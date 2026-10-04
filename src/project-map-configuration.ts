import path from "node:path";
import type { API, Project } from "typescript/unstable/async";
import type { MapConfigurationResult, MapWorkspacePlan } from "./project-map-configuration-types";
import { type MapVirtualFiles, mapRelativePath, mapVirtualPath } from "./project-map-virtual-files";
import { mapWorkspaceMembership } from "./project-map-workspace-membership";

const configuration = /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[a-z0-9_.-]+)?\.json$/u;
const packagePath = /(?:^|\/)package\.json$/u;
const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u;
const inside = (root: string, file: string) => file.startsWith(`${root}/`);

export async function discoverMapConfiguration(
  api: API,
  files: MapVirtualFiles,
): Promise<MapConfigurationResult> {
  const manifests = new Map<string, { path: string; value: Record<string, unknown> }[]>();
  for (const [file, text] of Object.entries(files.input.files)) {
    if (!packagePath.test(file)) continue;
    files.configurations.add(file);
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (typeof value?.name !== "string" || !packageName.test(value.name)) continue;
      const into = manifests.get(value.name);
      if (into) into.push({ path: file, value });
      else manifests.set(value.name, [{ path: file, value }]);
    } catch {
      /* The native compiler will report invalid admitted configuration. */
    }
  }
  const links: MapWorkspacePlan["links"] = [];
  const membership = mapWorkspaceMembership(files.input.files);
  const issues = new Set<MapWorkspacePlan["issues"][number]>();
  for (const file of membership.configurationFiles) files.configurations.add(file);
  for (const definitions of manifests.values()) {
    for (const definition of definitions) {
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const dependencies = definition.value[field];
        if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
          continue;
        for (const [name, value] of Object.entries(dependencies)) {
          if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
          if (membership.code) {
            issues.add(membership.code);
            continue;
          }
          if (
            !membership.contains(path.posix.dirname(definition.path)) &&
            definition.path !== "package.json"
          )
            continue;
          const targets = manifests.get(name);
          if (targets?.length !== 1) {
            issues.add("WORKSPACE_DEPENDENCY_TARGET_NOT_AVAILABLE");
            continue;
          }
          const target = targets[0];
          if (!target) continue;
          if (!membership.contains(path.posix.dirname(target.path))) {
            issues.add("WORKSPACE_DEPENDENCY_TARGET_NOT_AVAILABLE");
            continue;
          }
          links.push({
            from: path.posix.join(path.posix.dirname(definition.path), "node_modules", name),
            to: path.posix.dirname(target.path),
          });
        }
      }
    }
  }
  const workspaceLinks = [...new Map(links.map((link) => [link.from, link])).values()];
  // Package-based configuration inheritance must resolve on the first compiler parse.
  applyMapWorkspaceLinks(files, workspaceLinks);
  const outputs = new Map<string, { source: string; configPath: string }[]>();
  for (const configPath of Object.keys(files.input.files)
    .filter((file) => configuration.test(file))
    .sort()) {
    const parsed = await api.parseConfigFile(mapVirtualPath(configPath));
    const { rootDir, outDir, outFile, noEmit, declarationDir } = parsed.options;
    if (typeof rootDir !== "string" || typeof outDir !== "string" || outFile || noEmit) continue;
    for (const source of parsed.fileNames) {
      if (
        !inside(rootDir, source) ||
        !/\.[cm]?tsx?$/u.test(source) ||
        /\.d\.[cm]?ts$/u.test(source)
      )
        continue;
      const relative = mapRelativePath(source);
      if (!relative || !files.input.inventory.includes(relative)) continue;
      const stem = path.posix
        .join(outDir, source.slice(rootDir.length + 1))
        .replace(/\.[cm]?tsx?$/u, "");
      const extensions = source.endsWith(".mts")
        ? [".mjs", ".d.mts"]
        : source.endsWith(".cts")
          ? [".cjs", ".d.cts"]
          : [source.endsWith(".tsx") && parsed.options.jsx === 1 ? ".jsx" : ".js", ".d.ts"];
      for (const extension of extensions) {
        const location =
          extension.startsWith(".d.") && typeof declarationDir === "string"
            ? path.posix
                .join(declarationDir, source.slice(rootDir.length + 1))
                .replace(/\.[cm]?tsx?$/u, "")
            : stem;
        const output = mapRelativePath(location + extension);
        if (!output) continue;
        const into = outputs.get(output);
        if (into) into.push({ source: relative, configPath });
        else outputs.set(output, [{ source: relative, configPath }]);
      }
    }
  }
  const redirects: MapWorkspacePlan["redirects"] = [];
  for (const definitions of manifests.values()) {
    if (definitions.length !== 1) continue;
    const manifest = definitions[0];
    if (!manifest) continue;
    const visit = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("./")) {
        const output = path.posix.join(path.posix.dirname(manifest.path), value);
        const candidates = outputs.get(output) ?? [];
        const sources = new Set(candidates.map((candidate) => candidate.source));
        const candidate = candidates[0];
        if (sources.size === 1 && candidate)
          redirects.push({ manifest: manifest.path, output, ...candidate });
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    for (const key of ["main", "types", "typings", "exports"]) visit(manifest.value[key]);
  }
  const workspace = {
    links: workspaceLinks,
    redirects: [...new Map(redirects.map((redirect) => [redirect.output, redirect])).values()],
    // These reads produced the workspace plan, before opening any source programs.
    configurationFiles: [...new Set([...files.configurations, ...files.readInputs])].sort(),
    issues: [...issues],
  };
  applyMapWorkspaceContents(files, workspace);
  const openFiles = files.input.inventory.filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
  const snapshot = await api.updateSnapshot({ openFiles: openFiles.map(mapVirtualPath) });
  try {
    // Let the compiler choose the containing/default project, not every base/build tsconfig.
    const selected = new Map<
      string,
      { configPath?: string; rootFiles: string[]; project: Project }
    >();
    // Pipeline independent lookups, then consume in source order. Drain the batch even on failure.
    for (let start = 0; start < openFiles.length; start += 32) {
      const batch = openFiles.slice(start, start + 32);
      const projects = await Promise.allSettled(
        batch.map((file) => snapshot.getDefaultProjectForFile(mapVirtualPath(file))),
      );
      for (const [index, result] of projects.entries()) {
        if (result.status === "rejected") throw result.reason;
        const project = result.value;
        const file = batch[index];
        if (!project || !file) continue;
        const configPath = mapRelativePath(project.configFileName);
        const key = configPath ?? "INFERRED";
        let entry = selected.get(key);
        if (!entry) {
          entry = { ...(configPath ? { configPath } : {}), rootFiles: [], project };
          selected.set(key, entry);
        }
        entry.rootFiles.push(file);
      }
    }
    const projects: MapConfigurationResult["projects"] = [];
    for (const { project, ...entry } of selected.values()) {
      const inputFiles = (await project.program.getSourceFileNames()).flatMap((file) => {
        const relative = mapRelativePath(file);
        return relative && files.input.inventory.includes(relative) ? [relative] : [];
      });
      projects.push({ ...entry, inputFiles });
    }
    return { projects, workspace };
  } finally {
    await snapshot.dispose();
  }
}

export function applyMapWorkspace(files: MapVirtualFiles, workspace: MapWorkspacePlan): void {
  applyMapWorkspaceLinks(files, workspace.links);
  applyMapWorkspaceContents(files, workspace);
}

function applyMapWorkspaceLinks(files: MapVirtualFiles, links: MapWorkspacePlan["links"]): void {
  for (const link of links) files.alias(link.from, link.to);
}

function applyMapWorkspaceContents(files: MapVirtualFiles, workspace: MapWorkspacePlan): void {
  const manifests = new Set(workspace.redirects.map((redirect) => redirect.manifest));
  for (const manifest of manifests) {
    const original = files.input.files[manifest];
    if (original === undefined) throw new Error("PROJECT_MAP_CONTEXT_NOT_AVAILABLE");
    const value = JSON.parse(original) as Record<string, unknown>;
    const replacements = new Map(
      workspace.redirects.filter((r) => r.manifest === manifest).map((r) => [r.output, r.source]),
    );
    const rewrite = (entry: unknown): unknown => {
      if (typeof entry === "string" && entry.startsWith("./")) {
        const source = replacements.get(path.posix.join(path.posix.dirname(manifest), entry));
        return source ? `./${path.posix.relative(path.posix.dirname(manifest), source)}` : entry;
      }
      if (Array.isArray(entry)) return entry.map(rewrite);
      if (entry && typeof entry === "object")
        return Object.fromEntries(
          Object.entries(entry).map(([key, child]) => [key, rewrite(child)]),
        );
      return entry;
    };
    for (const key of ["main", "types", "typings", "exports"])
      if (Object.hasOwn(value, key)) value[key] = rewrite(value[key]);
    files.set(manifest, JSON.stringify(value));
  }
  for (const config of workspace.configurationFiles) files.configurations.add(config);
}

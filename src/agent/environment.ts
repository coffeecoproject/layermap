import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type LayerMapAnalyzers, mapDatabasePath } from "../layermap";
import { executableName } from "../platform";
import { discoverJavaRuntime } from "../project-map-process";

/** The layermap package around this module, whether run from its sources or from its bundle. */
export const packageRoot = (() => {
  for (let directory = path.dirname(fileURLToPath(import.meta.url)); ; ) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "layermap")
      return directory;
    if (path.dirname(directory) === directory) throw new Error("LayerMap cannot find its package.");
    directory = path.dirname(directory);
  }
})();

export const packageVersion = async (): Promise<string> =>
  JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;

/** Maps and built analyzers live in the user's cache, never inside a project. */
export const cacheDirectory = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.LAYERMAP_CACHE) return path.resolve(env.LAYERMAP_CACHE);
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Caches", "layermap");
  if (process.platform === "win32")
    return path.join(
      env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
      "layermap",
      "Cache",
    );
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "layermap");
};

/**
 * The project an agent works in: the Git work tree around the directory. Maps are built from
 * what Git lists, so a directory outside any work tree has none.
 */
export const projectDirectory = (
  directory: string,
): Promise<Readonly<{ directory: string; git: boolean }>> =>
  new Promise((resolve) =>
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: directory, timeout: 10_000 },
      (error, stdout) =>
        resolve(
          error
            ? { directory: path.resolve(directory), git: false }
            : { directory: stdout.trim(), git: true },
        ),
    ),
  );

type StoredAnalyzers = { [K in keyof LayerMapAnalyzers]: Record<string, unknown> };
const relativeTo = (directory: string, value: StoredAnalyzers): StoredAnalyzers =>
  Object.fromEntries(
    Object.entries(value).map(([language, resources]) => [
      language,
      Object.fromEntries(
        Object.entries(resources).map(([key, field]) => [
          key,
          key.endsWith("Path") && typeof field === "string" && field.startsWith(directory)
            ? path.relative(directory, field)
            : field,
        ]),
      ),
    ]),
  ) as StoredAnalyzers;
/**
 * A published package names its platform files by placeholder: the TypeScript compiler that npm
 * installed for this platform with the typescript dependency, and go-map built for each platform.
 */
const resolvePlaceholder = (field: string): string => {
  if (field === "@typescript/native") {
    const compiler = createRequire(
      createRequire(import.meta.url).resolve("typescript/package.json"),
    );
    const native = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
    return path.join(path.dirname(compiler.resolve(native)), "lib", executableName("tsc"));
  }
  const resolved = field
    .replaceAll("{platform}", process.platform)
    .replaceAll("{arch}", process.arch);
  // go-map is built per platform under its own name; Windows runs it as go-map.exe.
  return field.includes("{platform}") ? executableName(resolved) : resolved;
};
const absoluteIn = (directory: string, value: StoredAnalyzers): LayerMapAnalyzers =>
  Object.fromEntries(
    Object.entries(value).map(([language, resources]) => [
      language,
      Object.fromEntries(
        Object.entries(resources).map(([key, field]) => {
          if (!key.endsWith("Path") || typeof field !== "string") return [key, field];
          const resolved = resolvePlaceholder(field);
          return [key, path.isAbsolute(resolved) ? resolved : path.join(directory, resolved)];
        }),
      ),
    ]),
  ) as LayerMapAnalyzers;

const readAnalyzers = async (directory: string): Promise<LayerMapAnalyzers | undefined> => {
  const file = path.join(directory, "analyzers.json");
  if (!existsSync(file)) return undefined;
  const analyzers = absoluteIn(directory, JSON.parse(await readFile(file, "utf8")));
  // A published package names no JDK: Java maps use the one found on this machine, if any.
  return analyzers.java.runtimePath
    ? analyzers
    : { ...analyzers, java: { ...analyzers.java, ...discoverJavaRuntime() } };
};

/** Identity of the analyzer sources in a checkout: any edit gives another build directory. */
const sourceDigest = async (): Promise<string> => {
  const hash = createHash("sha256").update(await readFile(path.join(packageRoot, "package.json")));
  for (const part of ["src", "go-map", "java-map", "scripts"]) {
    const directory = path.join(packageRoot, part);
    if (!existsSync(directory)) continue;
    for (const entry of (await readdir(directory, { recursive: true })).sort()) {
      const file = path.join(directory, entry);
      const info = await stat(file);
      if (info.isFile()) hash.update(`${part}/${entry}\0${info.size}\0${info.mtimeMs}\0`);
    }
  }
  return hash.digest("hex").slice(0, 16);
};

/**
 * The analyzers to run: LAYERMAP_ANALYZERS, the ones a published package ships, or, in a
 * checkout, a build kept in the cache until the analyzer sources change.
 */
export async function resolveAnalyzers(
  cache: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LayerMapAnalyzers> {
  for (const directory of [env.LAYERMAP_ANALYZERS, path.join(packageRoot, "analyzers")]) {
    const analyzers = directory && (await readAnalyzers(path.resolve(directory)));
    if (analyzers) return analyzers;
  }
  const directory = path.join(cache, "analyzers", await sourceDigest());
  const built = await readAnalyzers(directory);
  if (built) return built;
  log("Building the language analyzers (once per LayerMap version)...");
  const staging = `${directory}.${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  // Only a checkout builds analyzers; the specifier is computed so a bundle does not take esbuild in.
  const builder = new URL("../../scripts/build.mjs", import.meta.url).href;
  const { buildProjectMapParser }: typeof import("../../scripts/build.mjs") = await import(builder);
  const parser = await buildProjectMapParser(staging);
  const stored = relativeTo(staging, {
    typescript: parser.resources,
    go: parser.goResources,
    python: parser.pythonResources,
    java: parser.javaResources,
  });
  await writeFile(path.join(staging, "analyzers.json"), `${JSON.stringify(stored, null, 2)}\n`);
  // Another process may have finished the same build first; either result is the same.
  await rename(staging, directory).catch(() => rm(staging, { recursive: true, force: true }));
  return (await readAnalyzers(directory)) as LayerMapAnalyzers;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Keeps the cache to what is in use: a project's map goes after 30 days unused, a superseded
 * analyzer build after a day (a server started before an update may still run it), and an
 * interrupted build after an hour.
 */
export async function pruneCache(cache: string, project: string, now = Date.now()): Promise<void> {
  const used = path.join(path.dirname(mapDatabasePath(cache, project)), "last-used");
  await mkdir(path.dirname(used), { recursive: true, mode: 0o700 });
  await writeFile(used, "");
  await utimes(used, now / 1000, now / 1000);
  const projects = path.join(cache, "projects");
  for (const name of await readdir(projects).catch(() => [])) {
    const directory = path.join(projects, name);
    const marker = path.join(directory, "last-used");
    const last = (await stat(existsSync(marker) ? marker : directory).catch(() => undefined))
      ?.mtimeMs;
    if (last !== undefined && now - last > 30 * DAY)
      await rm(directory, { recursive: true, force: true });
  }
  const builds = path.join(cache, "analyzers");
  const current = await sourceDigest();
  for (const name of await readdir(builds).catch(() => [])) {
    if (name === current) continue;
    const built = (await stat(path.join(builds, name)).catch(() => undefined))?.mtimeMs;
    if (built !== undefined && now - built > (name.includes(".") ? DAY / 24 : DAY))
      await rm(path.join(builds, name), { recursive: true, force: true });
  }
}

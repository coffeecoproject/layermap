import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { ZodType } from "zod";
import { ProjectEvidenceError } from "./core";
import { digestValue } from "./digest";
import { validateMapAnalysis } from "./project-map-analysis-validation";
import {
  type MapFacts,
  MapFactsSchema,
  MapReferenceFactsSchema,
  mapFactsAnalysis,
  mapFactsOffset,
  mapReferencePages,
} from "./project-map-facts";
import type {
  MapAnalyzerObserver,
  MapLanguage,
  MapLanguageAnalyzer,
  MapLanguageSession,
} from "./project-map-language";
import {
  installedGoMapResources,
  type MapParserResources,
  runMapOperation,
} from "./project-map-process";
import type { MapReferenceBatch, MapReferenceRequest } from "./project-map-reference-types";
import type { MapAnalysis, MapWorkerInput } from "./project-map-types";

const goModule = /(?:^|\/)go\.mod$/u;
const goWork = /(?:^|\/)go\.work$/u;
const codeHosts = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

export const GO_MAP_LANGUAGE: MapLanguage = Object.freeze({
  id: "go-1.24-map-v10",
  claims: (path: string) => path.endsWith(".go"),
  reads: (path: string) => goModule.test(path) || goWork.test(path),
  // A module path, or the standard library, whose first path element has no dot.
  importName: (specifier: string) => {
    const parts = specifier.split("/");
    if (!parts[0]?.includes(".")) return "Go standard library";
    const size = codeHosts.has(parts[0]) || specifier.startsWith("golang.org/x/") ? 3 : 2;
    return parts.slice(0, size).join("/");
  },
  // Go imports a package: the directory of the file.
  importTarget: (path: string) => `${path.slice(0, path.lastIndexOf("/") + 1) || "./"}`,
  create: () => new GoMapAnalyzer(),
});

// What every Go map states about its own reach.
const GO_GAPS = [
  "EXTERNAL_DEPENDENCIES_NOT_LOADED",
  "STANDARD_LIBRARY_NOT_LOADED",
  "BUILD_CONSTRAINTS_EVALUATED_FOR_LINUX_AMD64_WITHOUT_CGO",
  "DYNAMIC_AND_FRAMEWORK_LINKS_REQUIRE_SOURCE_INVESTIGATION",
  "UNMODELED_LANGUAGE_CONSTRUCTS_REQUIRE_SOURCE_INVESTIGATION",
  "DETAILED_REFERENCES_AVAILABLE_ON_DEMAND",
  "LOCAL_BINDINGS_MAPPED_WHEN_LINKED",
];

type GoInput = Omit<MapWorkerInput, "compilerPath">;

/** The Go program's facts as map units; configurations are the go.mod and go.work files read. */
export const goMapAnalysis = (
  facts: MapFacts,
  input: GoInput,
  configurations: readonly string[],
): MapAnalysis =>
  mapFactsAnalysis(facts, input, {
    language: "go",
    offsets: "UTF8_BYTES",
    ...(input.configPath ? { configPath: input.configPath } : {}),
    configurationFiles: configurations,
    optionsDigest: digestValue({ goos: "linux", goarch: "amd64", cgo: false }),
    gaps: [
      ...(input.configPath ? [] : [{ code: "NO_GO_MODULE" }]),
      ...GO_GAPS.map((code) => ({ code })),
    ],
    typeIssues: "GO_TYPE_CHECK_ISSUES",
    contract:
      "Declares a Go interface. This does not establish runtime enforcement or business authority.",
  });

/**
 * The directories ("." at the root), inside the project, of the modules a go.mod's replace
 * directives or a go.work's use directives name: modules the go command builds from that source.
 */
export const goLocalModules = (path: string, text: string): string[] => {
  const directive = goWork.test(path) ? "use" : "replace";
  const found: string[] = [];
  let block = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/u, "").trim();
    let entry: string | undefined;
    if (block) {
      if (line === ")") block = false;
      else entry = line;
    } else if (line === `${directive} (`) block = true;
    else if (line.startsWith(`${directive} `)) entry = line.slice(directive.length + 1);
    // replace module [version] => directory; use directory
    const target = directive === "use" ? entry : entry?.split("=>")[1];
    const directory = target
      ?.trim()
      .split(/\s+/u)[0]
      ?.replace(/^(["`])(.*)\1$/u, "$2");
    if (!directory || !/^\.\.?(?:\/|$)/u.test(directory)) continue;
    const joined = posix.normalize(posix.join(posix.dirname(path), directory)).replace(/\/$/u, "");
    if (joined !== ".." && !joined.startsWith("../")) found.push(joined);
  }
  return found;
};

export type GoModuleGroup = Readonly<{ configPath: string; modules: readonly string[] }>;

/**
 * The group of Go modules each go.mod is built with: modules a replace directive or a go.work
 * joins, which share one map context so calls between them resolve. A group is named by its
 * go.work, or else by its first go.mod.
 */
export const goModuleGroups = (
  files: readonly string[],
  text: (path: string) => string,
): Map<string, GoModuleGroup> => {
  const modules = files.filter((path) => goModule.test(path)).sort();
  const moduleAt = new Map(modules.map((path) => [posix.dirname(path), path]));
  const parent = new Map(modules.map((path) => [path, path]));
  const root = (path: string): string => {
    const up = parent.get(path) ?? path;
    return up === path ? path : root(up);
  };
  const works: [string, string][] = [];
  for (const path of [...files].filter((file) => goModule.test(file) || goWork.test(file)).sort()) {
    const linked = goLocalModules(path, text(path)).flatMap((dir) => moduleAt.get(dir) ?? []);
    const first = goWork.test(path) ? linked[0] : path;
    if (!first) continue;
    if (goWork.test(path)) works.push([path, first]);
    for (const module of linked) {
      const [low = first, high = module] = [root(first), root(module)].sort();
      if (low !== high) parent.set(high, low);
    }
  }
  const members = new Map<string, string[]>();
  for (const path of modules) members.set(root(path), [...(members.get(root(path)) ?? []), path]);
  const named = new Map(works.reverse().map(([work, module]) => [root(module), work]));
  return new Map(
    modules.map((path) => [
      path,
      { configPath: named.get(root(path)) ?? root(path), modules: members.get(root(path)) ?? [] },
    ]),
  );
};

/**
 * Go through the native go-map program: its parser and type checker, with the standard library
 * and other modules left unloaded. One map context per group of modules built together (go.mod
 * files joined by replace directives or a go.work); files outside any module share an inferred
 * context.
 */
export class GoMapAnalyzer implements MapLanguageAnalyzer {
  readonly id = GO_MAP_LANGUAGE.id;
  readonly claims = GO_MAP_LANGUAGE.claims;
  readonly reads = GO_MAP_LANGUAGE.reads;
  readonly importName = GO_MAP_LANGUAGE.importName;
  readonly importTarget = GO_MAP_LANGUAGE.importTarget;

  constructor(private readonly resources: MapParserResources = installedGoMapResources()) {}

  private async operation<T>(
    input: GoInput & { operation: string; [key: string]: unknown },
    schema: ZodType<T>,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<T> {
    const start = performance.now();
    const event = {
      operation: input.operation,
      contextRef: input.contextRef,
      inputFiles: Object.keys(input.files).length,
    };
    observe?.({ ...event, phase: "STARTED" });
    try {
      return await runMapOperation(this.resources, input, schema, signal);
    } finally {
      observe?.({ ...event, phase: "FINISHED", elapsedMs: performance.now() - start });
    }
  }

  async analyze(session: MapLanguageSession, signal: AbortSignal): Promise<void> {
    const paths = session.readable.map((entry) => entry.path);
    const groupOf = goModuleGroups(paths, (path) => session.texts[path] ?? "");
    // Each file belongs to the nearest enclosing module, and is mapped with that module's group.
    const moduleOf = (path: string) => {
      let best: string | undefined;
      for (const modFile of groupOf.keys()) {
        const directory = modFile.slice(0, modFile.lastIndexOf("/") + 1);
        if (path.startsWith(directory) && (!best || directory.length > best.lastIndexOf("/") + 1))
          best = modFile;
      }
      return best;
    };
    const contexts = new Map<string, { configurations: readonly string[]; sources: string[] }>();
    for (const path of paths) {
      if (!this.claims(path)) continue;
      const module = moduleOf(path);
      const group = module ? groupOf.get(module) : undefined;
      const configPath = group?.configPath ?? "";
      const into = contexts.get(configPath);
      if (into) into.sources.push(path);
      else
        contexts.set(configPath, {
          configurations: group ? [...new Set([...group.modules, configPath])].sort() : [],
          sources: [path],
        });
    }
    for (const [configPath, { configurations, sources }] of [...contexts].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      const files: Record<string, string> = Object.create(null);
      for (const path of [...sources, ...configurations]) {
        const text = session.texts[path];
        if (text === undefined)
          throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
        files[path] = text;
      }
      const input: GoInput = {
        contextRef: digestValue({
          analyzer: this.id,
          configPath: configPath || null,
        }),
        ...(configPath ? { configPath } : {}),
        files,
        inventory: Object.keys(files).sort(),
        syntaxOnly: false,
      };
      // A build without Go 1.24 leaves no analyzer: the files are mapped without facts.
      const built = existsSync(this.resources.compilerPath);
      const reused = session.reuse(input.contextRef, { configurations, built }, Object.keys(files));
      if (reused) {
        session.accept(reused);
        continue;
      }
      const facts: MapFacts = built
        ? await this.operation(
            { ...input, operation: "BUILD" },
            MapFactsSchema,
            signal,
            session.observe,
          )
        : { files: [], objects: [], relations: [], notes: [], typeErrors: 0 };
      const analysis = goMapAnalysis(facts, input, configurations);
      if (!built) analysis.gaps.push({ code: "GO_ANALYZER_NOT_BUILT" });
      validateMapAnalysis(analysis, input);
      session.accept(analysis);
    }
  }

  async references(
    input: GoInput,
    references: readonly MapReferenceRequest[],
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<MapReferenceBatch> {
    if (!existsSync(this.resources.compilerPath))
      return { pages: references.map(() => null), requiredFiles: [] };
    const files: Record<string, string> = Object.create(null);
    for (const [path, value] of Object.entries(input.files))
      if (this.claims(path) || this.reads(path)) files[path] = value;
    const facts = await this.operation(
      {
        ...input,
        files,
        operation: "REFERENCES",
        targets: references.map(({ targetPath, symbolStart }) => ({
          path: targetPath,
          offset: mapFactsOffset(input.files[targetPath] ?? "", symbolStart, "UTF8_BYTES"),
        })),
      },
      MapReferenceFactsSchema,
      signal,
      observe,
    );
    return mapReferencePages(facts, files, references, "UTF8_BYTES");
  }
}

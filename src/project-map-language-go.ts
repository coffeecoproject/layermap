import { existsSync } from "node:fs";
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
  mapReferencesPage,
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
import type { MapReferencePage, MapReferenceRequest } from "./project-map-reference-types";
import type { MapAnalysis, MapWorkerInput } from "./project-map-types";

const goModule = /(?:^|\/)go\.mod$/u;
const codeHosts = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

export const GO_MAP_LANGUAGE: MapLanguage = Object.freeze({
  id: "go-1.24-map-v6",
  claims: (path: string) => path.endsWith(".go"),
  reads: (path: string) => goModule.test(path),
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

/** The Go program's facts as map units. */
export const goMapAnalysis = (facts: MapFacts, input: GoInput, modFile?: string): MapAnalysis =>
  mapFactsAnalysis(facts, input, {
    language: "go",
    offsets: "UTF8_BYTES",
    ...(modFile ? { configPath: modFile } : {}),
    optionsDigest: digestValue({ goos: "linux", goarch: "amd64", cgo: false }),
    gaps: [...(modFile ? [] : [{ code: "NO_GO_MODULE" }]), ...GO_GAPS.map((code) => ({ code }))],
    typeIssues: "GO_TYPE_CHECK_ISSUES",
    contract:
      "Declares a Go interface. This does not establish runtime enforcement or business authority.",
  });

/**
 * Go through the native go-map program: its parser and type checker, with the standard library
 * and other modules left unloaded. One map context per module (go.mod); files outside any module
 * share an inferred context.
 */
export class GoMapAnalyzer implements MapLanguageAnalyzer {
  readonly id = GO_MAP_LANGUAGE.id;
  readonly claims = GO_MAP_LANGUAGE.claims;
  readonly reads = GO_MAP_LANGUAGE.reads;
  readonly importName = GO_MAP_LANGUAGE.importName;
  readonly importTarget = GO_MAP_LANGUAGE.importTarget;

  constructor(private readonly resources: MapParserResources = installedGoMapResources()) {}

  private async operation<T>(
    input: GoInput & { operation: string; modFile: string; [key: string]: unknown },
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
    const modules = session.readable
      .map((entry) => entry.path)
      .filter((path) => goModule.test(path))
      .sort();
    // Each file belongs to the nearest enclosing module.
    const moduleOf = (path: string) => {
      let best: string | undefined;
      for (const modFile of modules) {
        const directory = modFile.slice(0, modFile.lastIndexOf("/") + 1);
        if (path.startsWith(directory) && (!best || directory.length > best.lastIndexOf("/") + 1))
          best = modFile;
      }
      return best;
    };
    const groups = new Map<string, string[]>();
    for (const entry of session.readable) {
      if (!this.claims(entry.path)) continue;
      const key = moduleOf(entry.path) ?? "";
      const into = groups.get(key);
      if (into) into.push(entry.path);
      else groups.set(key, [entry.path]);
    }
    for (const modFile of [...groups.keys()].sort()) {
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      const files: Record<string, string> = Object.create(null);
      for (const path of [...(groups.get(modFile) ?? []), ...(modFile ? [modFile] : [])]) {
        const text = session.texts[path];
        if (text === undefined)
          throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
        files[path] = text;
      }
      const input: GoInput = {
        contextRef: digestValue({
          analyzer: this.id,
          configPath: modFile || null,
        }),
        ...(modFile ? { configPath: modFile } : {}),
        files,
        inventory: Object.keys(files).sort(),
        syntaxOnly: false,
      };
      // A build without Go 1.24 leaves no analyzer: the files are mapped without facts.
      const built = existsSync(this.resources.compilerPath);
      const reused = session.reuse(input.contextRef, { modFile, built }, Object.keys(files));
      if (reused) {
        session.accept(reused);
        continue;
      }
      const facts: MapFacts = built
        ? await this.operation(
            { ...input, operation: "BUILD", modFile },
            MapFactsSchema,
            signal,
            session.observe,
          )
        : { files: [], objects: [], relations: [], notes: [], typeErrors: 0 };
      const analysis = goMapAnalysis(facts, input, modFile || undefined);
      if (!built) analysis.gaps.push({ code: "GO_ANALYZER_NOT_BUILT" });
      validateMapAnalysis(analysis, input);
      session.accept(analysis);
    }
  }

  async references(
    input: GoInput,
    reference: MapReferenceRequest,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<MapReferencePage> {
    const text = input.files[reference.targetPath];
    if (text === undefined || !existsSync(this.resources.compilerPath))
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", false);
    const files: Record<string, string> = Object.create(null);
    for (const [path, value] of Object.entries(input.files))
      if (this.claims(path) || goModule.test(path)) files[path] = value;
    const facts = await this.operation(
      {
        ...input,
        files,
        operation: "REFERENCES",
        modFile: input.configPath ?? "",
        target: {
          path: reference.targetPath,
          offset: mapFactsOffset(text, reference.symbolStart, "UTF8_BYTES"),
        },
      },
      MapReferenceFactsSchema,
      signal,
      observe,
    );
    return mapReferencesPage(facts, files, reference, "UTF8_BYTES");
  }
}

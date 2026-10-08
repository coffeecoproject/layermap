import type { ZodType } from "zod";
import { ProjectEvidenceError } from "./core";
import { digestValue } from "./digest";
import { validateMapAnalysis } from "./project-map-analysis-validation";
import {
  type MapConfigurationResult,
  MapConfigurationResultSchema,
  type MapWorkspacePlan,
} from "./project-map-configuration-types";
import type {
  MapAnalyzerObserver,
  MapLanguage,
  MapLanguageAnalyzer,
  MapLanguageSession,
} from "./project-map-language";
import {
  installedMapParserResources,
  type MapParserResources,
  runMapOperation,
} from "./project-map-process";
import { MapReferencePageSchema, type MapReferenceRequest } from "./project-map-reference-types";
import { type MapAnalysis, MapAnalysisSchema, type MapWorkerInput } from "./project-map-types";

export const TYPESCRIPT_MAP_LANGUAGE: MapLanguage = Object.freeze({
  id: "typescript-7.0.2-map-v17",
  claims: (path: string) => /\.[cm]?[jt]sx?$/u.test(path),
  reads: (path: string) => path.endsWith(".json") || path === "pnpm-workspace.yaml",
  create: () => new TypeScriptMapAnalyzer(),
});

// Discovered configurations kept, one per recently mapped revision of the language's files.
const CONFIGURATIONS_KEPT = 4;

/**
 * TypeScript and JavaScript through the native compiler worker: one context per discovered
 * project, then an inferred context for claimed files no project parsed.
 */
export class TypeScriptMapAnalyzer implements MapLanguageAnalyzer {
  readonly id = TYPESCRIPT_MAP_LANGUAGE.id;
  readonly claims = TYPESCRIPT_MAP_LANGUAGE.claims;
  readonly reads = TYPESCRIPT_MAP_LANGUAGE.reads;
  // Discovery reads the texts of the files the language reads and nothing else, so a result
  // stands while they are the same, as they are when only other languages' files changed.
  private readonly configurations = new Map<string, MapConfigurationResult>();

  constructor(private readonly resources: MapParserResources = installedMapParserResources()) {}

  private async operation<T>(
    input: Omit<MapWorkerInput, "compilerPath"> & { operation: string; [key: string]: unknown },
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
      return await runMapOperation(this.resources, input, schema, signal, (timing) =>
        observe?.({ ...event, phase: "MEASURED", timing }),
      );
    } finally {
      observe?.({ ...event, phase: "FINISHED", elapsedMs: performance.now() - start });
    }
  }

  references(
    input: Omit<MapWorkerInput, "compilerPath">,
    reference: MapReferenceRequest,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ) {
    return this.operation(
      { ...input, operation: "REFERENCES", reference },
      MapReferencePageSchema,
      signal,
      observe,
    );
  }

  async analyze(session: MapLanguageSession, signal: AbortSignal): Promise<void> {
    const { entries, texts: unitTexts, observe } = session;
    const byPath = new Map(session.readable.map((entry) => [entry.path, entry]));
    const inventory = [...byPath.keys()];
    const parsed = new Set<string>();
    const syntaxFailed = new Set<string>();
    const accept = (analysis: MapAnalysis) => {
      for (const file of analysis.parsedFiles) parsed.add(file);
      for (const gap of analysis.gaps)
        if (gap.code === "SYNTAX_ERROR" && gap.path) syntaxFailed.add(gap.path);
      session.accept(analysis);
    };
    let workspace: MapWorkspacePlan | undefined;
    const context = async (
      configPath?: string,
      rootFiles?: readonly string[],
      inputFiles?: readonly string[],
    ) => {
      const texts: Record<string, string> = Object.create(null);
      for (const file of [
        ...(workspace?.configurationFiles ?? []),
        ...(configPath ? [configPath] : []),
      ]) {
        const text = unitTexts[file];
        if (text === undefined)
          throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
        texts[file] = text;
      }
      // Reuse captured text, while keeping each compiler context's discovered input set.
      // Placeholder reads below extend that set until every dependency is available.
      for (const file of inputFiles ?? rootFiles ?? inventory) {
        const text = unitTexts[file];
        if (text !== undefined) texts[file] = text;
      }
      // A context is its configuration (or inferred root files), not the revision's contents, so
      // a file whose facts did not change keeps identical facts across map versions.
      const contextRef = digestValue({
        analyzer: this.id,
        configPath: configPath ?? null,
        rootFiles: rootFiles ?? null,
      });
      // The files read on request below are among the previous analysis's input files, which
      // replaying requires to be unchanged as well.
      const reused = session.reuse(
        contextRef,
        {
          configPath: configPath ?? null,
          rootFiles: rootFiles ?? null,
          inventory,
          workspace: workspace ?? null,
        },
        Object.keys(texts),
      );
      if (reused) {
        accept(reused);
        return;
      }
      for (;;) {
        if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
        const input: Omit<MapWorkerInput, "compilerPath"> = {
          contextRef,
          ...(configPath ? { configPath } : {}),
          ...(rootFiles ? { rootFiles } : {}),
          files: texts,
          inventory,
          syntaxOnly: false,
          ...(workspace ? { workspace } : {}),
        };
        const analysis = await this.operation(
          { ...input, operation: "BUILD" },
          MapAnalysisSchema,
          signal,
          observe,
        );
        validateMapAnalysis(analysis, input);
        if (!analysis.requiredFiles.length) {
          accept(analysis);
          return;
        }
        const required = analysis.requiredFiles.map((path) => {
          const entry = byPath.get(path);
          if (!entry || Object.hasOwn(texts, path))
            throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
          return entry;
        });
        // Every requested file must be a new admitted input, so this loop either
        // makes finite progress or fails validation; partial placeholder maps are never stored.
        for (const entry of required)
          texts[entry.path] = unitTexts[entry.path] ?? (await session.read(entry));
      }
    };
    const configurationKey = digestValue({
      files: session.readable.map((entry) => [entry.path, entry.contentDigest ?? null]),
    });
    const discovered =
      this.configurations.get(configurationKey) ??
      (await this.operation(
        {
          operation: "CONFIGURE",
          contextRef: digestValue({ entries, purpose: "CONFIGURE" }),
          files: unitTexts,
          inventory,
          syntaxOnly: false,
        },
        MapConfigurationResultSchema,
        signal,
        observe,
      ));
    this.configurations.delete(configurationKey);
    this.configurations.set(configurationKey, discovered);
    for (const key of this.configurations.keys())
      if (this.configurations.size > CONFIGURATIONS_KEPT) this.configurations.delete(key);
    for (const project of discovered.projects) {
      if (
        (project.configPath && !byPath.has(project.configPath)) ||
        project.rootFiles.some((file) => !byPath.has(file)) ||
        project.inputFiles.some((file) => !byPath.has(file))
      )
        throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
    }
    workspace = discovered.workspace;
    for (const file of workspace.configurationFiles) {
      if (!byPath.has(file)) throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
      session.configuration(file);
    }
    for (const project of discovered.projects)
      await context(project.configPath, project.rootFiles, project.inputFiles);
    const orphaned = session.readable.filter(
      (entry) =>
        this.claims(entry.path) && !parsed.has(entry.path) && !syntaxFailed.has(entry.path),
    );
    if (orphaned.length)
      await context(
        undefined,
        orphaned.map((entry) => entry.path),
      );
  }
}

import { availableParallelism } from "node:os";
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
import { miniprogramConfiguration, miniprogramTemplateOf } from "./project-map-miniprogram";
import {
  installedMapParserResources,
  type MapParserResources,
  ProjectMapStopUnconfirmedError,
  runMapOperation,
} from "./project-map-process";
import {
  MapDiagnosticsSchema,
  MapReferenceBatchSchema,
  type MapReferenceRequest,
} from "./project-map-reference-types";
import { type MapAnalysis, MapAnalysisSchema, type MapWorkerInput } from "./project-map-types";

export const TYPESCRIPT_MAP_LANGUAGE: MapLanguage = Object.freeze({
  id: "typescript-7.0.2-map-v31",
  claims: (path: string) => /\.[cm]?[jt]sx?$/u.test(path),
  readsRequests: true,
  reads: (path: string) =>
    path.endsWith(".json") || path.endsWith(".wxml") || path === "pnpm-workspace.yaml",
  create: () => new TypeScriptMapAnalyzer(),
});

// Discovered configurations kept, one per recently mapped revision of the language's files.
const CONFIGURATIONS_KEPT = 4;
// Contexts analyzed at once, each by its own compiler worker.
const CONTEXTS_AT_ONCE = Math.min(4, availableParallelism());

/**
 * Runs the tasks `atOnce` at a time and takes each result in task order, once those before it are
 * taken. The first failure stops the other tasks and is thrown after they have stopped, unless a
 * worker could not be confirmed stopped: that is thrown instead, since it may still be running.
 */
export async function inOrder<T>(
  tasks: readonly ((signal: AbortSignal) => Promise<T>)[],
  take: (result: T) => void,
  signal: AbortSignal,
  atOnce: number,
) {
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  // A finishing task hands its slot to the next waiting one.
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (running < atOnce) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  let failure: { error: unknown } | undefined;
  const results = tasks.map(async (task) => {
    await slot();
    try {
      return await task(stopping.signal);
    } finally {
      release();
    }
  });
  // The first task to fail is the failure; those it stops fail after it.
  for (const result of results)
    result.catch((error: unknown) => {
      failure ??= { error };
      stop();
    });
  try {
    for (const result of results) take(await result);
  } catch (error) {
    stop();
    const unconfirmed = (await Promise.allSettled(results))
      .flatMap((settled) => (settled.status === "rejected" ? [settled.reason] : []))
      .find((reason) => reason instanceof ProjectMapStopUnconfirmedError);
    throw unconfirmed ?? (failure ? failure.error : error);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * TypeScript and JavaScript through the native compiler worker: one context per discovered
 * project, then an inferred context for claimed files no project parsed.
 */
export class TypeScriptMapAnalyzer implements MapLanguageAnalyzer {
  readonly id = TYPESCRIPT_MAP_LANGUAGE.id;
  readonly claims = TYPESCRIPT_MAP_LANGUAGE.claims;
  readonly reads = TYPESCRIPT_MAP_LANGUAGE.reads;
  // Discovery reads the texts of the files the language reads and what is installed, nothing else,
  // so a result stands while they are the same, as they are when only other languages' files changed.
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
    references: readonly MapReferenceRequest[],
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
    until?: number,
  ) {
    return this.operation(
      { ...input, operation: "REFERENCES", references, ...(until === undefined ? {} : { until }) },
      MapReferenceBatchSchema,
      signal,
      observe,
    );
  }

  diagnostics(
    input: Omit<MapWorkerInput, "compilerPath">,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ) {
    return this.operation(
      { ...input, operation: "DIAGNOSTICS" },
      MapDiagnosticsSchema,
      signal,
      observe,
    );
  }

  async analyze(session: MapLanguageSession, signal: AbortSignal): Promise<void> {
    const { entries, texts: unitTexts, observe, installed } = session;
    const byPath = new Map(session.readable.map((entry) => [entry.path, entry]));
    const inventory = [...byPath.keys()];
    const inventorySet = new Set(inventory);
    const parsed = new Set<string>();
    const syntaxFailed = new Set<string>();
    const accept = (analysis: MapAnalysis) => {
      for (const file of analysis.parsedFiles) parsed.add(file);
      for (const gap of analysis.gaps)
        if (gap.code === "SYNTAX_ERROR" && gap.path) syntaxFailed.add(gap.path);
      session.accept(analysis);
    };
    let workspace: MapWorkspacePlan | undefined;
    // A context's analysis, replayed or made by a compiler worker; the caller accepts it.
    const context = async (
      signal: AbortSignal,
      configPath?: string,
      rootFiles?: readonly string[],
      inputFiles?: readonly string[],
    ): Promise<MapAnalysis> => {
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
      // The template beside each mini-program page or component, and the configuration that
      // registers its components, which the analysis reads to link them.
      for (const file of Object.keys(texts)) {
        const template = miniprogramTemplateOf(file, inventorySet);
        if (!template) continue;
        const { own, app } = miniprogramConfiguration(template, inventorySet);
        for (const read of [template, own, app]) {
          const text = read === undefined ? undefined : unitTexts[read];
          if (read !== undefined && text !== undefined) texts[read] = text;
        }
      }
      // A context is its configuration (or inferred root files), not the revision's contents, so
      // a file whose facts did not change keeps identical facts across map versions.
      const contextRef = digestValue({
        analyzer: this.id,
        configPath: configPath ?? null,
        rootFiles: rootFiles ?? null,
      });
      // What the context is. What it read is the previous analysis's input files, which replaying
      // requires to be unchanged; the files given to it may be more than it reads, since discovery
      // opens the inferred project under options other than its own.
      const reused = session.reuse(
        contextRef,
        {
          configPath: configPath ?? null,
          rootFiles: rootFiles ?? null,
          inventory,
          workspace: workspace ?? null,
          installed: installed.digest,
        },
        [
          ...(workspace?.configurationFiles ?? []),
          ...(configPath ? [configPath] : []),
          ...(rootFiles ?? inventory),
        ],
      );
      if (reused) return reused;
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
          dependencies: installed.directory,
        };
        const analysis = await this.operation(
          { ...input, operation: "BUILD" },
          MapAnalysisSchema,
          signal,
          observe,
        );
        validateMapAnalysis(analysis, input);
        if (!analysis.requiredFiles.length) return analysis;
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
      installed: installed.digest,
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
          dependencies: installed.directory,
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
    // Accepted in discovery order, which decides whose copy of an object several contexts stage
    // is kept, however the analyses finish.
    await inOrder(
      discovered.projects.map(
        (project) => (signal: AbortSignal) =>
          context(signal, project.configPath, project.rootFiles, project.inputFiles),
      ),
      accept,
      signal,
      CONTEXTS_AT_ONCE,
    );
    const orphaned = session.readable.filter(
      (entry) =>
        this.claims(entry.path) && !parsed.has(entry.path) && !syntaxFailed.has(entry.path),
    );
    if (orphaned.length)
      accept(
        await context(
          signal,
          undefined,
          orphaned.map((entry) => entry.path),
        ),
      );
  }
}

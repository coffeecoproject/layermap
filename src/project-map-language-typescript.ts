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
// Compiler workers run at once for one analysis, besides the one discovering its configuration.
const WORKERS_AT_ONCE = Math.min(4, availableParallelism());

/** Runs work `atOnce` at a time, in the order it is asked for. */
export function limit(atOnce: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running < atOnce) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      // A finishing run hands its place to the next waiting one.
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

// Where a code file names a module: from, import and require with a literal, and reference
// directives. Only whether to begin builds before discovery rests on it, never what is stored.
const MODULE_NAMES =
  /\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`\n]+)\1|\/\/\/\s*<reference\s+(?:path|types|lib)\s*=\s*(["'])([^"'\n]+)\3/gu;
const moduleNames = (text: string) =>
  digestValue([...text.matchAll(MODULE_NAMES)].map((match) => match[2] ?? match[4] ?? ""));

/** What discovery read of a revision, as far as an edit to a code file's body leaves it alone. */
type MapCodeShape = Readonly<{
  installed: string;
  // Each readable file's content digest, and what of it discovery depends on: the module names
  // of a code file, all of another.
  files: ReadonlyMap<string, Readonly<{ digest: string | null; shape: string | null }>>;
}>;

const sameShape = (left: MapCodeShape, right: MapCodeShape) =>
  left.installed === right.installed &&
  left.files.size === right.files.size &&
  [...left.files].every(([path, { shape }]) => right.files.get(path)?.shape === shape);

const stopUnconfirmed = async (runs: readonly Promise<unknown>[]) =>
  (await Promise.allSettled(runs))
    .flatMap((settled) => (settled.status === "rejected" ? [settled.reason] : []))
    .find((reason) => reason instanceof ProjectMapStopUnconfirmedError);

/**
 * Starts the tasks, the larger by `sizes` first so that work they queue for goes to the longest
 * first, and takes each result in task order, once those before it are taken. The first failure
 * stops the other tasks and is thrown after they have stopped, unless a worker could not be
 * confirmed stopped: that is thrown instead, since it may still be running.
 */
export async function inOrder<T>(
  tasks: readonly ((signal: AbortSignal) => Promise<T>)[],
  take: (result: T) => void,
  signal: AbortSignal,
  sizes: readonly number[],
) {
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let failure: { error: unknown } | undefined;
  // Equal sizes keep the task order.
  const results: Promise<T>[] = [];
  for (const index of tasks
    .map((_, index) => index)
    .sort((left, right) => (sizes[right] ?? 0) - (sizes[left] ?? 0)))
    results[index] = (tasks[index] as (signal: AbortSignal) => Promise<T>)(stopping.signal);
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
    throw (await stopUnconfirmed(results)) ?? (failure ? failure.error : error);
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
  // The last configuration discovered, and the shape of the code it was discovered from.
  private last?: Readonly<{ shape: MapCodeShape; discovered: MapConfigurationResult }>;

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
    const workers = limit(WORKERS_AT_ONCE);
    // What a context is given and asked: its ref, the request and files that decide whether the
    // previous map's analysis of it stands, and the compiler's input.
    const plan = (
      workspace: MapWorkspacePlan,
      configPath?: string,
      rootFiles?: readonly string[],
      inputFiles?: readonly string[],
    ) => {
      const texts: Record<string, string> = Object.create(null);
      for (const file of [...workspace.configurationFiles, ...(configPath ? [configPath] : [])]) {
        const text = unitTexts[file];
        if (text === undefined)
          throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
        texts[file] = text;
      }
      // Reuse captured text, while keeping each compiler context's discovered input set.
      // Placeholder reads extend that set until every dependency is available.
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
      const input: Omit<MapWorkerInput, "compilerPath"> = {
        contextRef,
        ...(configPath ? { configPath } : {}),
        ...(rootFiles ? { rootFiles } : {}),
        files: texts,
        inventory,
        syntaxOnly: false,
        workspace,
        dependencies: installed.directory,
      };
      return {
        contextRef,
        // What the context is. What it read is the previous analysis's input files, which
        // replaying requires to be unchanged; the files given to it may be more than it reads,
        // since discovery opens the inferred project under options other than its own.
        request: {
          configPath: configPath ?? null,
          rootFiles: rootFiles ?? null,
          inventory,
          workspace,
          installed: installed.digest,
        },
        files: [
          ...workspace.configurationFiles,
          ...(configPath ? [configPath] : []),
          ...(rootFiles ?? inventory),
        ],
        texts,
        input,
        // The texts are the captured ones of these paths, so the paths stand for them.
        key: digestValue({ ...input, files: Object.keys(texts) }),
      };
    };
    type Plan = ReturnType<typeof plan>;
    type Build = Readonly<{ analysis: Promise<MapAnalysis>; controller: AbortController }>;
    const build = (input: Plan["input"], signal: AbortSignal) =>
      workers(() =>
        this.operation({ ...input, operation: "BUILD" }, MapAnalysisSchema, signal, observe),
      );
    // A context's analysis, replayed or made by compiler workers; `started` is a build begun on the
    // same input before discovery confirmed it. The caller accepts the analysis.
    const context = async (
      signal: AbortSignal,
      { contextRef, request, files, texts, input }: Plan,
      started?: Build,
    ) => {
      const reused = session.reuse(contextRef, request, files);
      if (reused) {
        started?.controller.abort();
        return reused;
      }
      if (started) {
        const stop = () => started.controller.abort();
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      }
      let first = started?.analysis;
      for (;;) {
        if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
        const analysis = await (first ?? build(input, signal));
        first = undefined;
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
    const admitted = (discovered: MapConfigurationResult) =>
      discovered.projects.every(
        (project) =>
          (!project.configPath || byPath.has(project.configPath)) &&
          project.rootFiles.every((file) => byPath.has(file)) &&
          project.inputFiles.every((file) => byPath.has(file)),
      ) && discovered.workspace.configurationFiles.every((file) => byPath.has(file));
    const configurationKey = digestValue({
      files: session.readable.map((entry) => [entry.path, entry.contentDigest ?? null]),
      installed: installed.digest,
    });
    const known = this.configurations.get(configurationKey);
    const shape: MapCodeShape = {
      installed: installed.digest,
      files: new Map(
        session.readable.map((entry) => {
          const digest = entry.contentDigest ?? null;
          const before = this.last?.shape.files.get(entry.path);
          return [
            entry.path,
            {
              digest,
              shape: !this.claims(entry.path)
                ? digest
                : before && before.digest === digest
                  ? before.shape
                  : moduleNames(unitTexts[entry.path] ?? ""),
            },
          ];
        }),
      ),
    };
    // Where only the bodies of code changed, discovery most likely finds the configuration it
    // found last: while it runs, that configuration's contexts are built as it had them, except
    // those the previous map holds as they are, and discovery decides which builds stand.
    const guess =
      !known && this.last && sameShape(this.last.shape, shape) ? this.last.discovered : undefined;
    const speculative = new Map<string, Build>();
    try {
      if (guess && admitted(guess))
        for (const project of [...guess.projects].sort(
          (left, right) => right.rootFiles.length - left.rootFiles.length,
        )) {
          const guessed = plan(
            guess.workspace,
            project.configPath,
            project.rootFiles,
            project.inputFiles,
          );
          if (session.replays(guessed.contextRef, guessed.request, guessed.files)) continue;
          const controller = new AbortController();
          const analysis = build(guessed.input, AbortSignal.any([signal, controller.signal]));
          analysis.catch(() => {});
          speculative.set(guessed.key, { analysis, controller });
        }
      const discovered =
        known ??
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
      this.last = { shape, discovered };
      for (const key of this.configurations.keys())
        if (this.configurations.size > CONFIGURATIONS_KEPT) this.configurations.delete(key);
      if (!admitted(discovered))
        throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
      const { workspace } = discovered;
      for (const file of workspace.configurationFiles) session.configuration(file);
      const plans = discovered.projects.map((project) =>
        plan(workspace, project.configPath, project.rootFiles, project.inputFiles),
      );
      const started = plans.map((planned) => speculative.get(planned.key));
      for (const [key, unused] of speculative)
        if (!plans.some((planned) => planned.key === key)) unused.controller.abort();
      // Accepted in discovery order, which decides whose copy of an object several contexts stage
      // is kept, however the analyses finish. A context's root files are the files it analyzes, so
      // their count sizes it.
      await inOrder(
        plans.map(
          (planned, index) => (signal: AbortSignal) => context(signal, planned, started[index]),
        ),
        accept,
        signal,
        discovered.projects.map((project) => project.rootFiles.length),
      );
      const orphaned = session.readable.filter(
        (entry) =>
          this.claims(entry.path) && !parsed.has(entry.path) && !syntaxFailed.has(entry.path),
      );
      if (orphaned.length)
        accept(
          await context(
            signal,
            plan(
              workspace,
              undefined,
              orphaned.map((entry) => entry.path),
            ),
          ),
        );
    } catch (error) {
      for (const unused of speculative.values()) unused.controller.abort();
      throw (await stopUnconfirmed([...speculative.values()].map((run) => run.analysis))) ?? error;
    }
    // A build discovery left unused may not have stopped.
    const unconfirmed = await stopUnconfirmed([...speculative.values()].map((run) => run.analysis));
    if (unconfirmed) throw unconfirmed;
  }
}

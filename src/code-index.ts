import { CodeIndexCapture, type CodeIndexCaptureResult } from "./code-index-capture";
import { CodeIndexQuery } from "./code-index-query";
import { type CodeIndexStore, MapReplayConflict } from "./code-index-store";
import type { CodeIndexCaptureOptions, CodeIndexSource } from "./code-index-types";
import { ProjectEvidenceError } from "./core";
import { digestValue } from "./digest";
import { GitCommandStopUnconfirmedError } from "./git-runner";
import { type MapParent, ProjectMapAnalyzer } from "./project-map-analyzer";
import { ProjectMapStopUnconfirmedError } from "./project-map-process";
import { ProjectMapReferenceQuery } from "./project-map-reference-query";
import type { MapReferenceInput } from "./project-map-reference-types";
import { ProjectMapSourceReader, readAll } from "./project-map-source";

type Rebuild = Readonly<{
  controller: AbortController;
  completion: Promise<void>;
  waiters: Set<symbol>;
}>;

export class CodeIndex {
  readonly query: CodeIndexQuery;
  private readonly capture: CodeIndexCapture;
  private readonly captures = new Map<AbortController, Promise<unknown>>();
  private readonly rebuilds = new Map<string, Rebuild>();
  private readonly mapBuilds = new Map<string, Rebuild>();
  private accepting = true;
  private quiescePromise?: Promise<void>;
  private stopFailure?: GitCommandStopUnconfirmedError | ProjectMapStopUnconfirmedError;

  constructor(
    readonly store: CodeIndexStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly analyzer: ProjectMapAnalyzer = new ProjectMapAnalyzer(),
  ) {
    this.query = new CodeIndexQuery(store, (signal, read) => this.read(signal, read));
    this.capture = new CodeIndexCapture(analyzer.id);
  }

  async prepare(
    source: CodeIndexSource,
    signal: AbortSignal,
    options: CodeIndexCaptureOptions = {},
  ) {
    const version = await this.captureVersion(source, signal, options);
    await this.ensureIndex(version.version, signal);
    return version;
  }

  captureVersion(
    source: CodeIndexSource,
    signal: AbortSignal,
    options: CodeIndexCaptureOptions = {},
  ) {
    this.assertAccepting(signal);
    source = Object.freeze({ ...source, directory: Object.freeze({ ...source.directory }) });
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const completion = this.capture
      .capture(source, combined, options)
      .then(async (result) => {
        if (combined.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
        const existing = this.store.getVersion(result.version.version);
        if (existing) {
          if (digestValue(existing) !== digestValue(result.version))
            throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CONFLICT", false);
          return existing;
        }
        await this.buildMap(result, source, combined);
        return this.store.requireVersion(result.version.version);
      })
      .catch((error: unknown) => {
        if (
          error instanceof GitCommandStopUnconfirmedError ||
          error instanceof ProjectMapStopUnconfirmedError
        )
          this.stopFailure = error;
        throw error;
      })
      .finally(() => {
        this.captures.delete(controller);
      });
    this.captures.set(controller, completion);
    return completion;
  }

  private async buildMap(
    result: CodeIndexCaptureResult,
    source: CodeIndexSource,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertAccepting(signal);
    const ref = result.version.version;
    const existing = this.mapBuilds.get(ref);
    if (existing?.controller.signal.aborted) {
      try {
        await existing.completion;
      } catch (error) {
        if (!(error instanceof ProjectEvidenceError) || error.code !== "PROJECT_READ_CANCELLED")
          throw error;
      }
      return this.buildMap(result, source, signal);
    }
    if (existing) return this.awaitRebuild(existing, signal);
    if (this.store.getVersion(ref)) return;
    const controller = new AbortController();
    // Not a default parameter: retrying with an undefined parent must not find one again.
    const run = async (parent: Omit<MapParent, "link"> | undefined): Promise<void> => {
      const stage = this.store.createMapStage();
      const linked: string[] = [];
      try {
        const reader = await ProjectMapSourceReader.open(source, controller.signal);
        if (digestValue([...reader.paths()].sort()) !== result.universeDigest)
          throw new ProjectEvidenceError("PROJECT_READ_SOURCE_CHANGED", true);
        // A conflict between what was analyzed and what the parent's units hold, found in the
        // analysis or when the units are listed, repeats the build without a parent.
        try {
          const coverage = await this.analyzer.analyze(
            reader,
            result.entries,
            controller.signal,
            (unit, record) => this.store.appendMapStage(stage, unit, record),
            parent && { ...parent, link: (paths) => linked.push(...paths) },
          );
          // Every captured file still has the content the analysis read.
          await readAll(result.entries, (entry) => reader.read(entry.path, entry));
          await reader.assertStable();
          if (controller.signal.aborted)
            throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
          this.store.publish(
            result.version,
            result.entries,
            stage,
            coverage,
            parent && linked.length
              ? { version: parent.version, paths: new Set(linked) }
              : undefined,
          );
        } catch (error) {
          if (parent && error instanceof MapReplayConflict) return run(undefined);
          throw error;
        }
      } finally {
        this.store.discardMapStage(stage);
      }
    };
    const completion = run(this.mapParent(result)).finally(() => {
      if (this.mapBuilds.get(ref)?.completion === completion) this.mapBuilds.delete(ref);
    });
    const build = { controller, completion, waiters: new Set<symbol>() };
    this.mapBuilds.set(ref, build);
    return this.awaitRebuild(build, signal);
  }

  /**
   * The recent map of the same project scope and analyzer whose files differ least from the new
   * revision's: its contexts whose inputs did not change are replayed rather than analyzed.
   */
  private mapParent(result: CodeIndexCaptureResult): Omit<MapParent, "link"> | undefined {
    const digests = new Map(result.entries.map((entry) => [entry.path, entry.contentDigest]));
    let best: { version: string; entries: Map<string, string>; changed: number } | undefined;
    for (const candidate of this.store.mapParentCandidates(result.version, 8)) {
      const entries = new Map<string, string>();
      for (const entry of this.store.listEntries(candidate))
        if (entry.contentDigest) entries.set(entry.path, entry.contentDigest);
      let changed = 0;
      for (const [path, digest] of digests) if (entries.get(path) !== digest) changed++;
      for (const path of entries.keys()) if (!digests.has(path)) changed++;
      if (!best || changed < best.changed) best = { version: candidate, entries, changed };
    }
    if (!best) return undefined;
    const { version, entries } = best;
    return {
      version,
      entries,
      contexts: this.store.mapContexts(version),
      shell: (contextRef) => this.store.mapContextShell(version, contextRef),
      state: (contextRef) => this.store.mapContextState(version, contextRef),
    };
  }

  private read<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertAccepting(signal);
    const controller = new AbortController();
    const completion = operation(AbortSignal.any([signal, controller.signal]))
      .catch((error: unknown) => {
        if (
          error instanceof GitCommandStopUnconfirmedError ||
          error instanceof ProjectMapStopUnconfirmedError
        )
          this.stopFailure = error;
        throw error;
      })
      .finally(() => this.captures.delete(controller));
    this.captures.set(controller, completion);
    return completion;
  }

  async ensureIndex(version: string, signal: AbortSignal): Promise<void> {
    this.assertAccepting(signal);
    if (this.store.getIndexProgress(version).complete) return;
    return this.rebuild(version, signal);
  }

  async rebuild(version: string, signal: AbortSignal): Promise<void> {
    this.assertAccepting(signal);
    const existing = this.rebuilds.get(version);
    if (existing?.controller.signal.aborted) {
      try {
        await existing.completion;
      } catch (error) {
        if (!(error instanceof ProjectEvidenceError) || error.code !== "PROJECT_READ_CANCELLED")
          throw error;
      }
      return this.rebuild(version, signal);
    }
    if (existing) return this.awaitRebuild(existing, signal);
    const controller = new AbortController();
    const completion = this.performRebuild(version, controller.signal).finally(() => {
      if (this.rebuilds.get(version)?.completion === completion) this.rebuilds.delete(version);
    });
    const rebuild = { controller, completion, waiters: new Set<symbol>() };
    this.rebuilds.set(version, rebuild);
    return this.awaitRebuild(rebuild, signal);
  }

  async searchMap(input: Parameters<CodeIndexQuery["searchMap"]>[0], signal: AbortSignal) {
    await this.ensureIndex(input.version, signal);
    return this.query.searchMap(input, signal);
  }

  findReferences(input: MapReferenceInput, signal: AbortSignal) {
    return this.read(signal, (signal) =>
      new ProjectMapReferenceQuery(this.store, this.analyzer).query(input, signal),
    );
  }

  get busy() {
    return this.captures.size > 0 || this.rebuilds.size > 0 || this.mapBuilds.size > 0;
  }

  close(): void {
    if (this.busy) throw new ProjectEvidenceError("PROJECT_EVIDENCE_MAINTENANCE_BUSY", true);
    this.accepting = false;
    this.query.clear();
  }

  quiesce(): Promise<void> {
    if (this.quiescePromise) return this.quiescePromise;
    this.accepting = false;
    for (const controller of this.captures.keys()) controller.abort();
    for (const rebuild of this.rebuilds.values()) rebuild.controller.abort();
    for (const build of this.mapBuilds.values()) build.controller.abort();
    this.quiescePromise = Promise.allSettled([
      ...this.captures.values(),
      ...[...this.rebuilds.values()].map((value) => value.completion),
      ...[...this.mapBuilds.values()].map((value) => value.completion),
    ]).then(() => {
      this.query.clear();
      if (this.stopFailure) throw this.stopFailure;
    });
    return this.quiescePromise;
  }

  private async performRebuild(version: string, signal: AbortSignal): Promise<void> {
    this.store.beginDerivedIndexRebuild(version);
    let afterPath = "";
    try {
      while (true) {
        if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
        const entries = this.store.listDerivedIndexEntries(version, afterPath, 16);
        if (entries.length === 0) break;
        this.store.appendDerivedIndexEntries(version, entries);
        afterPath = entries.at(-1)?.path ?? afterPath;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      this.store.completeDerivedIndex(version, this.clock());
    } catch (error) {
      this.store.discardDerivedIndex(version);
      throw error;
    }
  }

  private awaitRebuild(rebuild: Rebuild, signal: AbortSignal): Promise<void> {
    this.assertAccepting(signal);
    const waiter = Symbol();
    rebuild.waiters.add(waiter);
    return new Promise<void>((resolve, reject) => {
      const release = () => {
        signal.removeEventListener("abort", abort);
        rebuild.waiters.delete(waiter);
      };
      const abort = () => {
        release();
        if (rebuild.waiters.size === 0) rebuild.controller.abort();
        else reject(new ProjectEvidenceError("PROJECT_READ_CANCELLED", true));
      };
      signal.addEventListener("abort", abort, { once: true });
      rebuild.completion.then(
        () => {
          release();
          if (signal.aborted) reject(new ProjectEvidenceError("PROJECT_READ_CANCELLED", true));
          else resolve();
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  }

  private assertAccepting(signal: AbortSignal) {
    if (!this.accepting || this.stopFailure)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_NOT_AVAILABLE", true);
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
  }
}

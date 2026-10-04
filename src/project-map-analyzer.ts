import {
  type MapContextRecord,
  MapReplayConflict,
  type MapStoredContext,
} from "./code-index-store";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { digestValue } from "./digest";
import {
  MAP_LANGUAGES,
  type MapAnalyzerObserver,
  type MapLanguageAnalyzer,
  mapAnalyzerSuite,
} from "./project-map-language";
import type { MapReferenceRequest } from "./project-map-reference-types";
import { type ProjectMapSourceReader, readAll } from "./project-map-source";
import type {
  MapAnalysis,
  MapBuildCoverage,
  MapContext,
  MapWorkerInput,
} from "./project-map-types";

/**
 * A previous map of the same project scope. A context whose inputs are unchanged is replayed: its
 * record comes from the parent and the version lists the parent's units of the files it
 * contributed to, so its facts are neither analyzed nor stored again. A language may also
 * analyze only part of a context from the state it kept, and link the parent's units of the
 * other files.
 */
export type MapParent = Readonly<{
  version: string;
  /** Content digests of its text entries by path. */
  entries: ReadonlyMap<string, string>;
  contexts: ReadonlyMap<string, MapStoredContext>;
  /**
   * A context's record, gaps and parsed files, without facts, the state its language kept and the
   * files it has facts in.
   */
  shell(
    contextRef: string,
  ): Readonly<{ analysis: MapAnalysis; state?: unknown; paths?: readonly string[] }>;
  /** The state a context's language kept, if any. */
  state(contextRef: string): unknown;
  /** Receives the files whose units the analysis links, once it is complete and consistent. */
  link(paths: readonly string[]): void;
}>;

const contextFiles = (context: MapContext) => [
  ...context.inputFiles,
  ...context.configurationFiles,
  ...(context.workspace?.configurationFiles ?? []),
];

/**
 * The parent's contexts whose files all have the same texts, among contexts that share no file
 * with a context that changed: those are replayed or analyzed together, so the objects that
 * several of them stage are deduplicated as a full analysis would.
 */
function replayableContexts(parent: MapParent, digests: ReadonlyMap<string, string>) {
  const sharing = new Map<string, Set<string>>();
  for (const [ref, { context }] of parent.contexts)
    for (const path of contextFiles(context)) {
      const refs = sharing.get(path) ?? new Set<string>();
      refs.add(ref);
      sharing.set(path, refs);
    }
  const unchanged = new Set<string>();
  for (const [ref, { context }] of parent.contexts)
    if (
      contextFiles(context).every(
        (path) => digests.get(path) !== undefined && digests.get(path) === parent.entries.get(path),
      )
    )
      unchanged.add(ref);
  const replayable = new Set<string>();
  for (const [ref, { context }] of parent.contexts)
    if (
      unchanged.has(ref) &&
      contextFiles(context).every((path) =>
        [...(sharing.get(path) ?? [])].every((other) => unchanged.has(other)),
      )
    )
      replayable.add(ref);
  return { replayable, sharing };
}

const invalidParent = (): never => {
  throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
};

const factPaths = (analysis: MapAnalysis) => [
  ...analysis.objects.map((object) => object.anchor.path),
  ...analysis.relations.map((relation) => relation.anchor.path),
  ...analysis.notes.map((note) => note.anchor.path),
];

const emptyAnalysis = (): MapAnalysis => ({
  contexts: [],
  objects: [],
  relations: [],
  notes: [],
  gaps: [],
  parsedFiles: [],
  requiredFiles: [],
});

/**
 * Runs the language analyzers a revision needs and stages their units as one map. A language
 * runs only when the revision holds a file it claims; every other admitted file is inventoried.
 */
export class ProjectMapAnalyzer {
  readonly id: string;

  constructor(
    private readonly languages: readonly MapLanguageAnalyzer[] = MAP_LANGUAGES.map((language) =>
      language.create(),
    ),
    private readonly observe?: MapAnalyzerObserver,
  ) {
    this.id = mapAnalyzerSuite(languages);
  }

  private claims(path: string) {
    return this.languages.some((language) => language.claims(path));
  }

  references(
    input: Omit<MapWorkerInput, "compilerPath">,
    reference: MapReferenceRequest,
    signal: AbortSignal,
  ) {
    const language = this.languages.find((language) => language.claims(reference.targetPath));
    if (!language?.references)
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", false);
    return language.references(input, reference, signal, this.observe);
  }

  async analyze(
    reader: ProjectMapSourceReader,
    entries: readonly ProjectEvidenceRevisionFileEntryV1[],
    signal: AbortSignal,
    consume: (unit: MapAnalysis, record: MapContextRecord) => void,
    parent?: MapParent,
  ): Promise<MapBuildCoverage> {
    const result: MapBuildCoverage = {
      gaps: [{ code: "MAP_COVERS_ADMITTED_SCOPE_AND_POLICY_ONLY" }],
      parsedFiles: [],
    };
    const parsed = new Set<string>();
    const text = entries.filter((entry) => entry.state === "TEXT");
    // Each code file has one language; a second claim would analyze it twice.
    if (
      text.some(
        (entry) => this.languages.filter((language) => language.claims(entry.path)).length > 1,
      )
    )
      throw new ProjectEvidenceError("PROJECT_MAP_PARSER_CONFIGURATION_INVALID", false);
    const running = this.languages.filter((language) =>
      text.some((entry) => language.claims(entry.path)),
    );
    const readableBy = (language: MapLanguageAnalyzer) =>
      text.filter((entry) => language.claims(entry.path) || language.reads(entry.path));
    const readable = text.filter((entry) =>
      running.some((language) => language.claims(entry.path) || language.reads(entry.path)),
    );
    const configurationInputs = new Set<string>();
    const digests = new Map<string, string>();
    for (const entry of entries)
      if (entry.contentDigest) digests.set(entry.path, entry.contentDigest);
    const { replayable, sharing } = parent
      ? replayableContexts(parent, digests)
      : { replayable: new Set<string>(), sharing: new Map<string, Set<string>>() };
    const requests = new Map<string, string>();
    const states = new Map<string, unknown>();
    // The files each replayed context has facts in, and those a context analyzed in part links.
    const replayed = new Map<string, readonly string[]>();
    const linked = new Set<string>();
    // Files of the contexts analyzed (a context analyzed in part: the files it staged facts for),
    // and every file with facts staged.
    const analyzedFiles = new Set<string>();
    const stagedPaths = new Set<string>();
    const reuse = (contextRef: string, request: unknown, files: readonly string[]) => {
      const digest = digestValue({
        request,
        files: files.map((path) => [path, digests.get(path) ?? null]),
      });
      requests.set(contextRef, digest);
      if (!parent || !replayable.has(contextRef)) return undefined;
      if (parent.contexts.get(contextRef)?.requestDigest !== digest) return undefined;
      const { analysis, state, paths } = parent.shell(contextRef);
      // A context stored before its files were recorded is analyzed again.
      if (!paths) return undefined;
      if (state !== undefined) states.set(contextRef, state);
      replayed.set(contextRef, paths);
      this.observe?.({
        operation: "REUSE",
        phase: "FINISHED",
        contextRef,
        inputFiles: analysis.contexts[0]?.inputFiles.length ?? 0,
      });
      return analysis;
    };
    const previous = (contextRef: string) => {
      if (!parent?.contexts.has(contextRef)) return undefined;
      const state = parent.state(contextRef);
      return state === undefined ? undefined : { state, digests: parent.entries };
    };
    const read = async (entry: ProjectEvidenceRevisionFileEntryV1) => {
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      const value = await reader.read(entry.path, entry);
      if (!value.content) throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.content);
    };
    // Read as the capture does, several at a time; the texts keep the admission order.
    const contents = await readAll(readable, read);
    const unitTexts: Record<string, string> = Object.create(null);
    for (const [index, entry] of readable.entries())
      unitTexts[entry.path] = contents[index] as string;
    const objectRoles = new Map<string, boolean>();
    let relationCount = 0;
    const accept = (
      analysis: MapAnalysis,
      options?: Readonly<{ state?: unknown; linked?: readonly string[] }>,
    ) => {
      if (analysis.requiredFiles.length)
        throw new ProjectEvidenceError("PROJECT_MAP_CONTEXT_INCOMPLETE", false);
      const ref = analysis.contexts[0]?.ref ?? "";
      if (options?.linked?.length) {
        if (!parent || analysis.contexts.length !== 1) return invalidParent();
        for (const path of options.linked) linked.add(path);
        this.observe?.({
          operation: "LINK",
          phase: "FINISHED",
          contextRef: ref,
          inputFiles: options.linked.length,
        });
      }
      if (options?.state !== undefined) states.set(ref, options.state);
      analysis.objects = analysis.objects.filter((object) => {
        const previous = objectRoles.get(object.id);
        const primary = object.contextRole !== "DEPENDENCY";
        if (previous !== undefined && (previous || !primary)) return false;
        objectRoles.set(object.id, primary);
        return true;
      });
      relationCount += analysis.relations.length;
      this.observe?.({
        operation: "BUILD",
        phase: "STAGED",
        contextRef: analysis.contexts[0]?.ref ?? "",
        inputFiles: analysis.contexts[0]?.inputFiles.length ?? 0,
        objects: objectRoles.size,
        relations: relationCount,
      });
      for (const file of analysis.parsedFiles) parsed.add(file);
      const staged = factPaths(analysis);
      for (const path of staged) stagedPaths.add(path);
      for (const context of analysis.contexts) {
        for (const file of context.configurationFiles) configurationInputs.add(file);
        if (!replayed.has(context.ref))
          for (const file of options?.linked?.length ? staged : contextFiles(context))
            analyzedFiles.add(file);
      }
      for (const gap of analysis.gaps) result.gaps.push(gap);
      const requestDigest = requests.get(ref);
      const state = states.get(ref);
      consume(analysis, {
        ...(requestDigest ? { requestDigest } : {}),
        ...(state !== undefined ? { state } : {}),
        paths: replayed.get(ref) ?? [...new Set([...staged, ...(options?.linked ?? [])])].sort(),
      });
    };
    for (const language of running) {
      const own = readableBy(language);
      const texts: Record<string, string> = Object.create(null);
      for (const entry of own) texts[entry.path] = unitTexts[entry.path] as string;
      await language.analyze(
        {
          entries,
          readable: own,
          texts,
          read,
          accept,
          reuse,
          previous,
          configuration: (path) => configurationInputs.add(path),
          observe: this.observe,
        },
        signal,
      );
    }

    const contextRef = digestValue({ analyzer: this.id, purpose: "FILE_INVENTORY" });
    const files = emptyAnalysis();
    files.contexts.push({
      ref: contextRef,
      mode: "SYNTAX_ONLY",
      optionsDigest: digestValue({ purpose: "FILE_INVENTORY" }),
      inputFiles: [],
      configurationFiles: [],
    });
    for (const entry of entries) {
      if (parsed.has(entry.path)) continue;
      if (entry.state === "TEXT")
        files.objects.push({
          id: digestValue({ contextRef, path: entry.path }),
          contextRef,
          kind: /(?:^|\/)package\.json$/u.test(entry.path)
            ? "PACKAGE"
            : configurationInputs.has(entry.path)
              ? "CONFIG"
              : "FILE",
          name: entry.path,
          exported: false,
          anchor: { path: entry.path, startLine: 1, endLine: 1, start: 0, end: 0 },
          language: entry.path.split(".").at(-1) ?? "unknown",
          parsing: configurationInputs.has(entry.path)
            ? "CONFIGURATION_INPUT"
            : this.claims(entry.path)
              ? "NOT_PARSED"
              : "NOT_ANALYZED",
        });
      if (configurationInputs.has(entry.path) && entry.state === "TEXT") continue;
      result.gaps.push({
        code:
          entry.state !== "TEXT"
            ? entry.state
            : this.claims(entry.path)
              ? "NOT_IN_PARSED_CONTEXT"
              : "LANGUAGE_NOT_ANALYZED",
        path: entry.path,
      });
    }
    if (files.objects.length) accept(files);

    if (parent && (replayed.size || linked.size)) {
      for (const ref of replayed.keys())
        for (const path of contextFiles(parent.contexts.get(ref)?.context ?? invalidParent()))
          if (
            analyzedFiles.has(path) ||
            [...(sharing.get(path) ?? [])].some((other) => !replayed.has(other))
          )
            throw new MapReplayConflict();
      for (const paths of replayed.values()) for (const path of paths) linked.add(path);
      for (const path of linked)
        if (analyzedFiles.has(path) || stagedPaths.has(path)) throw new MapReplayConflict();
      parent.link([...linked]);
    }
    result.parsedFiles = [...parsed].sort();
    return result;
  }
}

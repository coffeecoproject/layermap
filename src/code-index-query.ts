import {
  assertProjectEvidencePathNotSensitive,
  isProjectEvidenceTraversalExcluded,
  PROJECT_EVIDENCE_POLICY_DESCRIPTOR,
  ProjectEvidencePolicyError,
} from "./capture-policy";
import type { CodeIndexStore } from "./code-index-store";
import type { CodeIndexSource, CodeIndexVersion } from "./code-index-types";
import {
  normalizeProjectEvidencePath,
  ProjectEvidenceError,
  type ProjectEvidenceRevisionFileEntryV1,
  type ProjectEvidenceRevisionPathStatusV1,
} from "./core";
import { decodeQueryCursor, encodeQueryCursor } from "./cursor";
import { digestValue } from "./digest";
import { ProjectMapQuery } from "./project-map-query";
import { ProjectMapReadSession } from "./project-map-read-session";
import { type MapExploreInput, MapObjectSchema, type MapSearchInput } from "./project-map-types";
import type { MapViewInput } from "./project-map-view";

type CodeSearchInput = {
  version: string;
  source: CodeIndexSource;
  path: string;
  query: string;
  maxResults: number;
  cursor?: string;
};
type CodeTextInput = {
  version: string;
  source: CodeIndexSource;
  path: string;
  entityRef?: string;
  startLine?: number;
  endLine?: number;
};

const pathMatches = (candidate: string, prefix: string): boolean =>
  prefix.length === 0 || candidate === prefix || candidate.startsWith(`${prefix}/`);

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export class CodeIndexQuery {
  private readonly cursorSecret: Buffer;
  private readonly map: ProjectMapQuery;

  constructor(
    private readonly store: CodeIndexStore,
    private readonly withRead: <T>(
      signal: AbortSignal,
      read: (signal: AbortSignal) => Promise<T>,
    ) => Promise<T>,
  ) {
    this.cursorSecret = store.cursorSecret();
    this.map = new ProjectMapQuery(store);
  }

  clear(): void {
    this.map.clear();
  }

  getVersion(version: string): CodeIndexVersion | undefined {
    return this.store.getVersion(version);
  }

  searchMap(input: MapSearchInput, signal: AbortSignal) {
    return this.map.search(input, signal);
  }

  exploreMap(input: MapExploreInput, signal: AbortSignal) {
    return this.withRead(signal, (readSignal) => this.map.explore(input, readSignal));
  }

  searchMapView(input: MapSearchInput, signal: AbortSignal) {
    return this.map.searchView(input, signal);
  }

  viewMap(input: MapViewInput, signal: AbortSignal) {
    return this.withRead(signal, async (readSignal) => this.map.view(input, readSignal));
  }

  async getPathStatus(
    input: { version: string; path: string },
    signal: AbortSignal,
  ): Promise<Readonly<{ pathStatus: ProjectEvidenceRevisionPathStatusV1 }>> {
    this.assertNotAborted(signal);
    this.requireVersion(input.version);
    const normalizedPath = normalizeProjectEvidencePath(input.path, true);
    const reportedPath = normalizedPath.length === 0 ? "." : normalizedPath;
    if (this.isContentPolicyRestricted(normalizedPath)) {
      return Object.freeze({
        pathStatus: Object.freeze({
          path: reportedPath,
          status: "CONTENT_POLICY_RESTRICTED" as const,
        }),
      });
    }

    const entry = normalizedPath ? this.store.getEntry(input.version, normalizedPath) : undefined;
    if (entry?.state === "TEXT") {
      if (!entry.contentDigest) {
        throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
      }
      this.assertNotAborted(signal);
      return Object.freeze({
        pathStatus: Object.freeze({
          path: entry.path,
          status: "TEXT_READABLE" as const,
          entryState: "TEXT" as const,
          byteLength: entry.byteLength,
          contentDigest: entry.contentDigest,
        }),
      });
    }
    if (entry) {
      this.assertNotAborted(signal);
      return Object.freeze({
        pathStatus: Object.freeze({
          path: entry.path,
          status: "KNOWN_NOT_READABLE" as const,
          entryState: entry.state,
          byteLength: entry.byteLength,
          ...(entry.contentDigest ? { contentDigest: entry.contentDigest } : {}),
        }),
      });
    }

    const isDirectory =
      normalizedPath.length === 0 ||
      this.store
        .listEntries(input.version)
        .some((candidate) => candidate.path.startsWith(`${normalizedPath}/`));
    this.assertNotAborted(signal);
    return Object.freeze({
      pathStatus: Object.freeze({
        path: reportedPath,
        status: isDirectory ? ("DIRECTORY" as const) : ("NOT_INCLUDED_IN_REVISION" as const),
      }),
    });
  }

  async listFiles(
    input: {
      version: string;
      path: string;
      depth: number;
      maxResults: number;
      cursor?: string;
    },
    signal: AbortSignal,
  ) {
    this.assertNotAborted(signal);
    const revision = this.requireVersion(input.version);
    if (
      !Number.isInteger(input.depth) ||
      input.depth < 1 ||
      input.depth > PROJECT_EVIDENCE_POLICY_DESCRIPTOR.maxDirectoryDepth ||
      !Number.isInteger(input.maxResults) ||
      input.maxResults < 1 ||
      input.maxResults > PROJECT_EVIDENCE_POLICY_DESCRIPTOR.maxDirectoryEntries
    ) {
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    }
    const base = normalizeProjectEvidencePath(input.path, true);
    const files = this.store.listEntries(input.version).map((entry) => entry.path);
    this.requireDirectory(base, files);
    const basePrefix = base ? `${base}/` : "";
    const candidates = new Map<string, "FILE" | "DIRECTORY">();
    for (const file of files) {
      if (basePrefix && !file.startsWith(basePrefix)) continue;
      const relativeToBase = basePrefix ? file.slice(basePrefix.length) : file;
      if (!relativeToBase) continue;
      const segments = relativeToBase.split("/");
      const visibleDepth = Math.min(input.depth, segments.length);
      for (let index = 0; index < visibleDepth; index += 1) {
        const entryPath = [base, ...segments.slice(0, index + 1)].filter(Boolean).join("/");
        const kind = index === segments.length - 1 ? "FILE" : "DIRECTORY";
        if (candidates.get(entryPath) !== "DIRECTORY") candidates.set(entryPath, kind);
      }
    }
    const ordered = [...candidates].sort(([left], [right]) => left.localeCompare(right));
    const scopeDigest = digestValue({
      operation: "LIST_FILES",
      version: revision.version,
      path: base,
      depth: input.depth,
    });
    const binding = `LIST_FILES\n${scopeDigest}`;
    // A cursor continues after the entries listed so far.
    let startIndex = 0;
    if (input.cursor !== undefined) {
      [startIndex = 0] = decodeQueryCursor(this.cursorSecret, binding, input.cursor, 1);
      if (startIndex < 1 || startIndex >= ordered.length)
        throw new ProjectEvidenceError("PROJECT_CONTINUATION_INVALID", false);
    }
    const entries = Object.freeze(
      ordered
        .slice(startIndex, startIndex + input.maxResults)
        .map(([entryPath, kind]) => Object.freeze({ path: entryPath, kind })),
    );
    const endIndex = startIndex + entries.length;
    const complete = endIndex >= ordered.length;
    const nextCursor = complete
      ? undefined
      : encodeQueryCursor(this.cursorSecret, binding, [endIndex]);
    this.assertNotAborted(signal);
    return Object.freeze({
      entries,
      coverage: Object.freeze({
        totalEntries: ordered.length,
        precedingEntries: startIndex,
        returnedEntries: entries.length,
        remainingEntries: ordered.length - endIndex,
        complete,
      }),
      ...(nextCursor ? { nextCursor } : {}),
      truncated: !complete,
    });
  }

  async searchExactText(input: CodeSearchInput, signal: AbortSignal) {
    return this.withRead(signal, (signal) => this.searchSource(input, signal));
  }

  private async searchSource(input: CodeSearchInput, signal: AbortSignal) {
    this.assertNotAborted(signal);
    const revision = this.requireVersion(input.version);
    const session = new ProjectMapReadSession(this.store, input.version, input.source, signal);
    if (
      input.query.length === 0 ||
      input.query.length > 256 ||
      !Number.isInteger(input.maxResults) ||
      input.maxResults < 1 ||
      input.maxResults > PROJECT_EVIDENCE_POLICY_DESCRIPTOR.maxSearchMatches
    ) {
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    }
    const base = normalizeProjectEvidencePath(input.path, true);
    const allEntries = this.store.listEntries(input.version);
    const entries = allEntries.filter((entry) => entry.state !== "TYPE_RESTRICTED");
    this.requireSearchScope(base, allEntries);
    const candidateFiles = entries.filter((entry) => pathMatches(entry.path, base));
    const scopeDigest = digestValue({
      operation: "SEARCH_TEXT",
      version: revision.version,
      path: base,
      query: input.query,
    });
    const binding = `SEARCH_TEXT\n${scopeDigest}`;
    // A cursor counts the files completed and skipped so far, and resumes in the next one after
    // a line and column (0 and 0 to start it from the beginning).
    const [precedingCompletedFiles = 0, precedingSkippedFiles = 0, afterLine = 0, afterColumn = 0] =
      input.cursor === undefined
        ? []
        : decodeQueryCursor(this.cursorSecret, binding, input.cursor, 4);
    const startIndex = precedingCompletedFiles + precedingSkippedFiles;
    if (
      input.cursor !== undefined &&
      (startIndex >= candidateFiles.length || (afterLine === 0) !== (afterColumn === 0))
    )
      throw new ProjectEvidenceError("PROJECT_CONTINUATION_INVALID", false);

    const matches: Array<{
      path: string;
      line: number;
      columnStart: number;
      columnEnd: number;
      excerptStartColumn: number;
      excerptEndColumn: number;
      text: string;
      contentDigest: string;
    }> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let skippedFiles = 0;
    let completedFiles = 0;
    let nextPosition: { line: number; column: number } | undefined;
    let stopped = false;
    for (
      let candidateIndex = startIndex;
      candidateIndex < candidateFiles.length;
      candidateIndex += 1
    ) {
      this.assertNotAborted(signal);
      const entry = candidateFiles[candidateIndex];
      if (!entry) break;
      if (scannedFiles >= PROJECT_EVIDENCE_POLICY_DESCRIPTOR.maxSearchFilesPerPage) {
        stopped = true;
        break;
      }
      if (entry.state !== "TEXT" || !entry.contentDigest) {
        scannedFiles += 1;
        skippedFiles += 1;
        nextPosition = { line: 0, column: 0 };
        await yieldToEventLoop();
        this.assertNotAborted(signal);
        continue;
      }
      scannedFiles += 1;
      const content = await session.read(entry);
      scannedBytes += content.byteLength;
      for (const [index, line] of content.toString("utf8").split("\n").entries()) {
        const lineNumber = index + 1;
        if (candidateIndex === startIndex && lineNumber < afterLine) continue;
        let searchFrom =
          candidateIndex === startIndex && lineNumber === afterLine ? afterColumn : 0;
        while (searchFrom <= line.length) {
          const matchIndex = line.indexOf(input.query, searchFrom);
          if (matchIndex < 0) break;
          const excerptRadius = 250;
          const excerptStart = Math.max(0, matchIndex - excerptRadius);
          const excerptEnd = Math.min(line.length, matchIndex + input.query.length + excerptRadius);
          const nextSearchFrom = matchIndex + input.query.length;
          matches.push({
            path: entry.path,
            line: lineNumber,
            columnStart: matchIndex + 1,
            columnEnd: nextSearchFrom,
            excerptStartColumn: excerptStart + 1,
            excerptEndColumn: excerptEnd,
            text: line.slice(excerptStart, excerptEnd),
            contentDigest: entry.contentDigest,
          });
          if (matches.length >= input.maxResults) {
            nextPosition = { line: lineNumber, column: nextSearchFrom };
            stopped = true;
            break;
          }
          searchFrom = nextSearchFrom;
        }
        if (stopped) break;
      }
      if (stopped) break;
      completedFiles += 1;
      nextPosition = { line: 0, column: 0 };
      await yieldToEventLoop();
      this.assertNotAborted(signal);
    }
    await yieldToEventLoop();
    await session.assertStable();
    this.assertNotAborted(signal);
    const cumulativeCompletedFiles = precedingCompletedFiles + completedFiles;
    const cumulativeSkippedFiles = precedingSkippedFiles + skippedFiles;
    const cumulativeAdvancedFiles = cumulativeCompletedFiles + cumulativeSkippedFiles;
    const exhausted = !stopped && cumulativeAdvancedFiles >= candidateFiles.length;
    const complete = exhausted && cumulativeSkippedFiles === 0;
    const nextCursor =
      !stopped || !nextPosition
        ? undefined
        : encodeQueryCursor(this.cursorSecret, binding, [
            cumulativeCompletedFiles,
            cumulativeSkippedFiles,
            nextPosition.line,
            nextPosition.column,
          ]);
    const currentFilePartiallyExamined = stopped && (nextPosition?.line ?? 1) !== 0 ? 1 : 0;
    return Object.freeze({
      matches: Object.freeze(matches.map((match) => Object.freeze(match))),
      coverage: Object.freeze({
        totalFiles: candidateFiles.length,
        examinedFiles: Math.min(
          candidateFiles.length,
          cumulativeAdvancedFiles + currentFilePartiallyExamined,
        ),
        completedFiles: cumulativeCompletedFiles,
        skippedFiles: cumulativeSkippedFiles,
        pageScannedFiles: scannedFiles,
        pageScannedBytes: scannedBytes,
        remainingFiles: Math.max(0, candidateFiles.length - cumulativeAdvancedFiles),
        complete,
      }),
      ...(nextCursor ? { nextCursor } : {}),
      truncated: !complete,
    });
  }

  async readText(input: CodeTextInput, signal: AbortSignal) {
    return this.withRead(signal, (signal) => this.readSourceText(input, signal));
  }

  private async readSourceText(input: CodeTextInput, signal: AbortSignal) {
    this.assertNotAborted(signal);
    this.requireVersion(input.version);
    const relativePath = normalizeProjectEvidencePath(input.path);
    const object =
      input.entityRef === undefined ? undefined : this.sourceObject(input, relativePath);
    // File-level anchors can be index placeholders; only declarations bound a source read.
    const declaration =
      object && !["FILE", "PACKAGE", "CONFIG"].includes(object.kind) ? object.anchor : undefined;
    const startLine = input.startLine ?? declaration?.startLine ?? 1;
    const requestedEnd = input.endLine ?? declaration?.endLine;
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      (requestedEnd !== undefined &&
        (!Number.isSafeInteger(requestedEnd) || requestedEnd < startLine))
    ) {
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    }
    if (
      declaration &&
      (startLine < declaration.startLine ||
        startLine > declaration.endLine ||
        (requestedEnd !== undefined && requestedEnd > declaration.endLine))
    )
      throw new ProjectEvidenceError("PROJECT_READ_RANGE_NOT_AVAILABLE", false);
    const entry = this.store.getEntry(input.version, relativePath);
    if (!entry) throw new ProjectEvidenceError("PROJECT_PATH_NOT_READABLE", false);
    const contentDigest = this.requireTextContentDigest(entry);
    const session = new ProjectMapReadSession(this.store, input.version, input.source, signal);
    const content = await session.read(entry);
    await session.assertStable();
    const lines = content.toString("utf8").split("\n");
    if (startLine > lines.length) {
      throw new ProjectEvidenceError("PROJECT_READ_RANGE_NOT_AVAILABLE", false);
    }
    const endLine = Math.min(requestedEnd ?? lines.length, lines.length);
    const selected = lines.slice(startLine - 1, endLine);
    this.assertNotAborted(signal);
    return Object.freeze({
      path: entry.path,
      range: Object.freeze({
        startLine,
        endLine: startLine + Math.max(0, selected.length - 1),
      }),
      text: selected.join("\n"),
      contentDigest,
      sourceHasMore: endLine < Math.min(declaration?.endLine ?? lines.length, lines.length),
      ...(object
        ? {
            symbol: Object.freeze({
              entityRef: object.id,
              name: object.name,
              startLine: declaration?.startLine ?? 1,
              endLine: declaration?.endLine ?? lines.length,
            }),
          }
        : {}),
    });
  }

  private sourceObject(input: CodeTextInput, relativePath: string) {
    if (!input.entityRef || input.entityRef.length > 128)
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    // Match the authorized path before returning any declaration metadata.
    const row = this.store.database
      .prepare(
        "SELECT object_json FROM project_map_objects WHERE version_ref = ? AND entity_ref = ? AND path = ?",
      )
      .get(input.version, input.entityRef, relativePath);
    if (!row) throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
    return MapObjectSchema.parse(JSON.parse(String(row.object_json)));
  }

  private requireTextContentDigest(entry: ProjectEvidenceRevisionFileEntryV1): string {
    if (entry.state === "TYPE_RESTRICTED") {
      throw new ProjectEvidenceError("PROJECT_FILE_TYPE_RESTRICTED", false);
    }
    if (entry.state === "TOO_LARGE") {
      throw new ProjectEvidenceError("PROJECT_FILE_NOT_ALLOWED", false);
    }
    if (entry.state === "NON_TEXT") {
      throw new ProjectEvidenceError("PROJECT_FILE_NOT_TEXT", false);
    }
    if (entry.state === "NOT_READABLE") {
      throw new ProjectEvidenceError("PROJECT_FILE_NOT_READABLE", false);
    }
    if (entry.state === "SYMLINK") {
      throw new ProjectEvidenceError("PROJECT_FILE_SYMLINK_NOT_ALLOWED", false);
    }
    if (entry.state === "UNSUPPORTED_ENTRY") {
      throw new ProjectEvidenceError("PROJECT_FILE_ENTRY_UNSUPPORTED", false);
    }
    if (!entry.contentDigest)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
    return entry.contentDigest;
  }

  private requireVersion(version: string): CodeIndexVersion {
    return this.store.requireVersion(version);
  }

  private requireDirectory(base: string, files: readonly string[]): void {
    if (base.length === 0) return;
    if (files.includes(base) || !files.some((candidate) => candidate.startsWith(`${base}/`))) {
      throw new ProjectEvidenceError("PROJECT_PATH_NOT_DIRECTORY", false);
    }
  }

  private requireSearchScope(
    base: string,
    entries: readonly ProjectEvidenceRevisionFileEntryV1[],
  ): void {
    if (base.length === 0) return;
    const file = entries.find((entry) => entry.path === base);
    if (file) {
      this.requireTextContentDigest(file);
      return;
    }
    if (!entries.some((entry) => entry.path.startsWith(`${base}/`))) {
      throw new ProjectEvidenceError("PROJECT_PATH_NOT_READABLE", false);
    }
  }

  private isContentPolicyRestricted(relativePath: string): boolean {
    if (relativePath.length === 0) return false;
    if (isProjectEvidenceTraversalExcluded(relativePath)) return true;
    try {
      assertProjectEvidencePathNotSensitive(relativePath);
      return false;
    } catch (error) {
      if (error instanceof ProjectEvidencePolicyError) return true;
      throw error;
    }
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
  }
}

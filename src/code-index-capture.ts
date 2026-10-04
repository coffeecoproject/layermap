import {
  assertProjectEvidencePathNotSensitive,
  isProjectEvidenceTraversalExcluded,
  PROJECT_EVIDENCE_POLICY_DESCRIPTOR,
} from "./capture-policy";
import { CodeCommitReader } from "./code-commit-reader";
import type {
  CodeIndexCaptureOptions,
  CodeIndexSource,
  CodeIndexVersion,
} from "./code-index-types";
import { StableProjectCaptureSession } from "./code-worktree-reader";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { digestValue } from "./digest";
import { ProjectEvidenceFileUniverse, ProjectEvidenceFileUniverseError } from "./file-universe";
import { GitCommandStopUnconfirmedError } from "./git-runner";
import { InitialEvidenceScopeSchema, includesInitialEvidencePath } from "./source-scope";

export type CodeIndexCaptureResult = Readonly<{
  version: CodeIndexVersion;
  entries: readonly ProjectEvidenceRevisionFileEntryV1[];
  universeDigest: string;
}>;

export class CodeIndexCapture {
  constructor(
    /** Identity of the analyzer suite that builds maps for captured versions. */
    private readonly analyzer: string,
  ) {}

  async capture(
    source: CodeIndexSource,
    signal: AbortSignal,
    options: CodeIndexCaptureOptions = {},
  ): Promise<CodeIndexCaptureResult> {
    source = { ...source, directory: { ...source.directory } };
    if (source.kind !== "WORKTREE" && source.kind !== "COMMIT")
      throw new ProjectEvidenceError("PROJECT_CODE_SOURCE_INVALID", false);
    if (!source.projectRef.trim())
      throw new ProjectEvidenceError("PROJECT_CODE_SOURCE_INVALID", false);
    const scope = options.initialScope
      ? InitialEvidenceScopeSchema.parse(options.initialScope)
      : undefined;
    const siblings = new AbortController();
    signal = AbortSignal.any([signal, siblings.signal]);
    const session = await StableProjectCaptureSession.open(
      source.directory.canonicalPath,
      source.directory.device,
      source.directory.inode,
      signal,
    );
    const universe = new ProjectEvidenceFileUniverse();
    const snapshot =
      source.kind === "WORKTREE"
        ? await this.readUniverse(universe, session.root, signal)
        : undefined;
    const commit =
      source.kind === "COMMIT"
        ? await CodeCommitReader.open(session.root, source.commit, signal)
        : undefined;
    const paths = (snapshot?.files ?? commit?.entries.map((entry) => entry.path) ?? []).filter(
      (relative) => {
        if (
          isProjectEvidenceTraversalExcluded(relative) ||
          (scope && !includesInitialEvidencePath(relative, scope))
        )
          return false;
        try {
          assertProjectEvidencePathNotSensitive(relative);
          return true;
        } catch {
          return false;
        }
      },
    );
    let next = 0;
    let processedFiles = 0;
    let capturedBytes = 0;
    let failure: unknown;
    let failed = false;
    const entries: ProjectEvidenceRevisionFileEntryV1[] = [];
    const progress = () =>
      options.onProgress?.({ processedFiles, totalFiles: paths.length, capturedBytes });
    progress();
    const worker = async () => {
      while (!failed && next < paths.length) {
        const relative = paths[next++];
        if (relative === undefined) break;
        try {
          if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
          const read = commit ? await commit.read(relative) : await session.captureFile(relative);
          capturedBytes += read.content?.byteLength ?? 0;
          entries.push(read.entry);
          processedFiles++;
          if (processedFiles % 16 === 0 || processedFiles === paths.length) progress();
        } catch (error) {
          if (!failed || error instanceof GitCommandStopUnconfirmedError) failure = error;
          failed = true;
          siblings.abort();
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(paths.length, PROJECT_EVIDENCE_POLICY_DESCRIPTOR.captureConcurrency) },
        worker,
      ),
    );
    if (failed) throw failure;
    await session.assertStable();
    if (snapshot) {
      try {
        await universe.assertCurrent(session.root, snapshot, signal);
      } catch (error) {
        this.universeFailure(error);
      }
    }
    await session.assertStable();
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const prefixes = [...new Set(scope?.pathPrefixes ?? ["."])].sort();
    const pathPrefixes = prefixes.filter(
      (prefix) =>
        !prefixes.some(
          (parent) => parent !== prefix && (parent === "." || prefix.startsWith(`${parent}/`)),
        ),
    );
    const textEntries = entries.filter((entry) => entry.state === "TEXT");
    return {
      version: {
        version: digestValue({
          projectRef: source.projectRef,
          pathPrefixes,
          entries,
          analyzer: this.analyzer,
        }),
        projectRef: source.projectRef,
        pathPrefixes,
        fileCount: entries.length,
        readableTextFileCount: textEntries.length,
        capturedBytes: textEntries.reduce((sum, entry) => sum + entry.byteLength, 0),
        analyzer: this.analyzer,
      },
      entries,
      universeDigest: digestValue(
        [...(snapshot?.files ?? commit?.entries.map((entry) => entry.path) ?? [])].sort(),
      ),
    };
  }

  private async readUniverse(
    universe: ProjectEvidenceFileUniverse,
    root: string,
    signal: AbortSignal,
  ) {
    try {
      return await universe.capture(root, signal);
    } catch (error) {
      return this.universeFailure(error);
    }
  }

  private universeFailure(error: unknown): never {
    if (error instanceof ProjectEvidenceFileUniverseError)
      throw new ProjectEvidenceError(error.code, true);
    throw error;
  }
}

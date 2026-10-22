import {
  assertProjectEvidencePathNotSensitive,
  isProjectEvidenceTraversalExcluded,
  PROJECT_EVIDENCE_POLICY_DESCRIPTOR,
} from "./capture-policy";
import { CodeCommitReader } from "./code-commit-reader";
import type { CodeIndexSource } from "./code-index-types";
import { StableProjectCaptureSession } from "./code-worktree-reader";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { ProjectEvidenceFileUniverse } from "./file-universe";

// A read session owns only open-source stability checks, never a persisted source copy.
export class ProjectMapSourceReader {
  private constructor(
    private readonly session: StableProjectCaptureSession,
    private readonly commit: CodeCommitReader | undefined,
    private readonly universe: ProjectEvidenceFileUniverse,
    private readonly snapshot:
      | Awaited<ReturnType<ProjectEvidenceFileUniverse["capture"]>>
      | undefined,
    private readonly signal: AbortSignal,
  ) {}

  static async open(
    source: CodeIndexSource,
    signal: AbortSignal,
    enumerate = true,
    selectedPath?: string,
  ) {
    source = Object.freeze({ ...source, directory: Object.freeze({ ...source.directory }) });
    if (!source.projectRef.trim() || (source.kind !== "WORKTREE" && source.kind !== "COMMIT"))
      throw new ProjectEvidenceError("PROJECT_CODE_SOURCE_INVALID", false);
    const session = await StableProjectCaptureSession.open(
      source.directory.canonicalPath,
      source.directory.device,
      source.directory.inode,
      signal,
    );
    const universe = new ProjectEvidenceFileUniverse();
    const commit =
      source.kind === "COMMIT"
        ? await CodeCommitReader.open(session.root, source.commit, signal, selectedPath)
        : undefined;
    const snapshot =
      source.kind === "WORKTREE" && enumerate
        ? await universe.capture(session.root, signal)
        : undefined;
    return new ProjectMapSourceReader(session, commit, universe, snapshot, signal);
  }

  paths() {
    return this.snapshot?.files ?? this.commit?.entries.map((entry) => entry.path) ?? [];
  }

  /** Reads a file and checks it still has the content captured. */
  async read(expected: ProjectEvidenceRevisionFileEntryV1) {
    return (await this.readAll([expected]))[0] as SourceRead;
  }

  /**
   * Reads files in their order and checks each still has the content captured: a commit's many
   * blobs to a Git process, a directory's files several at a time.
   */
  async readAll(expected: readonly ProjectEvidenceRevisionFileEntryV1[]): Promise<SourceRead[]> {
    if (this.signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    const paths = expected.map(({ path }) => {
      assertProjectEvidencePathNotSensitive(path);
      if (isProjectEvidenceTraversalExcluded(path))
        throw new ProjectEvidenceError("PROJECT_FILE_NOT_ALLOWED", false);
      return path;
    });
    const results = this.commit
      ? await this.commit.readAll(paths)
      : await concurrently(paths, (path) => this.session.captureFile(path));
    for (const [index, { entry }] of results.entries()) {
      const wanted = expected[index];
      if (
        entry.state !== wanted?.state ||
        entry.contentDigest !== wanted.contentDigest ||
        entry.byteLength !== wanted.byteLength
      )
        throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
    }
    return results;
  }

  async assertStable() {
    await this.session.assertStable();
    if (this.snapshot)
      await this.universe.assertCurrent(this.session.root, this.snapshot, this.signal);
    await this.session.assertStable();
  }
}

type SourceRead = Readonly<{ entry: ProjectEvidenceRevisionFileEntryV1; content?: Buffer }>;

/**
 * Reads items with the capture's concurrency and returns the results in item order. The first
 * failure stops further reads and is thrown.
 */
async function concurrently<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, PROJECT_EVIDENCE_POLICY_DESCRIPTOR.captureConcurrency) },
      async () => {
        while (!failed && next < items.length) {
          const index = next++;
          try {
            results[index] = await read(items[index] as T);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      },
    ),
  );
  return results;
}

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

  async read(relative: string, expected?: ProjectEvidenceRevisionFileEntryV1) {
    if (this.signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    assertProjectEvidencePathNotSensitive(relative);
    if (isProjectEvidenceTraversalExcluded(relative))
      throw new ProjectEvidenceError("PROJECT_FILE_NOT_ALLOWED", false);
    const result = this.commit
      ? await this.commit.read(relative)
      : await this.session.captureFile(relative);
    if (
      expected &&
      (result.entry.state !== expected.state ||
        result.entry.contentDigest !== expected.contentDigest ||
        result.entry.byteLength !== expected.byteLength)
    ) {
      throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
    }
    return result;
  }

  async assertStable() {
    await this.session.assertStable();
    if (this.snapshot)
      await this.universe.assertCurrent(this.session.root, this.snapshot, this.signal);
    await this.session.assertStable();
  }
}

/**
 * Reads items with the capture's concurrency and returns the results in item order. The first
 * failure stops further reads and is thrown.
 */
export async function readAll<T, R>(
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

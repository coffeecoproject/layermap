import { lstat } from "node:fs/promises";
import path from "node:path";
import { GitCommandStopUnconfirmedError, GitRunner } from "./git-runner";

const FILE_UNIVERSE_ARGS = Object.freeze([
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
  "--deduplicate",
  "--",
  ".",
]);

export const PROJECT_EVIDENCE_FILE_UNIVERSE_POLICY = Object.freeze({
  kind: "GIT_TRACKED_AND_UNIGNORED_UNTRACKED",
  deletedPaths: "EXCLUDED",
  stability: "MATCHING_START_AND_END_CAPTURE",
});

export type ProjectEvidenceFileUniverseSnapshot = Readonly<{
  files: readonly string[];
}>;

export class ProjectEvidenceFileUniverseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectEvidenceFileUniverseError";
  }
}

const parseFileUniverse = (output: Buffer): readonly string[] => {
  const files = new Set<string>();
  const records = output.toString("utf8").split("\0");
  for (const record of records) {
    if (record.length === 0) continue;
    const normalized = path.posix.normalize(record);
    if (
      normalized !== record ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      normalized.includes("\\")
    ) {
      throw new ProjectEvidenceFileUniverseError("PROJECT_FILE_UNIVERSE_INVALID");
    }
    files.add(normalized);
  }
  return Object.freeze(
    [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
};

export class ProjectEvidenceFileUniverse {
  constructor(private readonly git = new GitRunner()) {}

  async capture(root: string, signal: AbortSignal): Promise<ProjectEvidenceFileUniverseSnapshot> {
    return this.readSnapshot(root, signal);
  }

  async assertCurrent(
    root: string,
    expected: ProjectEvidenceFileUniverseSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.readSnapshot(root, signal);
    if (
      current.files.length !== expected.files.length ||
      current.files.some((file, index) => file !== expected.files[index])
    ) {
      throw new ProjectEvidenceFileUniverseError("PROJECT_FILE_UNIVERSE_CHANGED");
    }
  }

  private async readSnapshot(
    root: string,
    signal: AbortSignal,
  ): Promise<ProjectEvidenceFileUniverseSnapshot> {
    if (signal.aborted) {
      throw new ProjectEvidenceFileUniverseError("PROJECT_READ_CANCELLED");
    }
    let listed: Buffer;
    try {
      listed = (
        await this.git.run(FILE_UNIVERSE_ARGS, {
          cwd: root,
          maxOutputBytes: null,
          signal,
          timeoutMs: null,
        })
      ).stdout;
    } catch (error) {
      if (error instanceof GitCommandStopUnconfirmedError) throw error;
      if (signal.aborted) {
        throw new ProjectEvidenceFileUniverseError("PROJECT_READ_CANCELLED");
      }
      throw new ProjectEvidenceFileUniverseError("PROJECT_FILE_UNIVERSE_UNAVAILABLE");
    }
    // Git lists a file it tracks that is not on disk: deleted, or left out of a sparse checkout.
    const candidates = parseFileUniverse(listed);
    const present = await Promise.all(
      candidates.map((file) =>
        lstat(path.join(root, ...file.split("/"))).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
            throw new ProjectEvidenceFileUniverseError("PROJECT_FILE_UNIVERSE_UNAVAILABLE");
          },
        ),
      ),
    );
    if (signal.aborted) {
      throw new ProjectEvidenceFileUniverseError("PROJECT_READ_CANCELLED");
    }
    return Object.freeze({
      files: Object.freeze(candidates.filter((_, index) => present[index])),
    });
  }
}

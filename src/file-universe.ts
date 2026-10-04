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
const DELETED_FILE_ARGS = Object.freeze(["ls-files", "-z", "--deleted", "--", "."]);

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
    let captured: { included: Buffer; deleted: Buffer };
    try {
      const stop = new AbortController();
      const combined = AbortSignal.any([signal, stop.signal]);
      let failed = false;
      let firstFailure: unknown;
      const results = await Promise.allSettled(
        [
          this.git.run(FILE_UNIVERSE_ARGS, {
            cwd: root,
            maxOutputBytes: null,
            signal: combined,
            timeoutMs: null,
          }),
          this.git.run(DELETED_FILE_ARGS, {
            cwd: root,
            maxOutputBytes: null,
            signal: combined,
            timeoutMs: null,
          }),
        ].map((work) =>
          work.catch((error: unknown) => {
            if (!failed) {
              failed = true;
              firstFailure = error;
            }
            stop.abort();
            throw error;
          }),
        ),
      );
      const unconfirmed = results.find(
        (result) =>
          result.status === "rejected" && result.reason instanceof GitCommandStopUnconfirmedError,
      );
      if (unconfirmed?.status === "rejected") throw unconfirmed.reason;
      if (failed) throw firstFailure;
      const [includedResult, deletedResult] = results;
      if (includedResult?.status !== "fulfilled") {
        throw includedResult?.status === "rejected"
          ? includedResult.reason
          : new Error("Missing file universe result.");
      }
      if (deletedResult?.status !== "fulfilled") {
        throw deletedResult?.status === "rejected"
          ? deletedResult.reason
          : new Error("Missing deleted-file result.");
      }
      const included = includedResult.value;
      const deleted = deletedResult.value;
      captured = { included: included.stdout, deleted: deleted.stdout };
    } catch (error) {
      if (error instanceof GitCommandStopUnconfirmedError) throw error;
      if (signal.aborted) {
        throw new ProjectEvidenceFileUniverseError("PROJECT_READ_CANCELLED");
      }
      throw new ProjectEvidenceFileUniverseError("PROJECT_FILE_UNIVERSE_UNAVAILABLE");
    }
    if (signal.aborted) {
      throw new ProjectEvidenceFileUniverseError("PROJECT_READ_CANCELLED");
    }
    const deleted = new Set(parseFileUniverse(captured.deleted));
    const files = Object.freeze(
      parseFileUniverse(captured.included).filter((candidate) => !deleted.has(candidate)),
    );
    return Object.freeze({ files });
  }
}

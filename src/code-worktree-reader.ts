import { type BigIntStats, constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isProjectEvidenceTextPath } from "./capture-policy";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { digestValue } from "./digest";

type CapturedEntry = Readonly<{
  entry: ProjectEvidenceRevisionFileEntryV1;
  content?: Buffer;
}>;

const fileSystemErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const isInsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
};

const stablePathFingerprint = (stats: BigIntStats): string =>
  [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.uid,
    stats.gid,
    stats.rdev,
    stats.size,
    stats.blksize,
    stats.blocks,
    stats.mtimeNs,
    stats.ctimeNs,
  ]
    .map(String)
    .join(":");

export class StableProjectCaptureSession {
  private readonly pathFingerprints = new Map<string, string>();

  private constructor(
    readonly root: string,
    private readonly rootDevice: string,
    private readonly rootInode: string,
    private readonly signal: AbortSignal,
  ) {}

  static async open(
    root: string,
    rootDevice: string,
    rootInode: string,
    signal: AbortSignal,
  ): Promise<StableProjectCaptureSession> {
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    const resolvedRoot = await realpath(root).catch(() => {
      throw new ProjectEvidenceError("PROJECT_READ_SOURCE_CHANGED", true);
    });
    if (resolvedRoot !== root) throw new ProjectEvidenceError("PROJECT_READ_SOURCE_CHANGED", true);
    const session = new StableProjectCaptureSession(resolvedRoot, rootDevice, rootInode, signal);
    const stats = await session.inspectPath(resolvedRoot);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.dev.toString() !== rootDevice ||
      stats.ino.toString() !== rootInode
    ) {
      throw new ProjectEvidenceError("PROJECT_READ_SOURCE_CHANGED", true);
    }
    return session;
  }

  async captureFile(relativePath: string): Promise<CapturedEntry> {
    this.assertNotAborted();
    const absolutePath = path.join(this.root, ...relativePath.split("/"));
    const stats = await this.inspectPath(absolutePath, true);
    const fingerprint = stablePathFingerprint(stats);
    const byteLength = stats.isDirectory() ? 0 : Number(stats.size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new ProjectEvidenceError("PROJECT_FILE_NOT_ALLOWED", false);
    }
    if (!isProjectEvidenceTextPath(relativePath)) {
      return Object.freeze({
        entry: Object.freeze({
          path: relativePath,
          state: "TYPE_RESTRICTED",
          byteLength,
        }),
      });
    }
    if (stats.isSymbolicLink()) {
      return Object.freeze({
        entry: Object.freeze({
          path: relativePath,
          state: "SYMLINK",
          byteLength,
        }),
      });
    }
    if (!stats.isFile()) {
      return Object.freeze({
        entry: Object.freeze({
          path: relativePath,
          state: "UNSUPPORTED_ENTRY",
          byteLength,
        }),
      });
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      await this.inspectPath(absolutePath);
      const code = fileSystemErrorCode(error);
      if (code === "EACCES" || code === "EPERM") {
        return Object.freeze({
          entry: Object.freeze({
            path: relativePath,
            state: "NOT_READABLE",
            byteLength,
          }),
        });
      }
      throw new ProjectEvidenceError("PROJECT_FILE_READ_FAILED", true);
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || stablePathFingerprint(opened) !== fingerprint) {
        throw new ProjectEvidenceError("PROJECT_FILE_CHANGED", true);
      }
      const bytes = Buffer.alloc(Number(opened.size));
      let bytesRead = 0;
      while (bytesRead < bytes.byteLength) {
        this.assertNotAborted();
        const read = await handle.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      this.assertNotAborted();
      const after = await handle.stat({ bigint: true });
      if (bytesRead !== bytes.byteLength || stablePathFingerprint(after) !== fingerprint) {
        throw new ProjectEvidenceError("PROJECT_FILE_CHANGED", true);
      }
      await this.inspectPath(absolutePath);
      const contentDigest = digestValue({ bytesBase64: bytes.toString("base64") });
      if (bytes.includes(0)) {
        return Object.freeze({
          entry: Object.freeze({
            path: relativePath,
            state: "NON_TEXT",
            byteLength,
            contentDigest,
          }),
          content: bytes,
        });
      }
      const text = bytes.toString("utf8");
      if (Buffer.from(text, "utf8").compare(bytes) !== 0) {
        return Object.freeze({
          entry: Object.freeze({
            path: relativePath,
            state: "NON_TEXT",
            byteLength,
            contentDigest,
          }),
          content: bytes,
        });
      }
      return Object.freeze({
        entry: Object.freeze({
          path: relativePath,
          state: "TEXT",
          byteLength,
          contentDigest,
        }),
        content: bytes,
      });
    } finally {
      await handle.close();
    }
  }

  async assertStable(): Promise<void> {
    for (const [absolutePath, expected] of this.pathFingerprints) {
      this.assertNotAborted();
      const current = await lstat(absolutePath, { bigint: true }).catch(() => {
        throw new ProjectEvidenceError(this.changeCode(absolutePath), true);
      });
      if (stablePathFingerprint(current) !== expected) {
        throw new ProjectEvidenceError(this.changeCode(absolutePath, current), true);
      }
    }
  }

  private async inspectPath(absolutePath: string, allowFinalSymlink = false): Promise<BigIntStats> {
    if (!isInsideRoot(this.root, absolutePath)) {
      throw new ProjectEvidenceError("PROJECT_PATH_OUTSIDE_ROOT", false);
    }
    const relative = path.relative(this.root, absolutePath);
    const components = relative === "" ? [] : relative.split(path.sep);
    const paths = [
      this.root,
      ...components.map((_, index) => path.join(this.root, ...components.slice(0, index + 1))),
    ];
    let finalStats: BigIntStats | undefined;
    for (const [index, currentPath] of paths.entries()) {
      this.assertNotAborted();
      const stats = await lstat(currentPath, { bigint: true }).catch(() => {
        throw new ProjectEvidenceError(this.changeCode(currentPath), true);
      });
      const isFinal = index === paths.length - 1;
      if (stats.isSymbolicLink() && !(isFinal && allowFinalSymlink)) {
        throw new ProjectEvidenceError("PROJECT_FILE_CHANGED", true);
      }
      if (!isFinal && !stats.isDirectory()) {
        throw new ProjectEvidenceError("PROJECT_FILE_CHANGED", true);
      }
      this.remember(currentPath, stats);
      if (isFinal) finalStats = stats;
    }
    if (!finalStats) throw new ProjectEvidenceError("PROJECT_FILE_CHANGED", true);
    return finalStats;
  }

  private remember(absolutePath: string, stats: BigIntStats): void {
    const fingerprint = stablePathFingerprint(stats);
    const existing = this.pathFingerprints.get(absolutePath);
    if (existing !== undefined && existing !== fingerprint) {
      throw new ProjectEvidenceError(this.changeCode(absolutePath, stats), true);
    }
    this.pathFingerprints.set(absolutePath, fingerprint);
  }

  private assertNotAborted(): void {
    if (this.signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
  }

  private changeCode(absolutePath: string, current?: BigIntStats): string {
    if (
      absolutePath === this.root &&
      (!current?.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev.toString() !== this.rootDevice ||
        current.ino.toString() !== this.rootInode)
    ) {
      return "PROJECT_READ_SOURCE_CHANGED";
    }
    return "PROJECT_FILE_CHANGED";
  }
}

import { createHash } from "node:crypto";
import { isProjectEvidenceTextPath } from "./capture-policy";
import {
  normalizeProjectEvidencePath,
  ProjectEvidenceError,
  type ProjectEvidenceRevisionFileEntryV1,
} from "./core";
import { digestValue } from "./digest";
import { GitRunner } from "./git-runner";

type GitEntry = Readonly<{ path: string; mode: string; object: string; bytes: number }>;
type CommitRead = Readonly<{ entry: ProjectEvidenceRevisionFileEntryV1; content?: Buffer }>;

/** Blobs one Git process reads: enough to keep processes few, few enough to bound what it holds. */
const BATCH_BYTES = 16 * 1024 * 1024;
const BATCH_BLOBS = 4096;

export class CodeCommitReader {
  private readonly byPath: ReadonlyMap<string, GitEntry>;

  private constructor(
    private readonly root: string,
    readonly entries: readonly GitEntry[],
    private readonly git: GitRunner,
    private readonly signal: AbortSignal,
  ) {
    this.byPath = new Map(entries.map((entry) => [entry.path, entry]));
  }

  static async open(
    root: string,
    commit: string,
    signal: AbortSignal,
    selectedPath?: string,
  ): Promise<CodeCommitReader> {
    if (selectedPath !== undefined && normalizeProjectEvidencePath(selectedPath) !== selectedPath)
      throw new ProjectEvidenceError("PROJECT_CODE_TREE_INVALID", false);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
      throw new ProjectEvidenceError("PROJECT_CODE_COMMIT_INVALID", false);
    }
    const git = new GitRunner();
    const options = { cwd: root, signal, timeoutMs: null, maxOutputBytes: null };
    const resolved = (
      await git.run(
        ["--no-replace-objects", "rev-parse", "--verify", `${commit}^{commit}`],
        options,
      )
    ).stdout
      .toString("utf8")
      .trim();
    if (resolved !== commit) throw new ProjectEvidenceError("PROJECT_CODE_COMMIT_INVALID", false);
    const tree = (
      await git.run(
        [
          "--no-replace-objects",
          "--literal-pathspecs",
          "ls-tree",
          "-r",
          "-l",
          "-z",
          "--full-tree",
          commit,
          ...(selectedPath ? ["--", selectedPath] : []),
        ],
        options,
      )
    ).stdout;
    if (!Buffer.from(tree.toString("utf8"), "utf8").equals(tree))
      throw new ProjectEvidenceError("PROJECT_CODE_TREE_INVALID", false);
    const entries: GitEntry[] = [];
    for (const record of tree.toString("utf8").split("\0")) {
      if (!record) continue;
      const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]+) +(-|[0-9]+)\t([\s\S]+)$/u.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !match[4])
        throw new ProjectEvidenceError("PROJECT_CODE_TREE_INVALID", false);
      const relative = normalizeProjectEvidencePath(match[4]);
      if (relative !== match[4]) throw new ProjectEvidenceError("PROJECT_CODE_TREE_INVALID", false);
      const bytes = match[3] === "-" ? 0 : Number(match[3]);
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new ProjectEvidenceError("PROJECT_CODE_TREE_INVALID", false);
      entries.push({ path: relative, mode: match[1], object: match[2], bytes });
    }
    if (selectedPath !== undefined && (entries.length !== 1 || entries[0]?.path !== selectedPath))
      throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
    return new CodeCommitReader(root, entries, git, signal);
  }

  /**
   * Reads the files at the given paths in their order, many blobs to a Git process: one process
   * per blob made capturing a commit take seconds per thousand files.
   */
  async readAll(paths: readonly string[]): Promise<CommitRead[]> {
    const reads: CommitRead[] = [];
    let batch: { index: number; source: GitEntry }[] = [];
    let bytes = 0;
    const flush = async () => {
      const contents = await this.blobs(batch.map(({ source }) => source.object));
      for (const [position, { index, source }] of batch.entries())
        reads[index] = this.blobRead(source, contents[position] as Buffer);
      batch = [];
      bytes = 0;
    };
    for (const [index, relativePath] of paths.entries()) {
      const source = this.byPath.get(relativePath);
      if (!source) throw new ProjectEvidenceError("PROJECT_CODE_TREE_INVALID", false);
      const base = { path: relativePath, byteLength: source.bytes };
      if (!isProjectEvidenceTextPath(relativePath))
        reads[index] = { entry: { ...base, state: "TYPE_RESTRICTED" } };
      else if (source.mode === "120000") reads[index] = { entry: { ...base, state: "SYMLINK" } };
      else if (source.mode !== "100644" && source.mode !== "100755")
        reads[index] = { entry: { ...base, state: "UNSUPPORTED_ENTRY" } };
      else {
        if (batch.length && (bytes + source.bytes > BATCH_BYTES || batch.length === BATCH_BLOBS))
          await flush();
        batch.push({ index, source });
        bytes += source.bytes;
      }
    }
    if (batch.length) await flush();
    return reads;
  }

  // Git prints each blob as "<object> blob <size>", a newline, its bytes and a newline.
  private async blobs(objects: readonly string[]): Promise<Buffer[]> {
    const output = (
      await this.git.run(["--no-replace-objects", "cat-file", "--batch"], {
        cwd: this.root,
        input: Buffer.from(objects.map((object) => `${object}\n`).join("")),
        signal: this.signal,
        timeoutMs: null,
        maxOutputBytes: null,
      })
    ).stdout;
    const contents: Buffer[] = [];
    let offset = 0;
    for (const object of objects) {
      const end = output.indexOf(0x0a, offset);
      const header = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(output.toString("utf8", offset, end));
      const start = end + 1;
      const size = Number(header?.[2]);
      if (end < 0 || header?.[1] !== object || output[start + size] !== 0x0a)
        throw new ProjectEvidenceError("PROJECT_CODE_BLOB_INVALID", false);
      contents.push(output.subarray(start, start + size));
      offset = start + size + 1;
    }
    if (offset !== output.length)
      throw new ProjectEvidenceError("PROJECT_CODE_BLOB_INVALID", false);
    return contents;
  }

  private blobRead(source: GitEntry, content: Buffer): CommitRead {
    const objectHash = createHash(source.object.length === 64 ? "sha256" : "sha1")
      .update(`blob ${content.byteLength}\0`)
      .update(content)
      .digest("hex");
    if (content.byteLength !== source.bytes || objectHash !== source.object)
      throw new ProjectEvidenceError("PROJECT_CODE_BLOB_INVALID", false);
    const contentDigest = digestValue({ bytesBase64: content.toString("base64") });
    let text = !content.includes(0);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      text = false;
    }
    return {
      entry: {
        path: source.path,
        byteLength: source.bytes,
        state: text ? "TEXT" : "NON_TEXT",
        contentDigest,
      },
      content,
    };
  }
}

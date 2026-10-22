// What a coding agent's session changed in code, and when to ask the agent to check it: the rules
// the Claude Code plugin's hooks and the Pi extension share. A session's changes are the code files
// its edit tools wrote and those its shell commands changed among the files they name, each noted
// as the tool call ends; a command that writes code without naming the file, such as a generator
// or formatter, is not seen. Another session working in the same tree changes files outside this
// one's tool calls, so its changes are not this one's.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_STOP_CHECK, AGENT_STOP_CHECK_REPOSITORIES, projectHeading } from "./notes";

// The code files LayerMap maps.
const CODE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "py", "java"];
const CODE_FILE = new RegExp(`\\.(?:${CODE_EXTENSIONS.join("|")})$`, "u");
const CODE_GLOBS = CODE_EXTENSIONS.map((extension) => `*.${extension}`);

/** A session's code edit or check, in the order its tool calls ended. */
export type SessionChange =
  | Readonly<{ kind: "edit"; repository: string; file: string }>
  | Readonly<{ kind: "check"; repository: string }>;

/** The content of each file as a hash, "" for one that does not exist, by path. */
export type FileStates = Record<string, string>;

const git = (cwd: string, args: readonly string[]) =>
  new Promise<string>((resolve) =>
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout),
    ),
  );

// Git in a repository with no program its own config names: no fsmonitor, and no filter its
// attributes would put a changed file's content through.
async function repositoryGit(repository: string, args: readonly string[]) {
  const drivers = new Set(
    (await git(repository, ["config", "--name-only", "--get-regexp", "^filter\\."]))
      .split("\n")
      .flatMap((key) => /^filter\.(.+)\.[^.]+$/su.exec(key)?.[1] ?? []),
  );
  const blank = [...drivers].flatMap((driver) =>
    ["clean=", "process=", "required=false"].flatMap((setting) => [
      "-c",
      `filter.${driver}.${setting}`,
    ]),
  );
  return git(repository, [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    ...blank,
    ...args,
  ]);
}

const isDirectory = async (given: string) =>
  Boolean((await stat(given).catch(() => undefined))?.isDirectory());

// The path, or the nearest directory of it that exists.
async function existingDirectory(given: string): Promise<string | undefined> {
  let directory = given;
  while (!(await isDirectory(directory))) {
    if (path.dirname(directory) === directory) return undefined;
    directory = path.dirname(directory);
  }
  return directory;
}

/** The Git repository around a path, or the nearest directory of it that exists; "" outside one. */
export async function repositoryAt(given: string): Promise<string> {
  const directory = await existingDirectory(given);
  return directory ? (await git(directory, ["rev-parse", "--show-toplevel"])).trim() : "";
}

/**
 * The edits of the code files among the paths: each file's repository, as Git names its root, and
 * its path there. Paths outside any repository are none.
 */
export async function codeEdits(files: Iterable<string>): Promise<SessionChange[]> {
  const located = new Map<string, Promise<{ repository: string; prefix: string } | undefined>>();
  const locate = async (directory: string) => {
    const [repository, prefix = ""] = (
      await git(directory, ["rev-parse", "--show-toplevel", "--show-prefix"])
    ).split("\n");
    return repository ? { repository, prefix } : undefined;
  };
  const edits: SessionChange[] = [];
  for (const file of new Set(files)) {
    if (!CODE_FILE.test(file)) continue;
    const directory = await existingDirectory(path.dirname(file));
    if (!directory) continue;
    if (!located.has(directory)) located.set(directory, locate(directory));
    const where = await located.get(directory);
    if (!where) continue;
    const rest = path.relative(directory, file).split(path.sep).join("/");
    edits.push({ kind: "edit", repository: where.repository, file: `${where.prefix}${rest}` });
  }
  return edits;
}

/**
 * The paths a shell command names that may be code files: each word of it with a code file's
 * extension, resolved from the directory the command runs in and from each directory the command
 * names (as `cd b && sed … a.ts` does), where its directory exists.
 */
export async function commandFiles(cwd: string, command: string): Promise<string[]> {
  const words = [
    ...new Set(
      command
        .split(/[^A-Za-z0-9._/\\~:@+,%-]+/u)
        .map((word) => word.replace(/[,:]+$/u, ""))
        .filter(Boolean),
    ),
  ];
  const resolve = (base: string, word: string) =>
    word.startsWith("~/") ? path.join(os.homedir(), word.slice(2)) : path.resolve(base, word);
  const bases = [cwd];
  for (const word of words.filter((word) => !CODE_FILE.test(word)).slice(0, 300)) {
    if (bases.length > 20) break;
    const named = resolve(cwd, word);
    if (!bases.includes(named) && (await isDirectory(named))) bases.push(named);
  }
  const files = new Set<string>();
  for (const word of words.filter((word) => CODE_FILE.test(word)))
    for (const base of bases) {
      const file = resolve(base, word);
      if (files.size < 200 && (await isDirectory(path.dirname(file)))) files.add(file);
    }
  return [...files];
}

const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** Each file's content now, as a hash. */
export async function fileStates(files: Iterable<string>): Promise<FileStates> {
  const states: FileStates = {};
  for (const file of files) {
    const content = await readFile(file).catch(() => undefined);
    states[file] = content ? hash(content) : "";
  }
  return states;
}

/** The files whose content differs between the two states. */
export const changedFiles = (before: FileStates, after: FileStates) =>
  Object.keys(before).filter((file) => before[file] !== after[file]);

// The code files of a repository that differ from its last commit, or that Git does not track and
// does not ignore; none without a commit.
async function changedCode(repository: string): Promise<Set<string>> {
  if (!(await git(repository, ["rev-parse", "--verify", "--quiet", "HEAD"]))) return new Set();
  const listed = await Promise.all([
    repositoryGit(repository, ["diff", "HEAD", "--name-only", "--no-renames", "--", ...CODE_GLOBS]),
    repositoryGit(repository, ["ls-files", "--others", "--exclude-standard", "--", ...CODE_GLOBS]),
  ]);
  return new Set(listed.join("\n").split("\n").filter(Boolean));
}

/**
 * What to ask the agent before it finishes, given the session's changes in order, the repository
 * the session started in ("" outside one) and the fingerprint of what it was last asked about:
 * each repository the session edited code in since it last checked that repository, while Git
 * still sees one of those files changed. Undefined when there is none, or the same files are still
 * as they were when it was last asked.
 */
export async function checkRequest(
  changes: Iterable<SessionChange>,
  start: string,
  asked: string,
): Promise<{ text: string; fingerprint: string } | undefined> {
  const pending = new Map<string, Set<string>>();
  for (const change of changes) {
    if (change.kind === "check") pending.delete(change.repository);
    else
      pending.set(
        change.repository,
        (pending.get(change.repository) ?? new Set()).add(change.file),
      );
  }
  const due: { repository: string; states: FileStates }[] = [];
  for (const [repository, files] of [...pending].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const changed = await changedCode(repository);
    const still = [...files].filter((file) => changed.has(file)).sort();
    if (still.length)
      due.push({
        repository,
        states: await fileStates(still.map((file) => path.join(repository, file))),
      });
  }
  const fingerprint = due.length ? hash(JSON.stringify(due)) : "";
  if (!fingerprint || fingerprint === asked) return undefined;
  const elsewhere = due.some(({ repository }) => repository !== start);
  return {
    text: elsewhere
      ? `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${due.map(({ repository }) => repository).join(", ")}.`
      : AGENT_STOP_CHECK,
    fingerprint,
  };
}

const [HEADING_START, HEADING_END] = projectHeading("\0").split("\0") as [string, string];

/**
 * The repository a check covered, as the line heading its result names it: the first text of the
 * result, found in the shapes agents give a tool's result (text, MCP content, an object holding
 * either). Undefined for a result without one, such as that of a check that failed.
 */
export function checkedRepository(result: unknown, depth = 0): string | undefined {
  if (typeof result === "string") {
    const line = result.split("\n", 1)[0] ?? "";
    return line.startsWith(HEADING_START) && line.endsWith(HEADING_END)
      ? line.slice(HEADING_START.length, line.length - HEADING_END.length)
      : undefined;
  }
  if (!result || typeof result !== "object" || depth > 3) return undefined;
  for (const value of Object.values(result)) {
    const repository = checkedRepository(value, depth + 1);
    if (repository) return repository;
  }
  return undefined;
}

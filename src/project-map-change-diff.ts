import { open } from "node:fs/promises";
import path from "node:path";
import { ProjectEvidenceError } from "./core";
import { GitCommandOutputLimitError, GitRunner } from "./git-runner";
import type { Hunk, Lines, MapChangedFile, MapChanges } from "./project-map-change-types";
import { mapLanguageOf } from "./project-map-language";
import { strandedNames } from "./project-map-names";
import { MAP_MIGRATION_PATH, mapTestPath } from "./project-map-types";
import { inExcludedDirectory } from "./source-scope";

// Reading a change: the base it is compared with, the files git says it changed, and where a
// line of the base is in the working tree.

export const git = new GitRunner();
export const gitOptions = (cwd: string, signal: AbortSignal) => ({
  cwd,
  signal,
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
});
const EVERYTHING: readonly [number, number] = [1, Number.MAX_SAFE_INTEGER];

/** The commit a base (a commit, branch or tag) names. */
export async function resolveMapBase(
  project: string,
  base: string,
  signal: AbortSignal,
): Promise<string> {
  if (!/^[\w./@^~-]{1,200}$/u.test(base) || base.startsWith("-"))
    throw new ProjectEvidenceError("LAYERMAP_BASE_INVALID", false);
  let commit: string;
  try {
    commit = (
      await git.run(
        ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
        gitOptions(project, signal),
      )
    ).stdout
      .toString()
      .trim();
  } catch {
    throw new ProjectEvidenceError("LAYERMAP_BASE_NOT_FOUND", false);
  }
  if (!/^[a-f0-9]{40,64}$/u.test(commit))
    throw new ProjectEvidenceError("LAYERMAP_BASE_NOT_FOUND", false);
  return commit;
}

/** The working tree's changes against a commit: tracked files from git diff, plus untracked files. */
export async function readMapChanges(
  project: string,
  base: string,
  signal: AbortSignal,
  // The names the diff strands are reported in the text alone; data leaves them out.
  options: Readonly<{ names: boolean }> = { names: true },
): Promise<MapChanges> {
  const commit = await resolveMapBase(project, base, signal);
  // A diff cut at the output limit would leave changes out of the check, so it is not checked.
  const diff = (
    await git
      .run(
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--unified=0",
          "-M",
          commit,
          "--",
        ],
        gitOptions(project, signal),
      )
      .catch((error: unknown) => {
        if (error instanceof GitCommandOutputLimitError)
          throw new ProjectEvidenceError("LAYERMAP_DIFF_TOO_LARGE", false);
        throw error;
      })
  ).stdout.toString("utf8");
  // A map never holds dependencies or coding agents' own directories, so their files are not
  // changes to check.
  const parsed = parseMapDiff(diff);
  const files = parsed.files.filter((file) => !inExcludedDirectory(file.path));
  // A test's existing tests are read from its code; data and fixtures beside it hold none.
  for (const [index, file] of files.entries())
    if (
      file.basePath &&
      file.status !== "ADDED" &&
      !file.binary &&
      mapTestPath(file.basePath) &&
      mapLanguageOf(file.basePath)
    )
      files[index] = {
        ...file,
        baseText: (
          await git.run(["show", `${commit}:${file.basePath}`], gitOptions(project, signal))
        ).stdout.toString("utf8"),
      };
  const untracked = (
    await git.run(["ls-files", "--others", "--exclude-standard", "-z"], gitOptions(project, signal))
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path && !inExcludedDirectory(path));
  for (const file of untracked)
    files.push({
      path: file,
      status: "ADDED",
      lines: [EVERYTHING],
      baseLines: [],
      hunks: [],
      removed: [],
      // git diff says which tracked files are binary; an untracked one in a language the map does
      // not analyze is told the way git tells it, by a NUL in its first 8000 bytes.
      binary: !mapLanguageOf(file) && (await startsBinary(path.join(project, file))),
    });
  const stranded = options.names
    ? await strandedNames(
        project,
        files,
        (file) => nonCodeKind(file) === "configuration",
        git,
        gitOptions(project, signal),
      )
    : { names: [] };
  return { base, commit, files, quoted: parsed.quoted, stranded };
}

async function startsBinary(file: string): Promise<boolean> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const head = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Files, changed line ranges and removed text from `git diff --unified=0 -M`, and the paths git
 * quoted (a tab, a newline or a quote in them), which the map cannot hold, as git wrote them.
 */
export function parseMapDiff(text: string): { files: MapChangedFile[]; quoted: string[] } {
  const files: MapChangedFile[] = [];
  const quoted: string[] = [];
  type Draft = {
    path: string;
    basePath?: string;
    status: MapChangedFile["status"];
    lines: [number, number][];
    baseLines: [number, number][];
    hunks: Hunk[];
    removed: string[];
    binary: boolean;
  };
  let current: Draft | undefined;
  // Past the first hunk, a line starting with --- is a removed line, not a header.
  let inHunk = false;
  const finish = () => {
    if (!current) return;
    if (current.path.startsWith('"')) quoted.push(current.path);
    else files.push(current);
    current = undefined;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      inHunk = false;
      // a/P b/P splits in half, whatever P holds; a renamed file is named again by the lines
      // below. git quotes a path holding a tab, a newline or a quote: the map cannot hold it, and
      // the file is left out.
      const names = line.slice("diff --git ".length);
      const half = (names.length - 1) / 2;
      const [from, to] = [names.slice(0, half), names.slice(half + 1)];
      const same =
        from.startsWith("a/") && to.startsWith("b/") && from.slice(2) === to.slice(2)
          ? from.slice(2)
          : undefined;
      const match = /^a\/(.+) b\/(.+)$/u.exec(names);
      current = {
        path: same ?? match?.[2] ?? names,
        basePath: same ?? match?.[1] ?? names,
        status: "MODIFIED",
        lines: [],
        baseLines: [],
        hunks: [],
        removed: [],
        binary: false,
      };
      continue;
    }
    if (!current) continue;
    if (inHunk) {
      if (line.startsWith("-")) current.removed.push(line.slice(1));
      else if (line.startsWith("@@ ")) addHunk(current, line);
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.status = "ADDED";
      current.basePath = undefined;
    } else if (line.startsWith("deleted file mode")) {
      current.status = "DELETED";
      current.path = current.basePath ?? current.path;
    } else if (line.startsWith("rename from ")) {
      current.status = "RENAMED";
      current.basePath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) current.binary = true;
    else if (line.startsWith("@@ ")) {
      inHunk = true;
      addHunk(current, line);
    }
  }
  finish();
  return { files, quoted };
}

function addHunk(
  file: { lines: [number, number][]; baseLines: [number, number][]; hunks: Hunk[] },
  line: string,
) {
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (!hunk) return;
  const [oldStart, oldCount, newStart, newCount] = [
    Number(hunk[1]),
    hunk[2] === undefined ? 1 : Number(hunk[2]),
    Number(hunk[3]),
    hunk[4] === undefined ? 1 : Number(hunk[4]),
  ];
  file.hunks.push({ baseStart: oldStart, baseCount: oldCount, start: newStart, count: newCount });
  if (oldCount > 0) file.baseLines.push([oldStart, oldStart + oldCount - 1]);
  file.lines.push(newCount > 0 ? [newStart, newStart + newCount - 1] : [newStart + 1, newStart]);
}

/** The changed files, by their path in the working tree (a deleted file's, in the base). */
export const changedInWorkingTree = (files: readonly MapChangedFile[]) =>
  new Map(files.map((file) => [file.path, file] as const));
/** The changed files that existed in the base, by their path there. */
export const changedInBase = (files: readonly MapChangedFile[]) =>
  new Map(files.flatMap((file) => (file.basePath ? [[file.basePath, file] as const] : [])));
export const overlaps = (lines: Lines, start: number, end: number) =>
  lines.some(([from, to]) => from <= end && start <= to);
/** Where a base line the diff left unchanged is in the working tree; a file outside it keeps it. */
export const workingLine = (file: MapChangedFile | undefined, line: number) => {
  let shift = 0;
  for (const hunk of file?.hunks ?? []) {
    // A hunk adding lines alone comes after the base line it starts at.
    if ((hunk.baseCount ? hunk.baseStart : hunk.baseStart + 1) > line) break;
    shift += hunk.count - hunk.baseCount;
  }
  return line + shift;
};

// Files whose effects a code map cannot follow: configuration, dependencies, builds, schemas,
// templates. A change to one widens what to check, as test impact tools run more when it happens.
const NON_CODE: readonly (readonly [RegExp, string])[] = [
  [
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|gradle\.lockfile)$/u,
    "dependency lock file",
  ],
  [
    /(?:^|\/)(?:package\.json|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Makefile|Dockerfile|tsconfig[^/]*\.json)$/u,
    "build or dependency file",
  ],
  [MAP_MIGRATION_PATH, "database migration or schema"],
  [/(?:^|\/)\.env[^/]*$|\.(?:ya?ml|toml|ini|properties|conf|cfg)$/iu, "configuration"],
  [/\.(?:html?|jinja2?|j2|hbs|ejs|tmpl|tpl|gohtml|vue|svelte|wxml)$/iu, "template"],
];
const nonCodeKind = (path: string) => NON_CODE.find(([pattern]) => pattern.test(path))?.[1];
// Other files the map does not analyze, by what they are; documentation changes no behavior.
const UNANALYZED: readonly (readonly [RegExp, string])[] = [
  [/\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/iu, "shell script"],
  [/\.(?:css|scss|sass|less|styl|wxss|acss)$/iu, "style sheet"],
];
const DOCUMENTATION = /\.(?:md|mdx|markdown|rst|adoc)$|(?:^|\/)(?:LICENSE|NOTICE)[^/]*$/iu;
/** What a changed file the map does not follow is, or nothing for documentation. */
export const unmappedKind = (path: string, binary: boolean) =>
  nonCodeKind(path) ??
  (binary
    ? "binary file"
    : DOCUMENTATION.test(path)
      ? undefined
      : (UNANALYZED.find(([pattern]) => pattern.test(path))?.[1] ?? "unanalyzed file"));

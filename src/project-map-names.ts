import { readFileSync } from "node:fs";
import path from "node:path";
import { GitCommandError, type GitRunner, type GitRunOptions } from "./git-runner";
import { mapLanguageOf } from "./project-map-language";
import { mapTestPath } from "./project-map-types";

// Environment variables and configuration keys are read and set by name, which no compiler links:
// renaming one on one side leaves the other side reading or setting the old name. The names a diff
// removes from a file are looked up, by text, in the rest of the working tree.

/** A name the diff removed from a file that other files still use, with where (path:line). */
export type MapStrandedName = Readonly<{ name: string; from: string; mentions: readonly string[] }>;

type ChangedFile = Readonly<{
  path: string;
  basePath?: string;
  status: string;
}>;

// A key a configuration line sets: KEY=value (.env, properties), key: value (YAML), key = value
// (TOML, INI), - KEY=value (a Compose environment list).
const CONFIG_KEY = /^\s*(?:export\s+|-\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*(?:=|:(?:\s|$))/u;
// How code reads or sets the environment or configuration by name.
const CODE_READS = [
  // process.env.NAME, import.meta.env.NAME
  /\benv\.([A-Za-z_]\w*)/gu,
  // getenv("NAME"), os.Getenv, os.LookupEnv, System.getProperty, env("NAME")
  /\b(?:getenv|Getenv|LookupEnv|setenv|Setenv|getProperty|env)\s*\(\s*["'`]([^"'`\s]+)["'`]/gu,
  // os.environ["NAME"], os.environ.get("NAME"), config.get("key"), settings["key"], viper.GetString("key")
  /\b(?:environ|env|conf|config|cfg|settings|viper)\w*(?:\s*\.\s*\w+)?\s*(?:<[^<>()]*>)?\s*[[(]\s*["'`]([^"'`\s]+)["'`]/giu,
  // "LOG_LEVEL": a quoted name spelled as an environment variable, as option tables keep them
  /["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/gu,
];
// ${NAME} placeholders: Spring's @Value("${key}"), and references in Compose and properties files.
// In other code ${...} is a template literal.
const PLACEHOLDER = /\$\{([A-Za-z_][\w.-]*)/gu;
// A settings class field spelled as an environment variable, as pydantic-settings reads them.
const PYTHON_FIELD = /^\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*:/gu;
const NAME = /^[A-Za-z_][\w.-]+[A-Za-z0-9]$/u;
// An environment variable's spelling. Other names (port, runs-on, db.host) are common words or
// a tool's own settings, so only a read by name in code, or the same key in configuration, counts.
const UPPER = /^[A-Z][A-Z0-9_]*$/u;
// Variables the system, CI or runtime sets, which a project does not rename.
const PLATFORM =
  /^(?:GITHUB_\w+|RUNNER_\w+|CI|NODE_ENV|PATH|HOME|USER|PWD|SHELL|LANG|LC_\w+|TZ|TERM|TMPDIR|TEMP|TMP|PYTHONPATH|GOPATH|GOOS|GOARCH|JAVA_HOME)$/u;
const HISTORY = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|NEWS|RELEASES?|release[-_ ]?notes)[^/]*$/iu;
const LIMIT = Object.freeze({ names: 50, mentions: 5 });

// A regular expression matching the text as written ("-" needs no escape outside a class).
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// A name as a whole, also after a dot: process.env.NAME, db.host.
const wholeName = (name: string) => new RegExp(`(?<![\\w-])${literal(name)}(?![\\w-])`, "u");
// Code names an environment variable when it quotes it, reads it from env, or puts it in a placeholder.
const quotedName = (name: string) =>
  new RegExp(
    `["'\`]${literal(name)}["'\`]|\\benv\\.${literal(name)}\\b|\\$\\{${literal(name)}[}:]`,
    "u",
  );

/** The names a line of code reads or sets the environment or configuration by. */
function codeReads(line: string, file: string): Set<string> {
  const names = new Set<string>();
  const extra = file.endsWith(".java") ? [PLACEHOLDER] : file.endsWith(".py") ? [PYTHON_FIELD] : [];
  for (const pattern of [...CODE_READS, ...extra])
    for (const match of line.matchAll(pattern)) if (match[1]) names.add(match[1]);
  return names;
}

/**
 * The text of the lines `git diff --unified=0` removed, by the file's path in the base, and the
 * numbers of the lines it added, by its path now.
 */
function diffLines(diff: string) {
  const removed = new Map<string, string[]>();
  const added = new Map<string, Set<number>>();
  let gone: string[] | undefined;
  let fresh: Set<number> | undefined;
  let inHunk = false;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(text);
      gone = [];
      fresh = new Set();
      if (match?.[1] && !match[1].startsWith('"')) removed.set(match[1], gone);
      if (match?.[2] && !match[2].startsWith('"')) added.set(match[2], fresh);
      inHunk = false;
    } else if (text.startsWith("rename from ") && gone)
      removed.set(text.slice("rename from ".length), gone);
    else if (text.startsWith("rename to ") && fresh)
      added.set(text.slice("rename to ".length), fresh);
    else if (text.startsWith("@@ ")) {
      inHunk = true;
      line = Number(/\+(\d+)/u.exec(text)?.[1] ?? 0);
    } else if (inHunk && text.startsWith("-")) gone?.push(text.slice(1));
    else if (inHunk && text.startsWith("+")) fresh?.add(line++);
  }
  return { removed, added };
}

/**
 * The environment variables and configuration keys the diff removed from a changed file (no longer
 * anywhere in it) that other files still use, found with git grep. A name the diff itself added
 * somewhere is taken as moved, not stranded; a deleted file's names are not looked for. When git
 * grep cannot finish (output or time limit), no names are reported rather than failing the check.
 */
export async function strandedNames(
  project: string,
  diff: string,
  files: readonly ChangedFile[],
  configuration: (file: string) => boolean,
  git: GitRunner,
  options: GitRunOptions,
): Promise<MapStrandedName[]> {
  const { removed, added } = diffLines(diff);
  // Each name, the file it left, and whether code read it there.
  const from = new Map<string, { path: string; code: boolean }>();
  for (const file of files) {
    const lines = file.basePath === undefined ? undefined : removed.get(file.basePath);
    if (!lines?.length || file.status === "DELETED" || mapTestPath(file.path)) continue;
    const config = configuration(file.path);
    if (!config && !mapLanguageOf(file.path)) continue;
    const names = new Set<string>();
    for (const line of lines)
      if (config) {
        const key = CONFIG_KEY.exec(line)?.[1];
        if (key) names.add(key);
        for (const match of line.matchAll(PLACEHOLDER)) if (match[1]) names.add(match[1]);
      } else for (const name of codeReads(line, file.path)) names.add(name);
    let text: string;
    try {
      text = readFileSync(path.join(project, file.path), "utf8");
    } catch {
      continue;
    }
    for (const name of names)
      if (NAME.test(name) && !PLATFORM.test(name) && !from.has(name) && !wholeName(name).test(text))
        from.set(name, { path: file.path, code: !config });
  }
  const names = [...from.keys()].slice(0, LIMIT.names);
  if (!names.length) return [];

  const patterns = new Map(
    names.map((name) => [name, { whole: wholeName(name), quoted: quotedName(name) }]),
  );
  let found: string;
  try {
    found = (
      await git.run(
        [
          "grep",
          "-n",
          "-I",
          "-w",
          "-F",
          "--untracked",
          "--full-name",
          "--no-color",
          ...names.flatMap((name) => ["-e", name]),
          "--",
          ".",
        ],
        options,
      )
    ).stdout.toString("utf8");
  } catch (error) {
    // git grep exits with 1 when nothing matches.
    if (error instanceof GitCommandError && !options.signal?.aborted) return [];
    throw error;
  }
  // Untracked files are not in the diff: all their lines are new.
  const untracked = new Set(
    files
      .filter((file) => file.status === "ADDED" && !added.has(file.path))
      .map((file) => file.path),
  );
  const moved = new Set<string>();
  const mentions = new Map<string, string[]>();
  for (const hit of found.split("\n")) {
    const match = /^(.+?):(\d+):(.*)$/u.exec(hit);
    if (!match) continue;
    const [, file = "", number = "", line = ""] = match;
    if (HISTORY.test(file)) continue;
    const at = Number(number);
    const code = mapLanguageOf(file) !== undefined;
    const reads = code ? codeReads(line, file) : undefined;
    const key = configuration(file) ? CONFIG_KEY.exec(line)?.[1] : undefined;
    for (const name of names) {
      const source = from.get(name);
      const pattern = patterns.get(name);
      if (!source || !pattern || file === source.path || !pattern.whole.test(line)) continue;
      if (untracked.has(file) || added.get(file)?.has(at)) {
        moved.add(name);
        continue;
      }
      const uses = UPPER.test(name)
        ? !reads || reads.has(name) || pattern.quoted.test(line)
        : reads
          ? reads.has(name)
          : source.code && /[_.-]/u.test(name) && key === name;
      if (uses) mentions.set(name, [...(mentions.get(name) ?? []), `${file}:${at}`]);
    }
  }
  return names
    .filter((name) => !moved.has(name) && mentions.has(name))
    .map((name) => ({
      name,
      from: from.get(name)?.path ?? "",
      mentions: mentions.get(name) ?? [],
    }));
}

/** One line per stranded name: where it was removed, and the first few places still using it. */
export const strandedNameLine = ({ name, from, mentions }: MapStrandedName) =>
  `${name}, gone from ${from}: ${mentions.slice(0, LIMIT.mentions).join(", ")}${mentions.length > LIMIT.mentions ? `, +${mentions.length - LIMIT.mentions} more` : ""}`;

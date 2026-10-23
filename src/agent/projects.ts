import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MAP_TOOL_NAMES } from "../tools";
import { projectDirectory } from "./environment";
import type { MapToolCall } from "./tools";

/**
 * Where a session started: a Git work tree's root, or a directory outside any, such as a folder
 * holding several repositories.
 */
export type SessionStart = Readonly<{ directory: string; git: boolean }>;

/** A tool call routed to the repository its paths name, with those paths made relative to its root. */
export type RoutedCall = Readonly<{ project: string; args: Record<string, unknown> }>;

const escapes = (relative: string) => {
  const normal = path.normalize(relative);
  return normal === ".." || normal.startsWith(`..${path.sep}`);
};

/**
 * The repository holding a path and the path within it. A relative path in the repository the
 * session started in is that repository's, as given; any other is resolved from where the session
 * started, and its repository is the Git work tree around it. Undefined outside any work tree.
 */
export async function locate(
  start: SessionStart,
  given: string,
): Promise<Readonly<{ project: string; path: string }> | undefined> {
  if (start.git && !path.isAbsolute(given) && !escapes(given))
    return { project: start.directory, path: given };
  const absolute = path.resolve(start.directory, given);
  // The path may name a file or one not written yet; its repository is that of the nearest
  // directory that exists, compared by real path as Git prints its root.
  let directory = absolute;
  while (!(await stat(directory).catch(() => undefined))?.isDirectory()) {
    if (path.dirname(directory) === directory) return undefined;
    directory = path.dirname(directory);
  }
  const real = path.join(await realpath(directory), path.relative(directory, absolute));
  const { directory: project, git } = await projectDirectory(directory);
  if (!git) return undefined;
  const relative = path.relative(project, real);
  if (escapes(relative)) return undefined;
  return { project, path: relative ? relative.split(path.sep).join("/") : "." };
}

/** The Git repositories directly inside a directory, as directory paths relative to it. */
async function repositoriesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(path.join(directory, entry.name, ".git")))
    .map((entry) => `${entry.name}/`)
    .sort();
}

/**
 * Routes a map tool call to the repository its path names: the file or directory it explores or
 * searches, the declaration whose references it finds, the repository it checks. Without a path,
 * the call is about the repository the session started in. Returns the text an agent reads when
 * no repository holds the path.
 */
export async function routeMapCall(
  start: SessionStart,
  { name, args }: MapToolCall,
): Promise<RoutedCall | string> {
  // The path that names the repository, and the argument that holds it.
  const holder = (["symbol", "locator"] as const).find(
    (key) => name === MAP_TOOL_NAMES.references && args[key] !== undefined,
  );
  const value = holder
    ? (args[holder] as { path: string }).path
    : (args.path as string | undefined);
  const named = value || ".";
  const located = await locate(start, named);
  if (!located) {
    // A session in a folder holding several repositories is told which they are.
    const repositories = start.git ? [] : await repositoriesIn(start.directory);
    const such = repositories.length ? `, such as ${repositories.join(", ")}` : "";
    return named === "."
      ? `LAYERMAP_NOT_A_GIT_REPOSITORY: This session started in ${start.directory}, which is not in a Git repository. Name a file or directory in one, relative to that folder or absolute${such}.`
      : `LAYERMAP_NOT_A_GIT_REPOSITORY: ${path.resolve(start.directory, named)} is not in a Git repository; LayerMap maps Git repositories${
          start.git
            ? ""
            : `. Name a file or directory in one, relative to ${start.directory} or absolute${such}`
        }.`;
  }
  if (!holder) {
    const routed = value === undefined ? args : { ...args, path: located.path };
    if (!Array.isArray(args.tests)) return { project: located.project, args: routed };
    // The tests a check is judged by are files of the repository it checks.
    const tests: string[] = [];
    for (const test of args.tests as string[]) {
      const within = await locate(start, test);
      if (within?.project !== located.project)
        return `PROJECT_PATH_INVALID: test ${test} is not in ${located.project}, the repository checked.`;
      tests.push(within.path);
    }
    return { project: located.project, args: { ...routed, tests } };
  }
  const routed = {
    ...args,
    [holder]: { ...(args[holder] as Record<string, unknown>), path: located.path },
  };
  // References filter their usages by a path in the declaration's repository.
  const filter = args.path as string;
  if (filter === ".") return { project: located.project, args: routed };
  const within = await locate(start, filter);
  if (within?.project !== located.project)
    return `PROJECT_PATH_INVALID: path ${filter} is not in ${located.project}, the repository of the declaration.`;
  return { project: located.project, args: { ...routed, path: within.path } };
}

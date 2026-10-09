import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// What differs between POSIX and Windows when LayerMap starts and stops the programs it runs: the
// file names of executables, the environment a child needs, and how a process tree is stopped.

/** An executable's file name: Windows runs a program only by a name with an extension. */
export const executableName = (name: string, platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? `${name}.exe` : name;

// The PATH a child would search. Windows spells the variable Path, and process.env matches names
// case-insensitively there while a copy of it does not.
const searchPath = (env: NodeJS.ProcessEnv) =>
  env.PATH ?? Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";

/** The first directory on PATH that holds one of the files, as a full path. */
function findOnPath(
  files: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  for (const directory of searchPath(env).split(platform === "win32" ? ";" : ":"))
    for (const file of files)
      if (directory && existsSync(join(directory, file))) return join(directory, file);
  return undefined;
}

/** The first directory on PATH that holds the executable, as a full path. */
export const findExecutable = (
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined => findOnPath([executableName(name, platform)], env, platform);

// cmd.exe's special characters, escaped with a caret; the quoting below follows cross-spawn's.
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;
const cmdArgument = (value: string) =>
  `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1")}"`
    .replace(CMD_META, "^$1")
    // npm's .cmd shims pass their arguments through cmd.exe a second time.
    .replace(CMD_META, "^$1");

/**
 * How to run a command found on PATH. On Windows a CLI that npm installed is a .cmd shim, which
 * Node starts only through cmd.exe, so the shim and its arguments are quoted for it; a program
 * with an .exe runs directly. Elsewhere the command runs as given.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32") return { file: command, args: [...args] };
  const program = findOnPath([`${command}.exe`, `${command}.cmd`, `${command}.bat`], env, platform);
  if (!program || program.toLowerCase().endsWith(".exe"))
    return { file: program ?? command, args: [...args] };
  return cmdInvocation(program, args, env.ComSpec ?? process.env.ComSpec ?? "cmd.exe");
}

/** A .cmd or .bat script and its arguments, run through cmd.exe and quoted for it. */
export function cmdInvocation(
  script: string,
  args: readonly string[],
  comspec = "cmd.exe",
): { file: string; args: string[]; windowsVerbatimArguments: true } {
  const line = [script.replace(CMD_META, "^$1"), ...args.map(cmdArgument)].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

// The variables a Windows process needs to start, load system libraries and find its temporary
// directory; LayerMap otherwise gives its children a minimal environment.
const WINDOWS_SYSTEM = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PATHEXT",
  "ComSpec",
] as const;

/** A child's environment: the given variables, and on Windows the system ones it cannot do without. */
export function childEnvironment(
  variables: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return variables;
  const system: NodeJS.ProcessEnv = {};
  for (const name of WINDOWS_SYSTEM) if (env[name] !== undefined) system[name] = env[name];
  return { ...system, ...variables };
}

/**
 * Stops a process and everything it started. On POSIX the process was spawned detached, so it
 * leads a process group; on Windows, where a parent's exit leaves its children running, the tree
 * is ended with taskkill, which cannot be asked to stop gently.
 */
export function stopProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    process.kill(-pid, signal);
    return;
  }
  const taskkill = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/**
 * Whether a process tree has exited: true only when the system says so (ESRCH), undefined while
 * it cannot tell. POSIX asks about the group; Windows, whose taskkill ends the tree at once, about
 * the process.
 */
export function processTreeGone(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): boolean | undefined {
  try {
    process.kill(platform === "win32" ? pid : -pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : undefined;
  }
}

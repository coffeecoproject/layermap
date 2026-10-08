import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// What differs between POSIX and Windows when LayerMap starts and stops the programs it runs: the
// file names of executables, the environment a child needs, and how a process tree is stopped.

/** An executable's file name: Windows runs a program only by a name with an extension. */
export const executableName = (name: string, platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? `${name}.exe` : name;

/** The first directory on PATH that holds the executable, as a full path. */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const file = executableName(name, platform);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const delimiter = platform === "win32" ? ";" : ":";
  // Windows spells the variable Path; process.env matches it case-insensitively, a copy does not.
  const value = env.PATH ?? env.Path ?? "";
  for (const directory of value.split(delimiter))
    if (directory && existsSync(join(directory, file))) return join(directory, file);
  return undefined;
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

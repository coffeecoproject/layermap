// The layermap command for shells with no plugin's on their PATH. Claude Code puts its plugin's
// command on the PATH of its shell commands; Codex's commands, a terminal and Git hooks have none,
// so a program run there that calls `layermap`, such as one choosing tests from
// `layermap check --json`, finds nothing. `layermap setup command` writes one file into
// ~/.local/bin, which those shells have on their PATH. It holds no version: each time it runs the
// newest one installed on this machine, where every agent's plugin installs the version it starts,
// so it follows the plugins as they update and never asks npm or a network for anything.
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { installDirectory } from "./environment";

export type CommandOptions = Readonly<{
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}>;

/** The line that marks a file as the command setup wrote, which setup replaces and remove deletes. */
const MARK = "// LayerMap's command, written by `layermap setup command`.";

/**
 * The command for the directory LayerMap is installed in: installDirectory, as setup found it. It
 * looks for versions nowhere else, whatever the shell calling it has set, a test's own home
 * directory say, or LAYERMAP_CACHE for its maps: it installs nothing, so a directory with no
 * version in it would leave it nothing to run. It runs as whichever module type node reads a file
 * without an extension as: built-in modules come from process, and the version is loaded with
 * import().
 */
export const commandScript = (directory: string): string => `#!/usr/bin/env node
${MARK}
// It runs the newest LayerMap version installed in the directory below, where each agent's LayerMap
// plugin installs the version it starts. \`layermap remove command\` deletes this file.
if (typeof process.getBuiltinModule !== "function") {
  process.stderr.write("layermap: LayerMap needs Node.js 22.22 or later; this is " + process.version + "\\n");
  process.exit(1);
}
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const { pathToFileURL } = process.getBuiltinModule("node:url");
const versions = path.join(${JSON.stringify(directory)}, "versions");
const installed = (version) => path.join(versions, version, "node_modules", "layermap");
// A version being installed is a directory named .<version>-…, and has no manifest in place yet.
const numbers = (version) => version.split(".").map(Number);
const newest = (fs.existsSync(versions) ? fs.readdirSync(versions) : [])
  .filter((name) => /^\\d+\\.\\d+\\.\\d+$/.test(name) && fs.existsSync(path.join(installed(name), "package.json")))
  .sort((a, b) => {
    const [left, right] = [numbers(a), numbers(b)];
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  })
  .at(-1);
if (!newest) {
  process.stderr.write(
    "layermap: no LayerMap version is installed in " + versions + ". Start a session of an agent that has the LayerMap plugin, which installs its version there, then run this again.\\n",
  );
  process.exit(1);
}
const entry = path.join(
  installed(newest),
  JSON.parse(fs.readFileSync(path.join(installed(newest), "package.json"), "utf8")).bin.layermap,
);
process.argv = [process.argv[0], entry, ...process.argv.slice(2)];
import(pathToFileURL(entry).href).catch((error) => {
  process.stderr.write("layermap: could not start LayerMap " + newest + ": " + (error?.message ?? error) + "\\n");
  process.exit(1);
});
`;

/** Where the command goes: the directory for a user's own commands, by the XDG convention. */
export const commandFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.HOME || homedir(), ".local", "bin", "layermap");

// Whether the file is there, and whether setup wrote it. A link is someone else's, wherever it
// leads: writing through it would change the file it names.
async function state(file: string): Promise<"absent" | "own" | "other"> {
  const found = await lstat(file).catch(() => undefined);
  if (!found) return "absent";
  if (!found.isFile()) return "other";
  return (await readFile(file, "utf8")).includes(MARK) ? "own" : "other";
}

const unsupported = (log: (line: string) => void) => {
  log(
    "The layermap command is for macOS and Linux, whose shells run a file in ~/.local/bin; on Windows use `npx layermap`.",
  );
  return false;
};

/**
 * Writes the layermap command into ~/.local/bin, replacing one an earlier setup wrote. A file
 * there that is not LayerMap's is left as it is.
 */
export async function setupCommand(options: CommandOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const { log } = options;
  if (process.platform === "win32") return unsupported(log);
  const file = commandFile(env);
  if ((await state(file)) === "other") {
    log(
      `${file} is there already and is not LayerMap's command: left as it is. Remove it if you do not need it, then run setup again.`,
    );
    return false;
  }
  log(`write LayerMap's command to ${file}`);
  if (options.dryRun) return true;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.${process.pid}`, commandScript(installDirectory(env)));
  await chmod(`${file}.${process.pid}`, 0o755);
  await rename(`${file}.${process.pid}`, file);
  if (!(env.PATH ?? "").split(path.delimiter).includes(path.dirname(file)))
    log(`${path.dirname(file)} is not on this shell's PATH: add it for the command to be found.`);
  log(
    `Done. \`layermap\` runs the newest LayerMap version installed in ${path.join(installDirectory(env), "versions")}, where each agent's LayerMap plugin installs the version it starts.`,
  );
  return true;
}

/** Deletes the command setup wrote; a file there that is not LayerMap's is left as it is. */
export async function removeCommand(options: CommandOptions): Promise<boolean> {
  const { log } = options;
  if (process.platform === "win32") return unsupported(log);
  const file = commandFile(options.env ?? process.env);
  const found = await state(file);
  if (found === "other") {
    log(`${file} is not LayerMap's command: left as it is.`);
    return false;
  }
  if (found === "absent") {
    log(`${file} is not there: nothing to remove.`);
    return true;
  }
  log(`remove LayerMap's command from ${file}`);
  if (options.dryRun) return true;
  await rm(file);
  log("Removed.");
  return true;
}

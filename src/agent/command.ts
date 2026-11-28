// The layermap command for shells with no plugin's on their PATH. Claude Code puts its plugin's
// command on the PATH of its shell commands; Codex's commands, a terminal and Git hooks have none,
// so a program run there that calls `layermap`, such as one choosing tests from
// `layermap check --json`, finds nothing. `layermap setup command` writes LayerMap's launcher into
// installDirectory as cli.mjs, which the machine's version keeps up to date, and one file into
// ~/.local/bin, which those shells have on their PATH, that runs it. It holds no version: each time
// it runs the machine's, the one every agent's plugin runs, installing it from npm only when there is
// none.
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { installDirectory, packageRoot } from "./environment";
import { launcherTemplate, writeLauncher } from "./launcher";

export type CommandOptions = Readonly<{
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}>;

/** The line that marks a file as the command setup wrote, which setup replaces and remove deletes. */
const MARK = "// LayerMap's command, written by `layermap setup command`.";

/**
 * The command for the directory LayerMap is installed in: installDirectory, as setup found it. It
 * names that directory to the launcher there, whatever the shell calling it has set, a test's own
 * home directory say, or LAYERMAP_CACHE for its maps. It runs as whichever module type node reads a
 * file without an extension as: built-in modules come from process, and the launcher is loaded with
 * import().
 */
export const commandScript = (directory: string): string => `#!/usr/bin/env node
${MARK}
// It runs LayerMap's launcher in the directory below, which runs the LayerMap version each agent's
// LayerMap plugin runs. \`layermap remove command\` deletes this file.
if (typeof process.getBuiltinModule !== "function") {
  process.stderr.write("layermap: LayerMap needs Node.js 22.22 or later; this is " + process.version + "\\n");
  process.exit(1);
}
const path = process.getBuiltinModule("node:path");
const { pathToFileURL } = process.getBuiltinModule("node:url");
const directory = ${JSON.stringify(directory)};
process.env.LAYERMAP_HOME = directory;
import(pathToFileURL(path.join(directory, "cli.mjs")).href).catch((error) => {
  process.stderr.write("layermap: could not start LayerMap: " + (error?.message ?? error) + "\\n");
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
  const directory = installDirectory(env);
  log(`write LayerMap's launcher to ${path.join(directory, "cli.mjs")}`);
  log(`write LayerMap's command to ${file}`);
  if (options.dryRun) return true;
  const template = launcherTemplate(packageRoot);
  if (!template) throw new Error(`${packageRoot} has no launcher`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeLauncher(directory, "cli.mjs", await readFile(template, "utf8"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.${process.pid}`, commandScript(directory));
  await chmod(`${file}.${process.pid}`, 0o755);
  await rename(`${file}.${process.pid}`, file);
  if (!(env.PATH ?? "").split(path.delimiter).includes(path.dirname(file)))
    log(`${path.dirname(file)} is not on this shell's PATH: add it for the command to be found.`);
  log(
    `Done. \`layermap\` runs the LayerMap version each agent's LayerMap plugin runs, installed in ${path.join(directory, "versions")}.`,
  );
  return true;
}

/**
 * Deletes the command setup wrote, and the launcher it ran; a file there that is not LayerMap's is
 * left as it is.
 */
export async function removeCommand(options: CommandOptions): Promise<boolean> {
  const { log } = options;
  if (process.platform === "win32") return unsupported(log);
  const env = options.env ?? process.env;
  const file = commandFile(env);
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
  await rm(path.join(installDirectory(env), "cli.mjs"), { force: true });
  log("Removed.");
  return true;
}

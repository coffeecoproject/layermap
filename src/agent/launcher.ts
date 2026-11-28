// LayerMap's launcher, scripts/launcher.mjs, and the copies of it outside the plugins: those setup
// writes into installDirectory, server.mjs for the agents it registers and cli.mjs for the
// ~/.local/bin command. The version every LayerMap of the machine runs rewrites them from its own,
// so a fix to the launcher reaches them as it reaches that version, with no setup run again.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** The launcher with its arguments: the server's, or code giving the command line's. */
export const launcherScript = (template: string, args = '["mcp"]'): string =>
  `// Generated from scripts/launcher.mjs.\n${template.replace("__ARGUMENTS__", args)}`;

/** The launchers setup writes into installDirectory, by file name, with their arguments. */
export const LAUNCHERS = {
  "server.mjs": '["mcp"]',
  "cli.mjs": "process.argv.slice(2)",
} as const;
export type LauncherName = keyof typeof LAUNCHERS;

/** The launcher a package carries: a published one in dist, a checkout in scripts. */
export const launcherTemplate = (packageRoot: string): string | undefined =>
  [
    path.join(packageRoot, "dist", "launcher.mjs"),
    path.join(packageRoot, "scripts", "launcher.mjs"),
  ].find(existsSync);

/** Writes a launcher into the directory, in one step so no start reads half of it. */
export async function writeLauncher(
  directory: string,
  name: LauncherName,
  template: string,
): Promise<void> {
  const file = path.join(directory, name);
  const content = launcherScript(template, LAUNCHERS[name]);
  if ((await readFile(file, "utf8").catch(() => undefined)) === content) return;
  await writeFile(`${file}.${process.pid}`, content);
  await rename(`${file}.${process.pid}`, file);
}

/** Rewrites the launchers setup wrote into the directory from the template; writes no others. */
export async function refreshLaunchers(directory: string, template: string): Promise<void> {
  const text = await readFile(template, "utf8");
  for (const name of Object.keys(LAUNCHERS) as LauncherName[])
    if (existsSync(path.join(directory, name))) await writeLauncher(directory, name, text);
}

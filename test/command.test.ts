import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commandFile, commandScript, removeCommand, setupCommand } from "../src/agent/command";
import { sandbox } from "./support";

// The command is a file a shell runs by its first line, which Windows has no way to do.
const skip = process.platform === "win32";

// A home and a cache of their own, and the node running the tests first on PATH.
async function machine() {
  const directory = await sandbox();
  const cache = path.join(directory, "cache");
  const env = {
    HOME: path.join(directory, "home"),
    LAYERMAP_CACHE: cache,
    PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
  };
  const lines: string[] = [];
  const options = { dryRun: false, env, log: (line: string) => lines.push(line) };
  return { directory, cache, env, lines, options, file: commandFile(env) };
}

// A version as the launcher installs it, whose command prints what ran and exits with 3.
async function install(cache: string, version: string, manifest = true) {
  const installed = path.join(cache, "versions", version, "node_modules", "layermap");
  await mkdir(installed, { recursive: true });
  await writeFile(
    path.join(installed, "cli.mjs"),
    `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2) }));\nprocess.exitCode = 3;\n`,
  );
  if (manifest)
    await writeFile(
      path.join(installed, "package.json"),
      JSON.stringify({ name: "layermap", version, type: "module", bin: { layermap: "cli.mjs" } }),
    );
}

const run = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(file, args, { env }, (_error, stdout, stderr) =>
      resolve({ code: child.exitCode, stdout, stderr }),
    );
  });

test("setup writes a command that runs the newest version in the cache, with its arguments and exit code", {
  skip,
}, async () => {
  const { cache, env, file, options, lines, directory } = await machine();
  assert.equal(await setupCommand(options), true);
  assert.equal(await readFile(file, "utf8"), commandScript(cache));
  assert.ok((await stat(file)).mode & 0o100, "a shell can run it");
  assert.equal(file, path.join(env.HOME, ".local", "bin", "layermap"));
  assert.ok(
    lines.some((line) => line.includes("is not on this shell's PATH")),
    lines.join("\n"),
  );

  // Nothing installed yet: it says where it looked, and installs nothing itself.
  const none = await run(file, ["--version"], env);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^layermap: no LayerMap version is installed in /u);
  assert.ok(none.stderr.includes(path.join(cache, "versions")), none.stderr);

  await install(cache, "0.1.9");
  await install(cache, "0.1.10");
  // npm has not finished these: no manifest in place, or still under the name of an install.
  await install(cache, "0.2.0", false);
  await install(cache, ".0.3.0-Ab12Cd");
  const newest = await run(file, ["check", "--json", "a b"], env);
  assert.deepEqual(JSON.parse(newest.stdout), {
    version: "0.1.10",
    args: ["check", "--json", "a b"],
  });
  assert.equal(newest.code, 3);
  assert.equal(newest.stderr, "");

  // A plugin that updates installs its version, and the command follows without another setup.
  await install(cache, "0.2.0");
  assert.equal(JSON.parse((await run(file, [], env)).stdout).version, "0.2.0");

  // LAYERMAP_CACHE moves the cache for the command as it does for LayerMap.
  const moved = path.join(directory, "moved");
  await install(moved, "0.0.1");
  const elsewhere = await run(file, [], { ...env, LAYERMAP_CACHE: moved });
  assert.equal(JSON.parse(elsewhere.stdout).version, "0.0.1");
});

test("the command runs whichever module type node reads a file without an extension as", {
  skip,
}, async () => {
  const { cache, env, file, options } = await machine();
  await install(cache, "1.0.0");
  await setupCommand(options);
  assert.equal(JSON.parse((await run(file, [], env)).stdout).version, "1.0.0");
  await writeFile(path.join(env.HOME, ".local", "package.json"), '{ "type": "module" }');
  const module = await run(file, ["x"], env);
  assert.deepEqual(JSON.parse(module.stdout), { version: "1.0.0", args: ["x"] });
});

test("setup replaces the command it wrote and leaves another file or a link alone; remove deletes only its own", {
  skip,
}, async () => {
  const { cache, env, file, lines } = await machine();
  const options = {
    dryRun: false,
    env: { ...env, PATH: [path.dirname(file), env.PATH].join(path.delimiter) },
    log: (line: string) => lines.push(line),
  };

  assert.equal(await setupCommand({ ...options, dryRun: true }), true);
  assert.equal(existsSync(file), false, "a dry run writes nothing");
  assert.equal(await removeCommand(options), true, "nothing there is nothing to remove");

  // Another program's command of the same name.
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\necho other\n");
  assert.equal(await setupCommand(options), false);
  assert.equal(await removeCommand(options), false);
  assert.equal(await readFile(file, "utf8"), "#!/bin/sh\necho other\n");
  assert.ok(
    lines.some((line) => line.includes("is not LayerMap's command")),
    lines.join("\n"),
  );

  // A link, even to a command setup wrote: writing would change the file it names.
  const target = path.join(path.dirname(file), "target");
  await writeFile(target, commandScript("/an/older/cache"));
  await rm(file);
  await symlink(target, file);
  assert.equal(await setupCommand(options), false);
  assert.equal(await removeCommand(options), false);
  assert.equal(await readFile(target, "utf8"), commandScript("/an/older/cache"));
  await rm(file);

  // The command of an earlier setup, for another cache.
  await writeFile(file, commandScript("/an/older/cache"), { mode: 0o755 });
  lines.length = 0;
  assert.equal(await setupCommand(options), true);
  assert.equal(await readFile(file, "utf8"), commandScript(cache));
  assert.ok(!lines.some((line) => line.includes("PATH")), "its directory is on PATH");

  assert.equal(await removeCommand({ ...options, dryRun: true }), true);
  assert.equal(existsSync(file), true);
  assert.equal(await removeCommand(options), true);
  assert.equal(existsSync(file), false);
});

test("layermap setup command and remove command write and delete the file from the command line", {
  skip,
}, async () => {
  const { env, file } = await machine();
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const layermap = (...args: string[]) =>
    run(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], env);
  const dry = await layermap("setup", "command", "--dry-run");
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(existsSync(file), false);
  const setup = await layermap("setup", "command");
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(await readFile(file, "utf8"), commandScript(env.LAYERMAP_CACHE));
  assert.equal((await layermap("allow", "command")).code, 1, "allow takes an agent");
  assert.equal((await layermap("remove", "command")).code, 0);
  assert.equal(existsSync(file), false);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "other\n");
  assert.equal((await layermap("setup", "command")).code, 1, "another file is in the way");
});

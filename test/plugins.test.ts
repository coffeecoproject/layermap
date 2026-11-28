import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXECUTABLES, generatedFiles, MCP_NAME, PLUGIN_ASSETS } from "../scripts/plugins";
import { sandbox } from "./support";

const root = fileURLToPath(new URL("../", import.meta.url));

// The plugins and registry entry in the repository are what scripts/plugins.ts writes for this
// version: the notes stay in one place (src/agent/notes.ts), and the server is the machine's
// version, installed from npm, which no plugin names.
test("the committed plugins, marketplaces and registry entry match the generator for this version", async () => {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const files = generatedFiles(version);
  for (const [file, content] of Object.entries(files))
    assert.equal(await readFile(path.join(root, file), "utf8"), content, file);
  for (const file of EXECUTABLES)
    if (process.platform !== "win32")
      assert.ok((await stat(path.join(root, file))).mode & 0o100, `${file} is executable`);
  // Both plugins start LayerMap with the one launcher: Claude Code's from a file of its plugin,
  // Codex's as code, as Codex names no file of a plugin.
  const launcher = files["plugins/claude/server.mjs"] ?? "";
  assert.ok(launcher.includes('const ARGUMENTS = ["mcp"];'));
  // The launchers are the same whatever the version: no plugin names the one it runs.
  const other = generatedFiles("0.0.0-other");
  for (const file of [
    "plugins/claude/server.mjs",
    "plugins/claude/cli.mjs",
    "plugins/claude/hooks/hooks.json",
    "plugins/codex/.mcp.json",
  ])
    assert.equal(other[file], files[file], file);
  const codex = JSON.parse(files["plugins/codex/.mcp.json"] ?? "{}").mcpServers.layermap;
  assert.deepEqual(codex.args, ["--input-type=module", "-e", launcher]);
  const registry = JSON.parse(files["server.json"] ?? "{}");
  assert.equal(registry.name, MCP_NAME);
  assert.ok(registry.description.length <= 100, "the MCP Registry allows 100 characters");
  assert.deepEqual(
    registry.packages.map((entry: { version: string }) => entry.version),
    [version],
  );
  for (const [file, source] of Object.entries(PLUGIN_ASSETS))
    assert.deepEqual(
      await readFile(path.join(root, file)),
      await readFile(path.join(root, source)),
      file,
    );
});

// Claude Code starts the plugin's server with node, and the launcher runs the machine's version,
// named in the cache: the server as its child, the command line and hooks in its own process. A stand-in package echoes its arguments and input and exits with its own code.
async function standIn(directory: string) {
  const installed = path.join(directory, "cache", "versions", "1.2.3", "node_modules", "layermap");
  await mkdir(path.join(installed, "dist"), { recursive: true });
  await writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({ name: "layermap", version: "1.2.3", bin: { layermap: "dist/cli.mjs" } }),
  );
  await writeFile(path.join(directory, "cache", "versions", "current"), "1.2.3\n");
  await writeFile(
    path.join(installed, "dist", "cli.mjs"),
    `let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write(\`\${process.argv.slice(2).join(" ")} in \${process.pid}: \${input}\`);
  process.exit(3);
});
`,
  );
}

// The launcher asks npm for the latest version as a server starts, which these find nowhere.
const OFFLINE = { npm_config_registry: "http://127.0.0.1:9/", npm_config_fetch_retries: "0" };

test("the Claude Code plugin's server script runs the installed version as its child", async () => {
  const directory = await sandbox();
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("1.2.3")["plugins/claude/server.mjs"] ?? "");
  await standIn(directory);
  const started = spawn(process.execPath, [server], {
    env: { ...process.env, ...OFFLINE, LAYERMAP_HOME: path.join(directory, "cache") },
  });
  let stdout = "";
  started.stdout.on("data", (chunk) => (stdout += chunk));
  started.stdin.end("ping\n");
  const status = await new Promise((resolve) => started.on("exit", resolve));
  const [, child] = /^mcp in (\d+): ping\n$/u.exec(stdout) ?? [];
  assert.ok(child && Number(child) !== started.pid, stdout);
  assert.equal(status, 3);
});

test("the Claude Code plugin's hooks run the installed version's hook command", async () => {
  const directory = await sandbox();
  const files = generatedFiles("1.2.3");
  const cli = path.join(directory, "cli.mjs");
  await writeFile(cli, files["plugins/claude/cli.mjs"] ?? "");
  const { hooks } = JSON.parse(files["plugins/claude/hooks/hooks.json"] ?? "{}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the command as Claude Code reads it.
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" hook claude';
  for (const event of Object.values(hooks) as { hooks: { command: string }[] }[][])
    for (const group of event)
      assert.deepEqual(
        group.hooks.map((hook) => hook.command),
        [command],
      );
  await standIn(directory);
  const started = spawn(process.execPath, [cli, "hook", "claude"], {
    env: { ...process.env, ...OFFLINE, LAYERMAP_HOME: path.join(directory, "cache") },
  });
  let stdout = "";
  started.stdout.on("data", (chunk) => (stdout += chunk));
  started.stdin.end("{}");
  const status = await new Promise((resolve) => started.on("exit", resolve));
  assert.equal(stdout, `hook claude in ${started.pid}: {}`);
  assert.equal(status, 3);
});

// Claude Code puts the plugin's bin directory on the PATH of its shell commands, where a program
// run there, choosing tests say, runs the machine's version with the arguments it gives.
test("the Claude Code plugin's layermap command runs the installed version's command line", {
  skip: process.platform === "win32" && "a script runs by its #! line only in a POSIX shell",
}, async () => {
  const directory = await sandbox();
  const files = generatedFiles("1.2.3");
  const command = path.join(directory, "plugin", "bin", "layermap");
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(command, files["plugins/claude/bin/layermap"] ?? "");
  await chmod(command, 0o755);
  await writeFile(path.join(directory, "plugin", "cli.mjs"), files["plugins/claude/cli.mjs"] ?? "");
  await standIn(directory);
  const started = spawn(command, ["check", "--json", "--base", "HEAD~1"], {
    env: { ...process.env, LAYERMAP_HOME: path.join(directory, "cache") },
  });
  let stdout = "";
  started.stdout.on("data", (chunk) => (stdout += chunk));
  started.stdin.end("ping\n");
  const status = await new Promise((resolve) => started.on("exit", resolve));
  assert.equal(stdout, `check --json --base HEAD~1 in ${started.pid}: ping\n`);
  assert.equal(status, 3);
});

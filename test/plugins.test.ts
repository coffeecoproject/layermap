import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generatedFiles, MCP_NAME, PLUGIN_ASSETS } from "../scripts/plugins";
import { sandbox } from "./support";

const root = fileURLToPath(new URL("../", import.meta.url));

// The plugins and registry entry in the repository are what scripts/plugins.ts writes for this
// version: the note and tool approval stay in one place (src/agent/tools.ts), and the server comes
// from npm at that version.
test("the committed plugins, marketplaces and registry entry match the generator for this version", async () => {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const files = generatedFiles(version);
  for (const [file, content] of Object.entries(files))
    assert.equal(await readFile(path.join(root, file), "utf8"), content, file);
  // Both plugins start this version with the one launcher: Claude Code's from a file of its plugin,
  // Codex's as code, as Codex names no file of a plugin.
  const launcher = files["plugins/claude/server.mjs"] ?? "";
  assert.ok(launcher.includes(`const VERSION = ${JSON.stringify(version)};`));
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

// Claude Code starts the plugin's server with node, and the launcher runs the version it finds
// installed in the cache in the same process. A stand-in package echoes its arguments and input
// and exits with its own code.
test("the Claude Code plugin's server script runs the installed version in its own process", async () => {
  const directory = await sandbox();
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("1.2.3")["plugins/claude/server.mjs"] ?? "");
  const installed = path.join(directory, "cache", "versions", "1.2.3", "node_modules", "layermap");
  await mkdir(path.join(installed, "dist"), { recursive: true });
  await writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({ name: "layermap", version: "1.2.3", bin: { layermap: "dist/cli.mjs" } }),
  );
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
  const started = spawn(process.execPath, [server], {
    env: { ...process.env, LAYERMAP_CACHE: path.join(directory, "cache") },
  });
  let stdout = "";
  started.stdout.on("data", (chunk) => (stdout += chunk));
  started.stdin.end("ping\n");
  const status = await new Promise((resolve) => started.on("exit", resolve));
  assert.equal(stdout, `mcp in ${started.pid}: ping\n`);
  assert.equal(status, 3);
});

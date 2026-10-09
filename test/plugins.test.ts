import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
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
  assert.match(files["plugins/claude/server.mjs"] ?? "", /"layermap@\d+\.\d+\.\d+"/u);
  assert.match(files["plugins/codex/.mcp.json"] ?? "", /"layermap@\d+\.\d+\.\d+"/u);
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

// Claude Code starts the plugin's server with node, which starts npx: on Windows npm's .cmd shim,
// run through cmd.exe. A stand-in npx echoes its arguments and input and exits with its own code.
test("the Claude Code plugin's server script runs npx with the server's input and exit code", async () => {
  const directory = await sandbox();
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("1.2.3")["plugins/claude/server.mjs"] ?? "");
  const npx = path.join(directory, "npx.mjs");
  await writeFile(
    npx,
    `let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write(\`\${process.argv.slice(2).join(" ")}: \${input}\`);
  process.exit(3);
});
`,
  );
  if (process.platform === "win32")
    await writeFile(path.join(directory, "npx.cmd"), `@"${process.execPath}" "${npx}" %*\r\n`);
  else {
    await writeFile(
      path.join(directory, "npx"),
      `#!/bin/sh\nexec "${process.execPath}" "${npx}" "$@"\n`,
    );
    await chmod(path.join(directory, "npx"), 0o755);
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
  );
  const result = spawnSync(process.execPath, [server], {
    input: "ping\n",
    encoding: "utf8",
    env: { ...env, PATH: [directory, process.env.PATH].join(path.delimiter) },
  });
  assert.equal(result.stdout, "-y layermap@1.2.3 mcp: ping\n", result.stderr);
  assert.equal(result.status, 3);
});

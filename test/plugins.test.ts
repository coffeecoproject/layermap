import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generatedFiles, MCP_NAME, PLUGIN_ASSETS } from "../scripts/plugins";

const root = fileURLToPath(new URL("../", import.meta.url));

// The plugins and registry entry in the repository are what scripts/plugins.ts writes for this
// version: the note and tool approval stay in one place (src/agent/tools.ts), and the server comes
// from npm at that version.
test("the committed plugins, marketplaces and registry entry match the generator for this version", async () => {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const files = generatedFiles(version, {
    command: "npx",
    args: ["-y", `layermap@${version}`, "mcp"],
  });
  for (const [file, content] of Object.entries(files))
    assert.equal(await readFile(path.join(root, file), "utf8"), content, file);
  assert.match(files["plugins/claude/.mcp.json"] ?? "", /"layermap@\d+\.\d+\.\d+"/u);
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

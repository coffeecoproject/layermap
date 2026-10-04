import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pluginFiles } from "../scripts/plugins";

const root = fileURLToPath(new URL("../", import.meta.url));

// The plugins in the repository are what scripts/plugins.ts writes for this version: the note and
// tool approval stay in one place (src/agent/tools.ts), and the server comes from npm at that version.
test("the committed plugins and marketplaces match the generator for this version", async () => {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const files = pluginFiles(version, {
    command: "npx",
    args: ["-y", `layermap@${version}`, "mcp"],
  });
  for (const [file, content] of Object.entries(files))
    assert.equal(await readFile(path.join(root, file), "utf8"), content, file);
  assert.match(files["plugins/claude/.mcp.json"] ?? "", /"layermap@\d+\.\d+\.\d+"/u);
});

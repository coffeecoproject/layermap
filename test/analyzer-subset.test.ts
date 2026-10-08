import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import type { CodeIndexSource } from "../src/code-index-types";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { analyzers, project, sandbox, signal } from "./support";

test("an index built with only some languages answers queries on the maps it builds", async (t) => {
  const { root } = await project({
    "src/main.ts":
      "export function helper() {\n  return 1;\n}\n\nexport function main() {\n  return helper();\n}\n",
  });
  const store = new CodeIndexStore(
    openMapDatabase(
      mapDatabasePath(await sandbox(), root),
    ) as unknown as CodeIndexStore["database"],
  );
  const { typescript } = await analyzers();
  const index = new CodeIndex(
    store,
    undefined,
    new ProjectMapAnalyzer([new TypeScriptMapAnalyzer(typescript)]),
  );
  t.after(async () => {
    await index.quiesce();
    index.close();
    store.database.close();
  });
  const stat = await lstat(root, { bigint: true });
  const source: CodeIndexSource = {
    kind: "WORKTREE",
    projectRef: "layermap:subset",
    directory: { canonicalPath: root, device: String(stat.dev), inode: String(stat.ino) },
  };
  const outputBudget = { maxBytes: 96 * 1024, envelopeBytes: 0 };

  const { version } = await index.prepare(source, signal());
  const view = await index.query.viewMap(
    { version, path: ".", allowedPathPrefixes: ["."], outputBudget },
    signal(),
  );
  assert.match(view.text, /^PROJECT MAP · DIRECTORY \./u);
  assert.match(view.text, /src\//u);

  const references = await index.findReferences(
    {
      version,
      source,
      symbol: { path: path.posix.join("src", "main.ts"), name: "helper" },
      path: ".",
      maxResults: 20,
      allowedPathPrefixes: ["."],
      outputBudget,
    },
    signal(),
  );
  assert.ok(references.references.some((reference) => reference.anchor.path === "src/main.ts"));

  // An index of the full suite does not read a map the subset recorded as its own.
  const full = new CodeIndex(store);
  await assert.rejects(
    full.query.viewMap({ version, path: ".", allowedPathPrefixes: ["."], outputBudget }, signal()),
    { code: "PROJECT_EVIDENCE_INDEX_UNAVAILABLE" },
  );
});

import assert from "node:assert/strict";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import type { CodeIndexSource } from "../src/code-index-types";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import type { MapAnalyzerEvent } from "../src/project-map-language";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { analyzers, project, sandbox, signal } from "./support";

// An index of its own, as a host keeps one while it runs, recording what the analyzer does.
async function host(t: { after(fn: () => unknown): void }, events?: MapAnalyzerEvent[]) {
  const store = new CodeIndexStore(
    openMapDatabase(
      mapDatabasePath(await sandbox(), "speculative"),
    ) as unknown as CodeIndexStore["database"],
  );
  const index = new CodeIndex(
    store,
    undefined,
    new ProjectMapAnalyzer([new TypeScriptMapAnalyzer((await analyzers()).typescript)], (event) =>
      events?.push(event),
    ),
  );
  t.after(async () => {
    await index.quiesce();
    index.close();
    store.database.close();
  });
  const analysis = (version: string) =>
    String(
      store.database
        .prepare("SELECT analysis_digest FROM project_code_versions WHERE version_ref = ?")
        .get(version)?.analysis_digest,
    );
  return { index, analysis };
}

async function source(directory: string): Promise<CodeIndexSource> {
  const stat = await lstat(directory, { bigint: true });
  return {
    kind: "WORKTREE",
    projectRef: "test:speculative",
    directory: { canonicalPath: directory, device: String(stat.dev), inode: String(stat.ino) },
  };
}

const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true },
  include: ["src"],
});

// What the analyzer began while discovery ran, by the events of one build.
const beforeDiscovery = (events: readonly MapAnalyzerEvent[]) => {
  const configured = events.findIndex(
    (event) => event.operation === "CONFIGURE" && event.phase === "FINISHED",
  );
  assert.ok(configured >= 0, "discovery runs on every build of changed code");
  return events
    .slice(0, configured)
    .filter((event) => event.operation === "BUILD" && event.phase === "STARTED");
};

test("builds begun on the last configuration stand only where discovery confirms them", async (t) => {
  const { root } = await project({
    "tsconfig.json": JSON.stringify({
      files: [],
      references: [{ path: "a" }, { path: "b" }, { path: "c" }],
    }),
    "a/tsconfig.json": tsconfig,
    // a takes in a script its include leaves out by importing it, written so that the check of
    // module names misses it: only discovery then sees the configuration change.
    "a/src/a.ts":
      'import { x } from /* unseen */ "../scripts/x.ts";\nexport function a() {\n  return x();\n}\n',
    "a/scripts/x.ts": "export function x() {\n  return 1;\n}\n",
    "b/tsconfig.json": tsconfig,
    "b/src/b.ts": "export function b() {\n  return 2;\n}\n",
    "c/tsconfig.json": tsconfig,
    "c/src/c.ts": "export function c() {\n  return 3;\n}\n",
  });
  const events: MapAnalyzerEvent[] = [];
  const running = await host(t, events);
  await running.index.prepare(await source(root), signal());

  // Each map the running index builds is the one an index built from nothing makes.
  const same = async (edits: Record<string, string>) => {
    for (const [file, text] of Object.entries(edits)) await writeFile(path.join(root, file), text);
    events.length = 0;
    const { version } = await running.index.prepare(await source(root), signal());
    const fresh = await host(t);
    await fresh.index.prepare(await source(root), signal());
    assert.equal(running.analysis(version), fresh.analysis(version));
    return [...events];
  };

  // The script leaves a's project: the guess still has it there.
  const left = await same({ "a/src/a.ts": "export function a() {\n  return 1;\n}\n" });
  assert.ok(beforeDiscovery(left).length > 0, "the unseen import leaves the guess standing");
  // b takes in a's file: b's context keeps its ref, with more input.
  await same({
    "b/src/b.ts":
      'import { a } from /* unseen */ "../../a/src/a.ts";\nexport function b() {\n  return a();\n}\n',
  });
  // An import the check sees: nothing is begun before discovery.
  const imported = await same({
    "a/src/a.ts":
      'import { x } from "../scripts/x.ts";\nexport function a() {\n  return x() + 1;\n}\n',
  });
  assert.deepEqual(beforeDiscovery(imported), [], "a changed import waits for discovery");
  // Only a body of c changes: discovery confirms the guess, and only c's context is analyzed,
  // once, begun before discovery finished.
  const body = await same({ "c/src/c.ts": "export function c() {\n  return 4;\n}\n" });
  const builds = body.filter((event) => event.operation === "BUILD" && event.phase === "STARTED");
  assert.equal(builds.length, 1, "the contexts c shares nothing with are replayed, not built");
  assert.deepEqual(beforeDiscovery(body), builds, "c's context is built while discovery runs");
});

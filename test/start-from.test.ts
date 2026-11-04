import assert from "node:assert/strict";
import { cp, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import type { CodeIndexSource } from "../src/code-index-types";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import type { MapLanguageAnalyzer } from "../src/project-map-language";
import { PythonMapAnalyzer } from "../src/project-map-language-python";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { analyzers, FILES, project, sandbox, signal } from "./support";

type Host = Readonly<{
  index: CodeIndex;
  store: CodeIndexStore;
  reused: string[];
  sabotage: { replay: boolean };
  typescriptRuns: { count: number };
}>;

// A host's own store and index. With sabotage set, a replayed TypeScript context is analyzed as
// well, so the build conflicts with the parent's units.
async function host(t: { after(fn: () => unknown): void }): Promise<Host> {
  const store = new CodeIndexStore(
    openMapDatabase(
      mapDatabasePath(await sandbox(), "host"),
    ) as unknown as CodeIndexStore["database"],
  );
  const { typescript, python } = await analyzers();
  const sabotage = { replay: false };
  const typescriptRuns = { count: 0 };
  const ts = new TypeScriptMapAnalyzer(typescript);
  const sabotaged: MapLanguageAnalyzer = Object.assign(Object.create(ts), {
    analyze: (session: Parameters<MapLanguageAnalyzer["analyze"]>[0], abort: AbortSignal) => {
      typescriptRuns.count++;
      return ts.analyze(
        {
          ...session,
          reuse: (...args) => {
            const reused = session.reuse(...args);
            return sabotage.replay ? undefined : reused;
          },
        },
        abort,
      );
    },
  });
  const reused: string[] = [];
  const index = new CodeIndex(
    store,
    undefined,
    new ProjectMapAnalyzer([sabotaged, new PythonMapAnalyzer(python)], (event) => {
      if (event.operation === "REUSE") reused.push(event.contextRef);
    }),
  );
  t.after(async () => {
    await index.quiesce();
    index.close();
    store.database.close();
  });
  return { index, store, reused, sabotage, typescriptRuns };
}

async function source(directory: string, projectRef: string): Promise<CodeIndexSource> {
  const canonicalPath = await realpath(directory);
  const stat = await lstat(canonicalPath, { bigint: true });
  return {
    kind: "WORKTREE",
    projectRef,
    directory: { canonicalPath, device: String(stat.dev), inode: String(stat.ino) },
  };
}

// What a version's map holds: the digest of its whole analysis (contexts, coverage and units),
// then each file's unit, whose ref is the digest of its facts.
const units = (store: CodeIndexStore, version: string) => [
  String(
    store.database
      .prepare("SELECT analysis_digest FROM project_code_versions WHERE version_ref = ?")
      .get(version)?.analysis_digest,
  ),
  ...store.database
    .prepare(
      "SELECT path, unit_ref FROM project_map_version_units WHERE version_ref = ? ORDER BY path",
    )
    .all(version)
    .map((row) => `${row.path} ${row.unit_ref}`),
];

// A copy of the project in another directory, as a host makes one to work in.
async function copy(root: string, edits: Record<string, string> = {}) {
  const target = path.join(await sandbox(), "copy");
  await cp(root, target, { recursive: true });
  for (const [file, content] of Object.entries(edits))
    await writeFile(path.join(target, file), content);
  return target;
}

// The copy's map built from nothing, in a store of its own.
async function fresh(t: { after(fn: () => unknown): void }, directory: string) {
  const { index, store } = await host(t);
  const { version } = await index.prepare(await source(directory, "copy"), signal());
  return units(store, version);
}

test("a copy's map starts from its original's, reusing what did not change", async (t) => {
  const { root } = await project(FILES);
  const edited = await copy(root, {
    // The helper no longer calls the target.
    "src/helper.ts": "export function helper(value: number) {\n  return value + 1;\n}\n",
  });
  const same = await copy(root);
  const { index, store, reused } = await host(t);
  await index.prepare(await source(root, "original"), signal());
  assert.deepEqual(reused, []);

  const unchanged = await index.prepare(await source(same, "copy-same"), signal(), {
    startFromProjectRef: "original",
  });
  assert.equal(reused.length, 2, "both contexts are replayed from the original's map");
  assert.deepEqual(units(store, unchanged.version), await fresh(t, same));

  reused.length = 0;
  const changed = await index.prepare(await source(edited, "copy-edited"), signal(), {
    startFromProjectRef: "original",
  });
  assert.equal(reused.length, 1, "only the Python context is replayed; TypeScript changed");
  const built = units(store, changed.version);
  assert.deepEqual(built, await fresh(t, edited));
  assert.notDeepEqual(built, units(store, unchanged.version), "the edited file was analyzed");

  reused.length = 0;
  await index.prepare(await source(same, "unrelated"), signal());
  assert.deepEqual(
    reused,
    [],
    "without a project to start from, another project's map is not used",
  );
});

test("a copy whose replay conflicts with the original's map is built from nothing", async (t) => {
  const { root } = await project(FILES);
  const target = await copy(root);
  const { index, store, reused, sabotage, typescriptRuns } = await host(t);
  await index.prepare(await source(root, "original"), signal());
  sabotage.replay = true;
  typescriptRuns.count = 0;
  const { version } = await index.prepare(await source(target, "copy"), signal(), {
    startFromProjectRef: "original",
  });
  assert.ok(reused.length > 0, "the build first replayed from the original's map");
  assert.equal(typescriptRuns.count, 2, "the conflict repeated the build without a parent");
  assert.deepEqual(units(store, version), await fresh(t, target));
});

// Two projects that share a base configuration and no code.
const SIDES = {
  "tsconfig.base.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "a/tsconfig.json": JSON.stringify({ extends: "../tsconfig.base.json", include: ["src"] }),
  "a/src/a.ts": "export function a() {\n  return 1;\n}\n",
  "b/tsconfig.json": JSON.stringify({ extends: "../tsconfig.base.json", include: ["src"] }),
  "b/src/b.ts": "export function b() {\n  return 2;\n}\n",
};

test("a context is replayed though a context that changed reads the same configuration", async (t) => {
  const { root } = await project(SIDES);
  const edited = await copy(root, { "a/src/a.ts": "export function a() {\n  return 3;\n}\n" });
  const { index, store, reused, typescriptRuns } = await host(t);
  await index.prepare(await source(root, "original"), signal());
  typescriptRuns.count = 0;
  const { version } = await index.prepare(await source(edited, "copy"), signal(), {
    startFromProjectRef: "original",
  });
  assert.equal(reused.length, 1, "the other side is replayed");
  assert.equal(typescriptRuns.count, 1, "nothing conflicted");
  assert.deepEqual(units(store, version), await fresh(t, edited));
});

test("a context that comes to read a replayed context's code is built from nothing", async (t) => {
  const { root } = await project(SIDES);
  const edited = await copy(root, {
    "a/src/a.ts": 'import { b } from "../../b/src/b";\n\nexport function a() {\n  return b();\n}\n',
  });
  const { index, store, reused, typescriptRuns } = await host(t);
  await index.prepare(await source(root, "original"), signal());
  typescriptRuns.count = 0;
  const { version } = await index.prepare(await source(edited, "copy"), signal(), {
    startFromProjectRef: "original",
  });
  assert.ok(reused.length > 0, "the build first replayed the other side");
  assert.equal(typescriptRuns.count, 2, "the conflict repeated the build without a parent");
  assert.deepEqual(units(store, version), await fresh(t, edited));
});

test("a context is replayed when a file discovery gave it, but it does not read, changed", async (t) => {
  // Discovery resolves this import under the inferred project's options; the analysis, in a package
  // of ES modules, does not.
  const { root } = await project({
    "package.json": JSON.stringify({ type: "module" }),
    "a/tsconfig.json": JSON.stringify({ include: ["src"] }),
    "a/src/lib.ts": "export function lib() {\n  return 1;\n}\n",
    "scripts/run.ts": 'import { lib } from "../a/src/lib";\n\nexport const run = lib;\n',
  });
  const edited = await copy(root, { "a/src/lib.ts": "export function lib() {\n  return 2;\n}\n" });
  const { index, store, reused, typescriptRuns } = await host(t);
  await index.prepare(await source(root, "original"), signal());
  typescriptRuns.count = 0;
  const { version } = await index.prepare(await source(edited, "copy"), signal(), {
    startFromProjectRef: "original",
  });
  assert.equal(reused.length, 1, "the inferred context is replayed");
  assert.equal(typescriptRuns.count, 1, "nothing conflicted");
  assert.deepEqual(units(store, version), await fresh(t, edited));
});

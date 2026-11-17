import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MapProjectImports } from "../src/project-map-imports";
import { openMap, project, sharedCache, signal } from "./support";

const run = promisify(execFile);
// Run from the project mapped, which does not have tsx: load it by where this package has it.
const tsx = import.meta.resolve("tsx");

// Code whose imports reach a file directly, through a path alias, for types only and when called;
// some reach no file. Tests and fixtures import the code too.
const FILES = {
  "package.json": JSON.stringify({ type: "module" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, paths: { "@/*": ["./src/*"] } },
    include: ["src", "fixtures"],
  }),
  "src/app.ts": [
    'import { store } from "./store";',
    'import { format } from "@/format";',
    'import type { Id } from "./types";',
    'import { gone } from "@/gone";',
    'import "./app.css";',
    "",
    'export const load = (id: Id) => import("./lazy").then(() => format(store(id)) + gone);',
    "",
  ].join("\n"),
  "src/store.ts": "export const store = (id: number) => id;\n",
  "src/format.ts": "export const format = (value: number) => String(value);\n",
  "src/types.ts": "export type Id = number;\n",
  "src/lazy.ts": "export const lazy = 1;\n",
  "src/app.css": "body {}\n",
  "src/app.test.ts": 'import { load } from "./app";\n\nexport const tested = load;\n',
  "fixtures/sample.ts":
    'import { store } from "../src/store";\n\nexport function sample() {\n  return import("../src/lazy").then(() => store(1));\n}\n',
};

test("the project's imports are every import of its code by line, with why those reaching no file do not", async () => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  try {
    const { imports, unresolved } = await map.imports(signal());
    assert.deepEqual(imports, [
      { from: "src/app.ts", line: 1, to: "src/store.ts", specifier: "./store" },
      { from: "src/app.ts", line: 2, to: "src/format.ts", specifier: "@/format" },
      { from: "src/app.ts", line: 3, to: "src/types.ts", specifier: "./types" },
      { from: "src/app.ts", line: 7, to: "src/lazy.ts", specifier: "./lazy" },
    ]);
    assert.deepEqual(unresolved, [
      { from: "src/app.ts", line: 4, specifier: "@/gone", reason: "SYMBOL_NOT_RESOLVED" },
      { from: "src/app.ts", line: 5, specifier: "./app.css", reason: "SYMBOL_NOT_RESOLVED" },
    ]);
  } finally {
    await map.close();
  }
});

test("the project's imports are those of the working tree, changes not committed included", async () => {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  await write(
    "src/store.ts",
    'import { format } from "./format";\n\nexport const store = format;\n',
  );
  const map = await openMap(root);
  try {
    const { imports } = await map.imports(signal());
    assert.ok(
      imports.some((item) => item.from === "src/store.ts" && item.to === "src/format.ts"),
      "the import the working tree adds is there",
    );
  } finally {
    await map.close();
  }
});

test("a test file's imports read as a test's wherever the map takes the file for a test", async () => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  try {
    const page = await map.explore(
      { path: "fixtures/sample.ts", name: "sample", direction: "OUTGOING", includeTests: true },
      signal(),
    );
    assert.match(page.text, /test imports .*src\/lazy\.ts/u);
  } finally {
    await map.close();
  }
});

test("layermap imports --json prints only the JSON on stdout", async () => {
  const { root } = await project(FILES);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const { stdout } = await run(process.execPath, ["--import", tsx, cli, "imports", "--json"], {
    cwd: root,
    env: { ...process.env, LAYERMAP_CACHE: sharedCache },
  });
  const data = JSON.parse(stdout) as MapProjectImports;
  assert.equal(data.imports.length, 4);
  assert.equal(data.unresolved.length, 2);
});

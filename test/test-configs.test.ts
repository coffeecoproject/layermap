import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);

// The application's tsconfig leaves its tests out, as one that builds for release does; a second
// one beside it, which the test runner and the type check of the tests use, takes them in. The
// package is an ES module, so the relative imports without an extension resolve only under the
// project's own module settings.
const FILES = {
  "package.json": JSON.stringify({ name: "app", type: "module" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" },
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts", "tests/**/*.ts"],
  }),
  "tsconfig.test.json": JSON.stringify({
    extends: "./tsconfig.json",
    include: ["src/**/*.ts", "tests/**/*.ts"],
    exclude: [],
  }),
  "src/target.ts": "export function target(value: number): number {\n  return value * 2;\n}\n",
  "src/target.test.ts":
    'import { target } from "./target";\n\nexport function beside() {\n  return target(1);\n}\n',
  "tests/target.test.ts":
    'import { target } from "../src/target";\n\nexport function apart() {\n  return target(2);\n}\n',
};

test("tests that only another tsconfig of the project holds are read under that one", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  const { text } = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 1, includeTests: true },
    signal(),
  );
  assert.match(text, /← called by src\/target\.test\.ts: beside f3-5 @4$/mu);
  assert.match(text, /← called by tests\/target\.test\.ts: apart f3-5 @4$/mu);
  for (const path of ["src/target.test.ts", "tests/target.test.ts"])
    assert.doesNotMatch((await map.explore({ path }, signal())).text, /UNRESOLVED IMPORTS/u);
});

test("a base tsconfig that every package extends does not take in the files outside them", async (t) => {
  const INFERRED = /files outside a tsconfig use inferred settings/u;
  const { root } = await project({
    // No include: the compiler takes in every file below it, those of each package among them.
    "tsconfig.base.json": JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" },
    }),
    "packages/a/package.json": JSON.stringify({ name: "a", type: "module" }),
    "packages/a/tsconfig.json": JSON.stringify({
      extends: "../../tsconfig.base.json",
      include: ["src"],
    }),
    "packages/a/src/target.ts": FILES["src/target.ts"],
    "scripts/tool.ts": "export const tool = 1;\n",
    // A test beside the scripts imports a JavaScript module, which only inferred settings read.
    "scripts/guard.mjs": "export function guard(value) {\n  return value > 0;\n}\n",
    "scripts/guard.test.ts":
      'import { guard } from "./guard.mjs";\n\nexport function positive() {\n  return guard(1);\n}\n',
  });
  const map = await openMap(root);
  t.after(() => map.close());
  // The script and the test stay under inferred settings rather than open a program of the whole
  // project under the base's options.
  assert.match((await map.explore({ path: "." }, signal())).text, INFERRED);
  const guard = (await map.explore({ path: "scripts/guard.test.ts" }, signal())).text;
  assert.doesNotMatch(guard, /UNRESOLVED IMPORTS/u, guard);
  assert.match(guard, /scripts\/guard\.mjs/u, guard);
});

test("a test tsconfig at the root of a monorepo holds the tests every package leaves out", async (t) => {
  const PACKAGE = {
    compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" },
    include: ["src"],
    exclude: ["src/**/*.test.ts"],
  };
  const { root } = await project({
    "tsconfig.base.json": JSON.stringify({ compilerOptions: PACKAGE.compilerOptions }),
    // The test runner's configuration takes in the sources and tests of every package.
    "tsconfig.test.json": JSON.stringify({
      extends: "./tsconfig.base.json",
      include: ["packages/*/src", "packages/*/tests"],
    }),
    "packages/a/package.json": JSON.stringify({ name: "a", type: "module" }),
    "packages/a/tsconfig.json": JSON.stringify(PACKAGE),
    "packages/a/src/target.ts": FILES["src/target.ts"],
    "packages/a/src/target.test.ts": FILES["src/target.test.ts"],
    "packages/a/tests/target.test.ts": FILES["tests/target.test.ts"],
    "scripts/tool.ts": "export const tool = 1;\n",
  });
  const map = await openMap(root);
  t.after(() => map.close());
  const { text } = await map.explore(
    {
      path: "packages/a/src/target.ts",
      name: "target",
      direction: "INCOMING",
      depth: 1,
      includeTests: true,
    },
    signal(),
  );
  assert.match(text, /← called by packages\/a\/src\/target\.test\.ts: beside f3-5 @4$/mu);
  assert.match(text, /← called by packages\/a\/tests\/target\.test\.ts: apart f3-5 @4$/mu);
  // A script is not a test: it stays under inferred settings.
  assert.match(
    (await map.explore({ path: "." }, signal())).text,
    /files outside a tsconfig use inferred settings/u,
  );
});

test("a change check finds the tests another tsconfig holds by their calls", async (t) => {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/target.ts", FILES["src/target.ts"].replace("* 2", "* 3"));
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /^ {2}src\/target\.test\.ts: beside \(calls target\)$/mu);
  assert.match(text, /^ {2}tests\/target\.test\.ts: apart \(calls target\)$/mu);
});

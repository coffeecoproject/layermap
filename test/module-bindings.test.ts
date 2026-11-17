import assert from "node:assert/strict";
import { test } from "node:test";
import { openMap, project, signal } from "./support";

// A module's functions taken apart from its namespace: loaded on demand, or imported whole.
const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  "src/mod.ts":
    "export function foo() {\n  return 1;\n}\nexport function bar() {\n  return 2;\n}\nexport { foo as again };\n",
  "src/dynamic.ts":
    'export async function dynamic() {\n  const { foo: f } = await import("./mod");\n  return f();\n}\n',
  "src/later.ts":
    'export function later() {\n  return import("./mod").then(({ bar }) => bar());\n}\n',
  "src/whole.ts":
    'import * as ns from "./mod";\n\nexport function whole() {\n  const { again } = ns;\n  return again();\n}\n',
  // An object that is not a module: what is taken from it stays a binding of its own.
  "src/plain.ts":
    "const handlers = {\n  foo() {\n    return 3;\n  },\n};\n\nexport function plain() {\n  const { foo } = handlers;\n  return foo();\n}\n",
};

test("a function taken apart from a module's namespace is called where the binding is", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  const callers = async (name: string) =>
    (await map.explore({ path: "src/mod.ts", name, direction: "INCOMING", depth: 1 }, signal()))
      .text;
  const foo = await callers("foo");
  assert.match(foo, /← called by src\/dynamic\.ts: dynamic/u);
  // Through the export's other name.
  assert.match(foo, /← called by src\/whole\.ts: whole/u);
  assert.doesNotMatch(foo, /plain/u);
  assert.match(await callers("bar"), /← called by src\/later\.ts: /u);
  const plain = await map.explore(
    { path: "src/plain.ts", name: "plain", direction: "OUTGOING", depth: 1 },
    signal(),
  );
  assert.match(plain.text, /→ trace stops: foo @9 \(function value\)/u);
});

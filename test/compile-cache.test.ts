import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import { openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import type { MapAnalyzerEvent } from "../src/project-map-language";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { analyzers, openMap, project, sandbox, signal } from "./support";

const run = promisify(execFile);
const commit = async (root: string) => {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
};

// The compiles the TypeScript analyzer is asked for, counted across every map in this process.
const asked = { DIAGNOSTICS: 0, REFERENCES: 0 };
const typescript = TypeScriptMapAnalyzer.prototype;
const { diagnostics, references } = typescript;
typescript.diagnostics = function (...args) {
  asked.DIAGNOSTICS++;
  return diagnostics.apply(this, args);
};
typescript.references = function (...args) {
  asked.REFERENCES++;
  return references.apply(this, args);
};
const counted = async <T>(work: () => Promise<T>) => {
  asked.DIAGNOSTICS = 0;
  asked.REFERENCES = 0;
  const result = await work();
  return { result, asked: { ...asked } };
};

const ORDER = "export class Order {\n  total: number = 1;\n  note?: string;\n}\n";
const FILES = {
  ".gitignore": "node_modules/\n",
  "README.md": "Orders.\n",
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ["src"],
  }),
  "node_modules/price/package.json": JSON.stringify({
    name: "price",
    version: "1.0.0",
    types: "index.d.ts",
  }),
  "node_modules/price/index.d.ts": "export function price(): number;\n",
  "src/order.ts": ORDER,
  "src/total.ts":
    'import type { Order } from "./order";\nimport { price } from "price";\n\nexport function total(order: Order): number {\n  return order.total + price();\n}\n',
  "src/label.ts":
    'import type { Order } from "./order";\n\nexport function label(order: Order): string {\n  const total: number = order.total;\n  return String(total);\n}\n',
};

test("a check of the same inputs starts no compile, and every check says what a fresh one says", async (t) => {
  const { root, write } = await project(FILES);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  // The check of the working tree as it is, by a map that has stored nothing yet.
  const fresh = async () => {
    const other = await openMap(root);
    try {
      return (await other.checkChanges({}, signal())).text;
    } finally {
      await other.close();
    }
  };
  const check = () => counted(async () => (await map.checkChanges({}, signal())).text);

  // A field's value and type change: its users are traced and both sides compiled.
  await write("src/order.ts", ORDER.replace("total: number = 1", 'total: string = "1"'));
  const first = await check();
  assert.ok(first.asked.DIAGNOSTICS > 0 && first.asked.REFERENCES > 0, "the first check compiles");
  assert.match(first.result, /src\/label\.ts:4 TS2322 /u);
  assert.equal(first.result, await fresh());

  // Nothing changed: the stored compiles answer.
  const again = await check();
  assert.deepEqual(again.asked, { DIAGNOSTICS: 0, REFERENCES: 0 });
  assert.equal(again.result, first.result);

  // A file no compile reads changes: the map is another version, whose compiles read the same.
  await write("README.md", "Orders and their totals.\n");
  const readme = await check();
  assert.deepEqual(readme.asked, { DIAGNOSTICS: 0, REFERENCES: 0 });
  assert.equal(readme.result, await fresh());

  // Another file changes: the working tree is compiled again, the base is not.
  await write("src/total.ts", FILES["src/total.ts"].replace("+ price()", "+ price() * 2"));
  const edited = await check();
  assert.equal(edited.asked.DIAGNOSTICS, 1, "only the working tree's context is compiled");
  assert.equal(edited.result, await fresh());

  // The installed package goes: what was stored while it was there does not stand.
  await rm(path.join(root, "node_modules/price"), { recursive: true });
  const installed = await check();
  assert.ok(installed.asked.DIAGNOSTICS > 0, "a change to what is installed compiles again");
  assert.notEqual(installed.result, edited.result);
  assert.match(installed.result, /\bprice\b/u);
  assert.equal(installed.result, await fresh());

  // Back to an earlier state: its stored compiles answer again.
  await write("node_modules/price/package.json", FILES["node_modules/price/package.json"]);
  await write("node_modules/price/index.d.ts", FILES["node_modules/price/index.d.ts"]);
  const back = await check();
  assert.deepEqual(back.asked, { DIAGNOSTICS: 0, REFERENCES: 0 });
  assert.equal(back.result, edited.result);
});

test("a map built in another process starts from the configuration the previous map discovered", async () => {
  const { root } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/a.ts": 'import { b } from "./b";\nexport function a() {\n  return b();\n}\n',
    "src/b.ts": "export function b() {\n  return 1;\n}\n",
    "README.md": "One.\n",
  });
  const database = path.join(await sandbox(), "map.sqlite");
  const { typescript: resources } = await analyzers();
  // Each build by an index of its own on the same database, as a process opening the map does.
  const build = async () => {
    const store = new CodeIndexStore(
      openMapDatabase(database) as unknown as CodeIndexStore["database"],
    );
    const events: MapAnalyzerEvent[] = [];
    const index = new CodeIndex(
      store,
      undefined,
      new ProjectMapAnalyzer([new TypeScriptMapAnalyzer(resources)], (event) => events.push(event)),
    );
    try {
      const stat = await lstat(root, { bigint: true });
      await index.prepare(
        {
          kind: "WORKTREE",
          projectRef: "test:compile-cache",
          directory: { canonicalPath: root, device: String(stat.dev), inode: String(stat.ino) },
        },
        signal(),
      );
    } finally {
      await index.quiesce();
      index.close();
      store.database.close();
    }
    return events.filter((event) => event.phase === "STARTED" || event.phase === "FINISHED");
  };
  const discovers = (events: readonly MapAnalyzerEvent[]) =>
    events.some((event) => event.operation === "CONFIGURE");
  assert.ok(discovers(await build()), "the first map discovers its configuration");

  // Only a file TypeScript does not read changed: the configuration stands without discovery.
  await writeFile(path.join(root, "README.md"), "Two.\n");
  assert.ok(!discovers(await build()), "the stored configuration answers");

  // Only a body changed: the context is built while discovery runs.
  await writeFile(path.join(root, "src/b.ts"), "export function b() {\n  return 2;\n}\n");
  const body = await build();
  const discovered = body.findIndex(
    (event) => event.operation === "CONFIGURE" && event.phase === "FINISHED",
  );
  assert.ok(discovered >= 0, "changed code is discovered again");
  assert.ok(
    body
      .slice(0, discovered)
      .some((event) => event.operation === "BUILD" && event.phase === "STARTED"),
    "the build begins on the stored configuration before discovery finishes",
  );
});

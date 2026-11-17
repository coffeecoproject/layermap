import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MapChangesData } from "../src/project-map-changes";
import { openMap, project, sharedCache, signal } from "./support";

const run = promisify(execFile);
// Run from the project checked, which does not have tsx: load it by where this package has it.
const tsx = import.meta.resolve("tsx");
const commit = (root: string) =>
  run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "base"], {
    cwd: root,
  });

const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src", "test"] }),
  "src/store.ts": "export function markRead(id: number) {\n  return id;\n}\n",
  "src/other.ts": "export function other() {\n  return 1;\n}\n",
  "test/store.test.ts":
    'import { markRead } from "../src/store";\n\nexport function testMarkRead() {\n  return markRead(2);\n}\n',
  "test/other.test.ts":
    'import { other } from "../src/other";\n\nexport function testOther() {\n  return other();\n}\n',
  "test/format.test.ts": "export function testFormat() {\n  return 1;\n}\n",
  "config.yaml": "retries: 3\n",
};

async function changed() {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  await write("src/store.ts", "export function markRead(id: number) {\n  return id + 1;\n}\n");
  await write("test/format.test.ts", "export function testFormat() {\n  return 2;\n}\n");
  await write("config.yaml", "retries: 5\n");
  return root;
}

test("the check as JSON gives the related tests by rank and the changed files the map does not follow", async (t) => {
  const root = await changed();
  const map = await openMap(root);
  t.after(() => map.close());

  const data = JSON.parse(
    (await map.checkChanges({ format: "json" }, signal())).text,
  ) as MapChangesData;
  assert.equal(data.base, "HEAD");
  assert.match(data.commit, /^[0-9a-f]{40}$/u);
  assert.deepEqual(data.files.map(({ path, status }) => `${status} ${path}`).sort(), [
    "MODIFIED config.yaml",
    "MODIFIED src/store.ts",
    "MODIFIED test/format.test.ts",
  ]);
  // The test calling the change, and the test the diff changed itself; not the unrelated one.
  const store = data.tests.find((item) => item.path === "test/store.test.ts");
  assert.ok(store && store.rank < 4, JSON.stringify(data.tests));
  assert.deepEqual(store.names, ["testMarkRead"]);
  assert.deepEqual(
    data.tests.find((item) => item.path === "test/format.test.ts"),
    { path: "test/format.test.ts", names: [], why: "changed in this diff", rank: 1 },
  );
  assert.ok(!data.tests.some((item) => item.path === "test/other.test.ts"));
  // Closest first.
  assert.deepEqual(
    data.tests.map((item) => item.rank),
    [...data.tests.map((item) => item.rank)].sort((a, b) => a - b),
  );
  assert.deepEqual(data.unmapped, [{ path: "config.yaml", kind: "configuration" }]);
  assert.ok(
    data.checkByHand.includes("config.yaml changed (configuration): its effects are not mapped"),
  );
  assert.equal(data.truncated, false);
  assert.equal(data.untested, undefined);

  // The same tests the text names.
  const text = (await map.checkChanges({}, signal())).text;
  for (const item of data.tests.filter((test) => test.rank < 4))
    assert.match(
      text.slice(text.indexOf("RELATED TESTS")),
      new RegExp(item.path.replace(/\./gu, "\\.")),
    );

  const given = JSON.parse(
    (await map.checkChanges({ format: "json", tests: ["test/other.test.ts"] }, signal())).text,
  ) as MapChangesData;
  assert.deepEqual(given.untested?.changed, ["src/store.ts: markRead f1-3"]);
  // The project's own test that runs it, which the given one does not.
  assert.deepEqual(given.untested?.runByOthers, [
    { declaration: "src/store.ts: markRead f1-3", tests: ["test/store.test.ts"] },
  ]);

  // The report comes with the same check as data, for a host that acts on it.
  const report = await map.checkChanges({ tests: ["test/other.test.ts"] }, signal());
  assert.match(report.text, /NOT REACHED BY THE GIVEN TESTS/u);
  assert.match(report.text, /src\/store\.ts: markRead f1-3 ← test\/store\.test\.ts/u);
  assert.deepEqual(report.data, given);
});

test("every changed file the map does not follow is unmapped, migrations with mapped code too", async (t) => {
  const { root, write } = await project({
    ...FILES,
    "src/db/migrations/001_orders.ts": "export function up() {\n  return 1;\n}\n",
    "scripts/deploy.sh": "echo 1\n",
    "scripts/old.sh": "echo old\n",
    "styles/app.wxss": ".a { color: red; }\n",
    "data/plans.json": '{ "plans": 1 }\n',
    "assets/logo.png": "\u0000\u0001png",
    "README.md": "# app\n",
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  await write("src/store.ts", "export function markRead(id: number) {\n  return id + 1;\n}\n");
  await write("src/db/migrations/001_orders.ts", "export function up() {\n  return 2;\n}\n");
  await write("scripts/deploy.sh", "echo 2\n");
  await rm(path.join(root, "scripts/old.sh"));
  await write("styles/app.wxss", ".a { color: blue; }\n");
  await write("data/plans.json", '{ "plans": 2 }\n');
  await write("assets/logo.png", "\u0000\u0002png");
  await write("README.md", "# app 2\n");
  const map = await openMap(root);
  t.after(() => map.close());

  const data = JSON.parse(
    (await map.checkChanges({ format: "json" }, signal())).text,
  ) as MapChangesData;
  // The service code still selects its test; the rest widens the check. Documentation does not.
  assert.ok(data.tests.some((item) => item.path === "test/store.test.ts"));
  assert.deepEqual(
    [...data.unmapped].sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "assets/logo.png", kind: "binary file" },
      { path: "data/plans.json", kind: "unanalyzed file" },
      { path: "scripts/deploy.sh", kind: "shell script" },
      { path: "scripts/old.sh", kind: "shell script" },
      { path: "src/db/migrations/001_orders.ts", kind: "database migration or schema" },
      { path: "styles/app.wxss", kind: "style sheet" },
    ],
  );
  assert.ok(
    data.checkByHand.includes("scripts/old.sh deleted (shell script): its effects are not mapped"),
  );
});

test("layermap check --json prints only the JSON on stdout", async () => {
  const root = await changed();
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, LAYERMAP_CACHE: sharedCache };
  const { stdout } = await run(process.execPath, ["--import", tsx, cli, "check", "--json"], {
    cwd: root,
    env,
  });
  const data = JSON.parse(stdout) as MapChangesData;
  assert.deepEqual(data.unmapped, [{ path: "config.yaml", kind: "configuration" }]);
  assert.ok(data.tests.some((item) => item.path === "test/store.test.ts"));

  await assert.rejects(
    run(process.execPath, ["--import", tsx, cli, "search", "markRead", "--json"], {
      cwd: root,
      env,
    }),
    (error: { code?: number }) => error.code === 1,
  );
});

// Two features and the billing code they use: through its entry, or around it.
const MODULES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  "src/billing/index.ts": 'export { charge } from "./charge";\n',
  "src/billing/charge.ts": "export function charge(amount: number) {\n  return amount;\n}\n",
  "src/billing/rate.ts": "export function rate() {\n  return 2;\n}\n",
  "src/util.ts": "export function one() {\n  return 1;\n}\n",
  "src/orders/order.ts":
    'import { charge } from "../billing";\n\nexport function order() {\n  return charge(1);\n}\n',
  "src/booking/book.ts":
    'import { one } from "../util";\n\nexport function book() {\n  return one();\n}\n',
};

async function edges(
  changes: Record<string, string>,
  files: Record<string, string> = MODULES,
  change?: (root: string) => Promise<void>,
) {
  const { root, write } = await project(files);
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  await change?.(root);
  for (const [name, content] of Object.entries(changes)) await write(name, content);
  const map = await openMap(root);
  try {
    return (
      JSON.parse((await map.checkChanges({ format: "json" }, signal())).text) as MapChangesData
    ).edges;
  } finally {
    await map.close();
  }
}

test("the check as JSON gives the imports and calls the change adds and removes between files", async () => {
  const found = await edges({
    "src/booking/book.ts":
      'import { rate } from "../billing/rate";\nimport { charge } from "../billing/charge";\n\nexport function book() {\n  return charge(rate());\n}\n',
    "src/billing/charge.ts": "export function charge(amount: number) {\n  return amount * 2;\n}\n",
  });
  assert.deepEqual(found.imports, [
    { from: "src/booking/book.ts", to: "src/billing/rate.ts", line: 1, change: "ADDED" },
    { from: "src/booking/book.ts", to: "src/util.ts", line: 1, change: "REMOVED" },
    { from: "src/booking/book.ts", to: "src/billing/charge.ts", line: 2, change: "ADDED" },
  ]);
  assert.deepEqual(found.calls, [
    {
      from: "src/booking/book.ts",
      line: 5,
      to: "src/billing/charge.ts",
      declaration: "charge",
      exported: true,
    },
    {
      from: "src/booking/book.ts",
      line: 5,
      to: "src/billing/rate.ts",
      declaration: "rate",
      exported: true,
    },
  ]);
  // The existing code the change rewrote, and who calls it on either side.
  assert.deepEqual(found.declarations, [
    {
      path: "src/billing/charge.ts",
      declaration: "charge",
      line: 1,
      exported: true,
      callersBefore: ["src/orders/order.ts"],
      callersAfter: ["src/booking/book.ts", "src/orders/order.ts"],
    },
    {
      path: "src/booking/book.ts",
      declaration: "book",
      line: 4,
      exported: true,
      callersBefore: [],
      callersAfter: [],
    },
  ]);
  assert.equal(found.truncated, false);
});

test("without the base map, what changed files do on the lines the diff left is what they did", async () => {
  // Lines added alone: the check builds no base map.
  const found = await edges({
    "src/booking/book.ts":
      'import { rate } from "../billing/rate";\nimport { one } from "../util";\n\nexport function book() {\n  return one();\n}\n\nexport function rebook() {\n  return rate();\n}\n',
    "src/billing/charge.ts":
      "export function charge(amount: number) {\n  console.log(amount);\n  return amount;\n}\n",
  });
  assert.deepEqual(found.imports, [
    { from: "src/booking/book.ts", to: "src/billing/rate.ts", line: 1, change: "ADDED" },
  ]);
  assert.deepEqual(
    found.calls.map(({ from, to, declaration }) => `${from} → ${to} ${declaration}`),
    ["src/booking/book.ts → src/billing/rate.ts rate"],
  );
  // The new function is no existing code; the one the diff added a line to is.
  assert.deepEqual(found.declarations, [
    {
      path: "src/billing/charge.ts",
      declaration: "charge",
      line: 1,
      exported: true,
      callersBefore: ["src/orders/order.ts"],
      callersAfter: ["src/orders/order.ts"],
    },
  ]);
});

test("without the base map, a file imported or called again on a new line is no new edge", async () => {
  const found = await edges({
    // Lines added alone: a second import of a file the code imported, and a function calling
    // what the code already called, ahead of the old call.
    "src/booking/book.ts":
      'import type { Sum } from "../util";\nimport { one } from "../util";\n\nexport function first(): Sum {\n  return one();\n}\n\nexport function book() {\n  return one();\n}\n',
    "src/util.ts": "export type Sum = number;\nexport function one() {\n  return 1;\n}\n",
  });
  assert.deepEqual(found.imports, []);
  assert.deepEqual(found.calls, []);
});

test("the edges follow renamed files, read deleted ones in the base and leave the tests out", async () => {
  const found = await edges(
    {
      "src/booking/quote.ts":
        'import { rate } from "../billing/rates";\n\nexport function quote() {\n  return rate();\n}\n',
      // A test reaching around the billing entry is the related tests' business, not an edge.
      "src/booking/book.test.ts":
        'import { charge } from "../billing/charge";\n\nexport function testBook() {\n  return charge(1);\n}\n',
    },
    {
      ...MODULES,
      "src/booking/quote.ts":
        'import { rate } from "../billing/rate";\n\nexport function quote() {\n  return rate();\n}\n',
      "src/booking/old.ts":
        'import { one } from "../util";\n\nexport function old() {\n  return one();\n}\n',
      "src/booking/book.test.ts": "export function testBook() {\n  return 1;\n}\n",
    },
    async (root) => {
      await run("git", ["mv", "src/billing/rate.ts", "src/billing/rates.ts"], { cwd: root });
      await rm(path.join(root, "src/booking/old.ts"));
    },
  );
  // The import of the renamed file is the one the base had; the deleted file's are gone.
  assert.deepEqual(found.imports, [
    { from: "src/booking/old.ts", to: "src/util.ts", line: 1, change: "REMOVED" },
  ]);
  assert.deepEqual(found.calls, []);
  assert.deepEqual(found.declarations, []);
});

test("the edges of a Python change", async () => {
  const found = await edges(
    {
      "booking/book.py":
        "from billing.charge import charge\n\n\ndef book():\n    return charge(2)\n",
      "billing/charge.py": "def charge(amount):\n    return amount * 2\n",
    },
    {
      "billing/charge.py": "def charge(amount):\n    return amount\n",
      "orders/order.py":
        "from billing.charge import charge\n\n\ndef order():\n    return charge(1)\n",
      "booking/book.py": "def book():\n    return 1\n",
    },
  );
  assert.deepEqual(found.imports, [
    { from: "booking/book.py", to: "billing/charge.py", line: 1, change: "ADDED" },
  ]);
  assert.deepEqual(found.calls, [
    {
      from: "booking/book.py",
      line: 5,
      to: "billing/charge.py",
      declaration: "charge",
      exported: true,
    },
  ]);
  assert.deepEqual(
    found.declarations.map(({ path, declaration, callersBefore, callersAfter }) => ({
      path,
      declaration,
      callersBefore,
      callersAfter,
    })),
    [
      {
        path: "billing/charge.py",
        declaration: "charge",
        callersBefore: ["orders/order.py"],
        callersAfter: ["booking/book.py", "orders/order.py"],
      },
      { path: "booking/book.py", declaration: "book", callersBefore: [], callersAfter: [] },
    ],
  );
});

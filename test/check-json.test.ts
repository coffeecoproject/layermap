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

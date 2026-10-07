import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseMapDiff } from "../src/project-map-changes";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);
const commit = (root: string) =>
  run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "base"], {
    cwd: root,
  });

const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src", "test"] }),
  "src/store.ts":
    "export function markRead(id: number) {\n  return id;\n}\n\nexport function legacy() {\n  return 1;\n}\n",
  "src/routes.ts": `import { legacy, markRead } from "./store";
declare const router: { get(path: string, h: unknown): void; put(path: string, h: unknown): void };
router.put("/feeds/:id/read", () => markRead(1));
export function oldHandler() {
  return legacy();
}
router.get("/old", oldHandler);
`,
  "test/store.test.ts":
    'import { markRead } from "../src/store";\n\nexport function testMarkRead() {\n  return markRead(2);\n}\n',
  "test/feeds.spec.ts": 'export const path = "/feeds/7/read";\n',
  "config.yaml": "retries: 3\n",
  "app/billing/service.py": "def charge(amount):\n    return amount\n",
  "tests/billing/test_charge.py": "def test_charge():\n    assert True\n",
};

test("git diff hunks become changed line ranges on both sides", () => {
  const files = parseMapDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,2 +3,3 @@ x",
      "@@ -10 +11,0 @@ y",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "@@ -1 +1 @@",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "@@ -1,4 +0,0 @@",
    ].join("\n"),
  );
  assert.deepEqual(files, [
    {
      path: "src/a.ts",
      basePath: "src/a.ts",
      status: "MODIFIED",
      lines: [
        [3, 5],
        [11, 12],
      ],
      baseLines: [
        [3, 4],
        [10, 10],
      ],
      binary: false,
    },
    {
      path: "new.ts",
      basePath: "old.ts",
      status: "RENAMED",
      lines: [[1, 1]],
      baseLines: [[1, 1]],
      binary: false,
    },
    {
      path: "gone.ts",
      basePath: "gone.ts",
      status: "DELETED",
      lines: [[1, 1]],
      baseLines: [[1, 4]],
      binary: false,
    },
  ]);
});

test("a change lists the routes it reaches, removed declarations, unmapped files and related tests", async (t) => {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  assert.match((await map.checkChanges({}, signal())).text, /Nothing changed against HEAD\./u);

  await write(
    "src/store.ts",
    "export function markRead(id: number) {\n  return id + 1;\n}\n\nexport function legacyRenamed() {\n  return 1;\n}\n",
  );
  await write("config.yaml", "retries: 5\n");
  await write("app/billing/service.py", "def charge(amount):\n    return amount * 2\n");
  const { text } = await map.checkChanges({}, signal());

  assert.match(text, /^CHANGED\n {2}app\/billing\/service\.py: charge f1-2/mu);
  assert.match(text, /src\/store\.ts: markRead f1-3/u);
  // The route an inline handler serves, and the chain down to the change.
  assert.match(text, /"PUT \/feeds\/:id\/read" → .*markRead/u);
  // A renamed function: its old name is gone, and the route its caller serves still expects it.
  assert.match(text, /REMOVED OR RENAMED[^\n]*\n {2}src\/store\.ts: legacy f5-7/u);
  assert.match(text, /"GET \/old" → oldHandler → legacy/u);
  assert.match(text, /config\.yaml changed \(configuration\)/u);
  // Tests, closest first: the one calling the change, the mirrored module's, then a mention.
  const tests = text.slice(text.indexOf("RELATED TESTS"));
  assert.match(tests, /test\/store\.test\.ts: testMarkRead \(calls markRead\)/u);
  assert.match(tests, /tests\/billing\/test_charge\.py \(tests the billing module\)/u);
  assert.match(tests, /test\/feeds\.spec\.ts \(mentions "PUT \/feeds\/:id\/read"\)/u);
  assert.ok(tests.indexOf("store.test.ts") < tests.indexOf("feeds.spec.ts"));
  assert.match(text, /If the change needs verifying, these existing tests are the ones to run\./u);
  assert.match(text, /does not prove the change is safe/u);
});

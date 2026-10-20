import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import type { CodeIndexSource } from "../src/code-index-types";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import { checkMapChanges, parseMapDiff } from "../src/project-map-changes";
import { GoMapAnalyzer } from "../src/project-map-language-go";
import { JavaMapAnalyzer } from "../src/project-map-language-java";
import { PythonMapAnalyzer } from "../src/project-map-language-python";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { analyzers, openMap, project, sandbox, signal } from "./support";

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

// Files the map keeps as files but does not analyze, by kind.
const NOT_ANALYZED = {
  "db/schema.sql": "create table feeds (id int);\n",
  "web/feeds.html": "<p>feeds</p>\n",
  "package.json": '{ "name": "feeds" }\n',
  "web/style.css": "p { color: red; }\n",
  "data/feeds.json": '{ "feeds": [] }\n',
};

test("a host embedding the index gets the same change check as LayerMap, whatever files it keeps", async (t) => {
  const { root, write } = await project({ ...FILES, ...NOT_ANALYZED });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  await write(
    "src/store.ts",
    "export function markRead(id: number) {\n  return id + 1;\n}\n\nexport function legacyRenamed() {\n  return 1;\n}\n",
  );
  await write("config.yaml", "retries: 5\n");
  for (const [file, content] of Object.entries(NOT_ANALYZED))
    await write(file, content.replace("feeds", "items"));
  const map = await openMap(root);
  t.after(() => map.close());

  // The host's own database and index, and its own way of building the base commit's map.
  const store = new CodeIndexStore(
    openMapDatabase(
      mapDatabasePath(await sandbox(), root),
    ) as unknown as CodeIndexStore["database"],
  );
  const { typescript, go, python, java } = await analyzers();
  const index = new CodeIndex(
    store,
    undefined,
    new ProjectMapAnalyzer([
      new TypeScriptMapAnalyzer(typescript),
      new GoMapAnalyzer(go),
      new PythonMapAnalyzer(python),
      new JavaMapAnalyzer(java),
    ]),
  );
  t.after(async () => {
    await index.quiesce();
    index.close();
    store.database.close();
  });
  const directory = await realpath(root);
  const stat = await lstat(directory, { bigint: true });
  const source: CodeIndexSource = {
    kind: "WORKTREE",
    projectRef: "host:project",
    directory: { canonicalPath: directory, device: String(stat.dev), inode: String(stat.ino) },
  };
  const bases: string[] = [];
  const { text } = await checkMapChanges(
    {
      index,
      project: directory,
      // Unlike LayerMap, this host keeps every file of the project, code or not.
      working: (await index.prepare(source, signal())).version,
      base: "HEAD",
      baseVersion: async (commit, baseSignal) => {
        bases.push(commit);
        return (await index.prepare({ ...source, kind: "COMMIT", commit }, baseSignal)).version;
      },
    },
    signal(),
  );

  assert.equal(
    bases.length,
    1,
    "the base map is asked for once, since the diff removed a function",
  );
  assert.match(text, /REMOVED OR RENAMED/u);
  // Changes to files the map does not analyze are named by kind, never as top-level code.
  assert.match(text, /config\.yaml changed \(configuration\)/u);
  assert.match(text, /db\/schema\.sql changed \(database migration or schema\)/u);
  assert.match(text, /web\/feeds\.html changed \(template\)/u);
  assert.match(text, /package\.json changed \(build or dependency file\)/u);
  assert.doesNotMatch(text, /top-level code of (?!src\/)/u);
  assert.equal(text, (await map.checkChanges({}, signal())).text);
});

const RESPONSES = (body: string) => `class Response:
    def __init__(self, body):
        self.body = body


class FileResponse(Response):
    def __init__(self, path):
        super().__init__(${body})
        self.path = path


class JSONResponse(Response):
    def __init__(self, data):
        super().__init__(data)


def make_json(data):
    return JSONResponse(data)
`;

test("a change to code several areas use names each area and its tests; constructors are not dispatched", async (t) => {
  const { root, write } = await project({
    "pkg/__init__.py": "",
    "pkg/shared.py": "def normalize(value):\n    return value.strip()\n",
    "pkg/feeds.py":
      "from pkg.shared import normalize\n\n\ndef parse_feed(value):\n    return normalize(value)\n",
    "pkg/users.py":
      "from pkg.shared import normalize\n\n\ndef parse_user(value):\n    return normalize(value)\n",
    "pkg/responses.py": RESPONSES("path"),
    "tests/test_feeds.py":
      'from pkg.feeds import parse_feed\n\n\ndef test_feed():\n    assert parse_feed(" a ") == "a"\n',
    "tests/test_users.py":
      'from pkg.users import parse_user\n\n\ndef test_user():\n    assert parse_user(" b ") == "b"\n',
    "tests/test_shared.py":
      'from pkg.shared import normalize\n\n\ndef test_strip():\n    assert normalize(" x ") == "x"\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("pkg/shared.py", "def normalize(value):\n    return value.strip().lower()\n");
  await write("pkg/responses.py", RESPONSES("str(path)"));
  // Named: an existing expectation rewritten, and an existing test whose line moved out to a new
  // test (git shows that as a pure addition). Not named: a test added, and one that only gained an
  // assertion.
  await write(
    "tests/test_users.py",
    'from pkg.users import parse_user\n\n\ndef test_user():\n    assert parse_user(" B ") == "b"\n',
  );
  await write(
    "tests/test_feeds.py",
    'from pkg.feeds import parse_feed\n\n\ndef test_feed():\n    assert parse_feed(" a ") == "a"\n    assert parse_feed("b") == "b"\n\n\ndef test_feed_case():\n    assert parse_feed("A") == "a"\n',
  );
  await write(
    "tests/test_shared.py",
    'from pkg.shared import normalize\n\n\ndef test_strip():\n    assert normalize(" X ") == "x"\n\n\ndef test_strip_plain():\n    assert normalize(" x ") == "x"\n',
  );
  const { text } = await map.checkChanges({}, signal());

  const rewritten = text.slice(text.indexOf("EXISTING TESTS CHANGED"), text.indexOf("For each,"));
  assert.match(rewritten, /^ {2}tests\/test_users\.py: test_user$/mu);
  assert.match(rewritten, /^ {2}tests\/test_shared\.py: test_strip$/mu);
  assert.doesNotMatch(rewritten, /test_feed/u);
  assert.match(text, /restore the test and narrow the change/u);

  const shared = text.slice(text.indexOf("SHARED BY"), text.indexOf("Each area's tests"));
  assert.match(shared, /^SHARED BY 3 AREAS/u);
  assert.match(shared, /pkg\/feeds\.py \(parse_feed\): tests\/test_feeds\.py: test_feed/u);
  assert.match(shared, /pkg\/users\.py \(parse_user\): tests\/test_users\.py: test_user/u);
  assert.match(text, /narrow the change/u);
  // JSONResponse's super().__init__ runs Response.__init__, never FileResponse.__init__.
  assert.doesNotMatch(text, /make_json|JSONResponse/u);
});

test("a change names the imports it adds between modules, and the ones that make two modules depend on each other", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/core/store.ts": "export function load() {\n  return 1;\n}\n",
    "src/core/format.ts": "export function format(value: number) {\n  return String(value);\n}\n",
    "src/feature/page.ts":
      'import { load } from "../core/store";\n\nexport function page() {\n  return load();\n}\n',
    "test/page.test.ts": 'import { page } from "../src/feature/page";\n\npage();\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const dependencies = async () => {
    const { text } = await map.checkChanges({}, signal());
    const at = text.indexOf("NEW MODULE DEPENDENCIES");
    return at < 0 ? "" : text.slice(at, text.indexOf("\n", text.indexOf("Decide for each", at)));
  };

  // Lines added only, so no base map is built: the imports on the other lines are the base's.
  await write(
    "src/core/format.ts",
    'import { page } from "../feature/page";\nimport { trim } from "../util/text";\n\nexport function format(value: number) {\n  return String(value);\n}\nexport const both = (value: number) => trim(format(value)) + page();\n',
  );
  await write(
    "src/util/text.ts",
    "export function trim(value: string) {\n  return value.trim();\n}\n",
  );
  let text = await dependencies();
  assert.match(
    text,
    /^ {2}src\/core\/ → src\/feature\/ \(src\/core\/format\.ts:1\); now a cycle, back through src\/feature\/ → src\/core\/$/mu,
  );
  assert.match(text, /^ {2}src\/core\/ → src\/util\/ \(src\/core\/format\.ts:2\)$/mu);
  assert.doesNotMatch(text, /^ {2}src\/feature\/ → src\/core\/|^ {2}test\//mu);
  assert.match(text, /A cycle ties the modules together/u);

  // An import line the diff edits was there before; the base map tells.
  await write(
    "src/feature/page.ts",
    'import { load as read } from "../core/store";\n\nexport function page() {\n  return read();\n}\n',
  );
  text = await dependencies();
  assert.doesNotMatch(text, /^ {2}src\/feature\/ → src\/core\//mu);
  assert.match(text, /^ {2}src\/core\/ → src\/feature\/ .*now a cycle/mu);

  // A dependency the base already had, or a cycle it already had, is not new.
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  await write(
    "src/core/store.ts",
    'import { page } from "../feature/page";\n\nexport function load() {\n  return 1;\n}\nexport const again = () => page();\n',
  );
  assert.equal(await dependencies(), "");
  await write(
    "src/feature/page.ts",
    'import { load as read } from "../core/store";\nimport { trim } from "../util/text";\n\nexport function page() {\n  return trim(String(read()));\n}\n',
  );
  // A module the diff adds: its imports on one line.
  await write(
    "src/report/summary.ts",
    'import { load } from "../core/store";\nimport { page } from "../feature/page";\n\nexport const summary = () => load() + page();\n',
  );
  text = await dependencies();
  assert.match(text, /^ {2}src\/feature\/ → src\/util\/ \(src\/feature\/page\.ts:2\)$/mu);
  assert.match(
    text,
    /^ {2}src\/report\/ \(a module this diff adds\) → src\/core\/, src\/feature\/$/mu,
  );
  assert.doesNotMatch(text, /cycle/u);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import type { CodeIndexSource } from "../src/code-index-types";
import { ProjectEvidenceError } from "../src/core";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import { checkMapChanges, parseMapDiff } from "../src/project-map-changes";
import { GoMapAnalyzer } from "../src/project-map-language-go";
import { JavaMapAnalyzer } from "../src/project-map-language-java";
import { PythonMapAnalyzer } from "../src/project-map-language-python";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import type { MapReferenceBatch, MapUses, MapUsesInput } from "../src/project-map-reference-types";
import { MapShapeUses, mapShapeDeadline } from "../src/project-map-shapes";
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
        // A pure deletion: the point after line 11.
        [12, 11],
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
      lines: [[1, 0]],
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
  // What a coding agent leaves in its own directory is not a change to the project.
  await write(".claude/reviews/store.test.ts", FILES["test/store.test.ts"]);
  await write(".claude/settings.local.json", "{}\n");
  const { text } = await map.checkChanges({}, signal());
  assert.doesNotMatch(text, /\.claude/u);

  assert.match(text, /^CHANGED\n {2}app\/billing\/service\.py: charge f1-2/mu);
  assert.match(text, /src\/store\.ts: markRead f1-3/u);
  // The route an inline handler serves, and the chain down to the change.
  assert.match(text, /"PUT \/feeds\/:id\/read" → .*markRead/u);
  // A renamed function: its old name is gone, and its caller, which the diff left, still uses it.
  assert.match(
    text,
    /REMOVED OR RENAMED, STILL USED[^\n]*\n {2}src\/store\.ts: legacy f5-7 ← src\/routes\.ts: oldHandler\n/u,
  );
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
test("a rename that updates its callers removes the old name without saying code still uses it", async (t) => {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write(
    "src/store.ts",
    "export function markRead(id: number) {\n  return id;\n}\n\nexport function current() {\n  return 1;\n}\n",
  );
  await write("src/routes.ts", FILES["src/routes.ts"].replaceAll("legacy", "current"));
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /^REMOVED OR RENAMED \(no code the diff left unchanged uses them\)\n {2}src\/store\.ts: legacy f5-7\n/mu,
  );
  assert.doesNotMatch(text, /STILL USED/u);
});

test("a removed class that unchanged code still extends is still used", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/shapes.ts": "export class Base {\n  size = 1;\n}\n",
    "src/square.ts": 'import { Base } from "./shapes";\n\nexport class Square extends Base {}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/shapes.ts", "export class Shape {\n  size = 1;\n}\n");
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /STILL USED[^\n]*\n {2}src\/shapes\.ts: Base c1-3 ← src\/square\.ts: Square\n/u,
  );
});

test("a declaration moved to another file, its callers importing it from there, is not still used", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/a.ts":
      "export function keep() {\n  return 1;\n}\n\nexport function foo(value: number) {\n  return value + 1;\n}\n",
    "src/c.ts": 'import { foo } from "./a";\n\nexport function caller() {\n  return foo(2);\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/a.ts", "export function keep() {\n  return 1;\n}\n");
  await write("src/b.ts", "export function foo(value: number) {\n  return value + 1;\n}\n");
  await write(
    "src/c.ts",
    'import { foo } from "./b";\n\nexport function caller() {\n  return foo(2);\n}\n',
  );
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /^REMOVED OR RENAMED \(no code the diff left unchanged uses them\)\n {2}src\/a\.ts: foo f5-7\n/mu,
  );
  assert.doesNotMatch(text, /STILL USED/u);
  // Taking out what followed keep left keep as it was.
  assert.doesNotMatch(text, /keep|top-level code of src\/a\.ts/u);
});

test("a deletion changes the declaration around it, or the top-level code it took out", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/jobs.ts":
      "declare function one(): void;\ndeclare function two(): void;\ndeclare function register(job: unknown): void;\n\nexport function first() {\n  one();\n}\n\nexport function second() {\n  one();\n  two();\n}\n\nregister(second);\n",
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write(
    "src/jobs.ts",
    "declare function one(): void;\ndeclare function two(): void;\ndeclare function register(job: unknown): void;\n\nexport function first() {\n  one();\n}\n\nexport function second() {\n  one();\n}\n",
  );
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /^CHANGED\n {2}src\/jobs\.ts: second f9-11\n(?! )/mu);
  assert.match(text, /top-level code of src\/jobs\.ts changed/u);
});

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
      source,
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

test("a change names the code it adds that reads almost the same as code the project has", async (t) => {
  const money =
    'export function formatMoney(cents: number) {\n  const dollars = Math.floor(cents / 100);\n  const rest = String(cents % 100).padStart(2, "0");\n  return "$" + dollars + "." + rest;\n}\n';
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/util/money.ts": money,
    "src/util/dates.ts":
      "export function formatDate(date: Date) {\n  const day = date.toISOString();\n  return day.slice(0, 10);\n}\n",
    "src/store.ts":
      "export class Store {\n  private rows = new Map<string, number>();\n  load(key: string) {\n    const row = this.rows.get(key);\n    return row ?? 0;\n  }\n  save(key: string, value: number) {\n    this.rows.set(key, value);\n    return value;\n  }\n}\n",
    "src/page.ts":
      'import { formatMoney } from "./util/money";\n\nexport function page(cents: number) {\n  const label = formatMoney(cents);\n  return "<b>" + label + "</b>";\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const similar = async () => {
    const { text } = await map.checkChanges({}, signal());
    const at = text.indexOf("EXISTING CODE LIKE THE NEW CODE");
    return at < 0
      ? ""
      : text.slice(at, text.indexOf("\n", text.indexOf("Use the existing code", at)));
  };

  // A copy under another name, in a new file; a test's copy is not the project's code.
  await write("src/checkout/price.ts", money.replace("formatMoney", "priceLabel"));
  await write("test/helpers.ts", money.replace("formatMoney", "money"));
  const text = await similar();
  assert.match(
    text,
    /^ {2}src\/checkout\/price\.ts: priceLabel f1-5 ~ src\/util\/money\.ts: formatMoney f1-5$/mu,
  );
  assert.doesNotMatch(text, /test\/helpers/u);

  // Code that calls the one it resembles uses it; a new method like its class's others follows
  // their pattern; neither is a copy.
  await write(
    "src/checkout/price.ts",
    'import { formatMoney } from "../util/money";\n\nexport function priceLabel(cents: number) {\n  const dollars = Math.floor(cents / 100);\n  const rest = String(cents % 100).padStart(2, "0");\n  return dollars < 0 ? "-" : formatMoney(cents);\n}\n',
  );
  await write(
    "src/store.ts",
    "export class Store {\n  private rows = new Map<string, number>();\n  load(key: string) {\n    const row = this.rows.get(key);\n    return row ?? 0;\n  }\n  save(key: string, value: number) {\n    this.rows.set(key, value);\n    return value;\n  }\n  loadValue(key: string) {\n    const row = this.rows.get(key);\n    return row ?? 0;\n  }\n}\n",
  );
  assert.equal(await similar(), "");

  // Moved to another file, not copied, though a copy is already there: the diff took it out of the
  // old file, so it adds nothing.
  await run("git", ["checkout", "--", "."], { cwd: root });
  await run("git", ["clean", "-qfd"], { cwd: root });
  await write("src/checkout/price.ts", money.replace("formatMoney", "priceLabel"));
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  await write("src/util/money.ts", "export {};\n");
  await write("src/util/currency.ts", money);
  assert.equal(await similar(), "");
});

test("a short declaration counts as a copy only when it repeats one of its name word for word", async (t) => {
  const directoryOf =
    'const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/"));\n';
  const convention = (name: string) => `const ${name} = console.log.bind(console, "app");\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/paths.ts": `${directoryOf}export const LIMIT = 10;\nexport function same(path: string) { return path; }\nexport { directoryOf };\n`,
    "src/other.ts": `${directoryOf}export { directoryOf };\n`,
    // What many files repeat is a convention; a few files' copies are not yet.
    "src/a.ts": `${convention("logger")}${convention("tracer")}export { logger, tracer };\n`,
    "src/b.ts": `${convention("logger")}${convention("tracer")}export { logger, tracer };\n`,
    "src/c.ts": `${convention("logger")}${convention("tracer")}export { logger, tracer };\n`,
    "src/d.ts": `${convention("logger")}export { logger };\n`,
    // Calls the new declaration of its name, in the same words: it uses it rather than repeats it.
    "src/linked.ts": 'import { go as helper } from "./new";\nexport const go = () => helper();\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const similar = async () => {
    const { text } = await map.checkChanges({}, signal());
    const at = text.indexOf("EXISTING CODE LIKE THE NEW CODE");
    return at < 0
      ? ""
      : text.slice(at, text.indexOf("\n", text.indexOf("Use the existing code", at)));
  };

  // Exported or not, however it is spaced, the same code under the same name is a copy. The same
  // name with other code, the same code under another name, and a convention are not.
  await write(
    "src/new.ts",
    `export ${directoryOf}export const LIMIT = 20;\nfunction same(path: string) {  return path;  }\nexport const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));\n${convention("logger")}${convention("tracer")}declare const helper: () => void;\nexport const go = () => helper();\nexport { same, logger, tracer };\n`,
  );
  const text = await similar();
  assert.match(
    text,
    /^ {2}src\/new\.ts: directoryOf v1 ~ src\/other\.ts: directoryOf v1 \(\+1 more alike\)$/mu,
  );
  assert.match(text, /^ {2}src\/new\.ts: same f3 ~ src\/paths\.ts: same f3$/mu);
  assert.match(text, /^ {2}src\/new\.ts: tracer v6 ~ src\/a\.ts: tracer v2 \(\+2 more alike\)$/mu);
  assert.doesNotMatch(text, /LIMIT|parent|logger|\bgo\b/u);

  // Moved to another file, it adds nothing, though another copy is still there.
  await run("git", ["clean", "-qfd"], { cwd: root });
  await write("src/paths.ts", "export const LIMIT = 10;\n");
  await write("src/moved.ts", `${directoryOf}export { directoryOf };\n`);
  assert.equal(await similar(), "");
});

test("a change names the code it left without callers, as when new code replaces old", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/format.ts":
      "export function oldFormat(value: number) {\n  return String(value);\n}\n\nexport function pad(value: string) {\n  return value.padStart(4);\n}\n",
    "src/report.ts":
      'import { oldFormat, pad } from "./format";\n\nexport function report(value: number) {\n  return pad(oldFormat(value));\n}\n',
    "src/summary.ts":
      'import { pad } from "./format";\n\nexport function summary() {\n  return pad("total");\n}\n',
    "test/format.test.ts":
      'import { oldFormat } from "../src/format";\n\nexport function testOldFormat() {\n  return oldFormat(1);\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/new-format.ts",
    "export function newFormat(value: number) {\n  return value.toFixed(2);\n}\n",
  );
  await write(
    "src/report.ts",
    'import { newFormat } from "./new-format";\n\nexport function report(value: number) {\n  return newFormat(value);\n}\n',
  );
  const { text } = await map.checkChanges({}, signal());
  // Only its test calls oldFormat now; summary still calls pad.
  assert.match(
    text,
    /^LEFT WITHOUT CALLERS[^\n]*\n {2}src\/format\.ts: oldFormat f1-3 \(only tests call it now\)\nIf the change replaced them, delete them/mu,
  );
});

// A repository's own config may name programs for Git to run (a filter its attributes apply to a
// file, an fsmonitor), as a cloned or downloaded one may come with; LayerMap's Git runs none.
test("checking changes runs no program the repository's Git config names", async (t) => {
  const { root, write } = await project({ ...FILES, ".gitattributes": "*.ts filter=evil\n" });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const marker = (name: string) => path.join(root, "..", name);
  await run("git", ["config", "filter.evil.clean", `sh -c 'touch "${marker("filter")}"; cat'`], {
    cwd: root,
  });
  await run("git", ["config", "filter.evil.required", "true"], { cwd: root });
  await run("git", ["config", "core.fsmonitor", `sh -c 'touch "${marker("fsmonitor")}"'`], {
    cwd: root,
  });
  const map = await openMap(root);
  t.after(() => map.close());
  await write(
    "src/store.ts",
    "export function markRead(id: number) {\n  return id + 1;\n}\n\nexport function legacy() {\n  return 1;\n}\n",
  );
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /src\/store\.ts: markRead f1-3/u);
  assert.equal(existsSync(marker("filter")), false);
  assert.equal(existsSync(marker("fsmonitor")), false);
});

// Code can be in use with no call to it: a class its subclasses extend, a handler a framework's
// decorator wires to a route. A change that takes away its last call leaves it in use; a decorator
// of the language's own library, such as dataclass, wires nothing.
test("code still extended or wired by a decorator is not left without callers", async (t) => {
  const web = (warm: string) =>
    `from dataclasses import dataclass\n\nfrom fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/items")\ndef list_items():\n    return []\n\n\n@dataclass\nclass Point:\n    x: int = 0\n\n\ndef legacy_total():\n    return 0\n\n\ndef warm():\n    return ${warm}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/base.ts": "export class Base {\n  constructor(readonly size: number) {}\n}\n",
    "src/sub.ts":
      'import { Base } from "./base";\n\nexport class Sub extends Base {\n  label() {\n    return "sub";\n  }\n}\n',
    "src/use.ts":
      'import { Base } from "./base";\nimport { Sub } from "./sub";\n\nexport function make() {\n  return [new Base(1), new Sub(1)];\n}\n',
    "app/web.py": web("list_items(), Point(), legacy_total()"),
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/use.ts",
    'import { Sub } from "./sub";\n\nexport function make() {\n  return [new Sub(2)];\n}\n',
  );
  await write("app/web.py", web("None"));
  await write(
    "src/base.ts",
    "export class Base {\n  constructor(readonly size: number) {}\n  // sized\n}\n",
  );
  const { text } = await map.checkChanges({}, signal());
  const left = /^LEFT WITHOUT CALLERS[^\n]*\n((?: {2}.*\n)+)/mu.exec(text)?.[1];
  assert.equal(left, "  app/web.py: Point c13-15\n  app/web.py: legacy_total f18-19\n");
  assert.match(
    text,
    /src\/base\.ts: Base has no callers in the map, and is used without a call: extended by src\/sub\.ts: Sub/u,
  );
});

// A contract its classes implement, and methods dispatch reaches through overriding, are in use
// with no call the map resolves to them; a class only a test extends is not, nor a value only
// written.
test("code still implemented or overridden is not left without callers; tests' uses and writes do not count", async (t) => {
  const state = (report: string) =>
    `export let count = 0;\n\nexport function reset() {\n  count = 0;\n}\n\nexport function report() {\n  return ${report};\n}\n`;
  const shapes = (check: string) =>
    `from typing import Protocol, runtime_checkable\n\n\n@runtime_checkable\nclass Shape(Protocol):\n    def area(self) -> int: ...\n\n\nclass Square(Shape):\n    def area(self) -> int:\n        return 4\n\n\ndef check(x):\n    return ${check}\n`;
  const { root, write } = await project({
    "app/shapes.py": shapes("isinstance(x, Shape)"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/shape.ts":
      "export interface Shape {\n  area(): number;\n}\n\nexport class Base {\n  size() {\n    return 1;\n  }\n}\n\nexport class Old {}\n",
    "src/square.ts":
      'import { Base, type Shape } from "./shape";\n\nexport class Square extends Base implements Shape {\n  area() {\n    return 4;\n  }\n  override size() {\n    return 2;\n  }\n}\n',
    "src/use.ts":
      'import { Base, Old, type Shape } from "./shape";\nimport { Square } from "./square";\n\nexport function total(shape: Shape) {\n  return shape.area();\n}\n\nexport function sizes() {\n  return [new Base().size(), new Square().size(), new Square().area(), new Old()];\n}\n',
    "test/old.test.ts":
      'import { Old } from "../src/shape";\n\nexport class FakeOld extends Old {}\n',
    "src/state.ts": state("count + 1"),
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/use.ts",
    'import { Square } from "./square";\n\nexport function sizes() {\n  return [new Square()];\n}\n',
  );
  await write("app/shapes.py", shapes("True"));
  await write("src/state.ts", state("0"));
  const { text } = await map.checkChanges({}, signal());
  const left = /^LEFT WITHOUT CALLERS[^\n]*\n((?: {2}.*\n)+)/mu.exec(text)?.[1];
  assert.equal(left, "  src/shape.ts: Old c11\n  src/state.ts: count v1\n");
});

// A service a route serves, whose changed code a test of the presenter alone does not run.
const FUNDS = (overdue: string, label: string) => ({
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src", "test"] }),
  "src/funds.ts": `export function readReceivableOverdueIds(ids: number[]) {
  return ids.filter((id) => ${overdue});
}

export function readFundsReceivableList(ids: number[]) {
  return readReceivableOverdueIds(ids).length;
}

export function presentReceivable(count: number) {
  return \`${label} \${count}\`;
}

export class FundsService {
  listReceivables(ids: number[]) {
    return presentReceivable(readFundsReceivableList(ids));
  }
}

export function summarize(ids: number[]) {
  return presentReceivable(ids.length);
}
`,
  "src/routes.ts": `import { FundsService } from "./funds";
declare const router: { get(path: string, h: unknown): void };
const service = new FundsService();
router.get("/funds/receivables", () => service.listReceivables([1, 2]));
`,
  // One test drives the service from its module scope, one calls only the presenter, one calls
  // it through other code, and one requests the route.
  "test/service.test.ts":
    'import { FundsService } from "../src/funds";\n\nexport const listed = new FundsService().listReceivables([3]);\n',
  "test/present.test.ts":
    'import { presentReceivable } from "../src/funds";\n\nexport function testPresent() {\n  return presentReceivable(2);\n}\n',
  "test/summary.test.ts":
    'import { summarize } from "../src/funds";\n\nexport const summary = summarize([1]);\n',
  "test/http.test.ts":
    'declare const request: (app: unknown) => { get(path: string): unknown };\n\nexport const response = request(undefined).get("/funds/receivables");\n',
});

test("given test files, the check names the changed code none of them runs and the entry points above it", async (t) => {
  const { root, write } = await project(FUNDS("id > 1", "count"));
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  for (const [file, content] of Object.entries(FUNDS("id > 2", "receivables")))
    await write(file, content);

  const plain = (await map.checkChanges({}, signal())).text;
  assert.doesNotMatch(plain, /NOT REACHED/u);
  const section = (text: string) =>
    text.slice(
      text.indexOf("\nNOT REACHED BY THE GIVEN TESTS\n") + 1,
      text.indexOf("\nRELATED TESTS") + 1,
    );

  const presenter = (
    await map.checkChanges({ tests: ["test/present.test.ts", "test/gone.test.ts"] }, signal())
  ).text;
  const left = section(presenter);
  assert.match(presenter, /· 1 changed declarations not reached by the given tests$/mu);
  assert.match(left, /given files: test\/gone\.test\.ts$/mu);
  assert.match(left, /1 of 2 changed declarations/u);
  assert.match(
    left,
    /^ {2}"GET \/funds\/receivables" → FundsService\.listReceivables → readFundsReceivableList → readReceivableOverdueIds \(registered at src\/routes\.ts:4\)$/mu,
  );
  assert.match(left, /^ {2}src\/funds\.ts: readReceivableOverdueIds f1-3$/mu);
  assert.doesNotMatch(left, /presentReceivable|only through a route/u);
  assert.ok(presenter.indexOf("AFFECTED ENTRY POINTS") < presenter.indexOf(left));
  // The section and its count are all the given tests add to the report.
  assert.equal(
    presenter
      .replace(left, "")
      .replace(" · 1 changed declarations not reached by the given tests", ""),
    plain,
  );

  const service = (await map.checkChanges({ tests: ["test/service.test.ts"] }, signal())).text;
  assert.match(
    section(service),
    /^NOT REACHED BY THE GIVEN TESTS\n {2}none: the given tests reach all 2 changed declarations\nReach is followed[^\n]*\n$/u,
  );

  // A test that requests the route by its path runs what its handler calls, as far as text tells;
  // code another given test calls, even through other code, counts as called.
  const requested = (
    await map.checkChanges({ tests: ["test/http.test.ts", "test/summary.test.ts"] }, signal())
  ).text;
  assert.match(
    section(requested),
    /^NOT REACHED BY THE GIVEN TESTS\n {2}none: the given tests reach all 2 changed declarations\n {2}1 changed declarations are reached only through a route whose path a given test names, found by text \("GET \/funds\/receivables"\):\n {2}src\/funds\.ts: readReceivableOverdueIds f1-3\nReach is followed/u,
  );

  const none = (await map.checkChanges({ tests: [] }, signal())).text;
  assert.match(none, /2 of 2 changed declarations/u);
  assert.match(none, /^ {2}src\/funds\.ts: presentReceivable f9-11$/mu);

  // The route's handler, changed itself, runs when the route is requested.
  await write(
    "src/funds.ts",
    FUNDS("id > 2", "receivables")["src/funds.ts"].replace(
      "readFundsReceivableList(ids)",
      "readFundsReceivableList([...ids])",
    ),
  );
  const handler = section(
    (await map.checkChanges({ tests: ["test/http.test.ts"] }, signal())).text,
  );
  assert.match(handler, /none: the given tests reach all 3 changed declarations/u);
  assert.match(handler, /^ {2}3 changed declarations are reached only through a route/mu);
  assert.match(handler, /^ {2}src\/funds\.ts: FundsService\.listReceivables m14-16$/mu);
});

// A field or type has no relations in the map; a search for its references links it to its users.
const SHAPES = (side: string, key: string, unread = "") => ({
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src", "test"] }),
  "src/keys.ts": `export type Key = ${key};\n`,
  "src/shape.ts": `import type { Key } from "./keys";

export interface Shape {
  side: ${side};
  ${unread}
}
export interface Row {
  key: Key;
}
export interface Idle {
  key: Key;
}
export const area = (s: Shape) => s.side + 1;
export function perimeter({ side }: Shape) {
  return String(side);
}
export const label = (row: Row) => String(row.key).length;
`,
  "src/routes.ts": `import { area, label, perimeter } from "./shape";
declare const router: { get(path: string, h: unknown): void };
router.get("/shapes/area", () => area({ side: 2 } as never));
router.get("/shapes/perimeter", () => perimeter({ side: 2 } as never));
router.get("/shapes/label", () => label({ key: "a" } as never));
`,
  "test/shape.test.ts":
    'import { area } from "../src/shape";\n\nexport const value = area({ side: 3 } as never);\n',
  "test/other.test.ts": "export const other = 1;\n",
});

test("a changed field or type reaches the code that uses it, the entry points above it and the tests", async (t) => {
  const { root, write } = await project({
    ...SHAPES("number", "string"),
    "test/direct.test.ts":
      'import type { Shape } from "../src/shape";\n\nexport const direct = (s: Shape) => s.side;\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const possibly = (text: string) =>
    text.slice(
      text.indexOf("\nPOSSIBLY AFFECTED"),
      text.indexOf("\n", text.indexOf('"', text.lastIndexOf("/shapes/"))),
    );

  // A read and a destructured read, through a route each; what changed in a field may not matter
  // to them, so they are possibly affected, not certainly.
  await write("src/shape.ts", SHAPES("bigint", "string")["src/shape.ts"]);
  const field = (await map.checkChanges({}, signal())).text;
  assert.match(field, /^ {2}src\/shape\.ts: Shape\.side p4$/mu);
  assert.match(field, /^ {2}"GET \/shapes\/area" → area → Shape\.side/mu);
  assert.match(field, /^ {2}"GET \/shapes\/perimeter" → perimeter → Shape\.side/mu);
  assert.ok(field.indexOf("POSSIBLY AFFECTED") < field.indexOf('"GET /shapes/area"'));
  assert.doesNotMatch(field, /AFFECTED ENTRY POINTS/u);
  assert.doesNotMatch(field, /has no callers/u);
  assert.match(
    field,
    /test\/shape\.test\.ts: test\/shape\.test\.ts \((?:calls area|uses Shape\.side)\)/u,
  );
  assert.match(field, /test\/direct\.test\.ts: direct \(uses Shape\.side\)/u);

  // A test that runs code using the field reaches it; one that does not, does not.
  const covered = (await map.checkChanges({ tests: ["test/shape.test.ts"] }, signal())).text;
  assert.match(covered, /^ {2}none: the given tests reach all 1 changed declarations$/mu);
  const uncovered = (await map.checkChanges({ tests: ["test/other.test.ts"] }, signal())).text;
  assert.match(uncovered, /^ {2}1 of 1 changed declarations are reached by none/mu);
  assert.match(uncovered, /^ {2}"GET \/shapes\/area" → area → Shape\.side.* \(possibly\)$/mu);

  // A type named by another type's field: the code reading that field uses it. A field nothing
  // reads ends the chain without being an entry point.
  await write("src/shape.ts", SHAPES("number", "string")["src/shape.ts"]);
  await write("src/keys.ts", SHAPES("number", "number")["src/keys.ts"]);
  const type = (await map.checkChanges({}, signal())).text;
  assert.match(type, /^ {2}"GET \/shapes\/label" → label → Row\.key → Key/mu);
  assert.doesNotMatch(type, /^ {2}src\/shape\.ts: Row/mu);
  assert.ok(possibly(type));
  assert.doesNotMatch(type, /Idle/u);

  // A field nothing uses is named as such, and is no entry point.
  await write("src/keys.ts", SHAPES("number", "string")["src/keys.ts"]);
  await write("src/shape.ts", SHAPES("number", "string", "ghost: number;")["src/shape.ts"]);
  const ghost = (await map.checkChanges({}, signal())).text;
  assert.match(
    ghost,
    /^ {2}src\/shape\.ts: Shape\.ghost has no callers in the map, and a search for references found no use/mu,
  );
  assert.doesNotMatch(ghost, /ENTRY POINTS|POSSIBLY AFFECTED/u);
});

test("a removed field or type code still uses is named as used; one that moved is not", async (t) => {
  const { root, write } = await project(SHAPES("number", "string"));
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const shape = SHAPES("number", "string")["src/shape.ts"];

  await write("src/shape.ts", shape.replace("  side: number;\n", ""));
  const kept = (await map.checkChanges({}, signal())).text;
  assert.match(
    kept,
    /^REMOVED OR RENAMED, STILL USED[^\n]*\n {2}src\/shape\.ts: Shape\.side p4 ← src\/shape\.ts: area, src\/shape\.ts: perimeter$/mu,
  );

  // The diff also rewrites the code that used it: nothing it left alone does.
  await write(
    "src/shape.ts",
    shape
      .replace("  side: number;\n", "")
      .replace("(s: Shape) => s.side + 1", "(s: Shape) => s")
      .replace("{ side }: Shape", "side: Shape"),
  );
  await write(
    "src/routes.ts",
    SHAPES("number", "string")["src/routes.ts"].replaceAll("{ side: 2 } as never", "{} as never"),
  );
  await write("test/shape.test.ts", "export const value = 1;\n");
  const gone = (await map.checkChanges({}, signal())).text;
  assert.doesNotMatch(gone, /Shape\.side p4 ←/u);
  assert.match(gone, /^REMOVED OR RENAMED \(no code[^\n]*\n {2}src\/shape\.ts: Shape\.side p4$/mu);
  await run("git", ["checkout", "--", "."], { cwd: root });

  // Moved to another file with the imports following it: the code naming it still has it.
  await write("src/keys.ts", "export {};\n");
  await write("src/moved.ts", "export type Key = string;\n");
  await write("src/shape.ts", shape.replace('from "./keys"', 'from "./moved"'));
  const moved = (await map.checkChanges({}, signal())).text;
  assert.doesNotMatch(moved, /Key t\d+ ←/u);
});

test("a field's reads count across languages, and who uses it is left to a person when it cannot be read", async (t) => {
  const many = (type: string) =>
    `export interface Many {\n  f0: ${type};\n}\nexport const sum = (m: Many) => [m.f0];\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "go.mod": "module example.com/m\n\ngo 1.22\n",
    "models/row.go":
      'package models\n\ntype Row struct {\n\tName string `json:"name"`\n}\n\nfunc Title(r Row) string {\n\treturn r.Name\n}\n',
    "app/__init__.py": "",
    "app/point.py":
      "class Point:\n    x: int = 1\n    y: int = 1\n\n\ndef norm(p: Point) -> int:\n    return p.x\n\n\ndef blind(p):\n    return p.y\n",
    "src/many.ts": many("number"),
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "models/row.go",
    'package models\n\ntype Row struct {\n\tName string `json:"title"`\n}\n\nfunc Title(r Row) string {\n\treturn r.Name\n}\n',
  );
  await write(
    "app/point.py",
    "class Point:\n    x: int = 2\n    y: int = 2\n\n\ndef norm(p: Point) -> int:\n    return p.x\n\n\ndef blind(p):\n    return p.y\n",
  );
  const known = (await map.checkChanges({}, signal())).text;
  assert.match(known, /^ {2}models\/row\.go: Title → Row\.Name/mu);
  assert.match(known, /^ {2}app\/point\.py: norm → Point\.x/mu);
  // Through a value of unknown type no search finds it.
  assert.match(
    known,
    /app\/point\.py: Point\.y has no callers in the map, and a search for references found no use/u,
  );

  await run("git", ["checkout", "--", "."], { cwd: root });
  await write("src/many.ts", many("string"));
  usesRead(
    map,
    (found) => new Map([...found].map(([ref]) => [ref, { uses: [], complete: false }])),
  );
  const limited = (await map.checkChanges({}, signal())).text;
  assert.match(
    limited,
    /^ {2}who uses 1 fields or types the change reaches was not read, so what they affect is not known \(Many\.f0\); project_find_references/mu,
  );
  // Not reading a field's uses does not mean finding none.
  assert.doesNotMatch(limited, /Many\.f0 has no callers/u);
});

test("what one check reads ends at one deadline across its versions, and what was not all read is named", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const graph = {
    object: (ref: string) => ({ kind: ref === "reader" ? "FUNCTION" : "PROPERTY" }),
    owner: (ref: string) => ref,
  } as never;
  const uses = [{ owner: "reader", anchor: {} as never, write: false }];
  const rounds: string[][] = [];
  const reader = async (refs: readonly string[]) => {
    rounds.push([...refs]);
    return new Map(
      refs
        .filter((ref) => ref !== "unfound")
        .map((ref) => [ref, { uses, complete: ref !== "partial" }]),
    );
  };

  const until = mapShapeDeadline();
  const working = new MapShapeUses(graph, reader, until);
  await working.read(["partial", "unfound", "whole", "whole", "reader"]);
  // Each once, and only what has no calls in the map.
  await working.read(["partial", "unfound", "whole"]);
  assert.deepEqual(rounds, [["partial", "unfound", "whole"]]);
  assert.deepEqual([...working.unread], ["partial", "unfound"]);
  assert.equal(working.uses.get("partial")?.length, 1);
  assert.equal(working.uses.has("unfound"), false);
  assert.equal(working.uses.get("whole")?.length, 1);

  // However many there are, up to the deadline, which the check's other version shares.
  const fields = Array.from({ length: 1000 }, (_, at) => `f${at}`);
  await new MapShapeUses(graph, reader, until).read(fields);
  assert.equal(rounds.at(-1)?.length, 1000);
  const base = new MapShapeUses(graph, reader, until);
  t.mock.timers.tick(20_001);
  const before = rounds.length;
  await base.read(["field"]);
  assert.equal(rounds.length, before);
  assert.deepEqual([...base.unread], ["field"]);
});

test("each language reads many declarations in one request, and a place naming none has no page", async (t) => {
  const { typescript, go, python, java } = await analyzers();
  const languages = [
    {
      language: new TypeScriptMapAnalyzer(typescript),
      file: "row.ts",
      text: "export interface Row {\n  name: string;\n  size: number;\n}\nexport const f = (r: Row) => [r.name, r.size, r.size];\n",
      names: ["name", "size"],
    },
    {
      language: new GoMapAnalyzer(go),
      file: "row.go",
      text: "package row\n\ntype Row struct {\n\tName string\n\tSize int\n}\n\nfunc F(r Row) []any {\n\treturn []any{r.Name, r.Size, r.Size}\n}\n",
      names: ["Name", "Size"],
    },
    {
      language: new PythonMapAnalyzer(python),
      file: "row.py",
      text: "class Row:\n    name: str\n    size: int\n\n\ndef f(r: Row):\n    return [r.name, r.size, r.size]\n",
      names: ["name", "size"],
    },
    {
      language: new JavaMapAnalyzer(java),
      file: "Row.java",
      text: "public class Row {\n  String name;\n  int size;\n\n  Object f() {\n    return new Object[] {name, size, size};\n  }\n}\n",
      names: ["name", "size"],
    },
  ];
  for (const { language, file, text, names } of languages)
    await t.test(file, async () => {
      const request = (symbolStart: number) => ({
        targetPath: file,
        symbolStart,
        offset: 0,
        maxResults: 100,
      });
      const { pages } = await language.references(
        { contextRef: "context", files: { [file]: text }, inventory: [file], syntaxOnly: false },
        [...names.map((name) => request(text.indexOf(name))), request(0)],
        signal(),
      );
      assert.deepEqual(
        pages.map((page) => (page ? page.references.length : null)),
        [2, 3, null],
      );
    });
});

test("past the deadline a compile reads only its first declaration, and the check says what it left out", async () => {
  const { typescript } = await analyzers();
  const text = "export interface Row {\n  a: string;\n  b: number;\n}\n";
  const request = (symbolStart: number) => ({
    targetPath: "row.ts",
    symbolStart,
    offset: 0,
    maxResults: 100,
  });
  const { pages } = await new TypeScriptMapAnalyzer(typescript).references(
    { contextRef: "context", files: { "row.ts": text }, inventory: ["row.ts"], syntaxOnly: false },
    [request(text.indexOf("a:")), request(text.indexOf("b:"))],
    signal(),
    undefined,
    Date.now() - 1,
  );
  assert.equal(pages.length, 1);
});

// The declarations a check asks the index for in each read; change alters what the index answers.
const usesRead = (map: unknown, change?: (found: MapUses, read: number) => MapUses) => {
  const index = (
    map as {
      index: { findUses: (input: MapUsesInput, signal: AbortSignal) => Promise<MapUses> };
    }
  ).index;
  const findUses = index.findUses.bind(index);
  const rounds: number[] = [];
  index.findUses = async (input, signal) => {
    rounds.push(input.refs.length);
    const found = await findUses(input, signal);
    return change ? change(found, rounds.length) : found;
  };
  return rounds;
};

// A compile that finds no declaration to follow, on the compiles the given test picks.
const noTargets = (map: unknown, none: (compile: number) => boolean) => {
  const { analyzer } = (
    map as {
      index: {
        analyzer: { references: (...args: unknown[]) => Promise<MapReferenceBatch> };
      };
    }
  ).index;
  const references = analyzer.references.bind(analyzer);
  let compiles = 0;
  analyzer.references = async (...args) => {
    const found = await references(...args);
    return none(++compiles) ? { ...found, pages: found.pages.map(() => null) } : found;
  };
};

test("a wide change reads its fields in one compile", async (t) => {
  const fields = Array.from({ length: 20 }, (_, at) => `f${at}`);
  const row = (type: string) =>
    `export interface Row {\n${fields.map((f) => `  ${f}: ${type};`).join("\n")}\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts": row("number"),
    "src/reader.ts": `import type { Row } from "./row";\n\nexport const reader = (r: Row) => [${fields.map((f) => `r.${f}`).join(", ")}];\n`,
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/row.ts", row("string"));

  const rounds = usesRead(map);
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(rounds, [20]);
  assert.match(text, /^ {2}src\/reader\.ts: reader → /mu);
  assert.doesNotMatch(text, /was not read/u);
});

test("a value is followed to the code reading it, and stops at a type that describes it", async (t) => {
  const work = (value: number) => `export function work() {\n  return ${value};\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/work.ts": work(1),
    "src/runtime.ts":
      'import { work } from "./work";\n\nexport function create() {\n  return work();\n}\nexport const services = { create };\nexport type Services = typeof services;\n',
    "src/reads.ts":
      'import { services } from "./runtime";\n\nexport function reads() {\n  return services.create();\n}\n',
    "src/names.ts":
      'import type { Services } from "./runtime";\n\nexport function names(s: Services) {\n  return s;\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/work.ts", work(2));
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /^ {2}src\/reads\.ts: reads → /mu);
  assert.doesNotMatch(text, /names|Services/u);
});

test("a type a value reached first is still followed when a change reaches it through uses too", async (t) => {
  const work = (value: number) => `export function work() {\n  return ${value};\n}\n`;
  const inner = (type: string) => `export type Inner = ${type};\nexport type Outer = Inner;\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/work.ts": work(1),
    "src/inner.ts": inner("number"),
    "src/both.ts":
      'import type { Outer } from "./inner";\nimport { work } from "./work";\n\nexport function create() {\n  return work();\n}\nexport const services = { create };\nexport type Both = (typeof services)["create"] & Outer;\n',
    "src/names.ts":
      'import type { Both } from "./both";\n\nexport function names(b: Both) {\n  return b;\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/work.ts", work(2));
  assert.doesNotMatch((await map.checkChanges({}, signal())).text, /names/u);
  await write("src/inner.ts", inner("string"));
  assert.match((await map.checkChanges({}, signal())).text, /^ {2}src\/names\.ts: names → /mu);
});

test("a field the trace reached and only code writing it is left of has lost its callers", async (t) => {
  const make = (value: number) => `export function make() {\n  return () => ${value};\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/make.ts": make(1),
    "src/holder.ts":
      'import { make } from "./make";\n\nexport class Holder {\n  value = make();\n}\n',
    "src/reader.ts":
      'import type { Holder } from "./holder";\n\nexport function reader(h: Holder) {\n  h.value();\n}\n',
    "src/setter.ts":
      'import type { Holder } from "./holder";\n\nexport function setter(h: Holder) {\n  h.value = () => 2;\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/make.ts", make(2));
  await write("src/reader.ts", "export const nothing = 1;\n");
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /^LEFT WITHOUT CALLERS[^\n]*\n(?: {2}.*\n)*? {2}src\/holder\.ts: Holder\.value /mu,
  );
});

test("a read that fails for a reason not of the declaration fails the check", async (t) => {
  const row = (type: string) => `export interface Row {\n  a: ${type};\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts": row("number"),
    "src/user.ts": 'import type { Row } from "./row";\n\nexport const user = (r: Row) => r.a;\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/row.ts", row("string"));

  usesRead(map, () => {
    throw new ProjectEvidenceError("PROJECT_EVIDENCE_MAINTENANCE_BUSY", false);
  });
  await assert.rejects(map.checkChanges({}, signal()), {
    code: "PROJECT_EVIDENCE_MAINTENANCE_BUSY",
  });
});

test("a declaration its compile finds no target for is left unread, and named as reached, not changed", async (t) => {
  const row = (type: string) => `export interface Row {\n  a: ${type};\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts": row("number"),
    "src/idle.ts":
      'import type { Row } from "./row";\n\nexport interface Idle {\n  key: Row["a"];\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/row.ts", row("string"));

  noTargets(map, (compile) => compile === 2);
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /^ {2}who uses 1 fields or types the change reaches was not read, so what they affect is not known \(Idle\.key\); project_find_references lists their uses$/mu,
  );
});

test("a removed field whose uses could not be read says what to do, which is not to ask the working tree", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts": "export interface Row {\n  kept: string;\n  gone: number;\n}\n",
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/row.ts", "export interface Row {\n  kept: string;\n}\n");

  noTargets(map, () => true);
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /src\/row\.ts: Row\.gone was removed, and who used it was not read; search the code for its name/u,
  );
  assert.doesNotMatch(text, /on the base/u);
});

test("fields losing callers are read in one compile, and those not read to the end are named, not listed", async (t) => {
  const fields = Array.from({ length: 401 }, (_, at) => `f${String(at).padStart(3, "0")}`);
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/deps.ts": `export interface Deps {\n${fields.map((f) => `  ${f}: () => void;`).join("\n")}\n}\n`,
    "src/reader.ts": `import type { Deps } from "./deps";\n\nexport function reader(d: Deps) {\n${fields.map((f) => `  d.${f}();`).join("\n")}\n}\n`,
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/reader.ts", "export const nothing = 1;\n");

  const rounds = usesRead(
    map,
    (found) => new Map([...found].map(([ref, read], at) => [ref, { ...read, complete: at > 0 }])),
  );
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(rounds, [401]);
  assert.match(
    text,
    /^ {2}1 fields lost callers the diff removed, and whether others use them was not read \(Deps\.f\d+\); project_find_references lists their uses$/mu,
  );
  assert.match(text, /^LEFT WITHOUT CALLERS/mu);
  const named = /\(Deps\.(f\d+)\); project_find_references/u.exec(text)?.[1];
  assert.doesNotMatch(text, new RegExp(`Deps\\.${named} p\\d+`, "u"));
});

test("a field losing callers is asked about alone, and a test's read does not keep it", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/deps.ts": "export interface Deps {\n  held: () => void;\n  tested: () => void;\n}\n",
    "src/idle.ts":
      'import type { Deps } from "./deps";\n\nexport interface Idle {\n  key: Deps["held"];\n}\n',
    "src/reader.ts":
      'import type { Deps } from "./deps";\n\nexport function reader(d: Deps) {\n  d.held();\n  d.tested();\n}\n',
    "test/deps.test.ts":
      'import type { Deps } from "../src/deps";\n\nexport const seen = (d: Deps) => d.tested;\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/reader.ts", "export const nothing = 1;\n");

  const rounds = usesRead(map);
  const { text } = await map.checkChanges({}, signal());
  // Each field once: who uses Idle.key says nothing of whether Deps.held is still used.
  assert.deepEqual(rounds, [2]);
  const left = /^LEFT WITHOUT CALLERS[^\n]*\n((?: {2}.*\n)+)/mu.exec(text)?.[1];
  assert.equal(left, "  src/deps.ts: Deps.tested p3\n");
});

test("a field that both uses a changed type and calls a changed method is an entry point", async (t) => {
  const code = (type: string, value: string) =>
    `export interface T {\n  a: ${type};\n  b: ${type};\n}\nexport interface Svc {\n  run(): number;\n}\nexport class One implements Svc {\n  run() {\n    return ${value};\n  }\n}\nexport class Two implements Svc {\n  run() {\n    return ${value};\n  }\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/t.ts": code("number", "1"),
    "src/holder.ts":
      'import type { Svc, T } from "./t";\n\ndeclare const svc: Svc;\nexport class Holder {\n  value: T["a"] = svc.run();\n  only: T["a"] | T["b"] = 1;\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/t.ts", code("string", "2"));
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /^ {2}src\/holder\.ts: Holder\.value → /mu);
  assert.doesNotMatch(text, /Holder\.only/u);
});

test("a function held in a field is followed as a function, and importing a type does not use it", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/work.ts": "export function work() {\n  return 1;\n}\n",
    "src/job.ts":
      'import { work } from "./work";\n\nexport class Job {\n  run = () => work();\n}\n',
    "src/keys.ts": "export type Lonely = string;\n",
    "src/barrel.ts": 'export type { Lonely } from "./keys";\n',
    "src/importer.ts": 'import type { Lonely } from "./keys";\n\nexport const one = 1;\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/work.ts", "export function work() {\n  return 2;\n}\n");
  const called = (await map.checkChanges({}, signal())).text;
  assert.match(called, /^ {2}src\/job\.ts: Job\.run → work/mu);
  await run("git", ["checkout", "--", "."], { cwd: root });

  await write("src/keys.ts", "export type Lonely = number;\n");
  const named = (await map.checkChanges({}, signal())).text;
  assert.match(
    named,
    /src\/keys\.ts: Lonely has no callers in the map, and a search for references found no use/u,
  );
});

test("an entry point both a call and a use reach is certainly affected, however short the use", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/thing.ts":
      "export interface Thing {\n  size: number;\n}\nexport function low() {\n  return 1;\n}\nexport function mid() {\n  return low();\n}\n",
    "src/command.ts":
      'import { mid, type Thing } from "./thing";\n\nexport function command(thing: Thing) {\n  return thing.size + mid();\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/thing.ts",
    "export interface Thing {\n  size: 1 | 2;\n}\nexport function low() {\n  return 2;\n}\nexport function mid() {\n  return low();\n}\n",
  );
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /^AFFECTED ENTRY POINTS[^\n]*\n {2}src\/command\.ts: command → mid → low$/mu);
  assert.doesNotMatch(text, /^POSSIBLY AFFECTED/mu);
});

test("a field holding a function others call by key is an entry point; one using a type is not", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/compare.ts": "export function compare() {\n  return 1;\n}\nexport type Stage = string;\n",
    "src/pipeline.ts":
      'import { compare, type Stage } from "./compare";\n\nexport const handlers = { comparing: compare };\nexport interface Row {\n  stage: Stage;\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/compare.ts",
    "export function compare() {\n  return 2;\n}\nexport type Stage = number;\n",
  );
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /^AFFECTED ENTRY POINTS[^\n]*\n {2}src\/pipeline\.ts: handlers\.comparing → compare$/mu,
  );
  assert.doesNotMatch(text, /Row\.stage/u);
});

test("removing one key of a type generic code indexes is not a use of it; a class's fields still count", async (t) => {
  const operations = (extra: string) =>
    `export interface Operations {\n${extra}  "GET /kept": {\n    readonly request: { id: string };\n  };\n}\n`;
  const fields = (extra: string) => `export class Account {\n  ${extra}id = "a";\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/operations.ts": operations(
      '  "POST /gone": {\n    readonly request: { name: string };\n  };\n',
    ),
    "src/client.ts":
      'import type { Operations } from "./operations";\n\ntype Key = keyof Operations;\nexport type Input<K extends Key> = {\n  readonly body?: Operations[K]["request"];\n};\n',
    "src/account.ts": fields("gone = 1;\n  "),
    "src/reader.ts":
      'import type { Account } from "./account";\n\nexport const read = (account: Account) => account.gone;\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/operations.ts", operations(""));
  const key = (await map.checkChanges({}, signal())).text;
  assert.doesNotMatch(key, /STILL USED/u);
  assert.match(
    key,
    /^REMOVED OR RENAMED \(no code[^\n]*\n {2}src\/operations\.ts: Operations\.POST \/gone p\d+/mu,
  );
  await run("git", ["checkout", "--", "."], { cwd: root });

  await write("src/account.ts", "export {};\n");
  const whole = (await map.checkChanges({}, signal())).text;
  assert.match(
    whole,
    /^REMOVED OR RENAMED, STILL USED[^\n]*\n {2}src\/account\.ts: Account c\S+ ← src\/reader\.ts: read$/mu,
  );
});

test("a field or key only a type's index names is used, by that type alone", async (t) => {
  const row = (fields: string) => `export interface Row {\n${fields}  kept: string;\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts": row(
      '  total: number;\n  "POST /gone": { request: string };\n  lonely: number;\n',
    ),
    // Offsets count past text that is not ASCII, and past names that only look like an index.
    "src/user.ts":
      'import type { Row } from "./row";\n\n// 中文注释 😀\nexport function show(value: Row["total"], body: Row["POST /gone"]) {\n  return [value, body];\n}\n',
    "src/other.ts":
      'interface Other {\n  lonely: number;\n}\nexport const names = ["lonely"];\n// Row["lonely"]\nexport function unrelated(value: Other["lonely"]) {\n  return [value, names];\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/row.ts", row("  total: string;\n  lonely: string;\n"));
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /^REMOVED OR RENAMED, STILL USED[^\n]*\n {2}src\/row\.ts: Row\.POST \/gone p\d+ ← src\/user\.ts: show$/mu,
  );
  assert.match(
    text,
    /^POSSIBLY AFFECTED[^\n]*\n(?: {2}[^\n]*\n)*? {2}src\/user\.ts: show → Row\.total/mu,
  );
  assert.doesNotMatch(text, /Row\.total has no callers/u);
  assert.match(
    text,
    /Row\.lonely has no callers in the map, and a search for references found no use/u,
  );
  assert.doesNotMatch(text, /unrelated/u);
});

test("a field a file both reads and indexes is one reference for each place", async (t) => {
  const { root } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts": "export interface Row {\n  total: number;\n}\n",
    "src/user.ts":
      'import type { Row } from "./row";\n\nexport const show = (row: Row, value: Row["total"]) => row.total + value;\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  const { references } = await map.references(
    { symbol: { path: "src/row.ts", name: "Row.total" }, maxResults: 20 },
    signal(),
  );
  assert.deepEqual(references.map((reference) => reference.kind).sort(), [
    "DECLARATION",
    "READ",
    "REFERENCE",
  ]);
});

test("an index on a generic or a union names the same field of each type", async (t) => {
  const { root } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/row.ts":
      "export interface Row {\n  total: number;\n}\nexport interface Sum {\n  total: string;\n}\n",
    "src/union.ts":
      'import type { Row, Sum } from "./row";\n\nexport type Union = (Row | Sum)["total"];\n',
    "src/generic.ts":
      'import type { Row } from "./row";\n\nexport type Generic<T extends Row> = T["total"];\n',
    "src/other.ts": 'import type { Sum } from "./row";\n\nexport type Other = Sum["total"];\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  const { references } = await map.references(
    { symbol: { path: "src/row.ts", name: "Row.total" }, maxResults: 20 },
    signal(),
  );
  assert.deepEqual([...new Set(references.map((reference) => reference.anchor.path))].sort(), [
    "src/generic.ts",
    "src/row.ts",
    "src/union.ts",
  ]);
});

// A field's reads are not all in the map, so its last recorded read going says nothing by itself.
test("a field an owner both writes and reads is still read, whichever comes first", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/box.ts":
      "declare function make(): () => void;\nexport class Box {\n  first = make();\n  last = make();\n  only = make();\n}\n",
    "src/report.ts":
      'import { Box } from "./box";\n\nexport function report(box: Box) {\n  box.first();\n  box.last();\n  box.only();\n}\n',
    "src/keeper.ts":
      'import { Box } from "./box";\ndeclare function make(): () => void;\n\nexport function keeper(box: Box) {\n  box.first = make();\n  const read = box.first;\n  const held = box.last;\n  box.last = make();\n  box.only = make();\n  return [read, held];\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/report.ts", "export const nothing = 1;\n");
  const { text } = await map.checkChanges({}, signal());
  const left = /^LEFT WITHOUT CALLERS[^\n]*\n((?: {2}.*\n)+)/mu.exec(text)?.[1];
  assert.equal(left, "  src/box.ts: Box.only p5\n");
});

test("a removed field is still used while any use of it is on a line the diff left alone", async (t) => {
  const code = `export interface Shape {
  side: number;
  name: string;
}
export function area(s: Shape) {
  const a = s.side;
  const b = s.side;
  return a + b + s.name.length;
}
`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/shape.ts": code,
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const without = code.replace("  side: number;\n", "");

  // Whichever of its two uses the diff changes, the other still names what is gone.
  for (const use of ["const a = s.side;", "const b = s.side;"]) {
    await write("src/shape.ts", without.replace(use, "const c = 1;"));
    assert.match(
      (await map.checkChanges({}, signal())).text,
      /^REMOVED OR RENAMED, STILL USED[^\n]*\n {2}src\/shape\.ts: Shape\.side p2 ← src\/shape\.ts: area$/mu,
    );
  }

  await write(
    "src/shape.ts",
    without
      .replace("const a = s.side;", "const a = 1;")
      .replace("const b = s.side;", "const b = 1;"),
  );
  assert.match(
    (await map.checkChanges({}, signal())).text,
    /^REMOVED OR RENAMED \(no code[^\n]*\n {2}src\/shape\.ts: Shape\.side p2$/mu,
  );
});

test("a field other code still reads is not left without callers", async (t) => {
  const reader = (reads: string) =>
    `import { Box } from "./box";\ndeclare function use(value: unknown): void;\n\nexport function report(box: Box) {\n  ${reads}\n}\n`;
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/box.ts":
      "declare function make(): () => void;\nexport class Box {\n  size = make();\n  spare = make();\n  reset() {\n    this.spare = make();\n  }\n}\n",
    "src/report.ts": reader("box.size();\n  box.spare();"),
    "src/total.ts":
      'import { Box } from "./box";\n\nexport function total(box: Box) {\n  const { size } = box;\n  return size;\n}\n',
  });
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/report.ts", reader("use(1);"));
  const { text } = await map.checkChanges({}, signal());
  const left = /^LEFT WITHOUT CALLERS[^\n]*\n((?: {2}.*\n)+)/mu.exec(text)?.[1];
  assert.equal(left, "  src/box.ts: Box.spare p4\n");
});

// low ← b0 … b3 ← high ← a0 … a3 ← a test: ten calls from the test down to low; and
// low ← z0 … z9, callers past the trace's eight levels that no test calls.
const CHAIN = (low: string, high: string) => {
  const above = (name: string, count: number, below: string) =>
    Array.from(
      { length: count },
      (_, at) =>
        `export function ${name}${at}(n: number) {\n  return ${at ? `${name}${at - 1}` : below}(n);\n}`,
    );
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/chain.ts": [
      `export function low(n: number) {\n  return n + ${low};\n}`,
      ...above("b", 4, "low"),
      `export function high(n: number) {\n  return b3(n) * ${high};\n}`,
      ...above("a", 4, "high"),
      ...above("z", 10, "low"),
    ].join("\n\n"),
    "test/chain.test.ts": 'import { a3 } from "../src/chain";\n\nexport const value = a3(1);\n',
  };
};

test("a given test reaches what the changed code it calls calls, however far below; beyond the trace's limits it says so", async (t) => {
  const { root, write } = await project(CHAIN("1", "2"));
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const tests = ["test/chain.test.ts"];

  // high is five calls from the test and low five from high: both are reached, and the callers
  // the trace stops at above low leave nothing unseen.
  await write("src/chain.ts", CHAIN("3", "4")["src/chain.ts"]);
  const both = (await map.checkChanges({ tests }, signal())).text;
  assert.match(both, /^ {2}none: the given tests reach all 2 changed declarations$/mu);
  assert.match(both, /the trace stopped at 8 levels/u);
  assert.doesNotMatch(both, /callers were followed/u);

  // low alone is ten calls from the test, past the trace's eight levels.
  await write("src/chain.ts", CHAIN("3", "2")["src/chain.ts"]);
  const deep = (await map.checkChanges({ tests }, signal())).text;
  assert.match(deep, /^ {2}1 of 1 changed declarations are reached by none of the given tests/mu);
  assert.match(
    deep,
    /^ {2}callers were followed 8 levels or 800 declarations up; a given test or entry point further up is not seen$/mu,
  );
});

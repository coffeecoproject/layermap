import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);

// A changed module-level variable or constant reaches the functions that read it, and through them the tests
// of every area that uses those functions, as a changed function does.
async function checkAfter(
  files: Record<string, string>,
  changed: [string, string],
): Promise<string> {
  const { root, write } = await project(files);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  const map = await openMap(root);
  try {
    await write(...changed);
    return (await map.checkChanges({}, signal())).text;
  } finally {
    map.close();
  }
}

test("a changed Go package variable reaches the functions that read it", async () => {
  const formats = (extra: string) =>
    `package date\n\nvar formats = []string{"2006-01-02"${extra}}\n\nfunc Parse(value string) string {\n\tfor _, format := range formats {\n\t\treturn format + value\n\t}\n\treturn value\n}\n`;
  const reader = (name: string) =>
    `package ${name}\n\nimport "example.com/m/date"\n\nfunc Read(value string) string {\n\treturn date.Parse(value)\n}\n`;
  const readerTest = (name: string) =>
    `package ${name}\n\nimport "testing"\n\nfunc TestRead(t *testing.T) {\n\tif Read("x") == "" {\n\t\tt.Fatal("empty")\n\t}\n}\n`;
  const text = await checkAfter(
    {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "date/date.go": formats(""),
      "json/json.go": reader("json"),
      "json/json_test.go": readerTest("json"),
      "rss/rss.go": reader("rss"),
      "rss/rss_test.go": readerTest("rss"),
    },
    ["date/date.go", formats(', "06-01-02"')],
  );
  assert.match(text, /date\/date\.go: formats/u);
  assert.match(text, /^ {2}json\/ \(Read\): json\/json_test\.go: TestRead$/mu);
  assert.match(text, /^ {2}rss\/ \(Read\): rss\/rss_test\.go: TestRead$/mu);
});

test("a changed Python module constant reaches the functions that read it", async () => {
  const date = (extra: string) =>
    `FORMATS = ["%Y-%m-%d"${extra}]\n\n\ndef parse(value):\n    for fmt in FORMATS:\n        return fmt + value\n    return value\n`;
  const reader = "from pkg.date import parse\n\n\ndef read(value):\n    return parse(value)\n";
  const readerTest = (name: string) =>
    `from pkg.${name} import read\n\n\ndef test_read():\n    assert read("x")\n`;
  const text = await checkAfter(
    {
      "pkg/__init__.py": "",
      "pkg/date.py": date(""),
      "pkg/feed_json.py": reader,
      "pkg/feed_rss.py": reader,
      "tests/test_feed_json.py": readerTest("feed_json"),
      "tests/test_feed_rss.py": readerTest("feed_rss"),
    },
    ["pkg/date.py", date(', "%y-%m-%d"')],
  );
  assert.match(text, /pkg\/date\.py: FORMATS/u);
  assert.match(text, /^ {2}pkg\/feed_json\.py \(read\): tests\/test_feed_json\.py: test_read$/mu);
  assert.match(text, /^ {2}pkg\/feed_rss\.py \(read\): tests\/test_feed_rss\.py: test_read$/mu);
});

test("a changed TypeScript module constant reaches the functions that read it", async () => {
  const date = (extra: string) =>
    `export const FORMATS = ["yyyy-mm-dd"${extra}];\n\nexport function parse(value: string): string {\n  return FORMATS[0] + value;\n}\n`;
  const reader = `import { parse } from "./date";\n\nexport function read(value: string): string {\n  return parse(value);\n}\n`;
  const readerTest = (name: string) =>
    `import { read } from "../src/${name}";\n\nexport function testRead() {\n  return read("x");\n}\n`;
  const text = await checkAfter(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src", "test"],
      }),
      "src/date.ts": date(""),
      "src/feedJson.ts": reader,
      "src/feedRss.ts": reader,
      "test/feedJson.test.ts": readerTest("feedJson"),
      "test/feedRss.test.ts": readerTest("feedRss"),
    },
    ["src/date.ts", date(', "yy-mm-dd"')],
  );
  assert.match(text, /src\/date\.ts: FORMATS/u);
  assert.match(text, /^ {2}src\/feedJson\.ts \(read\): test\/feedJson\.test\.ts: testRead$/mu);
  assert.match(text, /^ {2}src\/feedRss\.ts \(read\): test\/feedRss\.test\.ts: testRead$/mu);
});

test("a changed Java static constant reaches the methods that read it", {
  skip: !process.env.LAYERMAP_JAVA_HOME && !process.env.JAVA_HOME,
}, async () => {
  const date = (extra: string) =>
    `package app.date;\n\npublic class Dates {\n  static final String[] FORMATS = {"yyyy-MM-dd"${extra}};\n\n  public static String parse(String value) {\n    return FORMATS[0] + value;\n  }\n}\n`;
  const reader = (name: string, type: string) =>
    `package app.${name};\n\nimport app.date.Dates;\n\npublic class ${type} {\n  public static String read(String value) {\n    return Dates.parse(value);\n  }\n}\n`;
  const readerTest = (name: string, type: string) =>
    `package app.${name};\n\npublic class ${type}Test {\n  void testRead() {\n    ${type}.read("x");\n  }\n}\n`;
  const text = await checkAfter(
    {
      "src/main/java/app/date/Dates.java": date(""),
      "src/main/java/app/json/JsonFeed.java": reader("json", "JsonFeed"),
      "src/main/java/app/rss/RssFeed.java": reader("rss", "RssFeed"),
      "src/test/java/app/json/JsonFeedTest.java": readerTest("json", "JsonFeed"),
      "src/test/java/app/rss/RssFeedTest.java": readerTest("rss", "RssFeed"),
    },
    ["src/main/java/app/date/Dates.java", date(', "yy-MM-dd"')],
  );
  assert.match(text, /Dates\.java: Dates\.FORMATS/u);
  assert.match(text, /^ {2}src\/main\/java\/app\/json\/ \(JsonFeed\.read\): /mu);
  assert.match(text, /^ {2}src\/main\/java\/app\/rss\/ \(RssFeed\.read\): /mu);
});

test("a Python class passed as a value counts as a use of it; annotations and base classes do not", async () => {
  const client = (extra: string) =>
    `class Client:\n    def __init__(self, base):\n        self.base = base${extra}\n`;
  const text = await checkAfter(
    {
      "pkg/__init__.py": "",
      "pkg/client.py": client(""),
      "pkg/typed.py":
        "from typing import Optional\n\nfrom pkg.client import Client\n\ncache: dict[str, Client] = {}\n\n\nclass Special(Client):\n    pass\n\n\ndef describe(client: Optional[Client]) -> list[Client]:\n    return [client]\n",
      "tests/__init__.py": "",
      "tests/conftest.py":
        "import functools\n\nfrom pkg.client import Client\n\n\ndef client_factory():\n    return functools.partial(Client, base='x')\n",
      "tests/test_requests.py": "def test_get():\n    assert True\n",
    },
    ["pkg/client.py", client("\n        assert base")],
  );
  assert.match(text, /pkg\/client\.py: Client\.__init__/u);
  assert.match(text, /tests\/test_requests\.py \(may use it through tests\/conftest\.py\)/u);
  assert.doesNotMatch(text, /describe|Special/u);
});

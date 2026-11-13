import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { promisify } from "node:util";
import type { MapChangesData } from "../src/project-map-changes";
import { mapRunnableTest } from "../src/project-map-types";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);

async function check(files: Record<string, string>, changed: [string, string]) {
  const { root, write } = await project(files);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  await write(...changed);
  const map = await openMap(root);
  try {
    return JSON.parse(
      (await map.checkChanges({ format: "json" }, signal())).text,
    ) as MapChangesData;
  } finally {
    map.close();
  }
}
const selected = (data: MapChangesData) =>
  Object.fromEntries(data.tests.filter((item) => item.rank < 4).map((item) => [item.path, item]));

test("a helper in a Go test file stands for the tests calling it, as go test -run names them", async () => {
  const parse = (value: string) =>
    `package date\n\nfunc Parse(value string) string {\n\treturn value + "${value}"\n}\n`;
  const data = await check(
    {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "date/date.go": parse(""),
      "date/date_test.go": `package date

import "testing"

func setup() string {
\treturn Parse("x")
}

func TestShort(t *testing.T) {
\tif setup() == "" {
\t\tt.Fatal("empty")
\t}
}

func TestLong(t *testing.T) {
\tif len(setup()) > 9 {
\t\tt.Fatal("long")
\t}
}
`,
    },
    ["date/date.go", parse("!")],
  );
  assert.deepEqual(
    selected(data)["date/date_test.go"]?.names,
    ["TestLong", "TestShort"],
    JSON.stringify(data.tests),
  );
});

// An Express-style CommonJS app: controllers wrapped as catchAsync(async (req, res) => ...) and
// exported in module.exports = { ... }, required by the routes that register them.
const COMMONJS = {
  "src/users.service.js":
    "function readUser(id) {\n  return { id };\n}\n\nmodule.exports = { readUser };\n",
  "src/wrap.js": "module.exports = (fn) => (req, res) => fn(req, res);\n",
  "src/users.controller.js": `const wrap = require("./wrap");
const service = require("./users.service");

const getUser = wrap(async (req, res) => res.send(service.readUser(req.params.id)));

module.exports = { getUser };
`,
  "src/routes.js": `const controller = require("./users.controller");

module.exports = function register(router) {
  router.get("/users/:userId", controller.getUser);
};
`,
  "src/app.js": `const register = require("./routes");

function buildApp() {
  const routes = [];
  const router = { get: (path, handler) => routes.push([path, handler]) };
  register(router);
  return router;
}

module.exports = { buildApp };
`,
  "test/users.test.js": `const { buildApp } = require("../src/app");

function readsAUser(request) {
  return request(buildApp()).get("/users/1");
}

module.exports = { readsAUser };
`,
  "test/health.test.js": `const { buildApp } = require("../src/app");

function startsTheApp() {
  return buildApp();
}

module.exports = { startsTheApp };
`,
};

// The ways a CommonJS module exports its controllers, each wrapped or not.
const CONTROLLERS = {
  "module.exports = { getUser }, getUser wrapped": `const wrap = require("./wrap");
const service = require("./users.service");

const getUser = wrap(async (req, res) => res.send(service.readUser(req.params.id)));

module.exports = { getUser };
`,
  "module.exports = { getUser: read }": `const service = require("./users.service");

const read = async (req, res) => res.send(service.readUser(req.params.id));

module.exports = { getUser: read };
`,
  "exports.getUser = wrap(...)": `const wrap = require("./wrap");
const service = require("./users.service");

exports.getUser = wrap(async (req, res) => res.send(service.readUser(req.params.id)));
`,
  "module.exports.getUser = function": `const service = require("./users.service");

module.exports.getUser = function (req, res) {
  return res.send(service.readUser(req.params.id));
};
`,
};

for (const [form, controller] of Object.entries(CONTROLLERS))
  test(`a CommonJS route finds its controller, exported as ${form}, and the tests requesting it`, async () => {
    const data = await check({ ...COMMONJS, "src/users.controller.js": controller }, [
      "src/users.service.js",
      COMMONJS["src/users.service.js"].replace("{ id }", "{ id, read: true }"),
    ]);
    const tests = selected(data);
    assert.deepEqual(Object.keys(tests), ["test/users.test.js"], JSON.stringify(data.tests));
    assert.equal(tests["test/users.test.js"]?.why, 'requests "GET /users/:userId"');
  });

test("a value a call builds from a function is no handler unless it can be called", async () => {
  const { root } = await project({
    "src/store.js": `function makeStore(build) {
  return { state: build() };
}

function makeHandler(handle) {
  return (req, res) => handle(req, res);
}

const store = makeStore(() => ({ count: 1 }));
const handler = makeHandler((req, res) => res.send(1));

module.exports = function register(router) {
  router.get("/state", store);
  router.get("/handled", handler);
};
`,
  });
  const map = await openMap(root);
  try {
    const text = (await map.explore({ path: "src/store.js", name: "register" }, signal())).text;
    assert.match(text, /handler v\d+ @\d+ "GET \/handled"/u, text);
    // Read as module state, as any module variable is, but not as the route's handler.
    assert.doesNotMatch(text, /store v\d+ @\d+ "GET \/state"/u, text);
  } finally {
    map.close();
  }
});

test("a helper another test file calls stands for that file's tests", async () => {
  const data = await check(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src", "test"],
      }),
      "src/parse.ts": "export function parse(value: string) {\n  return value;\n}\n",
      "test/parse.test.ts": `import { parse } from "../src/parse";

export function setup() {
  return parse("x");
}

export function parsesAValue() {
  return setup();
}
`,
      "test/other.test.ts": `import { setup } from "./parse.test";

export function readsWithSetup() {
  return setup().length;
}
`,
    },
    ["src/parse.ts", "export function parse(value: string) {\n  return value.trim();\n}\n"],
  );
  const tests = selected(data);
  assert.deepEqual(
    tests["test/parse.test.ts"]?.names,
    ["parsesAValue"],
    JSON.stringify(data.tests),
  );
  assert.deepEqual(
    tests["test/other.test.ts"]?.names,
    ["readsWithSetup"],
    JSON.stringify(data.tests),
  );
});

test("a CommonJS require binds an import, not a declaration of the file", async () => {
  const read = (path: string) => `const fs = require("${path}");
const { join } = require("node:path");
const store = require("./store");

function readConfig(dir) {
  return fs.readFileSync(join(dir, "config.json"), "utf8") + store.count;
}

module.exports = { readConfig };
`;
  const { root, write } = await project({
    "src/store.js": "let count = 0;\n\nmodule.exports = { count };\n",
    "src/read.js": read("node:fs"),
  });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  await write("src/read.js", read("fs"));
  const map = await openMap(root);
  try {
    const text = (await map.checkChanges({}, signal())).text;
    assert.match(text, /0 changed and 0 removed declarations/u, text);
    assert.match(text, /top-level code of src\/read\.js changed/u, text);
    const explored = (await map.explore({ path: "src/read.js" }, signal())).text;
    assert.doesNotMatch(explored, /\b(fs|join|store) v\d/u, explored);
  } finally {
    map.close();
  }
});

test("a test helper file stands for the tests calling it, and for every test beside it only when none does", async () => {
  const files = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/parse.ts": "export function parse(value: string) {\n  return value;\n}\n",
    "src/load.ts": "export function load() {\n  return 1;\n}\n",
    "test/support.ts": `import { parse } from "../src/parse";

export function setup() {
  return parse("x");
}
`,
    // Run before the tests by the runner's configuration: no test calls it.
    "test/setup.ts": 'import { load } from "../src/load";\n\nload();\n',
    "test/parse.test.ts": `import { setup } from "./support";

export function parsesAValue() {
  return setup();
}
`,
    "test/other.test.ts": "export function addsUp() {\n  return 1 + 1;\n}\n",
  };
  const parsed = selected(
    await check(files, [
      "src/parse.ts",
      "export function parse(value: string) {\n  return value.trim();\n}\n",
    ]),
  );
  assert.deepEqual(Object.keys(parsed), ["test/parse.test.ts"], JSON.stringify(parsed));
  const loaded = selected(
    await check(files, ["src/load.ts", "export function load() {\n  return 2;\n}\n"]),
  );
  assert.deepEqual(
    Object.keys(loaded).sort(),
    ["test/other.test.ts", "test/parse.test.ts"],
    JSON.stringify(loaded),
  );
  assert.equal(loaded["test/other.test.ts"]?.why, "may use it through test/setup.ts");
});

test("the tests a runner runs by its own conventions are selected, not climbed past as helpers", async () => {
  const sum = (by: string) =>
    `export function sum(a: number, b: number) {\n  return a + b${by};\n}\n`;
  const calls = (from: string) =>
    `import { sum } from "${from}";\n\nexport function check() {\n  return sum(1, 2);\n}\n`;
  const data = await check(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src", "test"],
      }),
      "src/sum.ts": sum(""),
      // Jest runs every file in a __tests__ directory; Nest's e2e tests end in e2e-spec.
      "src/__tests__/sum.ts": calls("../sum"),
      "test/app.e2e-spec.ts": calls("../src/sum"),
    },
    ["src/sum.ts", sum(" + 0")],
  );
  assert.deepEqual(Object.keys(selected(data)).sort(), [
    "src/__tests__/sum.ts",
    "test/app.e2e-spec.ts",
  ]);
});

test("Java and Kotlin tests are runnable by the names Surefire and Failsafe run", () => {
  for (const file of [
    "src/test/java/a/UserServiceTest.java",
    "src/test/java/a/UserServiceTests.java",
    "src/test/java/a/TestUserService.java",
    "src/test/java/a/UserServiceTestCase.java",
    "src/test/kotlin/a/UserServiceIT.kt",
    "src/test/java/a/ITUserService.java",
    "src/test/java/a/UserServiceITCase.java",
  ])
    assert.ok(mapRunnableTest(file), file);
  for (const file of ["src/test/java/a/Fixtures.java", "src/test/java/a/Testing.java"])
    assert.ok(!mapRunnableTest(file), file);
});

test("a search of the tests for a route's path that the deadline stops says how many were left", async (t) => {
  const items = (by: string) => `export function list() {\n  return [1${by}];\n}\n`;
  const tests = Object.fromEntries(
    Array.from({ length: 70 }, (_, at) => [
      `test/t${String(at).padStart(2, "0")}.test.ts`,
      `export const url = "/elsewhere/${at}";\n`,
    ]),
  );
  const { root, write } = await project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "src/items.ts": items(""),
    "src/routes.ts":
      'import { list } from "./items";\n\ndeclare const router: { get(path: string, h: () => unknown): void };\nrouter.get("/items/all", () => list());\n',
    ...tests,
  });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  await write("src/items.ts", items(", 2"));
  const map = await openMap(root);
  t.after(() => map.close());
  // The clock passes any deadline once the search reads its first test: the first batch is read,
  // the rest is not.
  const real = Date.now;
  let late = false;
  t.mock.method(Date, "now", () => (late ? real() + 3_600_000 : real()));
  const read = fs.readFile;
  t.mock.method(fs, "readFile", (...args: Parameters<typeof read>) => {
    if (/\/t\d+\.test\.ts$/u.test(String(args[0]))) late = true;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /the check ran out of time before searching 6 of the project's runnable tests for the paths of the routes the change reaches/u,
  );
});

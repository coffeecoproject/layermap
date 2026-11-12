import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import type { MapChangesData } from "../src/project-map-changes";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);

// A service whose routes are registered under paths built from constants, one of them imported,
// and whose tests build the whole app and request the routes with the same constants, as Fastify
// apps tested with app.inject() are. A ${...} placeholder is split so it stays text here.
const $ = "$";
const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src", "test"] }),
  "src/paths.ts": `export const API = "/api/v1";\nexport const ITEMS_PATH = \`${$}{API}/items\`;\n`,
  "src/app.ts": `export class App {
  get(path: string, handler: () => unknown) {
    return [path, handler];
  }
  inject(request: { method: string; url: string }) {
    return request;
  }
}
`,
  "src/service.ts": `export function readItem() {
  return 1;
}
export function readStock() {
  return 2;
}
export function readHidden() {
  return 3;
}
export function readHistory() {
  return 4;
}
export function readOrder() {
  return 5;
}
`,
  "src/routes.ts": `import type { App } from "./app";
import { API, ITEMS_PATH } from "./paths";
import { readHidden, readHistory, readItem, readOrder, readStock } from "./service";

const root = ITEMS_PATH;

export function registerItemRoutes(app: App) {
  app.get(\`${$}{root}/:itemId\`, async () => readItem());
  app.get(API + "/stock", async () => readStock());
  app.get(\`${$}{API}/hidden\`, async () => readHidden());
  app.get(\`${$}{API}/history\`, async () => readHistory());
  app.get(\`${$}{API}/orders/:orderId\`, async () => readOrder());
}
`,
  "src/server.ts": `import { buildApp } from "./build";

export function main() {
  return buildApp();
}
`,
  "src/build.ts": `import { App } from "./app";
import { registerItemRoutes } from "./routes";

export function buildApp() {
  const app = new App();
  registerItemRoutes(app);
  return app;
}
`,
  "test/items.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

export function readsAnItem(id: string) {
  return buildApp().inject({ method: "GET", url: \`${$}{ITEMS_PATH}/${$}{id}\` });
}
`,
  "test/stock.test.ts": `import { buildApp } from "../src/build";

export function readsTheStock(baseUrl: string) {
  buildApp();
  return fetch(\`${$}{baseUrl}/api/v1/stock\`);
}
`,
  // A helper of the tests sends the request; the tests calling it make it.
  "test/requests.ts": `import type { App } from "../src/app";
import { API } from "../src/paths";

export function requestHistory(app: App) {
  return app.inject({ method: "GET", url: \`${$}{API}/history\` });
}
`,
  "test/history.test.ts": `import { buildApp } from "../src/build";
import { requestHistory } from "./requests";

export function readsTheHistory() {
  return requestHistory(buildApp());
}
`,
  // A helper no test calls: its request is no test's.
  "test/unused.ts": `import type { App } from "../src/app";
import { API } from "../src/paths";

export function requestHidden(app: App) {
  return app.inject({ method: "GET", url: \`${$}{API}/hidden\` });
}
`,
  // A test naming only a stretch of a route's path, not requesting it.
  "test/mention.test.ts": `export const ORDERS_DOC = "the orders are under /api/v1/orders";
`,
  "test/health.test.ts": `import { buildApp } from "../src/build";

export function startsTheApp() {
  return buildApp();
}
`,
};

async function changed(file: string, from: string, to: string) {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  await write(file, (FILES as Record<string, string>)[file]?.replace(from, to) ?? "");
  return root;
}

const check = async (root: string) => {
  const map = await openMap(root);
  try {
    return JSON.parse(
      (await map.checkChanges({ format: "json" }, signal())).text,
    ) as MapChangesData;
  } finally {
    map.close();
  }
};
const tests = (data: MapChangesData) =>
  Object.fromEntries(data.tests.filter((item) => item.rank < 4).map((item) => [item.path, item]));

test("a route registered under constants is found, with the tests requesting it and not every test of the app", async () => {
  const data = await check(await changed("src/service.ts", "return 1;", "return 10;"));
  const selected = tests(data);
  assert.deepEqual(
    Object.keys(selected).sort(),
    ["test/items.test.ts"],
    JSON.stringify(data.tests),
  );
  assert.deepEqual(selected["test/items.test.ts"], {
    path: "test/items.test.ts",
    names: ["readsAnItem"],
    why: 'requests "GET /api/v1/items/:itemId"',
    rank: 2,
  });
});

test("a test requesting a route under a base URL it computes is found too", async () => {
  const data = await check(await changed("src/service.ts", "return 2;", "return 20;"));
  const selected = tests(data);
  assert.deepEqual(
    Object.keys(selected).sort(),
    ["test/stock.test.ts"],
    JSON.stringify(data.tests),
  );
  assert.equal(selected["test/stock.test.ts"]?.why, 'requests "GET /api/v1/stock"');
});

test("for a route no test requests, the tests of the app that registers it are kept, a helper no test calls aside", async () => {
  const data = await check(await changed("src/service.ts", "return 3;", "return 30;"));
  assert.deepEqual(
    Object.keys(tests(data)).sort(),
    ["test/health.test.ts", "test/history.test.ts", "test/items.test.ts", "test/stock.test.ts"],
    JSON.stringify(data.tests),
  );
  assert.ok(
    data.tests.every((item) => item.why === "calls buildApp"),
    JSON.stringify(data.tests),
  );
});

test("a change in a route's own handler finds the tests requesting the route", async () => {
  const data = await check(
    await changed("src/routes.ts", "async () => readItem()", "async () => readItem() + 1"),
  );
  assert.deepEqual(Object.keys(tests(data)).sort(), ["test/items.test.ts"], JSON.stringify(data));
});

test("a route a test helper requests is requested by the tests calling the helper", async () => {
  const data = await check(await changed("src/service.ts", "return 4;", "return 40;"));
  const selected = tests(data);
  assert.deepEqual(Object.keys(selected), ["test/history.test.ts"], JSON.stringify(data.tests));
  assert.equal(selected["test/history.test.ts"]?.why, 'requests "GET /api/v1/history"');
  assert.deepEqual(selected["test/history.test.ts"]?.names, ["readsTheHistory"]);
});

test("a test naming only a stretch of a route's path does not stand for the tests requesting it", async () => {
  const data = await check(await changed("src/service.ts", "return 5;", "return 50;"));
  const selected = tests(data);
  assert.deepEqual(
    Object.keys(selected).sort(),
    [
      "test/health.test.ts",
      "test/history.test.ts",
      "test/items.test.ts",
      "test/mention.test.ts",
      "test/stock.test.ts",
    ],
    JSON.stringify(data.tests),
  );
  assert.equal(selected["test/mention.test.ts"]?.why, 'mentions "GET /api/v1/orders/:orderId"');
});

test("the entry points of a change the given tests miss go on past its route", async () => {
  const root = await changed("src/service.ts", "return 1;", "return 10;");
  const map = await openMap(root);
  try {
    const data = JSON.parse(
      (await map.checkChanges({ format: "json", tests: ["test/mention.test.ts"] }, signal())).text,
    ) as MapChangesData;
    assert.deepEqual(
      data.untested?.entries.map((entry) => entry.label),
      ["GET /api/v1/items/:itemId", "src/server.ts: main"],
      JSON.stringify(data.untested),
    );
  } finally {
    map.close();
  }
});

test("constants referring to each other through imports leave the path unknown", {
  timeout: 120_000,
}, async () => {
  const { root } = await project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/a.ts": 'import { B } from "./b";\nexport const A: string = B;\n',
    "src/b.ts": 'import { A } from "./a";\nexport const B: string = A;\n',
    "src/routes.ts":
      'import { A } from "./a";\nexport function register(app: { get(p: string, h: () => void): void }) {\n  app.get(A, () => {});\n}\n',
  });
  const map = await openMap(root);
  try {
    assert.match((await map.explore({ path: "src/routes.ts" }, signal())).text, /register/u);
  } finally {
    map.close();
  }
});

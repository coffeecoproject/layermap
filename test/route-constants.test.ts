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

async function changed(
  file: string,
  from: string,
  to: string,
  files: Record<string, string> = FILES,
) {
  const { root, write } = await project(files);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  await write(file, files[file]?.replace(from, to) ?? "");
  return root;
}

const check = async (root: string, given?: string[]) => {
  const map = await openMap(root);
  try {
    return JSON.parse(
      (await map.checkChanges({ format: "json", ...(given ? { tests: given } : {}) }, signal()))
        .text,
    ) as MapChangesData;
  } finally {
    await map.close();
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

test("for a route no test requests, where the app's tests request its routes in ways the map reads, no test is selected and the check says so", async () => {
  const data = await check(await changed("src/service.ts", "return 3;", "return 30;"));
  assert.deepEqual(Object.keys(tests(data)), [], JSON.stringify(data.tests));
  assert.ok(
    data.checkByHand.includes(
      'no test is found to request "GET /api/v1/hidden": a test requesting it in a way the map does not read is not selected',
    ),
    JSON.stringify(data.checkByHand),
  );
});

test("for a route no test requests, where the map reads no request of the app's tests, the tests of the app are kept, a helper no test calls aside", async () => {
  const files: Record<string, string> = { ...FILES };
  for (const file of ["test/items.test.ts", "test/stock.test.ts", "test/history.test.ts"])
    delete files[file];
  const data = await check(await changed("src/service.ts", "return 3;", "return 30;", files));
  assert.deepEqual(Object.keys(tests(data)), ["test/health.test.ts"], JSON.stringify(data.tests));
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
    ["test/mention.test.ts"],
    JSON.stringify(data.tests),
  );
  assert.equal(selected["test/mention.test.ts"]?.why, 'mentions "GET /api/v1/orders/:orderId"');
  // Not taken for a request of the route: the check says none is found.
  assert.ok(
    data.checkByHand.includes(
      'no test is found to request "GET /api/v1/orders/:orderId": a test requesting it in a way the map does not read is not selected',
    ),
    JSON.stringify(data.checkByHand),
  );
});

test("the routes no test is found to request are named in one line", async () => {
  const from = FILES["src/service.ts"].slice(
    FILES["src/service.ts"].indexOf("return 3;"),
    FILES["src/service.ts"].indexOf("return 5;") + "return 5;".length,
  );
  const data = await check(
    await changed("src/service.ts", from, from.replaceAll(/return (\d);/gu, "return $1$1;")),
  );
  const lines = data.checkByHand.filter((line) => line.startsWith("no test is found"));
  assert.equal(lines.length, 1, JSON.stringify(data.checkByHand));
  assert.match(lines[0] ?? "", /^no test is found to request 2 routes the change reaches \(/u);
  assert.ok(
    ['"GET /api/v1/hidden"', '"GET /api/v1/orders/:orderId"'].every((label) =>
      lines[0]?.includes(label),
    ),
    JSON.stringify(lines),
  );
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
    // The test requesting that route runs the change, which the given one does not.
    assert.deepEqual(
      data.untested?.runByOthers.map((each) => each.tests),
      [["test/items.test.ts"]],
      JSON.stringify(data.untested),
    );
  } finally {
    await map.close();
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
    await map.close();
  }
});

test("a constant first met deep in another path keeps its value where it is met again", async () => {
  // src/a.ts is read first, and meets ITEMS_PATH deep inside a path it builds.
  const root = await changed("src/service.ts", "return 1;", "return 10;", {
    ...FILES,
    "src/a.ts": `import type { App } from "./app";
import { ITEMS_PATH } from "./paths";

export function registerDeep(app: App) {
  app.get("" + ("" + ("" + ("" + ("" + ("" + ("" + ITEMS_PATH)))))) + "/deep", async () => 0);
}
`,
  });
  const selected = tests(await check(root));
  assert.match(
    selected["test/items.test.ts"]?.why ?? "",
    /requests "GET \/api\/v1\/items\/:itemId"/u,
    JSON.stringify(selected),
  );
});

test("a test requesting a path the map cannot work out is kept for a route other tests request", async () => {
  const root = await changed("src/service.ts", "return 1;", "return 10;", {
    ...FILES,
    // The path comes from a function: it may be any route of the app.
    "test/item-path.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

const itemPath = (id: string) => ITEMS_PATH + "/" + id;

export function readsAnItemByPath() {
  return buildApp().inject({ method: "GET", url: itemPath("1") });
}
`,
    // A shorthand url the map works out requests its route.
    "test/shorthand.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

export function readsAnItemByShorthand() {
  const url = \`${$}{ITEMS_PATH}/1\`;
  return buildApp().inject({ method: "GET", url });
}
`,
    // A lookup by a key is no request.
    "test/cache.test.ts": `import { buildApp } from "../src/build";

const cache = new Map<string, string>();

export function readsTheCache(key: string) {
  buildApp();
  return cache.get(key);
}
`,
  });
  const data = await check(root);
  const selected = tests(data);
  assert.deepEqual(
    Object.keys(selected).sort(),
    ["test/item-path.test.ts", "test/items.test.ts", "test/shorthand.test.ts"],
    JSON.stringify(data.tests),
  );
  assert.equal(
    selected["test/item-path.test.ts"]?.why,
    'may request "GET /api/v1/items/:itemId": the path a request of it is sent to is not worked out',
  );
  assert.deepEqual(selected["test/item-path.test.ts"]?.names, ["readsAnItemByPath"]);
  assert.equal(selected["test/shorthand.test.ts"]?.why, 'requests "GET /api/v1/items/:itemId"');
  // Only the tests found to request the route run the change; one that may request it is no
  // evidence that it is run.
  const given = await check(root, ["test/mention.test.ts"]);
  assert.deepEqual(
    given.untested?.runByOthers.map((each) => each.tests),
    [["test/items.test.ts", "test/shorthand.test.ts"]],
    JSON.stringify(given.untested),
  );
});

// Requests sent as supertest sends them, by a method other than the route's, and calls that look
// like requests but send none, to the app of FILES.
const SENDERS = {
  ...FILES,
  // supertest, a package: request(app) makes a client, its get and post send the requests.
  "test/supertest.d.ts": `declare module "supertest" {
  type Client = { get(path: string): Promise<unknown>; post(path: string): Promise<unknown> };
  export default function request(app: unknown): Client;
}
`,
  "test/supertest-items.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";
import request from "supertest";

export function readsAnItemThroughAClient() {
  return request(buildApp()).get(\`${$}{ITEMS_PATH}/1\`);
}

export function readsAnItemThroughABoundClient() {
  const api = request(buildApp());
  return api.get(\`${$}{ITEMS_PATH}/2\`);
}
`,
  "test/supertest-stock.test.ts": `import { buildApp } from "../src/build";
import { API } from "../src/paths";
import request from "supertest";

export function readsTheStockThroughAClient() {
  return request(buildApp()).get(API + "/stock");
}
`,
  // Only POSTs to the items' path, which no route serves.
  "test/add-item.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";
import request from "supertest";

export function addsAnItem() {
  return buildApp().inject({ method: "POST", url: \`${$}{ITEMS_PATH}/1\` });
}

export function addsAnItemThroughAClient() {
  return request(buildApp()).post(\`${$}{ITEMS_PATH}/1\`);
}
`,
  // Lookups and a local function that send no request, whatever their arguments.
  "test/lookups.test.ts": `import { buildApp } from "../src/build";

declare const db: { prepare(sql: string): { get(id: unknown): unknown } };
declare const wrapper: { get(selector: unknown): unknown };
const request = (at: number) => at;

export function readsRows(id: string, selector: string, text: string) {
  buildApp();
  return [db.prepare("SELECT 1").get(id), wrapper.get(selector), request(text.indexOf("/"))];
}
`,
};

test("supertest-style requests are read by their method and path, and calls sending none are no requests", async () => {
  const data = await check(await changed("src/service.ts", "return 1;", "return 10;", SENDERS));
  const selected = tests(data);
  assert.deepEqual(
    Object.keys(selected).sort(),
    ["test/items.test.ts", "test/supertest-items.test.ts"],
    JSON.stringify(data.tests),
  );
  assert.deepEqual(selected["test/supertest-items.test.ts"], {
    path: "test/supertest-items.test.ts",
    names: ["readsAnItemThroughABoundClient", "readsAnItemThroughAClient"],
    why: 'requests "GET /api/v1/items/:itemId"',
    rank: 2,
  });
});

test("a route only requested by another method is requested by no test, and the check says so", async () => {
  const { "test/items.test.ts": _, "test/supertest-items.test.ts": __, ...others } = SENDERS;
  const data = await check(await changed("src/service.ts", "return 1;", "return 10;", others));
  assert.deepEqual(Object.keys(tests(data)), [], JSON.stringify(data.tests));
  assert.match(
    data.checkByHand.join("\n"),
    /no test is found to request "GET \/api\/v1\/items\/:itemId"/u,
    JSON.stringify(data.checkByHand),
  );
});

test("the given tests run a change only by their calls and the routes they request", async () => {
  const root = await changed("src/service.ts", "return 1;", "return 10;", {
    ...SENDERS,
    "test/comment.test.ts":
      "// The items are read at /api/v1/items/:itemId.\nexport const NOTE = 1;\n",
    "test/item-path.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

const itemPath = (id: string) => ITEMS_PATH + "/" + id;

export function readsAnItemByPath() {
  return buildApp().inject({ method: "GET", url: itemPath("1") });
}
`,
  });
  // Building the app, naming the path in a comment, or requesting it by another method runs
  // none of the route's handlers.
  for (const given of ["test/health.test.ts", "test/comment.test.ts", "test/add-item.test.ts"]) {
    const data = await check(root, [given]);
    assert.deepEqual(data.untested?.changed, ["src/service.ts: readItem f1-3"], given);
    assert.deepEqual(data.untested?.throughRoutes, [], given);
    assert.deepEqual(
      data.untested?.runByOthers.map((each) => each.tests),
      [["test/items.test.ts", "test/supertest-items.test.ts"]],
      given,
    );
  }
  // Requesting it runs them.
  const requesting = await check(root, ["test/supertest-items.test.ts"]);
  assert.deepEqual(requesting.untested?.changed, [], JSON.stringify(requesting.untested));
  assert.deepEqual(requesting.untested?.throughRoutes, ["src/service.ts: readItem f1-3"]);
  assert.deepEqual(requesting.untested?.routes, ["GET /api/v1/items/:itemId"]);
  // A request whose path is not worked out may run them: not counted, but named.
  const unknown = await check(root, ["test/item-path.test.ts"]);
  assert.deepEqual(unknown.untested?.changed, ["src/service.ts: readItem f1-3"]);
  assert.deepEqual(
    unknown.untested?.mayRun,
    [{ declaration: "src/service.ts: readItem f1-3", tests: ["test/item-path.test.ts"] }],
    JSON.stringify(unknown.untested),
  );
});

// More ways tests send requests, to an app with a POST route as well.
const WAYS = {
  ...FILES,
  "src/app.ts": FILES["src/app.ts"].replace(
    "  inject(",
    "  post(path: string, handler: () => unknown) {\n    return [path, handler];\n  }\n  inject(",
  ),
  "src/service.ts": `${FILES["src/service.ts"]}export function addOrder() {\n  return 6;\n}\n`,
  "src/routes.ts": FILES["src/routes.ts"]
    .replace("readStock }", "readStock, addOrder }")
    .replace(
      '  app.get(API + "/stock"',
      `  app.post(\`${$}{API}/orders\`, async () => addOrder());\n  app.get(API + "/stock"`,
    ),
  // A get of the test's own sends the path it is given.
  "test/own-get.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

declare function get(path: string): Promise<unknown>;

export function readsAnItemWithItsOwnGet() {
  buildApp();
  return get(\`${$}{ITEMS_PATH}/1\`);
}
`,
  // A visit sent a path is a request, whatever is chained after it.
  "test/visit.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

declare const cy: any;

export function visitsAnItem() {
  buildApp();
  return cy.visit(\`${$}{ITEMS_PATH}/1\`).get("h1");
}
`,
  // Options spread from elsewhere may name any method.
  "test/spread.test.ts": `import { buildApp } from "../src/build";
import { API } from "../src/paths";

declare const init: RequestInit;

export function addsAnOrder() {
  buildApp();
  return fetch(API + "/orders", { ...init });
}
`,
  // A Request object names its own method.
  "test/request-object.test.ts": `import { buildApp } from "../src/build";

export function addsAnOrderByRequest(url: string) {
  buildApp();
  return fetch(new Request(url, { method: "POST" }));
}
`,
  // An untyped client, made by a call: requests go through it, the call sends none.
  "test/untyped-client.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

declare const request: any;
declare const server: any;

export function readsAnItemThroughAnUntypedClient() {
  buildApp();
  return request(server).get(\`${$}{ITEMS_PATH}/1\`);
}

export function readsAnItemThroughABoundUntypedClient() {
  buildApp();
  const api = request(server);
  return api.get(\`${$}{ITEMS_PATH}/2\`);
}
`,
  // A client named for nothing it does: what its get gives is awaited, as a response is.
  "test/awaited.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

declare const superagent: { get(path: string): Promise<unknown> };
const itemPath = (id: string) => ITEMS_PATH + "/" + id;

export function readsAnItemThroughSuperagent(id: string) {
  buildApp();
  return superagent.get(itemPath(id));
}
`,
  // The same name bound in another function is another value: fetch's result here is a response.
  "test/scoped.test.ts": `import { buildApp } from "../src/build";
import { ITEMS_PATH } from "../src/paths";

declare function client(): { get(path: string): Promise<unknown> };
const itemPath = (id: string) => ITEMS_PATH + "/" + id;

export function readsAnItemByPath(id: string) {
  buildApp();
  const res = fetch(itemPath(id));
  return res;
}

export function readsElsewhere() {
  const res = client();
  return res.get("/elsewhere");
}
`,
  // A helper of the tests sends what it is called for: its request is read where it is sent.
  "test/harness.ts": `import { ITEMS_PATH } from "../src/paths";

const get = (id: string) => fetch(\`${$}{ITEMS_PATH}/${$}{id}\`);

export const harness = () => ({ get });
`,
  // A function declared to give any, whatever it does, is not a client's.
  // An untyped value's get may be a client's, whatever it is named.
  "test/untyped-value.test.ts": `import { buildApp } from "../src/build";

declare const harness: any;

export function readsThroughAnUntypedValue(path: string) {
  buildApp();
  return harness.get(path);
}
`,
  "test/reflect.test.ts": `import { buildApp } from "../src/build";

export function readsAProperty(target: any, key: string) {
  buildApp();
  return Reflect.get(target, key);
}
`,
  // A client of the app's own, whose requests are not read: the test's call is all there is.
  "src/client.ts": `export const api = { get: (path: string) => fetch(path) };
`,
  "test/app-client.test.ts": `import { buildApp } from "../src/build";
import { api } from "../src/client";

export function readsThroughTheAppsClient(path: string) {
  buildApp();
  return api.get(path);
}
`,
  "test/helper.test.ts": `import { buildApp } from "../src/build";
import { harness } from "./harness";

export function readsAnItemThroughAHelper(id: string) {
  buildApp();
  return harness().get(id);
}
`,
};

test("requests are read however a test sends them, by the method they may have", async () => {
  const ranks = async (file: string, from: string, to: string) =>
    Object.fromEntries(
      Object.values(tests(await check(await changed(file, from, to, WAYS)))).map((item) => [
        item.path,
        item.rank,
      ]),
    );
  assert.deepEqual(await ranks("src/service.ts", "return 1;", "return 10;"), {
    "test/app-client.test.ts": 3,
    "test/awaited.test.ts": 3,
    "test/helper.test.ts": 2,
    "test/items.test.ts": 2,
    "test/own-get.test.ts": 2,
    "test/request-object.test.ts": 3,
    "test/scoped.test.ts": 3,
    "test/untyped-client.test.ts": 2,
    "test/untyped-value.test.ts": 3,
    "test/visit.test.ts": 2,
  });
  // Neither GETs to the orders' path: one may send any method, the other names its own.
  assert.deepEqual(await ranks("src/service.ts", "return 6;", "return 60;"), {
    "test/mention.test.ts": 3.5,
    "test/request-object.test.ts": 3,
    "test/spread.test.ts": 2,
  });
  // The untyped client is made by calls that send no request: the stock is not requested by it;
  // nor by the helper's get, whose request is read in the helper.
  assert.deepEqual(await ranks("src/service.ts", "return 2;", "return 20;"), {
    "test/app-client.test.ts": 3,
    "test/awaited.test.ts": 3,
    "test/request-object.test.ts": 3,
    "test/scoped.test.ts": 3,
    "test/stock.test.ts": 2,
    "test/untyped-value.test.ts": 3,
  });
});

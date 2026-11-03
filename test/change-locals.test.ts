import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);
const commit = async (root: string) => {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
};

// A factory whose returned closures two pages reach through another factory's returned closures:
// what a page calls is not what creates the runtime it calls it on.
const READER = (row = "id", other = "id", prefix = "a") => `function listRow(id: number) {
  return ${row};
}
function listOther(id: number) {
  return ${other};
}
export function createReader() {
  const prefix = "${prefix}";
  const rows = () => [1].map((id) => listRow(id));
  const others = () => listOther(1);
  return { prefix, rows, others };
}
`;
const FACTORIES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src", "test"] }),
  "src/reader.ts": READER(),
  "src/runtime.ts": `import { createReader } from "./reader";
export function createRuntime() {
  const reader = createReader();
  const getRows = () => reader.rows();
  const getOthers = () => reader.others();
  return { getRows, getOthers };
}
`,
  "src/pages.ts": `import { createRuntime } from "./runtime";
export function ordersPage() {
  return createRuntime().getRows();
}
export function couponsPage() {
  return createRuntime().getOthers();
}
`,
};

// One section of a report: the lines under its heading.
const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(heading));
  if (at < 0) return [];
  const end = lines.findIndex((line, index) => index > at && !line.startsWith("  "));
  return lines.slice(at + 1, end < 0 ? undefined : end).map((line) => line.trim());
};
const CERTAIN = "AFFECTED ENTRY POINTS";
const POSSIBLE = "POSSIBLY AFFECTED";

test("a function a factory's returned closure uses reaches the page calling that closure, not the pages calling its others", async (t) => {
  const { root, write } = await project(FACTORIES);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id + 1"));
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text, CERTAIN), [
    "src/pages.ts: ordersPage → createRuntime → createReader → listRow",
  ]);
  assert.deepEqual(section(text, POSSIBLE), []);
  assert.doesNotMatch(text, /stopped at/u);
});

test("a change inside one returned closure starts there, and the rest of its factory stays out", async (t) => {
  const { root, write } = await project(FACTORIES);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER().replace("listOther(1)", "listOther(2)"));
  const { text } = await map.checkChanges({}, signal());
  // The declaration a reader knows is what the report names.
  assert.match(text, /^CHANGED\n {2}src\/reader\.ts: createReader f7-12$/mu);
  assert.deepEqual(section(text, CERTAIN), [
    "src/pages.ts: couponsPage → createRuntime → createReader",
  ]);
  assert.deepEqual(section(text, POSSIBLE), []);
});

test("a factory's own code may reach every closure it returns, as what it creates certainly does", async (t) => {
  const { root, write } = await project(FACTORIES);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id", "id", "b"));
  const { text } = await map.checkChanges({}, signal());
  // Whoever calls the factory runs that code; which closures read it, the map does not keep.
  assert.deepEqual(section(text, CERTAIN), [
    "src/pages.ts: couponsPage → createRuntime → createReader",
    "src/pages.ts: ordersPage → createRuntime → createReader",
  ]);
  assert.deepEqual(section(text, POSSIBLE), []);
});

test("what a factory's creator reaches only through its own code stays possible, not certain", async (t) => {
  const { root, write } = await project({
    ...FACTORIES,
    "src/runtime.ts": `import { createReader } from "./reader";
export const reader = createReader;
export function holder(run: () => unknown) {
  return run;
}
`,
    "src/pages.ts": `import { createReader } from "./reader";
declare const shared: ReturnType<typeof createReader>;
export function setup() {
  return createReader();
}
export function ordersPage() {
  return shared.rows();
}
export function couponsPage() {
  return shared.others();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id", "id", "b"));
  const { text } = await map.checkChanges({}, signal());
  assert.ok(section(text, CERTAIN).includes("src/pages.ts: setup → createReader"), text);
  assert.deepEqual(section(text, POSSIBLE), [
    "src/pages.ts: couponsPage → createReader",
    "src/pages.ts: ordersPage → createReader",
  ]);
});

test("a callback and a helper nothing else calls run through the declaration around them", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/work.ts": "export function work(id: number) {\n  return id;\n}\n",
    "src/plain.ts": `import { work } from "./work";
export function viaCallback() {
  return [1].map((id) => work(id));
}
export function viaHelper() {
  const helper = () => work(1);
  return helper();
}
export function viaRecursion(depth: number): number {
  const again = (left: number): number => (left ? again(left - 1) : work(left));
  return again(depth);
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/work.ts", "export function work(id: number) {\n  return id + 1;\n}\n");
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "src/plain.ts: viaCallback → work",
    "src/plain.ts: viaHelper → work",
    "src/plain.ts: viaRecursion → work",
  ]);
});

test("a recursive declaration with no other caller is still where its chain starts", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/work.ts": "export function work(id: number) {\n  return id;\n}\n",
    "src/walk.ts": `import { work } from "./work";
export function walk(left: number): number {
  return [left].map((id) => (id ? walk(id - 1) : work(id)))[0] ?? 0;
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/work.ts", "export function work(id: number) {\n  return id + 1;\n}\n");
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "src/walk.ts: walk → work",
  ]);
});

test("a returned closure with no caller in the map runs through whoever creates its factory", async (t) => {
  const { root, write } = await project({
    ...FACTORIES,
    "src/runtime.ts": `import { createReader } from "./reader";
export function createRuntime() {
  return createReader();
}
`,
    "src/pages.ts": `import { createRuntime } from "./runtime";
export function page() {
  return createRuntime();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id + 1"));
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "src/pages.ts: page → createRuntime → createReader → listRow",
  ]);
});

test("a returned closure only tests are seen to call may still run through whoever creates its factory", async (t) => {
  const { root, write } = await project({
    ...FACTORIES,
    "src/pages.ts": `import { createReader } from "./reader";
export function server() {
  return createReader();
}
`,
    "src/runtime.ts": "export const unused = 1;\n",
    "test/reader.test.ts": `import { createReader } from "../src/reader";
export function testRows() {
  return createReader().rows();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id + 1"));
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text, POSSIBLE), ["src/pages.ts: server → createReader → listRow"]);
  assert.deepEqual(section(text, CERTAIN), []);
  assert.match(text, /test\/reader\.test\.ts: testRows \(calls createReader\)/u);
});

const TYPED = (row: number) => `export interface Reader {
  rows(): number;
  others(): number;
}
function listRow() {
  return ${row};
}
export function createReader(): Reader {
  return {
    rows() {
      return listRow();
    },
    others() {
      return 2;
    },
  };
}
`;

test("an object a factory returns as an interface is reached through calls of the interface", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/reader.ts": TYPED(1),
    "src/pages.ts": `import type { Reader } from "./reader";
export function ordersPage(reader: Reader) {
  return reader.rows();
}
export function couponsPage(reader: Reader) {
  return reader.others();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", TYPED(3));
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "src/pages.ts: ordersPage → createReader → listRow",
  ]);
});

const PAGE_READ = `export interface Options {
  read(): number;
}
export class PageRead {
  constructor(private readonly options: Options) {}
  run() {
    return this.options.read();
  }
}
`;
const PAGE = (name: string, value: string) => `import { PageRead } from "./read";
function work() {
  return ${value};
}
export function ${name}() {
  return new PageRead({ read: () => work() }).run();
}
`;

test("an option's callback, one of several, runs on the page that passes it, not on every page using the option", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/read.ts": PAGE_READ,
    "src/a.ts": PAGE("pageA", "1"),
    "src/b.ts": PAGE("pageB", "2"),
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/a.ts", PAGE("pageA", "10"));
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text, CERTAIN), ["src/a.ts: pageA → work"]);
  assert.deepEqual(section(text, POSSIBLE), []);
});

test("a test double does not make a factory's object one of several: calls of the interface still reach it", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/reader.ts": TYPED(1),
    "src/pages.ts": `import type { Reader } from "./reader";
export function ordersPage(reader: Reader) {
  return reader.rows();
}
`,
    "test/fake.ts": `import type { Reader } from "../src/reader";
export const fake: Reader = {
  rows() {
    return 0;
  },
  others() {
    return 0;
  },
};
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", TYPED(3));
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "src/pages.ts: ordersPage → createReader → listRow",
  ]);
});

test("a factory's object, one of several in running code, runs through whoever creates that factory", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/reader.ts": TYPED(1),
    "src/memory.ts": `import type { Reader } from "./reader";
export function createMemoryReader(): Reader {
  return {
    rows() {
      return 0;
    },
    others() {
      return 0;
    },
  };
}
`,
    "src/pages.ts": `import { createReader, type Reader } from "./reader";
export function setup() {
  return createReader();
}
export function ordersPage(reader: Reader) {
  return reader.rows();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", TYPED(3));
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text, CERTAIN), ["src/pages.ts: setup → createReader → listRow"]);
  assert.deepEqual(section(text, POSSIBLE), []);
});

const JOB = (value: number) => `export interface Job {
  run(): number;
}
function work() {
  return ${value};
}
export class Real implements Job {
  run() {
    return work();
  }
}
`;

test("a class's implementation stays dispatched whatever else implements its contract, and test doubles still count for it", async (t) => {
  const page = `import type { Job } from "./job";
export function page(job: Job) {
  return job.run();
}
`;
  const alone = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/job.ts": JOB(1),
    "src/page.ts": page,
  });
  await commit(alone.root);
  const aloneMap = await openMap(alone.root);
  t.after(() => aloneMap.close());
  await alone.write("src/job.ts", JOB(2));
  const certain = (await aloneMap.checkChanges({}, signal())).text;
  assert.deepEqual(section(certain, CERTAIN), ["src/page.ts: page → Real.run → work"]);

  const doubled = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/job.ts": JOB(1),
    "src/page.ts": page,
    "test/fake.ts": `import type { Job } from "../src/job";
export class Fake implements Job {
  run() {
    return 0;
  }
}
`,
  });
  await commit(doubled.root);
  const doubledMap = await openMap(doubled.root);
  t.after(() => doubledMap.close());
  await doubled.write("src/job.ts", JOB(2));
  const possible = (await doubledMap.checkChanges({}, signal())).text;
  assert.deepEqual(section(possible, POSSIBLE), ["src/page.ts: page → Real.run → work"]);
  assert.deepEqual(section(possible, CERTAIN), []);
});

test("a method changed in a factory names the calls of its name on unknown receivers, and so does the method around a local", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/reader.ts": `export function createReader() {
  return {
    rows() {
      return 1;
    },
  };
}
export class Store {
  load() {
    const inner = () => 1;
    return inner();
  }
}
`,
    "src/pages.ts": `import { createReader, Store } from "./reader";
declare const unknown: any;
export function page() {
  unknown.rows();
  unknown.load();
  new Store().load();
  return createReader().rows();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/reader.ts",
    `export function createReader() {
  return {
    rows() {
      return 2;
    },
  };
}
export class Store {
  load() {
    const inner = () => 2;
    return inner();
  }
}
`,
  );
  const { text } = await map.checkChanges({}, signal());
  assert.match(
    text,
    /1 calls of a member named rows on receivers of unknown type may reach createReader\.rows;/u,
  );
  assert.match(
    text,
    /1 calls of a member named load on receivers of unknown type may reach Store\.load;/u,
  );
});

test("a local's field is not read for its uses, and a line in one is the code of what holds it", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/report.ts": `export function report() {
  const row = { total: 1 };
  return row.total;
}
`,
    "src/pages.ts": `import { report } from "./report";
export function page() {
  return report();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "src/report.ts",
    "export function report() {\n  const row = { total: 2 };\n  return row.total;\n}\n",
  );
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text, CERTAIN), ["src/pages.ts: page → report"]);
  assert.doesNotMatch(text, /who uses/u);
  assert.deepEqual(section(text, POSSIBLE), []);
});

// Each level a declaration of its own, the one at the bottom holding a run of local helpers.
const LOCALS = (levels: number, locals: number, value = 1) => {
  const helpers = Array.from({ length: locals }, (_, index) =>
    index ? `  const h${index} = () => h${index - 1}();\n` : "  const h0 = () => work();\n",
  ).join("");
  const above = Array.from(
    { length: levels },
    (_, index) =>
      `export function level${index + 1}() {\n  return ${index ? `level${index}` : "bottom"}();\n}\n`,
  ).join("");
  return {
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/chain.ts": `function work() {
  return ${value};
}
export function bottom() {
${helpers}  return h${locals - 1}();
}
${above}`,
  };
};

test("the trace's depth counts declarations, however many locals it climbs inside one", async (t) => {
  const { root, write } = await project(LOCALS(7, 12));
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  // work, bottom and seven levels are eight steps up, whatever bottom's locals add.
  await write("src/chain.ts", LOCALS(7, 12, 2)["src/chain.ts"]);
  const { text } = await map.checkChanges({}, signal());
  assert.doesNotMatch(text, /stopped at/u);
  assert.match(
    section(text, CERTAIN).join("\n"),
    /^src\/chain\.ts: level7 → level6 → level5 → level4/u,
  );
});

test("past eight declarations the trace stops and says so, locals or not", async (t) => {
  const { root, write } = await project(LOCALS(8, 3));
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/chain.ts", LOCALS(8, 3, 2)["src/chain.ts"]);
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /the trace stopped at 8 levels or 800 declarations/u);
  assert.deepEqual(section(text, CERTAIN), []);
});

test("the trace's declaration limit counts declarations too, not their locals", async (t) => {
  const { root, write } = await project(LOCALS(1, 900));
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/chain.ts", LOCALS(1, 900, 2)["src/chain.ts"]);
  const { text } = await map.checkChanges({}, signal());
  assert.doesNotMatch(text, /stopped at/u);
  assert.match(section(text, CERTAIN).join("\n"), /level1 → bottom → work/u);
});

test("a line deleted inside a returned closure starts there; one deleted from the factory's own code is the factory's", async (t) => {
  const reader = (extra: string, own: string) => `export function createReader() {
  const prefix = "a";
${own}  const rows = () => 1;
  const others = () => {
    const value = 2;
${extra}    return value;
  };
  return { prefix, rows, others };
}
`;
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/reader.ts": reader("    console.log(value);\n", '  console.log("made");\n'),
    "src/pages.ts": `import { createReader } from "./reader";
declare const shared: ReturnType<typeof createReader>;
export function ordersPage() {
  return shared.rows();
}
export function couponsPage() {
  return shared.others();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", reader("", '  console.log("made");\n'));
  const inside = (await map.checkChanges({}, signal())).text;
  assert.deepEqual(section(inside, CERTAIN), ["src/pages.ts: couponsPage → createReader"]);
  assert.deepEqual(section(inside, POSSIBLE), []);

  await write("src/reader.ts", reader("    console.log(value);\n", ""));
  const own = (await map.checkChanges({}, signal())).text;
  assert.deepEqual(section(own, POSSIBLE), [
    "src/pages.ts: couponsPage → createReader",
    "src/pages.ts: ordersPage → createReader",
  ]);
});

test("a member of a type nested in a field changes the field: what reads the field is followed, not only what calls the member", async (t) => {
  const api = (result: string) => `export interface Api {
  inner: {
    load(): ${result};
  };
}
`;
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/api.ts": api("number"),
    "src/pages.ts": `import type { Api } from "./api";
export function caller(api: Api) {
  return api.inner.load();
}
export function reader(api: Api) {
  return api.inner;
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/api.ts", api("string"));
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /src\/pages\.ts: reader\b/u);
});

test("a static method is a caller of its own class's constructor, and a method dispatching to its own contract is not its own caller", async (t) => {
  const box = (value: number) => `export function work() {
  return ${value};
}
export class Box {
  constructor() {
    work();
  }
  static create() {
    return new Box();
  }
}
export interface Job {
  run(next: Job): number;
}
export class Only implements Job {
  run(next: Job) {
    work();
    return next.run(next);
  }
}
`;
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/box.ts": box(1),
    "src/pages.ts": `import { Box } from "./box";
export function page() {
  return Box.create();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/box.ts", box(2));
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "src/box.ts: Only.run → work",
    "src/pages.ts: page → Box.create → Box.constructor → work",
  ]);
});

test("given tests that do not reach a factory's own code name what its returned closures may reach above it", async (t) => {
  const { root, write } = await project({
    ...FACTORIES,
    "src/runtime.ts": "export const unused = 1;\n",
    "src/pages.ts": `import { createReader } from "./reader";
declare const shared: ReturnType<typeof createReader>;
export function ordersPage() {
  return shared.rows();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id", "id", "b"));
  const { text } = await map.checkChanges({ tests: [] }, signal());
  const left = text.slice(text.indexOf("NOT REACHED BY THE GIVEN TESTS"));
  assert.match(left, /src\/pages\.ts: ordersPage/u);
});

test("a given test that calls one returned closure reaches what it uses, not what its others use", async (t) => {
  const { root, write } = await project({
    ...FACTORIES,
    "test/orders.test.ts": `import { ordersPage } from "../src/pages";
export function testOrders() {
  return ordersPage();
}
`,
    "test/factory.test.ts": `import { createReader } from "../src/reader";
export function testFactory() {
  return createReader();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", READER("id + 1"));
  const reached = (await map.checkChanges({ tests: ["test/orders.test.ts"] }, signal())).text;
  assert.match(reached, /none: the given tests reach all 1 changed declarations/u);

  await write("src/reader.ts", READER("id", "id + 1"));
  const other = (await map.checkChanges({ tests: ["test/orders.test.ts"] }, signal())).text;
  assert.match(other, /1 of 1 changed declarations are reached by none of the given tests/u);
  assert.match(other, /src\/pages\.ts: couponsPage → createRuntime → createReader/u);
  // A test creating the factory alone does not run a closure others call.
  const created = (await map.checkChanges({ tests: ["test/factory.test.ts"] }, signal())).text;
  assert.match(created, /1 of 1 changed declarations are reached by none of the given tests/u);
});

test("given tests' reach counts declarations, however many locals it climbs inside one", async (t) => {
  const files = {
    ...LOCALS(7, 12),
    "test/top.test.ts": `import { level7 } from "../src/chain";
export function testTop() {
  return level7();
}
`,
  };
  const { root, write } = await project(files);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/chain.ts", LOCALS(7, 12, 2)["src/chain.ts"]);
  const { text } = await map.checkChanges({ tests: ["test/top.test.ts"] }, signal());
  assert.match(text, /none: the given tests reach all 1 changed declarations/u);
});

test("removing a factory names the entry points above the closures it returned as possibly affected", async (t) => {
  const { root, write } = await project({
    "tsconfig.json": FACTORIES["tsconfig.json"],
    "src/reader.ts": `export function createReader() {
  const rows = () => 1;
  return { rows };
}
export function keep() {
  return 1;
}
`,
    "src/pages.ts": `import { createReader } from "./reader";
const shared = createReader();
export function ordersPage() {
  return shared.rows();
}
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("src/reader.ts", "export function keep() {\n  return 1;\n}\n");
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /STILL USED[^\n]*\n {2}src\/reader\.ts: createReader f1-4 ← /u);
  assert.ok(
    [...section(text, CERTAIN), ...section(text, POSSIBLE)].some((line) =>
      /src\/pages\.ts: ordersPage/u.test(line),
    ),
    text,
  );
});

test("a nested function in Python runs through the function around it", async (t) => {
  const { root, write } = await project({
    "app/work.py": "def work():\n    return 1\n",
    "app/plain.py": `from app.work import work


def handler():
    def inner():
        return work()

    return inner()
`,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write("app/work.py", "def work():\n    return 2\n");
  assert.deepEqual(section((await map.checkChanges({}, signal())).text, CERTAIN), [
    "app/plain.py: handler → work",
  ]);
});

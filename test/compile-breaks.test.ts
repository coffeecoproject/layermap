import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodeIndex } from "../src/code-index";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);
const commit = async (root: string) => {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
};
const TITLE = "NEW COMPILE ERRORS ON LINES THE DIFF LEFT UNCHANGED";
const section = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(TITLE));
  if (at < 0) return [];
  const end = lines.findIndex((line, index) => index > at && !line.startsWith("  "));
  return lines.slice(at + 1, end < 0 ? undefined : end).map((line) => line.trim());
};
const CONFIG = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ["src"],
  }),
};
const LIB =
  "export function one(): number {\n  return 1;\n}\nexport function two(): string {\n  return '';\n}\n";

test("an error the diff causes on a line it left unchanged is reported", async (t) => {
  const { root, write } = await project({
    ...CONFIG,
    "src/lib.ts": LIB,
    "src/use.ts": 'import { two } from "./lib";\nexport const text: string = two();\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  assert.deepEqual(section((await map.checkChanges({}, signal())).text), []);
  await write("src/lib.ts", LIB.replace("two(): string", "two(): number").replace("''", "2"));
  const { text } = await map.checkChanges({}, signal());
  const [error, ...others] = section(text);
  assert.match(error ?? "", /^src\/use\.ts:2 TS2322 /u);
  assert.deepEqual(others, []);
});

test("errors the base had stay out, wherever the diff moved them", async (t) => {
  const { root, write } = await project({
    ...CONFIG,
    "src/lib.ts": LIB,
    "src/use.ts": 'import { one } from "./lib";\nexport const text: string = one();\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write(
    "src/use.ts",
    '// A line above it.\nimport { one } from "./lib";\nexport const text: string = one();\n',
  );
  assert.deepEqual(section((await map.checkChanges({}, signal())).text), []);
});

test("the same error at another place counts, in one file and in another", async (t) => {
  const USE = `import { one, two } from "./lib";
export function first() {
  const value: string = one();
  return value;
}
export function second() {
  const value: string = two();
  return value;
}
`;
  const { root, write } = await project({
    ...CONFIG,
    "src/lib.ts": LIB,
    "src/use.ts": USE,
    "src/other.ts": USE.replace("one();", "two();"),
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", LIB.replace("two(): string", "two(): number").replace("''", "2"));
  const errors = section((await map.checkChanges({}, signal())).text);
  // use.ts has the error once more than it had; other.ts, which had none, has it twice. Text alone
  // would have called all three known.
  assert.equal(errors.filter((error) => error.startsWith("src/use.ts:")).length, 1, errors.join());
  assert.equal(
    errors.filter((error) => error.startsWith("src/other.ts:")).length,
    2,
    errors.join(),
  );
});

test("an error the diff fixed on its own line does not excuse the same error elsewhere", async (t) => {
  const USE = `import { one, two } from "./lib";
export function first() {
  const value: string = one();
  return value;
}
export function second() {
  const value: string = two();
  return value;
}
`;
  const { root, write } = await project({ ...CONFIG, "src/lib.ts": LIB, "src/use.ts": USE });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/use.ts", USE.replace("= one();", '= "";'));
  await write("src/lib.ts", LIB.replace("two(): string", "two(): number").replace("''", "2"));
  const [error, ...others] = section((await map.checkChanges({}, signal())).text);
  assert.match(error ?? "", /^src\/use\.ts:7 TS2322 /u);
  assert.deepEqual(others, []);
});

test("an error on a line the diff changed is not one it left unchanged", async (t) => {
  const USE = 'import { two } from "./lib";\nexport const text: string = two();\n';
  const { root, write } = await project({ ...CONFIG, "src/lib.ts": LIB, "src/use.ts": USE });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/use.ts", USE.replace("text: string", "text: number"));
  assert.deepEqual(section((await map.checkChanges({}, signal())).text), []);
});

test("adding a file leaves the errors the base had out, though the context's files changed", async (t) => {
  const { root, write } = await project({
    ...CONFIG,
    "src/lib.ts": LIB,
    "src/use.ts": 'import { one } from "./lib";\nexport const text: string = one();\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/added.ts", "export const added = 1;\n");
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text), []);
});

test("a renamed file keeps the errors it had", async (t) => {
  const { root } = await project({
    ...CONFIG,
    "src/lib.ts": LIB,
    "src/use.ts":
      'import { one } from "./lib";\nexport const text: string = one();\nexport const more = 1;\nexport const yet = 2;\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await run("git", ["mv", "src/use.ts", "src/moved.ts"], { cwd: root });
  assert.deepEqual(section((await map.checkChanges({}, signal())).text), []);
});

test("a context without a tsconfig is not compiled, as its options are ours", async (t) => {
  const { root, write } = await project({
    "src/lib.ts": LIB,
    "src/use.ts": 'import { two } from "./lib";\nexport const text: string = two();\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", LIB.replace("two(): string", "two(): number").replace("''", "2"));
  assert.deepEqual(section((await map.checkChanges({}, signal())).text), []);
});

test("a removed field's users are reported as errors of their own lines, not tied to the field", async (t) => {
  const { root, write } = await project({
    ...CONFIG,
    "src/shape.ts": "export interface Shape {\n  side: number;\n  name: string;\n}\n",
    // Its users see a value of unknown shape, so only the compiler can tell of this one.
    "src/use.ts":
      'import type { Shape } from "./shape";\nexport function area(shape: Shape) {\n  return shape.side * 2;\n}\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/shape.ts", "export interface Shape {\n  name: string;\n}\n");
  const { text } = await map.checkChanges({}, signal());
  const [error] = section(text);
  assert.match(error ?? "", /^src\/use\.ts:3 TS2339 Property 'side' does not exist/u);
  assert.doesNotMatch(text, /side[^\n]*TS2339/u);
});

test("the removed list says what it looked for", async (t) => {
  const { root, write } = await project({
    ...CONFIG,
    "src/lib.ts": "export function gone() {\n  return 1;\n}\nexport const kept = 1;\n",
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", "export const kept = 1;\n");
  assert.match(
    (await map.checkChanges({}, signal())).text,
    /^REMOVED OR RENAMED \(no reference found on a line the diff left unchanged\)\n {2}src\/lib\.ts: gone /mu,
  );
});

const NOT_CHECKED = /^NOT CHECKED FOR NEW COMPILE ERRORS \(([^)]*)\)/mu;
const unchecked = (text: string) => NOT_CHECKED.exec(text)?.[1];

// A file with an error the base has, and a second the diff causes through lib.ts.
const USES =
  'import { one, two } from "./lib";\nexport const had: string = one();\nexport const text: string = two();\n';
const breakTwo = LIB.replace("two(): string", "two(): number").replace("''", "2");

type Input = Parameters<CodeIndex["findDiagnostics"]>[0];
/** The compiles of a check, in order, each by what it compiles. */
function watchCompiles(t: { mock: typeof test.mock }, change?: (input: Input) => Input) {
  const sides: Input[] = [];
  const real = CodeIndex.prototype.findDiagnostics;
  t.mock.method(
    CodeIndex.prototype,
    "findDiagnostics",
    function (this: CodeIndex, input: Input, abort: AbortSignal) {
      const changed = change?.(input) ?? input;
      sides.push(changed);
      return real.call(this, changed, abort);
    },
  );
  return sides;
}
/** A clock that jumps past any deadline once told to. */
function jumpingClock(t: { mock: typeof test.mock }) {
  const real = Date.now;
  const clock = { jumped: false };
  t.mock.method(Date, "now", () => (clock.jumped ? real() + 3_600_000 : real()));
  return clock;
}

test("with both sides compiled, the report is whole", async (t) => {
  const { root, write } = await project({ ...CONFIG, "src/lib.ts": LIB, "src/use.ts": USES });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", breakTwo);
  const { text } = await map.checkChanges({}, signal());
  const [error, ...others] = section(text);
  assert.match(error ?? "", /^src\/use\.ts:3 TS2322 /u);
  assert.deepEqual(others, []);
  assert.equal(unchecked(text), undefined);
});

test("out of time on the working tree, nothing is said of the context, and it is named", async (t) => {
  const { root, write } = await project({ ...CONFIG, "src/lib.ts": LIB, "src/use.ts": USES });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", breakTwo);
  const sides = watchCompiles(t, (input) => ({ ...input, until: 0 }));
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text), []);
  assert.match(unchecked(text) ?? "", /^tsconfig\.json$/u);
  assert.deepEqual(
    sides.map((side) => side.source.kind),
    ["WORKTREE"],
  );
});

test("out of time on the base, the errors it had are not called new", async (t) => {
  const { root, write } = await project({ ...CONFIG, "src/lib.ts": LIB, "src/use.ts": USES });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", breakTwo);
  watchCompiles(t, (input) => (input.source.kind === "COMMIT" ? { ...input, until: 0 } : input));
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text), []);
  assert.match(unchecked(text) ?? "", /^tsconfig\.json$/u);
});

test("out of time between the sides, the base is not built or compiled", async (t) => {
  // Only added files: nothing has made the base's map yet.
  const { root, write } = await project({ ...CONFIG, "src/lib.ts": LIB, "src/use.ts": USES });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/added.ts", "export const added = 1;\n");
  const sides = watchCompiles(t);
  const clock = jumpingClock(t);
  const real = ProjectMapAnalyzer.prototype.diagnostics;
  t.mock.method(
    ProjectMapAnalyzer.prototype,
    "diagnostics",
    function (this: ProjectMapAnalyzer, ...args: Parameters<typeof real>) {
      const result = real.apply(this, args);
      clock.jumped = true;
      return result;
    },
  );
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text), []);
  assert.match(unchecked(text) ?? "", /^tsconfig\.json$/u);
  assert.equal(sides.length, 1);
});

test("contexts compiled on both sides report, whatever became of the others", async (t) => {
  const config = JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ["."],
  });
  const { root, write } = await project({
    "a/tsconfig.json": config,
    "a/lib.ts": LIB,
    "a/use.ts": USES,
    "b/tsconfig.json": config,
    "b/lib.ts": LIB,
    "b/use.ts": USES,
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("a/lib.ts", breakTwo);
  await write("b/lib.ts", breakTwo);
  const clock = jumpingClock(t);
  let compiles = 0;
  const real = ProjectMapAnalyzer.prototype.diagnostics;
  t.mock.method(
    ProjectMapAnalyzer.prototype,
    "diagnostics",
    function (this: ProjectMapAnalyzer, ...args: Parameters<typeof real>) {
      const result = real.apply(this, args);
      // Both of the working tree's, then the base's first.
      if (++compiles === 3) clock.jumped = true;
      return result;
    },
  );
  const { text } = await map.checkChanges({}, signal());
  const errors = section(text);
  assert.equal(errors.length, 1, errors.join());
  const reported = errors[0]?.startsWith("a/") ? "a" : "b";
  assert.match(errors[0] ?? "", /\/use\.ts:3 TS2322 /u);
  assert.equal(unchecked(text), `${reported === "a" ? "b" : "a"}/tsconfig.json`);
});

test("an error new to one context is reported, though another context's base had it, and once", async (t) => {
  // Each configuration has its own file, which imports the shared ones: they compile in both.
  const config = (strict: boolean) =>
    JSON.stringify({ compilerOptions: { strict, noEmit: true }, include: ["."] });
  const main =
    'import { same } from "../shared/use";\nimport { text } from "../shared/two";\nexport const all = [same, text];\n';
  const { root, write } = await project({
    "a/tsconfig.json": config(false),
    "a/main.ts": main,
    "b/tsconfig.json": config(true),
    "b/main.ts": main,
    "shared/use.ts": "export const same = (value) => value;\n",
    "shared/lib.ts": LIB,
    "shared/two.ts": 'import { two } from "./lib";\nexport const text: string = two();\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  // Strict now in a, as b always was: b's base has the error, a's does not.
  await write("a/tsconfig.json", config(true));
  await write("shared/lib.ts", `${LIB}export const unrelated = 1;\n`);
  const errors = section((await map.checkChanges({}, signal())).text);
  assert.equal(errors.length, 1, errors.join());
  assert.match(errors[0] ?? "", /^shared\/use\.ts:1 TS7006 /u);

  // New to both, it is one error.
  await write("a/tsconfig.json", config(false));
  await write("shared/lib.ts", breakTwo);
  const both = section((await map.checkChanges({}, signal())).text);
  assert.equal(both.length, 1, both.join());
  assert.match(both[0] ?? "", /^shared\/two\.ts:2 TS2322 /u);
});

test("a configuration the base does not have is named, not compared with nothing", async (t) => {
  const { root, write } = await project({
    "extra/use.ts": "export const same = (value) => value;\n",
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write(
    "extra/tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["."] }),
  );
  const { text } = await map.checkChanges({}, signal());
  assert.deepEqual(section(text), []);
  assert.equal(unchecked(text), "extra/tsconfig.json");
});

test("uses and compiles share one deadline, and uses come first", async (t) => {
  const shape = "export interface Shape {\n  side: number;\n  name: string;\n}\n";
  const { root, write } = await project({
    ...CONFIG,
    "src/shape.ts": shape,
    "src/use.ts":
      'import type { Shape } from "./shape";\nexport function area(shape: Shape) {\n  return shape.side * 2;\n}\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/shape.ts", shape.replace("  side: number;\n", ""));
  const seen: { kind: string; until: number }[] = [];
  const uses = CodeIndex.prototype.findUses;
  t.mock.method(
    CodeIndex.prototype,
    "findUses",
    function (this: CodeIndex, ...args: Parameters<typeof uses>) {
      seen.push({ kind: "uses", until: args[0].until });
      return uses.apply(this, args);
    },
  );
  const sides = watchCompiles(t);
  const first = await map.checkChanges({}, signal());
  assert.match(section(first.text)[0] ?? "", /^src\/use\.ts:3 TS2339 /u);
  const untils = new Set([...seen.map((item) => item.until), ...sides.map((side) => side.until)]);
  assert.ok(seen.length > 0 && sides.length === 2);
  assert.equal(untils.size, 1, `${[...untils]}`);

  // A changed field is read in the working tree too.
  seen.length = 0;
  sides.length = 0;
  await write("src/shape.ts", shape.replace("side: number", "side: string"));
  // Every reading of the clock differs, so two deadlines cannot pass for one.
  const now = Date.now;
  let tick = 0;
  const ticking = t.mock.method(Date, "now", () => now() + ++tick);
  await map.checkChanges({}, signal());
  ticking.mock.restore();
  assert.ok(seen.length > 0);
  assert.equal(
    new Set([...seen.map((item) => item.until), ...sides.map((side) => side.until)]).size,
    1,
  );

  // Uses spend it all: the compile does not start, and the report says so.
  const clock = jumpingClock(t);
  sides.length = 0;
  t.mock.method(
    CodeIndex.prototype,
    "findUses",
    function (this: CodeIndex, ...args: Parameters<typeof uses>) {
      const result = uses.apply(this, args);
      clock.jumped = true;
      return result;
    },
  );
  const started = t.mock.method(ProjectMapAnalyzer.prototype, "diagnostics");
  await write("src/shape.ts", `${shape.replace("  side: number;\n", "")}// again\n`);
  const { text } = await map.checkChanges({}, signal());
  assert.equal(started.mock.callCount(), 0);
  assert.deepEqual(section(text), []);
  assert.match(unchecked(text) ?? "", /^tsconfig\.json$/u);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseMapDiff } from "../src/project-map-change-diff";
import { mapErasable, mapRuntimeLines } from "../src/project-map-change-runtime";

const run = promisify(execFile);

// The lines whose code changed once types are erased, for two versions of a file, as the change
// check works them out from git's hunks.
async function runtime(before: string, after: string, name = "file.ts") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "layermap-runtime-"));
  await writeFile(path.join(directory, "a"), before);
  await writeFile(path.join(directory, "b"), after);
  const diff = await run("git", ["diff", "--no-index", "--unified=0", "a", "b"], {
    cwd: directory,
  }).catch((error: { stdout: string }) => error);
  const hunks = parseMapDiff(diff.stdout).files[0]?.hunks ?? [];
  return mapRuntimeLines(name, before, after, hunks);
}

const BASE = `import type { Row } from "./rows";
import { load } from "./load";

export const total = (rows: Row[]): number => {
  // add them up
  return rows.reduce((sum, row) => sum + row.amount, 0);
};

export async function find(db: Db, id: number) {
  const rows = await db.query<{ id: number; name: string }>("SELECT id, name FROM t WHERE id = $1", [id]);
  return rows[0];
}

export function untouched() {
  return load(1);
}
`;

test("a change to annotations, inline types, comments or layout changes no code", async () => {
  const after = BASE.replace("(rows: Row[]): number =>", "(rows: readonly Row[]) =>")
    .replace("// add them up", "// the sum of the amounts")
    .replace("{ id: number; name: string }", "{ id: number; name: string | null }")
    .replace("find(db: Db, id: number)", "find(\n  db: Db,\n  id: number,\n)")
    .replace('import type { Row } from "./rows";', 'import type { Row, Rows } from "./rows";');
  assert.deepEqual(await runtime(BASE, after), []);
});

test("a change to code among type changes is its line alone", async () => {
  const after = BASE.replace("(rows: Row[]): number =>", "(rows: readonly Row[]) =>").replace(
    "return load(1);",
    "return load(2);",
  );
  assert.deepEqual(await runtime(BASE, after), [[15, 15]]);
});

test("code only removed is the point where it was; a type import removed is not code", async () => {
  const removed = BASE.replace("export function untouched() {\n  return load(1);\n}\n", "");
  assert.deepEqual(await runtime(BASE, removed), [[14, 13]]);
  assert.deepEqual(
    await runtime(BASE, BASE.replace('import type { Row } from "./rows";\n', "")),
    [],
  );
  // A value import is code, even one only types use: a project may keep it as written.
  assert.deepEqual(await runtime(BASE, BASE.replace('import { load } from "./load";\n', "")), [
    [2, 1],
  ]);
});

test("enum values, declared fields and parameter properties are code", async () => {
  const before =
    "enum Kind {\n  A = 1,\n}\nclass Box {\n  size!: number;\n  constructor(private name: string) {}\n}\n";
  assert.deepEqual(await runtime(before, before.replace("A = 1", "A = 2")), [[2, 2]]);
  assert.deepEqual(
    await runtime(before, before.replace("size!: number;", "declare size: number;")),
    [[5, 5]],
  );
  // The field a parameter property declares moves in the erased code: where it no longer lines up
  // with the diff, the file is not judged, and every changed line counts as code.
  const property = await runtime(before, before.replace("private name: string", "name: string"));
  assert.ok(property === undefined || property.some(([from, to]) => from <= 6 && 6 <= to));
  assert.deepEqual(
    await runtime(before, before.replace("size!: number;", "size!: number | null;")),
    [],
  );
});

test("a template string's text is code, to its commas; an item added to a list is its own line", async () => {
  const before =
    "export const sql = (id: number) => `\n  SELECT a,\n    b\n  FROM t WHERE id = ` + id;\nexport const list = [\n  1,\n  2\n];\n";
  assert.deepEqual(await runtime(before, before.replace("SELECT a,", "SELECT a")), [[2, 2]]);
  // The comma the item before it gains is on the line before.
  const added = await runtime(before, before.replace("  2\n];", "  2,\n  3\n];"));
  assert.deepEqual([...new Set(added?.flatMap(([from, to]) => [from, to]))], [7, 8]);
  // A comment esbuild keeps inside a value counts as code: changed, it is not ruled out.
  const commented = 'export const config = {\n  port: 1,\n  // the host\n  host: "a",\n};\n';
  const result = await runtime(commented, commented.replace("// the host", "// where it listens"));
  assert.ok(result === undefined || result.some(([from, to]) => from <= 3 && 3 <= to));
});

test("a new file's code is its lines with code; its types are none", async () => {
  const after =
    "export type Id = number;\nexport interface Row {\n  id: Id;\n}\n\nexport const first = (rows: Row[]) => rows[0];\n";
  assert.deepEqual(await runtime("", after), [[6, 6]]);
});

test("JSX is code; the types in a TSX file are not", async () => {
  const before =
    'export const Name = ({ name }: { name: string }) => <b title="name">{name as string}</b>;\n';
  assert.deepEqual(
    await runtime(
      before,
      before.replace("{ name: string }", "{ name: string | null }"),
      "view.tsx",
    ),
    [],
  );
  assert.deepEqual(
    await runtime(before, before.replace("<b ", "<i ").replace("</b>", "</i>"), "view.tsx"),
    [[1, 1]],
  );
});

test("a file with decorators, or one that does not erase, is not judged", async () => {
  const decorated = "class Api {\n  @get()\n  list(id: number) {\n    return id;\n  }\n}\n";
  assert.equal(await runtime(decorated, decorated.replace("id: number", "id: string")), undefined);
  const broken = "export const a = (x: number) => x;\n";
  assert.equal(await runtime(broken, broken.replace("=> x;", "=> x +;")), undefined);
});

test("only TypeScript sources are erased", () => {
  assert.equal(mapErasable("src/a.ts"), true);
  assert.equal(mapErasable("src/a.tsx"), true);
  assert.equal(mapErasable("src/a.mts"), true);
  assert.equal(mapErasable("src/a.d.ts"), false);
  assert.equal(mapErasable("src/a.js"), false);
  assert.equal(mapErasable("src/a.py"), false);
  assert.equal(mapErasable("src/a.vue"), false);
});

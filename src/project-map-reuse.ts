import type { CodeIndexStore } from "./code-index-store";
import { mapCodePath } from "./project-map-language";
import { type MapObject, mapTestPath } from "./project-map-types";
import { MapViewGraph, mapDeclarationLabel } from "./project-map-view-graph";

// Agents write a helper the project already has more often than they look for it: they do not
// know it is there. The declarations a diff adds are compared with the ones the project already
// has by the words of their code, weighted by how rare each word is in the project, so a copy
// renamed or lightly edited still matches while code that only shares the project's common words
// does not. Code that does the same with other words is not found; whether to reuse, replace or
// keep both is the agent's call.

/** A declaration the diff adds whose code reads almost the same as an existing declaration's. */
export type MapSimilarCode = Readonly<{
  path: string;
  name: string;
  label: string;
  like: Readonly<{ path: string; name: string; label: string }>;
  /** Other existing declarations as alike, which repeat the same code. */
  others: number;
}>;

type ChangedFile = Readonly<{
  path: string;
  basePath?: string;
  status: string;
  lines: readonly (readonly [number, number])[];
}>;

type Row = Readonly<{
  id: string;
  path: string;
  name: string;
  kind: MapObject["kind"];
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}>;

/** A declaration other code can call: module-level, or a member of a module-level class or object. */
type Declaration = Row & Readonly<{ qualifiedName: string; container?: string }>;

type Code = Readonly<{ declaration: Declaration; words: Map<string, number> }>;

const MODULES = new Set<MapObject["kind"]>(["FILE", "PACKAGE", "CONFIG"]);
const MEMBER_CONTAINERS = new Set<MapObject["kind"]>(["CLASS", "INTERFACE", "TYPE", "ENUM"]);
const KINDS = new Set<MapObject["kind"]>(["FUNCTION", "METHOD", "CLASS", "VARIABLE"]);
// Shorter declarations are constants and one-line wrappers, alike by nature.
const MIN_LINES = 3;
const ALIKE = 0.8;
// Members of one class or object follow one pattern on purpose; only a near copy counts there.
const SIBLINGS_ALIKE = 0.95;
const KEYWORDS = new Set(
  (
    "abstract and any as assert async await boolean break case catch chan class const continue " +
    "def default defer del delete do elif else enum except export extends false final finally for " +
    "from func function go if implements import in instanceof interface is keyof lambda let map " +
    "new nil none not null number object of or package pass private protected public raise range " +
    "readonly return self static string struct super switch this throw throws true try type " +
    "typeof undefined unknown var void while with yield"
  ).split(" "),
);

// Properties hold no declaration other code calls, so they are left out.
const ROWS = `SELECT entity_ref AS id, path, name, kind, object_json AS object
  FROM project_map_objects WHERE version_ref = ? AND kind <> 'PROPERTY'`;

function rows(store: CodeIndexStore, version: string, path?: string): Row[] {
  const statement = store.database.prepare(path === undefined ? ROWS : `${ROWS} AND path = ?`);
  return (path === undefined ? statement.all(version) : statement.all(version, path)).map((row) => {
    const { anchor } = JSON.parse(String(row.object)) as Pick<MapObject, "anchor">;
    return {
      id: String(row.id),
      path: String(row.path),
      name: String(row.name),
      kind: String(row.kind) as MapObject["kind"],
      start: anchor.start,
      end: anchor.end,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
    };
  });
}

// The declarations of one file other code can call, each inside the innermost object around it,
// as the map's view reads them: closures and locals belong to the code around them.
function declarations(inFile: readonly Row[]): Declaration[] {
  const sorted = inFile
    .filter((row) => !MODULES.has(row.kind))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const found: Declaration[] = [];
  const open: { row: Row; declaration?: Declaration; parent?: Row }[] = [];
  for (const row of sorted) {
    while (open.length && (open.at(-1) as { row: Row }).row.end <= row.start) open.pop();
    const around = open.at(-1);
    let declaration: Declaration | undefined;
    if (!row.name.startsWith("<")) {
      if (!around) declaration = { ...row, qualifiedName: row.name };
      else if (
        around.declaration &&
        row.kind === "METHOD" &&
        !around.parent &&
        (MEMBER_CONTAINERS.has(around.row.kind) || around.row.kind === "VARIABLE")
      )
        declaration = {
          ...row,
          qualifiedName: `${around.row.name}.${row.name}`,
          container: around.row.id,
        };
    }
    if (declaration) found.push(declaration);
    open.push({ row, declaration, parent: around?.row });
  }
  return found;
}

// The words of a line of code: identifiers split at case changes, digits and underscores,
// lowercased, keywords out.
function lineWords(line: string): string[] {
  return (
    line
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z][a-z0-9]+/g) ?? []
  ).filter((word) => !KEYWORDS.has(word));
}

const within = (lines: ChangedFile["lines"], declaration: Declaration) =>
  lines.some(([from, to]) => from <= declaration.startLine && declaration.endLine <= to);

/**
 * The declarations the diff adds, each with the existing declaration whose code reads most like
 * it, when that is almost the same. A declaration is added when all its lines are new and the base
 * had none of its name in that file, nor in a file the diff took it out of (a move).
 */
export async function similarCode(
  store: CodeIndexStore,
  working: string,
  base: string | undefined,
  files: readonly ChangedFile[],
  read: (path: string) => Promise<string | undefined>,
): Promise<MapSimilarCode[]> {
  const code = (path: string) => mapCodePath(path) !== undefined && !mapTestPath(path);
  const changed = files.filter((file) => file.status !== "DELETED" && code(file.path));
  if (!changed.length) return [];
  const names = (version: string, path: string) =>
    new Set(declarations(rows(store, version, path)).map((item) => item.qualifiedName));
  // Names the diff took out of a file: a declaration that turns up elsewhere under one was moved.
  const movedOut = new Set<string>();
  if (base !== undefined)
    for (const file of files) {
      if (!file.basePath || file.status === "ADDED") continue;
      const now = file.status === "DELETED" ? new Set<string>() : names(working, file.path);
      for (const name of names(base, file.basePath)) if (!now.has(name)) movedOut.add(name);
    }
  const eligible = (item: Declaration) =>
    KINDS.has(item.kind) && item.endLine - item.startLine + 1 >= MIN_LINES;
  const added = new Set<string>();
  for (const file of changed) {
    const had =
      base !== undefined && file.basePath && file.status !== "ADDED"
        ? names(base, file.basePath)
        : undefined;
    for (const item of declarations(rows(store, working, file.path)))
      if (
        eligible(item) &&
        within(file.lines, item) &&
        !had?.has(item.qualifiedName) &&
        !movedOut.has(item.qualifiedName)
      )
        added.add(item.id);
  }
  if (!added.size) return [];

  // Every eligible declaration of the project's code, with the words of its code as the working
  // tree the map was built from has them.
  const byPath = new Map<string, Row[]>();
  for (const row of rows(store, working)) {
    if (!code(row.path)) continue;
    const inFile = byPath.get(row.path) ?? [];
    inFile.push(row);
    byPath.set(row.path, inFile);
  }
  const all: Code[] = [];
  await Promise.all(
    [...byPath].map(async ([path, inFile]) => {
      const found = declarations(inFile).filter(eligible);
      if (!found.length) return;
      const text = await read(path);
      if (text === undefined) return;
      const lines = text.split("\n").map(lineWords);
      for (const declaration of found) {
        const words = new Map<string, number>();
        for (const line of lines.slice(declaration.startLine - 1, declaration.endLine))
          for (const word of line) words.set(word, (words.get(word) ?? 0) + 1);
        all.push({ declaration, words });
      }
    }),
  );
  const frequency = new Map<string, number>();
  for (const { words } of all)
    for (const word of words.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const weight = (word: string) => Math.log((all.length + 1) / ((frequency.get(word) ?? 0) + 1));
  const vector = (words: Map<string, number>) => {
    const weighted = new Map<string, number>();
    let length = 0;
    for (const [word, count] of words) {
      const value = (1 + Math.log(count)) * weight(word);
      weighted.set(word, value);
      length += value * value;
    }
    length = Math.sqrt(length) || 1;
    for (const [word, value] of weighted) weighted.set(word, value / length);
    return weighted;
  };
  // Which existing declarations hold each word, so each added one meets only those sharing one.
  const holders = new Map<string, { item: Code; value: number }[]>();
  for (const item of all) {
    if (added.has(item.declaration.id)) continue;
    for (const [word, value] of vector(item.words)) {
      const holding = holders.get(word) ?? [];
      holding.push({ item, value });
      holders.set(word, holding);
    }
  }

  const graph = new MapViewGraph(store, working);
  const label = (row: Row) =>
    mapDeclarationLabel({
      kind: row.kind,
      anchor: { startLine: row.startLine, endLine: row.endLine },
    });
  const found: (MapSimilarCode & { score: number })[] = [];
  for (const item of all) {
    const declaration = item.declaration;
    if (!added.has(declaration.id)) continue;
    const scores = new Map<Code, number>();
    for (const [word, value] of vector(item.words))
      for (const other of holders.get(word) ?? [])
        scores.set(other.item, (scores.get(other.item) ?? 0) + value * other.value);
    const alike = [...scores]
      .filter(([other, score]) => {
        const them = other.declaration;
        if (
          them.path === declaration.path &&
          them.start < declaration.end &&
          declaration.start < them.end
        )
          return false;
        const siblings =
          declaration.container !== undefined && them.container === declaration.container;
        return score >= (siblings ? SIBLINGS_ALIKE : ALIKE);
      })
      .sort(([, left], [, right]) => right - left);
    if (!alike.length) continue;
    // Code that calls or is called by the new declaration uses it rather than repeats it.
    const scope = graph.scope(declaration.id).refs;
    const linked = new Set([
      ...graph
        .relationsFrom(scope)
        .flatMap((relation) => (relation.to ? [graph.owner(relation.to)] : [])),
      ...graph.relationsTo(scope).map((relation) => graph.owner(relation.from)),
    ]);
    const unlinked = alike.filter(([other]) => !linked.has(other.declaration.id));
    const best = unlinked[0];
    if (!best) continue;
    found.push({
      path: declaration.path,
      name: declaration.qualifiedName,
      label: label(declaration),
      like: {
        path: best[0].declaration.path,
        name: best[0].declaration.qualifiedName,
        label: label(best[0].declaration),
      },
      others: unlinked.length - 1,
      score: best[1],
    });
  }
  return found
    .sort(
      (left, right) =>
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || right.score - left.score,
    )
    .map(({ score: _score, ...similar }) => similar);
}

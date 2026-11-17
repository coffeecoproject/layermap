import type { CodeIndexStore } from "./code-index-store";
import { changedInWorkingTree, mapPathNow, overlaps } from "./project-map-change-diff";
import { CALLER_KINDS, changedUnits, changeUnits } from "./project-map-change-trace";
import { LIMITS, type MapChangedFile } from "./project-map-change-types";
import { type MapObject, mapTestPath } from "./project-map-types";
import { MapViewGraph, mapIsModule } from "./project-map-view-graph";

// What a diff changes in how files depend on each other, as facts for a program that keeps a
// project's own boundaries: the imports it adds and removes, the calls it adds into other files,
// and the existing declarations it changes with the files calling them before and after. Which of
// these a project allows is its own rule, not the map's. Code in test files is left out: the
// related tests already say what the change reaches there.

export type MapChangeEdges = Readonly<{
  /**
   * Imports between files of the project the diff adds or removes, by file in the working tree
   * (a deleted file's, or a removed import's target's, path in the base when it is gone). The line
   * is the import's in the working tree, or in the base for one the diff removed. A Go import names
   * a package, which the map anchors at one of its files.
   */
  imports: readonly Readonly<{
    from: string;
    to: string;
    line: number;
    change: "ADDED" | "REMOVED";
  }>[];
  /**
   * Calls and references the diff adds from a file into a declaration of another file, at their
   * first site. exported: whether the file's top-level declaration holding it is exported.
   */
  calls: readonly Readonly<{
    from: string;
    line: number;
    to: string;
    declaration: string;
    exported: boolean;
  }>[];
  /**
   * The declarations the base already had that the diff changed, with the other files calling or
   * referencing them in the base and in the working tree. Calls and callers are those the map
   * resolves to the declaration itself: a call on an interface or base member it implements or
   * overrides, which may dispatch to it, does not count.
   */
  declarations: readonly Readonly<{
    path: string;
    declaration: string;
    line: number;
    exported: boolean;
    callersBefore: readonly string[];
    callersAfter: readonly string[];
  }>[];
  /** Whether more declarations changed than the check follows, so some are not listed. */
  truncated: boolean;
}>;

type Paths = (path: string) => string;
const same: Paths = (path) => path;
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * A version of the code as the check reads it: the working tree; or the base, as the base map has
 * it or, where the check built none, as the working tree has it on the lines the diff left alone,
 * since the diff then removed no lines. Everything telling the two apart is decided here.
 */
type Side = Readonly<{
  graph: MapViewGraph;
  /** A path of this version by its path in the working tree. */
  pathNow: Paths;
  /** Whether a site of the graph is code of this version. */
  counts: (path: string, line: number) => boolean;
  /** Where a changed file is in this version, if it is there. */
  pathOf: (file: MapChangedFile) => string | undefined;
  /** What a declaration the working tree has in a changed file is in this version, if it is there. */
  declaration: (file: MapChangedFile, ref: string) => string | undefined;
}>;

/** Where a file's code imports another file, or calls or references one of its declarations. */
type Sites = Readonly<{ to: string; lines: readonly number[] }>;
type Links = Readonly<{
  /** By the other file's path in the working tree. */
  imports: ReadonlyMap<string, Sites>;
  /** By that path and the declaration's kind and name, which name it in either version. */
  calls: ReadonlyMap<string, Sites & Readonly<{ ref: string }>>;
}>;

/** What a changed file's code imports and calls of the project's other files, now and in the base. */
export type MapFileLinks = Readonly<{ file: MapChangedFile; now: Links; before: Links }>;

/** The changed files' links to other files in both versions, read once for every part of the check. */
export type MapChangeLinks = Readonly<{
  now: Side;
  before: Side;
  files: readonly MapFileLinks[];
}>;

function linksOf(side: Side, path: string | undefined): Links {
  const imports = new Map<string, { to: string; lines: number[] }>();
  const calls = new Map<string, { to: string; lines: number[]; ref: string }>();
  if (path === undefined) return { imports, calls };
  const { graph } = side;
  for (const relation of graph.relationsFrom(graph.objectsAt(path).map((object) => object.id))) {
    const line = relation.anchor.startLine;
    if (relation.to === undefined || !side.counts(path, line)) continue;
    if (relation.kind === "IMPORTS") {
      const target = graph.object(relation.to).anchor.path;
      if (target === path) continue;
      const to = side.pathNow(target);
      const found = imports.get(to) ?? { to, lines: [] };
      found.lines.push(line);
      imports.set(to, found);
    } else if (CALLER_KINDS.has(relation.kind)) {
      const ref = graph.owner(relation.to);
      const owner = graph.object(ref);
      if (owner.anchor.path === path || mapIsModule(owner)) continue;
      const to = side.pathNow(owner.anchor.path);
      const key = `${to}\u0000${graph.declarationKey(owner)}`;
      const found = calls.get(key) ?? { to, lines: [], ref };
      found.lines.push(line);
      calls.set(key, found);
    }
  }
  return { imports, calls };
}

/** Reads what the changed files import and call of other files, in the working tree and in the base. */
export function mapChangeLinks(
  store: CodeIndexStore,
  working: string,
  base: string | undefined,
  files: readonly MapChangedFile[],
): MapChangeLinks {
  const graph = new MapViewGraph(store, working);
  const always = () => true;
  const now: Side = {
    graph,
    pathNow: same,
    counts: always,
    pathOf: (file) => (file.status === "DELETED" ? undefined : file.path),
    declaration: (_, ref) => ref,
  };
  let before: Side;
  if (base !== undefined) {
    const baseGraph = new MapViewGraph(store, base);
    const pathOf = (file: MapChangedFile) => (file.status === "ADDED" ? undefined : file.basePath);
    const declared = new Map<string, Map<string, string>>();
    before = {
      graph: baseGraph,
      pathNow: mapPathNow(files),
      counts: always,
      pathOf,
      declaration: (file, ref) => {
        const path = pathOf(file);
        if (path === undefined) return undefined;
        let keys = declared.get(path);
        if (!keys) {
          keys = new Map(
            changeUnits(baseGraph, path).map((object) => [
              baseGraph.declarationKey(object),
              object.id,
            ]),
          );
          declared.set(path, keys);
        }
        return keys.get(graph.declarationKey(graph.object(ref)));
      },
    };
  } else {
    const changedAt = changedInWorkingTree(files);
    before = {
      graph,
      pathNow: same,
      counts: (path, line) => {
        const file = changedAt.get(path);
        return !file || !overlaps(file.lines, line, line);
      },
      pathOf: (file) => (file.status === "ADDED" ? undefined : file.path),
      // A declaration lying wholly in added lines is new.
      declaration: (file, ref) => {
        const { anchor } = graph.object(ref);
        return file.status === "ADDED" ||
          file.lines.some(([from, to]) => from <= anchor.startLine && anchor.endLine <= to)
          ? undefined
          : ref;
      },
    };
  }
  return {
    now,
    before,
    files: files.map((file) => ({
      file,
      now: linksOf(now, now.pathOf(file)),
      before: linksOf(before, before.pathOf(file)),
    })),
  };
}

// The file's top-level declaration around the object: its exports are what other files may name.
function exportedTop(graph: MapViewGraph, ref: string): boolean {
  let top: MapObject = graph.object(ref);
  for (const at of graph.lineage(ref)) {
    const object = graph.object(at);
    if (mapIsModule(object)) break;
    top = object;
  }
  return top.exported;
}

// The other files outside tests whose code calls or references the declaration in this version,
// by their path in the working tree.
function callersOf(side: Side, ref: string): string[] {
  const home = side.graph.object(ref).anchor.path;
  const files = new Set<string>();
  for (const relation of side.graph.relationsTo([ref])) {
    const path = relation.anchor.path;
    if (!CALLER_KINDS.has(relation.kind) || path === home || mapTestPath(path)) continue;
    if (side.counts(path, relation.anchor.startLine)) files.add(side.pathNow(path));
  }
  return [...files].sort();
}

/**
 * The imports the diff adds and removes between files, the calls it adds, and the callers of the
 * existing declarations it changed, outside the tests.
 */
export function mapChangeEdges(links: MapChangeLinks): MapChangeEdges {
  const { now, before } = links;
  const imports: MapChangeEdges["imports"][number][] = [];
  const calls: MapChangeEdges["calls"][number][] = [];
  const declarations: MapChangeEdges["declarations"][number][] = [];
  let truncated = false;
  const first = ({ lines }: Sites) => Math.min(...lines);
  for (const linked of links.files) {
    const { file } = linked;
    if (file.binary || mapTestPath(file.path)) continue;
    for (const [to, sites] of linked.now.imports)
      if (!linked.before.imports.has(to))
        imports.push({ from: file.path, to, line: first(sites), change: "ADDED" });
    for (const [to, sites] of linked.before.imports)
      if (!linked.now.imports.has(to))
        imports.push({ from: file.path, to, line: first(sites), change: "REMOVED" });
    for (const [key, sites] of linked.now.calls)
      if (!linked.before.calls.has(key))
        calls.push({
          from: file.path,
          line: first(sites),
          to: sites.to,
          declaration: now.graph.qualifiedName(sites.ref),
          exported: exportedTop(now.graph, sites.ref),
        });

    // The innermost declarations around the changed lines, as the trace starts from them, that
    // the base already had.
    if (now.pathOf(file) === undefined || before.pathOf(file) === undefined) continue;
    for (const ref of changedUnits(now.graph, file.path, file.lines).refs) {
      const object = now.graph.object(ref);
      // A template is read as one unit, the page it shows, which is no declaration.
      if (mapIsModule(object)) continue;
      const was = before.declaration(file, ref);
      if (was === undefined) continue;
      if (declarations.length >= LIMITS.changed) {
        truncated = true;
        break;
      }
      declarations.push({
        path: file.path,
        declaration: now.graph.qualifiedName(ref),
        line: object.anchor.startLine,
        exported: exportedTop(now.graph, ref),
        callersBefore: callersOf(before, was),
        callersAfter: callersOf(now, ref),
      });
    }
  }
  const order = (
    left: Readonly<{ from: string; line: number; to: string }>,
    right: Readonly<{ from: string; line: number; to: string }>,
  ) => compare(left.from, right.from) || left.line - right.line || compare(left.to, right.to);
  return {
    imports: imports.sort(order),
    calls: calls.sort(order),
    declarations: declarations.sort(
      (left, right) => compare(left.path, right.path) || left.line - right.line,
    ),
    truncated,
  };
}

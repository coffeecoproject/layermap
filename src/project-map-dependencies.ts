import type { CodeIndexStore } from "./code-index-store";
import { mapCodePath } from "./project-map-language";
import type { MapRelation } from "./project-map-types";
import { type MapViewCache, mapProjectModules } from "./project-map-view";
import { MapViewGraph } from "./project-map-view-graph";

// Which way code depends is how a project keeps its layers: the code others build on (shared
// types, storage, utilities) does not import the features and interfaces built on it. A diff
// that adds an import between two modules may run against them, and one that makes two modules
// depend on each other ties them together. The map names both, between the modules its overview
// shows; whether a direction is allowed is the project's call, which the agent makes.

/** An import between two modules that the base did not have, and the imports that add it. */
export type MapModuleDependency = Readonly<{
  from: string;
  to: string;
  /** Where the changed files import the other module (path:line). */
  sites: readonly string[];
  /** When it makes the modules depend on each other: the modules from `to` back to `from`. */
  back?: readonly string[];
  /** Whether `from` is a module the diff adds: all of its code files are new. */
  added: boolean;
}>;

type ChangedFile = Readonly<{
  path: string;
  basePath?: string;
  status: string;
  lines: readonly (readonly [number, number])[];
}>;

type Edges = Map<string, Map<string, string[]>>;

const IMPORT_KINDS = new Set<MapRelation["kind"]>(["IMPORTS", "TEST_IMPORTS"]);

// The files a file imports from the project, with the line of each import.
function imports(graph: MapViewGraph, path: string) {
  const found: { target: string; line: number }[] = [];
  for (const relation of graph.relationsFrom(graph.objectsAt(path).map((object) => object.id)))
    if (IMPORT_KINDS.has(relation.kind) && relation.to !== undefined)
      found.push({
        target: graph.object(relation.to).anchor.path,
        line: relation.anchor.startLine,
      });
  return found;
}

// The modules on the shortest path from one module to another, both included.
function pathBetween(edges: Edges, from: string, to: string): string[] | undefined {
  const via = new Map<string, string>([[from, from]]);
  for (let frontier = [from]; frontier.length; ) {
    const next: string[] = [];
    for (const module of frontier)
      for (const target of edges.get(module)?.keys() ?? []) {
        if (via.has(target)) continue;
        via.set(target, module);
        if (target === to) {
          const path = [to];
          for (let step = module; step !== from; step = via.get(step) ?? from) path.unshift(step);
          return [from, ...path];
        }
        next.push(target);
      }
    frontier = next;
  }
  return undefined;
}

/**
 * The imports between modules of the working tree that the base did not have. The base's imports
 * are the working map's for unchanged files and, for changed ones, the base map's when it was
 * built; without it, every changed line is an addition, so the imports on the other lines are
 * the ones the base had.
 */
export function newModuleDependencies(
  store: CodeIndexStore,
  cache: MapViewCache,
  working: string,
  base: string | undefined,
  files: readonly ChangedFile[],
): MapModuleDependency[] {
  const entries = store.listEntries(working);
  const moduleOf = mapProjectModules(entries);
  const now: Edges = new Map();
  const before: Edges = new Map();
  const add = (edges: Edges, source: string, target: string, site?: string) => {
    const from = moduleOf(source);
    const to = moduleOf(target);
    if (!from || !to || from === to) return;
    const targets = edges.get(from) ?? new Map<string, string[]>();
    const sites = targets.get(to) ?? [];
    if (site && !sites.includes(site)) sites.push(site);
    targets.set(to, sites);
    edges.set(from, targets);
  };
  const changed = new Set(files.map((file) => file.path));
  for (const row of cache.imports(store, working))
    if (row.target !== null && !changed.has(row.source)) {
      add(now, row.source, row.target);
      add(before, row.source, row.target);
    }
  const graph = new MapViewGraph(store, working);
  const baseGraph = base === undefined ? undefined : new MapViewGraph(store, base);
  for (const file of files) {
    const current = file.status === "DELETED" ? [] : imports(graph, file.path);
    for (const { target, line } of current) add(now, file.path, target, `${file.path}:${line}`);
    if (!file.basePath || file.status === "ADDED") continue;
    if (baseGraph)
      for (const { target } of imports(baseGraph, file.basePath)) add(before, file.path, target);
    else
      for (const { target, line } of current)
        if (!file.lines.some(([from, to]) => from <= line && line <= to))
          add(before, file.path, target);
  }

  const added = new Set(files.filter((file) => file.status === "ADDED").map((file) => file.path));
  const kept = new Set<string>();
  for (const entry of entries) {
    const module = mapCodePath(entry.path) ? moduleOf(entry.path) : undefined;
    if (module && !added.has(entry.path)) kept.add(module);
  }
  const dependencies: MapModuleDependency[] = [];
  for (const [from, targets] of now)
    for (const [to, sites] of targets) {
      if (before.get(from)?.has(to)) continue;
      // A cycle is new unless the two modules already reached each other in the base.
      const back = pathBetween(now, to, from);
      const cycle =
        back && !(pathBetween(before, from, to) && pathBetween(before, to, from)) ? { back } : {};
      dependencies.push({ from, to, sites, ...cycle, added: !kept.has(from) });
    }
  return dependencies.sort(
    (left, right) =>
      Number(right.back !== undefined) - Number(left.back !== undefined) ||
      (left.from < right.from ? -1 : left.from > right.from ? 1 : 0) ||
      (left.to < right.to ? -1 : left.to > right.to ? 1 : 0),
  );
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeIndexStore } from "./code-index-store";
import { IMPORT_KINDS, type Tracer, testEntries } from "./project-map-change-trace";
import type { MapChangedFile, MapChangeEntry } from "./project-map-change-types";
import {
  mapRegisteredRoute,
  mapRequestedRoutes,
  mapRouteLabel,
  mapRouteLiteral,
  mapRouteServes,
  routeRegistrations,
} from "./project-map-clients";
import { mapReadsRequests } from "./project-map-language";
import { MAP_PATH_PARAMETER } from "./project-map-route-paths";
import { type MapObject, mapRunnableTest, mapTestPath } from "./project-map-types";
import { type MapViewGraph, mapInnermost, mapIsModule } from "./project-map-view-graph";

// The tests related to a change beyond its callers: by import, place and name, by the routes
// they request, and the existing tests a diff rewrote.

// The declarations of a changed test file that existed in the base and whose lines the diff changed
// or removed, innermost first: a test method, not its class. Comparing text, not diff hunks, keeps
// a test added beside an existing one from counting as a change to it, and catches lines moved out
// of an existing test, which git may show as a pure addition; a test that only gained lines kept
// every check it had.
export async function existingTestsChanged(
  before: MapViewGraph,
  after: MapViewGraph,
  file: MapChangedFile,
  project: string | undefined,
): Promise<string[]> {
  if (!file.basePath || file.baseText === undefined) return [];
  const baseLines = file.baseText.split("\n");
  const workingLines =
    file.status !== "DELETED" && project
      ? ((await readFile(path.join(project, file.path), "utf8").catch(() => undefined))?.split(
          "\n",
        ) ?? [])
      : [];
  const body = (lines: readonly string[], object: MapObject) =>
    lines.slice(object.anchor.startLine - 1, object.anchor.endLine).map((line) => line.trimEnd());
  // A test whose every line is still there, in order, only gained lines (a new table row, another
  // assertion): what it checked before, it still checks.
  const extended = (before: readonly string[], after: readonly string[]) => {
    let at = 0;
    for (const line of after) if (at < before.length && line === before[at]) at++;
    return at === before.length;
  };
  const now = new Map(
    (file.status === "DELETED" ? [] : after.declarationsAt(file.path)).map((object) => [
      after.declarationKey(object),
      object,
    ]),
  );
  const changed = before.declarationsAt(file.basePath).filter((object) => {
    const counterpart = now.get(before.declarationKey(object));
    return !counterpart || !extended(body(baseLines, object), body(workingLines, counterpart));
  });
  // A class changes with its method; name the method.
  return mapInnermost(changed)
    .map((object) => before.qualifiedName(object.id))
    .sort();
}

// A module importing another: the file holding the import, and the importing module.
export type Importer = Readonly<{ path: string; module: string }>;

// Tests that import a changed file, directly or through up to two importing modules. Each module's
// importers are read once and kept for the other changed files.
export function importerTests(
  graph: MapViewGraph,
  objects: readonly MapObject[],
  tracer: Tracer,
  importers: Map<string, Importer[]>,
) {
  let modules = objects.filter((object) => mapIsModule(object)).map((object) => object.id);
  const seen = new Set(modules);
  for (let hop = 0; hop < 3 && modules.length; hop++) {
    const unread = modules.filter((module) => !importers.has(module));
    for (const module of unread) importers.set(module, []);
    for (const relation of graph.relationsTo(unread)) {
      if (!IMPORT_KINDS.has(relation.kind) || !relation.to) continue;
      const importer = graph.object(relation.from);
      importers.get(relation.to)?.push({
        path: relation.anchor.path,
        module: mapIsModule(importer) ? importer.id : graph.owner(relation.from),
      });
    }
    const next: string[] = [];
    for (const imported of modules)
      for (const { path, module } of importers.get(imported) ?? [])
        if (mapTestPath(path))
          tracer.test(
            path,
            undefined,
            hop ? "imports a changed file indirectly" : "imports a changed file",
            hop ? 4 : 2,
          );
        else if (!seen.has(module)) {
          seen.add(module);
          next.push(module);
        }
    modules = next;
  }
}

// Tests that may use the change through test support no test is found to call (pytest's
// conftest.py, shared fixtures, setup files): fixtures are injected by name, so the tests beside
// and below the support file count.
export function supportTests(store: CodeIndexStore, version: string, tracer: Tracer) {
  for (const file of tracer.support) {
    const slash = file.lastIndexOf("/");
    const directory = slash < 0 ? "" : file.slice(0, slash + 1);
    for (const row of store.database
      .prepare(
        "SELECT DISTINCT path FROM project_map_objects WHERE version_ref = ? AND substr(path, 1, ?) = ?",
      )
      .all(version, directory.length, directory))
      tracer.test(String(row.path), undefined, `may use it through ${file}`, 3.5);
  }
}

/** The mapped files by where they are, read once per check for the tests beside each change. */
export type MapPathIndex = Readonly<{
  /** Test files by their directory ("" or ending in /). */
  testsIn: ReadonlyMap<string, readonly string[]>;
  /** Files by the name of the directory holding them. */
  under: ReadonlyMap<string, readonly string[]>;
}>;

export function mapPathIndex(paths: readonly string[]): MapPathIndex {
  const testsIn = new Map<string, string[]>();
  const under = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string) => {
    const found = map.get(key);
    if (found) found.push(path);
    else map.set(key, [path]);
  };
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash + 1);
    if (mapTestPath(path)) add(testsIn, directory, path);
    const name = directory.slice(directory.lastIndexOf("/", directory.length - 2) + 1, -1);
    if (name) add(under, name, path);
  }
  return { testsIn, under };
}

// Tests of the same module in a mirrored test tree: tests/file/ for polar/file/service.py, in the
// same package: what is above the test tree (server/ of server/tests/) is above the file too.
export function mirroredTests(paths: MapPathIndex, file: string, tracer: Tracer) {
  const directories = file.split("/").slice(0, -1);
  const module = directories.at(-1);
  if (!module) return;
  for (const candidate of paths.under.get(module) ?? []) {
    const parts = candidate.split("/");
    const at = parts.length - 2;
    if (at < 1) continue;
    const tree = parts
      .slice(0, at)
      .some(
        (part, index) =>
          /^(?:tests?|__tests__|specs?)$/iu.test(part) &&
          parts.slice(0, index).every((above, depth) => directories[depth] === above),
      );
    if (tree) tracer.test(candidate, undefined, `tests the ${module} module`, 3);
  }
}

// The requests the tests send as the map read them, each with the tests sending it (through a
// test helper, the tests calling it), and the text of the runnable tests: read once per check.
// Files read at once: enough to keep the disk busy, few enough to hold few open.
const READ_BATCH = 64;

export class RouteRequests {
  private readonly sites: {
    request: string;
    tests: [string, string][];
    // The routes its path is closest to, or none when the path is not worked out (`unknown`).
    routes: string[];
    unknown: boolean;
  }[] = [];
  private known?: Set<string>;
  private candidates?: string[];
  /** The most runnable tests one search left unread when the check's deadline came. */
  unsearched = 0;

  constructor(
    private readonly store: CodeIndexStore,
    private readonly version: string,
    graph: MapViewGraph,
    private readonly project: string | undefined,
    private readonly until: number,
  ) {
    const closest = mapRequestedRoutes(routeRegistrations(store, version).routes);
    for (const row of store.database
      .prepare(
        "SELECT entity_ref, note_json FROM project_map_notes WHERE version_ref = ? AND json_extract(note_json, '$.kind') = 'ROUTE_REQUEST'",
      )
      .all(version)) {
      const note = JSON.parse(String(row.note_json)) as { text: string; anchor: { path: string } };
      if (!mapTestPath(note.anchor.path)) continue;
      const unknown = mapRouteLabel(note.text).path === MAP_PATH_PARAMETER;
      this.sites.push({
        request: note.text,
        tests: testEntries(graph, graph.owner(String(row.entity_ref))),
        routes: unknown ? [] : closest(note.text),
        unknown,
      });
    }
  }

  /** The tests requesting a route: their files, with the tests in each sending the request. */
  requesting(route: string): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>();
    for (const site of this.sites)
      if (site.routes.includes(route))
        for (const [file, name] of site.tests)
          found.set(file, (found.get(file) ?? new Set()).add(name));
    return found;
  }

  /**
   * The tests that may request a route: those sending a request whose path is not worked out, by
   * a method the route serves.
   */
  unknown(route: string): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>();
    for (const site of this.sites)
      if (site.unknown && mapRouteServes(route, site.request))
        for (const [file, name] of site.tests)
          found.set(file, (found.get(file) ?? new Set()).add(name));
    return found;
  }

  /** The test files requesting some route of the project: tests whose requests the map reads. */
  get reading(): ReadonlySet<string> {
    this.known ??= new Set(
      this.sites.flatMap((site) => (site.routes.length ? site.tests.map(([file]) => file) : [])),
    );
    return this.known;
  }

  /**
   * The runnable tests and their text, in path order, read a batch at a time and not kept: a
   * project's tests may be more text than is worth holding, and each pass reads them again. Reading
   * stops at the check's deadline, and how many were left is kept to be said.
   */
  async *tests(): AsyncGenerator<readonly [string, string]> {
    const project = this.project;
    if (!project) return;
    this.candidates ??= this.store.database
      .prepare("SELECT DISTINCT path FROM project_map_objects WHERE version_ref = ? ORDER BY path")
      .all(this.version)
      .map((row) => String(row.path))
      .filter(mapRunnableTest);
    for (let at = 0; at < this.candidates.length; at += READ_BATCH) {
      if (Date.now() > this.until) {
        this.unsearched = Math.max(this.unsearched, this.candidates.length - at);
        return;
      }
      const batch = this.candidates.slice(at, at + READ_BATCH);
      const texts = await Promise.all(
        batch.map((file) => readFile(path.join(project, file), "utf8").catch(() => undefined)),
      );
      for (const [index, text] of texts.entries())
        if (text !== undefined) yield [batch[index] as string, text];
    }
  }
}

// Tests that request an affected route over HTTP: no call links them, but they request its path.
// The requests tests send are in the map, matched to routes as code requesting them is, by method
// and path. A test naming a stretch of a route's path, the longest literal one, mentions it, so
// parameters and prefixes added where the router is mounted do not hide it; where the map does not
// read requests, a test naming the whole path requests the route, and one naming a stretch of it
// may. Returns the routes some test requests: a mention of a stretch alone does not say the test
// requests that route, so it does not hold the route.
export async function routeTests(
  requests: RouteRequests,
  entries: readonly MapChangeEntry[],
  tracer: Tracer,
): Promise<Set<string>> {
  const requested = new Set<string>();
  const affected = new Set(entries.filter((entry) => entry.route).map((entry) => entry.label));
  if (!affected.size) return requested;
  for (const label of affected)
    for (const [file, names] of requests.requesting(label)) {
      requested.add(label);
      tracer.requester(label, file);
      for (const name of names) tracer.test(file, name, `requests ${JSON.stringify(label)}`, 2);
    }
  // Routes sharing a stretch (GET and DELETE /users/{id}) are each mentioned where it is named.
  const fragments = new Map<string, string[]>();
  for (const label of affected) {
    const fragment = routeFragment(label);
    if (fragment) fragments.set(fragment, [...(fragments.get(fragment) ?? []), label]);
  }
  if (!fragments.size) return requested;
  for await (const [candidate, text] of requests.tests()) {
    // A mention alone is weak evidence; with another relation it is the strongest one.
    const rank = tracer.tests.has(candidate) ? 2 : 3.5;
    const read = mapReadsRequests(candidate);
    for (const [fragment, labels] of fragments)
      if (text.includes(fragment))
        for (const label of labels) {
          // Where the map does not read a test's requests, its text is what says which it sends:
          // naming a route's whole path, the test requests it; a stretch of it, it may.
          if (!read) {
            tracer.mentioner(label, candidate);
            if (fragment === mapRouteLabel(label).path && wholePath(text, fragment)) {
              requested.add(label);
              tracer.requester(label, candidate);
            }
          }
          tracer.test(candidate, undefined, `mentions ${JSON.stringify(label)}`, rank);
        }
  }
  return requested;
}

// Whether a text names this path whole somewhere, not as the start of a longer one.
function wholePath(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1))
    if (!/[\w./-]/u.test(text[at + path.length] ?? "")) return true;
  return false;
}

// Tests sending a request whose path the map cannot work out, as path(id) gives it, may request
// a route the trace held. Of the tests the code registering such a route reaches, as the trace
// climbing on would find them, those are kept: the map not reading a request selects more tests
// rather than fewer.
export async function unworkedRequests(
  requests: RouteRequests,
  tracer: Tracer,
  reaching: (route: string) => Promise<ReadonlySet<string>>,
) {
  for (const route of tracer.held.keys()) {
    const unknown = requests.unknown(route);
    if (!unknown.size) continue;
    for (const file of await reaching(route)) {
      const names = unknown.get(file);
      if (!names) continue;
      tracer.requester(route, file, true);
      for (const name of names)
        tracer.test(
          file,
          name,
          `may request ${JSON.stringify(route)}: the path a request of it is sent to is not worked out`,
          3,
        );
    }
  }
}

// Test files beside a changed file, as Go's _test.go files and many projects keep them.
export function sameDirectoryTests(paths: MapPathIndex, path: string, tracer: Tracer) {
  const slash = path.lastIndexOf("/");
  for (const candidate of paths.testsIn.get(slash < 0 ? "" : path.slice(0, slash + 1)) ?? [])
    tracer.test(candidate, undefined, "in the same directory", 3);
}

// The routes a file registers: a call's route literal, or a decorator's route.
export function routesIn(graph: MapViewGraph, path: string): Set<string> {
  const routes = new Set<string>();
  for (const relation of graph.relationsFrom(graph.objectsAt(path).map((object) => object.id))) {
    const route = mapRegisteredRoute(relation);
    if (route) routes.add(route);
  }
  return routes;
}

// The longest literal part of a route's path, which code requesting it spells out; a part too
// short to tell routes apart is none.
function routeFragment(label: string): string | undefined {
  const longest = mapRouteLiteral(label);
  return longest.replace(/\//gu, "").length >= 4 ? longest : undefined;
}

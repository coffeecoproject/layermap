import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeIndex } from "./code-index";
import type { CodeIndexStore } from "./code-index-store";
import type { CodeIndexSource } from "./code-index-types";
import {
  changedInBase,
  changedInWorkingTree,
  git,
  gitOptions,
  overlaps,
  readMapChanges,
  unmappedKind,
} from "./project-map-change-diff";
import { mapRemovedImpact } from "./project-map-change-removed";
import {
  type Importer,
  importerTests,
  type MapPathIndex,
  mapPathIndex,
  mirroredTests,
  RouteRequests,
  routeTests,
  sameDirectoryTests,
  supportTests,
  unworkedRequests,
} from "./project-map-change-tests";
import { mapChangesText } from "./project-map-change-text";
import { type ChangeStart, changeUnits, Tracer } from "./project-map-change-trace";
import {
  LIMITS,
  LIST,
  type MapChangedFile,
  type MapChangeEntry,
  type MapChangeImpact,
  type MapChanges,
  type MapCompileBreaks,
  type MapReusableCode,
  type MapUntestedChanges,
} from "./project-map-change-types";
import {
  type MapRouteClientSearch,
  mapRegisteredRoute,
  mapRouteLabel,
  routeClients,
  routeRegistrations,
} from "./project-map-clients";
import { mapReuseImports, newModuleDependencies } from "./project-map-dependencies";
import { mapPackageOf } from "./project-map-installed";
import { mapLanguageOf } from "./project-map-language";
import { mapMiniprogramTemplate } from "./project-map-miniprogram";
import { MAP_REFERENCES_MAX, type MapDiagnostic } from "./project-map-reference-types";
import { type MapSimilarCode, similarCode } from "./project-map-reuse";
import { type MapShapeReader, MapShapeUses, mapShapeDeadline } from "./project-map-shapes";
import { MAP_MIGRATION_PATH, mapTestPath } from "./project-map-types";
import { MapViewCache } from "./project-map-view";
import { MapViewGraph, mapDeclarationLabel, mapInnermost } from "./project-map-view-graph";

// "What does this change affect?": the declarations a diff touches, the entry points and tests
// their callers reach, and what a static map cannot see. It borrows test impact analysis practice:
// tests are chosen by file (call paths only explain them), an import graph backs up the call
// graph, and anything uncertain is named rather than ruled out. Who uses a changed field or type is
// not in the call graph, so it is found on demand (project-map-shapes.ts).

export async function mapChangeImpact(
  store: CodeIndexStore,
  working: string,
  base: string | undefined,
  changes: MapChanges,
  shapes: Readonly<{ working: MapShapeReader; base: MapShapeReader }>,
  /** When the check stops reading uses and compiling. */
  until: number,
  project?: string,
  tests?: readonly string[],
): Promise<MapChangeImpact> {
  const graph = new MapViewGraph(store, working);
  const cache = new MapViewCache();
  const memberCalls = cache.memberCalls(store, working);
  const tracer = new Tracer(
    graph,
    memberCalls,
    new MapShapeUses(graph, shapes.working, until),
    true,
  );
  const changed: string[] = [];
  const unclear: string[] = [];
  const incomplete: string[] = [];
  if (changes.quoted.length)
    incomplete.push(
      `${changes.quoted.length} changed file${changes.quoted.length === 1 ? " has" : "s have"} a tab, a newline or a quote in ${changes.quoted.length === 1 ? "its" : "their"} path, which the map cannot hold, and ${changes.quoted.length === 1 ? "was" : "were"} not checked: ${changes.quoted.slice(0, LIST.names).join(", ")}${changes.quoted.length > LIST.names ? ", …" : ""}`,
    );
  if (changes.stranded.unsearched)
    incomplete.push(
      `the diff removed more environment variables and configuration keys than the check looks up; ${changes.stranded.unsearched} of them were not looked for, so the files still using those are not listed`,
    );
  if (changes.stranded.failed)
    incomplete.push(
      `the text search for the environment variables and configuration keys the diff removed did not finish (${changes.stranded.failed}), so the files still using them are not listed`,
    );
  const unmapped: { path: string; kind: string }[] = [];
  let changedCount = 0;
  const starts: ChangeStart[] = [];
  // Read once for all changed files, as a large change (thousands of files nobody has added to
  // Git yet) would otherwise query the same importers, and every mapped path, once per file.
  const importers = new Map<string, Importer[]>();
  let mapped: string[] | undefined;
  const mappedPaths = () =>
    (mapped ??= store.database
      .prepare("SELECT DISTINCT path FROM project_map_objects WHERE version_ref = ?")
      .all(working)
      .map((row) => String(row.path)));
  let paths: MapPathIndex | undefined;
  const pathIndex = () => (paths ??= mapPathIndex(mappedPaths()));

  const topLevelChanged = (path: string) => {
    const note = `top-level code of ${path} changed (imports, constants or registrations)`;
    if (!unclear.includes(note)) unclear.push(note);
  };
  for (const file of changes.files) {
    const objects = file.status === "DELETED" || file.binary ? [] : graph.objectsAt(file.path);
    if (mapTestPath(file.path)) {
      if (file.status !== "DELETED" && !file.binary)
        tracer.test(file.path, undefined, "changed in this diff", 1);
      continue;
    }
    // Files in a language the map does not analyze have no declarations; whether the capture kept
    // them as files (a host may keep every file) does not make their changes code.
    const template = mapMiniprogramTemplate(file.path);
    const analyzed =
      file.status === "DELETED"
        ? !file.binary && (mapLanguageOf(file.path) !== undefined || template)
        : objects.length > 0 &&
          (mapLanguageOf(file.path) !== undefined ||
            (template && objects.some((object) => object.parsing === "PARSED")));
    // A migration changes the data the code reads, which the map does not follow even where it
    // maps the migration's own code.
    const kind =
      !analyzed || MAP_MIGRATION_PATH.test(file.path)
        ? unmappedKind(file.path, file.binary)
        : undefined;
    if (kind) {
      unclear.push(
        `${file.path} ${file.status === "DELETED" ? "deleted" : "changed"} (${kind}): its effects are not mapped`,
      );
      unmapped.push({ path: file.path, kind });
    }
    if (!objects.length) continue;
    // The innermost declarations around each changed line; top-level lines belong to the file.
    const hits = new Set<string>();
    let topLevel = false;
    const inFile = changeUnits(graph, file.path);
    for (const [from, to] of file.lines) {
      const containing = inFile.filter(
        (object) => object.anchor.startLine <= to && from <= object.anchor.endLine,
      );
      // What a deletion took from top-level code is found in the base.
      if (!containing.length && from <= to) topLevel = true;
      for (const object of mapInnermost(containing)) hits.add(object.id);
    }
    for (const ref of hits) {
      if (changedCount++ >= LIMITS.changed) {
        tracer.truncated = true;
        break;
      }
      const object = graph.object(ref);
      changed.push(
        `${file.path}${template ? " (template)" : `: ${graph.qualifiedName(ref)} ${mapDeclarationLabel(object)}`}${file.status === "ADDED" ? " (new file)" : ""}`,
      );
      starts.push(tracer.startsAt(ref, file.lines));
    }
    // Registrations on changed lines, wherever they are: a call's route literal, a decorator's route.
    for (const relation of graph.relationsFrom(objects.map((object) => object.id))) {
      const route = mapRegisteredRoute(relation);
      if (route && overlaps(file.lines, relation.anchor.startLine, relation.anchor.endLine))
        unclear.push(
          `the registration of ${JSON.stringify(route)} at ${relation.anchor.path}:${relation.anchor.startLine} changed; check that the route still reaches the right handler`,
        );
    }
    if (analyzed && topLevel && file.status !== "ADDED") topLevelChanged(file.path);
    // A file's importers back up its callers: tests that import it, even without a mapped call.
    importerTests(graph, objects, tracer, importers);
    sameDirectoryTests(pathIndex(), file.path, tracer);
    mirroredTests(pathIndex(), file.path, tracer);
  }
  await tracer.trace(
    starts.flatMap((start) => start.refs),
    starts.flatMap((start) => start.own),
  );
  let requests: RouteRequests | undefined;
  const routeRequests = () => {
    requests ??= new RouteRequests(store, working, graph, project, until);
    return requests;
  };
  // The tests the code registering a held route reaches, as the trace climbing on would find them:
  // by that code, which the routes one function registers share.
  const reached = new Map<string, Promise<ReadonlySet<string>>>();
  const reaching = (route: string) => {
    const callers = [...new Set((tracer.held.get(route) ?? []).map(({ caller }) => caller.ref))];
    const key = callers.sort().join("\u0000");
    let tests = reached.get(key);
    if (!tests) {
      tests = (async () => {
        const above = new Tracer(graph, memberCalls, tracer.shapes);
        await above.trace(callers);
        supportTests(store, working, above);
        return new Set(above.tests.keys());
      })();
      reached.set(key, tests);
    }
    return tests;
  };
  // The tests requesting the routes the change reaches run it. For a route none is found to
  // request, the trace climbs on to the code registering it, as for a call, unless the tests of
  // that app request its routes in ways the map reads; until no route is left.
  const asked = new Set<string>();
  const unfound: string[] = [];
  for (;;) {
    const fresh = [...tracer.entries.values()].filter(
      (entry) => entry.route && !asked.has(entry.label),
    );
    if (!fresh.length) break;
    for (const entry of fresh) asked.add(entry.label);
    const requested = await routeTests(routeRequests(), fresh, tracer);
    const unrequested = fresh
      .map((entry) => entry.label)
      .filter((label) => tracer.held.has(label) && !requested.has(label));
    // Where the tests of the app registering a route request its routes in ways the map reads,
    // none requesting this one says no test runs it, but for those whose request is not worked
    // out; elsewhere the map cannot tell, and the trace climbs on to every test of the app.
    const climbing: string[] = [];
    for (const label of unrequested) {
      const tests = await reaching(label);
      const reads = routeRequests().reading;
      if ([...tests].some((file) => reads.has(file))) unfound.push(label);
      else climbing.push(label);
    }
    if (!climbing.length) break;
    await tracer.release(climbing);
  }
  if (unfound.length)
    unclear.push(
      `no test is found to request ${unfound.length > 1 ? `${unfound.length} routes the change reaches (` : ""}${unfound
        .slice(0, LIST.names)
        .map((label) => JSON.stringify(label))
        .join(
          ", ",
        )}${unfound.length > LIST.names ? ", …" : ""}${unfound.length > 1 ? ")" : ""}: a test requesting ${unfound.length > 1 ? "them" : "it"} in a way the map does not read is not selected`,
    );
  if (tracer.held.size) await unworkedRequests(routeRequests(), tracer, reaching);
  if (requests?.unsearched)
    incomplete.push(
      `the check ran out of time before searching ${requests.unsearched} of the project's runnable tests for the paths of the routes the change reaches, so a test naming one of them there is not selected`,
    );
  const unread = [...tracer.shapes.unread];
  if (unread.length)
    unclear.push(
      `who uses ${unread.length} fields or types the change reaches was not read, so what they affect is not known (${unread
        .slice(0, LIST.names)
        .map((ref) => graph.qualifiedName(ref))
        .join(
          ", ",
        )}${unread.length > LIST.names ? ", …" : ""}); project_find_references lists their uses`,
    );
  const untested =
    tests && (await untestedChanges(graph, tracer, memberCalls, starts, changed, tests));
  supportTests(store, working, tracer);

  // What the diff took away, read in the base.
  const taken = base
    ? await mapRemovedImpact({
        store,
        cache,
        base,
        graph,
        tracer,
        changes,
        shapes: shapes.base,
        until,
        project,
        mappedPaths,
      })
    : undefined;
  for (const path of taken?.topLevel ?? []) topLevelChanged(path);
  unclear.push(...(taken?.unclear ?? []));

  return {
    changed,
    removed: taken?.removed ?? [],
    rewrittenTests: taken?.rewrittenTests ?? [],
    entries: [...tracer.entries.values()].sort(entryOrder),
    tests: [...tracer.tests]
      .map(([path, test]) => ({
        path,
        names: [...test.names].sort(),
        why: test.why,
        rank: test.rank,
      }))
      .sort(
        (left, right) =>
          left.rank - right.rank || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      ),
    areas: [...tracer.areas]
      .map(([area, known]) => ({
        area,
        through: [...known.through].sort(),
        tests: [...known.tests]
          .map(([path, names]) => ({ path, names: [...names].sort() }))
          .sort((left, right) => right.names.length - left.names.length),
      }))
      .sort((left, right) => right.tests.length - left.tests.length),
    unclear: [...new Set([...unclear, ...tracer.unclear])],
    incomplete: [
      ...incomplete,
      ...(tracer.truncated
        ? [
            `the trace stopped at ${LIMITS.depth} levels or ${LIMITS.declarations} declarations; continue with project_explore_map from the last ones`,
          ]
        : []),
    ],
    unmapped,
    removedRoutes: taken?.removedRoutes ?? [],
    uncalled: taken?.uncalled ?? [],
    dependencies: newModuleDependencies(store, cache, working, base, changes.files),
    ...(untested ? { untested } : {}),
    truncated: tracer.truncated,
  };
}

// Certain entries first, routes before other entry points, then by label.
const entryOrder = (left: MapChangeEntry, right: MapChangeEntry) =>
  Number(right.certain) - Number(left.certain) ||
  Number(right.route) - Number(left.route) ||
  (left.label < right.label ? -1 : left.label > right.label ? 1 : 0);

// The changed declarations the given test files do not run as far as the map follows: none of
// their code calls them, and they request no route above them. The entry points above those are
// traced apart, so they are found exactly as the affected entry points are. Whether a test runs a
// declaration is judged as the related tests are found: by its calls, and by the routes it is
// found to request, not by the code registering a route the trace held, which runs the route only
// for the tests requesting it. Where the map does not read a test's requests, its text naming a
// stretch of a route's path is what says it requests the route, as it relates the test.
async function untestedChanges(
  graph: MapViewGraph,
  tracer: Tracer,
  memberCalls: ReturnType<MapViewCache["memberCalls"]>,
  starts: readonly ChangeStart[],
  changed: readonly string[],
  tests: readonly string[],
): Promise<MapUntestedChanges> {
  const given = new Set(tests);
  // The handlers of the routes these files request, with the files requesting each.
  const handlers = (requests: ReadonlyMap<string, ReadonlySet<string>>, files: Set<string>) => {
    const into = new Map<string, Set<string>>();
    for (const [label, requesting] of requests)
      for (const file of requesting)
        if (files.has(file))
          for (const ref of tracer.handlers.get(label) ?? [])
            into.set(ref, (into.get(ref) ?? new Set()).add(file));
    return into;
  };
  // The routes each test file requests: found, or named by one whose requests the map does not read.
  const requested = new Map<string, Set<string>>();
  for (const found of [tracer.requests, tracer.mentions])
    for (const [label, files] of found)
      requested.set(label, new Set([...(requested.get(label) ?? []), ...files]));
  const routes = [...requested]
    .filter(([, files]) => [...files].some((file) => given.has(file)))
    .map(([label]) => label);
  const { how, truncated } = tracer.reach(
    starts.flatMap((start) => start.refs),
    given,
    handlers(requested, given),
    true,
  );
  const unreached: number[] = [];
  const throughRoutes: string[] = [];
  for (const [at, start] of starts.entries()) {
    const found = start.refs.map((ref) => how.get(ref));
    if (found.includes("call")) continue;
    if (found.includes("route")) throughRoutes.push(changed[at] ?? "");
    else unreached.push(at);
  }
  const above = new Tracer(graph, memberCalls, tracer.shapes);
  const refs = unreached.flatMap((at) => starts[at]?.refs ?? []);
  await above.trace(
    refs,
    unreached.flatMap((at) => starts[at]?.own ?? []),
  );
  // The test files running each unreached declaration, of these files, by these requests.
  const runBy = (files: Set<string>, requests: ReadonlyMap<string, ReadonlySet<string>>) => {
    const by = unreached.length
      ? tracer.reach(refs, files, handlers(requests, files), true).by
      : new Map<string, Set<string>>();
    return unreached.flatMap((at) => {
      const running = new Set((starts[at]?.refs ?? []).flatMap((ref) => [...(by.get(ref) ?? [])]));
      return running.size
        ? [
            {
              declaration: changed[at] ?? "",
              tests: [...running].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
            },
          ]
        : [];
    });
  };
  const rank = (file: string) => tracer.tests.get(file)?.rank ?? Number.POSITIVE_INFINITY;
  // The project's other related tests that run what the given ones do not: by a call, or by
  // requesting a route above it.
  const others = new Set([...tracer.tests.keys()].filter((file) => !given.has(file)));
  return {
    changed: unreached.map((at) => changed[at] ?? ""),
    runByOthers: runBy(others, requested),
    mayRun: runBy(given, tracer.mayRequest),
    entries: [...above.entries.values()].sort(entryOrder),
    throughRoutes,
    routes: throughRoutes.length ? routes.sort() : [],
    missing: tests.filter((test) => !graph.objectsAt(test).length),
    truncated: unreached.length > 0 && (truncated || above.truncated),
  };
}

export type MapChangeCheckInput = Readonly<{
  /** The index holding the map of the working tree. */
  index: CodeIndex;
  /** The directory that map was captured from; the diff against the base is read there. */
  project: string;
  /** Where the map was captured from, to find who uses a changed field or type. */
  source: CodeIndexSource;
  /** The map version of that directory as it is now. */
  working: string;
  /** The commit, branch or tag to compare with. */
  base: string;
  /**
   * The built map version of a commit of the same directory, captured with the same options as the
   * working version; the host builds it, since it decides how versions are kept. Called only when
   * the base has something to compare: lines the diff removed or changed, a changed test file's
   * existing tests, a renamed template, or compile errors to tell new from old.
   */
  baseVersion: (commit: string, signal: AbortSignal) => Promise<string>;
  /**
   * Test files in the working tree, by path from the repository root, to judge the change by: the
   * report then names the changed declarations they do not run, and the entry points above those.
   * Only these files count, not the project's other tests.
   */
  tests?: readonly string[];
  /**
   * "json" returns the check as data for a program choosing tests (see MapChangesData), and skips
   * what only a reader acts on: the code requesting routes, copies of existing code and compile
   * errors.
   */
  format?: "text" | "json";
}>;

/**
 * The check as data, for a program that chooses which tests to run: the changed files, the related
 * tests by rank (0 calls the change ... 4 imports it indirectly), the changed files the map does not
 * analyze, what else it cannot see, and whether the trace stopped at its limits.
 */
export type MapChangesData = Readonly<{
  base: string;
  commit: string;
  files: readonly Readonly<{ path: string; basePath?: string; status: MapChangedFile["status"] }>[];
  tests: MapChangeImpact["tests"];
  unmapped: MapChangeImpact["unmapped"];
  /** Where the check itself stopped short, so what it would have found is missing. */
  incomplete: readonly string[];
  checkByHand: readonly string[];
  truncated: boolean;
  /** With test files given, the changed code they do not run. */
  untested?: MapUntestedChanges;
}>;

export function mapChangesData(changes: MapChanges, impact: MapChangeImpact): MapChangesData {
  return {
    base: changes.base,
    commit: changes.commit,
    files: changes.files.map(({ path, basePath, status }) => ({
      path,
      ...(basePath !== undefined && basePath !== path ? { basePath } : {}),
      status,
    })),
    tests: impact.tests,
    unmapped: impact.unmapped,
    incomplete: impact.incomplete,
    checkByHand: impact.unclear,
    truncated: impact.truncated,
    ...(impact.untested ? { untested: impact.untested } : {}),
  };
}

/**
 * What the working tree's changes against a base commit affect, as project_check_changes reports
 * it: the changed and removed declarations, the entry points and tests their callers reach, the
 * code requesting affected routes, and what the map cannot see; and the same check as data, for a
 * host that acts on it, such as on the changed code the given tests do not run.
 */
export async function checkMapChanges(
  input: MapChangeCheckInput,
  signal: AbortSignal,
): Promise<{ text: string; data: MapChangesData }> {
  const { index, project, working } = input;
  const changes = await readMapChanges(project, input.base, signal, {
    names: input.format !== "json",
  });
  await index.ensureIndex(working, signal);
  // The base map tells what the diff removed, and which existing tests it changed.
  const base = changes.files.some(
    (file) =>
      file.basePath !== undefined &&
      (file.baseLines.length || file.baseText !== undefined || file.status === "RENAMED"),
  )
    ? await input.baseVersion(changes.commit, signal)
    : undefined;
  // The uses of fields and types in one version; what a repository uses too widely to read says
  // little about this change.
  const usesIn =
    (version: string, source: CodeIndexSource): MapShapeReader =>
    async (refs, until) => {
      const found = await index.findUses(
        { version, source, refs, until, maxResults: MAP_REFERENCES_MAX },
        signal,
      );
      return new Map(
        [...found].map(([ref, { uses, complete }]) => [
          ref,
          {
            complete,
            uses: uses.flatMap(({ kind, owner, anchor }) =>
              owner && kind !== "IMPORT_EXPORT"
                ? [{ owner: owner.id, anchor, write: kind === "WRITE" }]
                : [],
            ),
          },
        ]),
      );
    };
  // One deadline for what the check reads on demand, once the maps it reads from exist. Uses come
  // first, as they decide what the trace reaches; the compile has what they leave.
  const until = mapShapeDeadline();
  const impact = await mapChangeImpact(
    index.store,
    working,
    base,
    changes,
    {
      working: usesIn(working, input.source),
      base: usesIn(base ?? working, { ...input.source, kind: "COMMIT", commit: changes.commit }),
    },
    until,
    project,
    input.tests,
  );
  const data = mapChangesData(changes, impact);
  if (input.format === "json") return { text: JSON.stringify(data), data };
  return {
    data,
    text: mapChangesText(
      changes,
      impact,
      await mapRouteClients(project, index.store, working, impact, signal),
      reusable(
        index.store,
        working,
        await similarCode(index.store, working, base, changes.files, (file) =>
          readFile(path.join(project, file), "utf8").catch(() => undefined),
        ),
      ),
      changes.files.length ? await compileBreaks(input, changes, base, until, signal) : undefined,
    ),
  };
}

/**
 * Code the diff adds that reads like existing code, with what one copy would import to use the
 * other; copies in packages neither of which imports the other's cannot share code, so they are
 * no reuse missed.
 */
function reusable(
  store: CodeIndexStore,
  working: string,
  similar: readonly MapSimilarCode[],
): MapReusableCode[] {
  if (!similar.length) return [];
  const importsFor = mapReuseImports(store, new MapViewCache(), working);
  return similar.flatMap((item) => {
    const imports = importsFor(item.path, item.like.path);
    return imports ? [{ ...item, imports }] : [];
  });
}

/**
 * The code and templates outside the tests that request the routes the change reaches through
 * their handlers (the handler itself or one call below it), and the routes it removed whose path
 * no registration keeps.
 */
export async function mapRouteClients(
  project: string,
  store: CodeIndexStore,
  working: string,
  impact: MapChangeImpact,
  signal: AbortSignal,
): Promise<MapRouteClientSearch> {
  const affected = impact.entries.filter(
    (entry) => entry.route && entry.certain && entry.chain.length <= 2,
  );
  if (!affected.length && !impact.removedRoutes.length) return { routes: [] };
  const registrations = routeRegistrations(store, working);
  // A removed route's path is still served when a route with HTTP methods, or the same label,
  // registers it; a class-level prefix with that path alone does not serve it.
  const served = (route: string) =>
    registrations.routes.has(route) ||
    [...registrations.routes].some(
      (other) => !other.startsWith("/") && mapRouteLabel(other).path === mapRouteLabel(route).path,
    );
  const routes = [
    ...affected.map((entry) => ({ route: entry.label, removed: false })),
    ...impact.removedRoutes
      .filter((route) => !served(route))
      .map((route) => ({ route, removed: true })),
  ];
  if (!routes.length) return { routes: [] };
  return routeClients(routes, registrations, git, gitOptions(project, signal));
}

/**
 * What the compiler says the diff broke: the errors on lines the diff left unchanged that the
 * base did not have on such lines, each error counted, as the same text at another place in a file
 * is another error. A context compares with
 * the same configuration's in the base, and only one compiled on both sides says anything: without
 * the base's errors, those it had would look new. Both compile against the packages installed now,
 * so a version the base needed differently is not seen.
 */
async function compileBreaks(
  input: MapChangeCheckInput,
  changes: MapChanges,
  base: string | undefined,
  until: number,
  signal: AbortSignal,
): Promise<MapCompileBreaks> {
  const { index, working } = input;
  const present = changes.files
    .filter((file) => file.status !== "DELETED")
    .map((file) => file.path);
  const gone = changes.files.flatMap((file) => (file.basePath ? [file.basePath] : []));
  const after = await index.findDiagnostics(
    {
      version: working,
      source: input.source,
      configurations: [
        ...new Set([
          ...index.contextConfigurations(working, present),
          ...(base ? index.contextConfigurations(base, gone) : []),
        ]),
      ],
      until,
    },
    signal,
  );
  const missing = new Set(after.contexts.flatMap((context) => context.missing));
  // A context without a configuration is not compiled here, but its imports still tell.
  const views = new MapViewCache();
  const { notInstalled } = views.coverageNotes(index.store, working);
  if (notInstalled.length)
    for (const { source, target, specifier } of views.imports(index.store, working))
      if (target === null && present.includes(source)) {
        const name = mapPackageOf(specifier);
        if (name && notInstalled.includes(name)) missing.add(name);
      }
  const changedAt = changedInWorkingTree(changes.files);
  const onUnchanged = after.contexts.flatMap(({ configPath, errors }) => {
    const unchanged = errors.filter((item) => {
      const file = changedAt.get(item.path);
      return !file || !overlaps(file.lines, item.line, item.line);
    });
    return unchanged.length ? [{ configPath, unchanged }] : [];
  });
  // The base is compiled only for contexts with something to compare, as long as time is left.
  const before =
    onUnchanged.length && Date.now() <= until
      ? await index.findDiagnostics(
          {
            version: base ?? (await input.baseVersion(changes.commit, signal)),
            source: { ...input.source, kind: "COMMIT", commit: changes.commit },
            configurations: onUnchanged.map(({ configPath }) => configPath),
            until,
          },
          signal,
        )
      : { contexts: [], unchecked: [] };
  const inBase = changedInBase(changes.files);
  const named = (path: string, item: MapDiagnostic) =>
    `${path}\u0000${item.code}\u0000${item.span}\u0000${item.text}`;
  const compiled = new Map(before.contexts.map((context) => [context.configPath, context.errors]));
  const unchecked = new Set(after.unchecked);
  const errors = new Set<string>();
  for (const { configPath, unchanged } of onUnchanged) {
    const had = compiled.get(configPath);
    if (!had) {
      unchecked.add(configPath);
      continue;
    }
    const known = new Map<string, number>();
    for (const item of had) {
      const file = inBase.get(item.path);
      if (file && overlaps(file.baseLines, item.line, item.line)) continue;
      const name = named(file?.path ?? item.path, item);
      known.set(name, (known.get(name) ?? 0) + 1);
    }
    for (const item of unchanged) {
      const name = named(item.path, item);
      const left = known.get(name) ?? 0;
      if (left) known.set(name, left - 1);
      else errors.add(`${item.path}:${item.line} TS${item.code} ${item.text.split("\n")[0]}`);
    }
  }
  return { errors: [...errors], missing: [...missing].sort(), unchecked: [...unchecked].sort() };
}

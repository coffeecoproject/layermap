import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeIndex } from "./code-index";
import type { CodeIndexStore } from "./code-index-store";
import type { CodeIndexSource } from "./code-index-types";
import {
  git,
  gitOptions,
  overlaps,
  readMapChanges,
  unmappedKind,
  workingLine,
} from "./project-map-change-diff";
import {
  existingTestsChanged,
  type Importer,
  importerTests,
  type MapPathIndex,
  mapPathIndex,
  mirroredTests,
  RouteRequests,
  routesIn,
  routeTests,
  sameDirectoryTests,
  supportTests,
  unworkedRequests,
} from "./project-map-change-tests";
import { mapChangesText } from "./project-map-change-text";
import { CALLER_KINDS, type ChangeStart, NAMING_KINDS, Tracer } from "./project-map-change-trace";
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
import { mapMiniprogramTemplate, miniprogramEventOf } from "./project-map-miniprogram";
import { MAP_REFERENCES_MAX, type MapDiagnostic } from "./project-map-reference-types";
import { type MapSimilarCode, similarCode } from "./project-map-reuse";
import {
  type MapShapeReader,
  MapShapeUses,
  mapIsShape,
  mapShapeDeadline,
} from "./project-map-shapes";
import {
  MAP_MIGRATION_PATH,
  type MapAnchor,
  type MapObject,
  type MapRelation,
  mapTestPath,
} from "./project-map-types";
import { MapViewCache } from "./project-map-view";
import { MapViewGraph, mapDeclarationLabel, mapIsModule } from "./project-map-view-graph";

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
  const removed: { declaration: string; usedBy: Set<string> }[] = [];
  const declarations = (g: MapViewGraph, path: string) =>
    g.objectsAt(path).filter((object) => !mapIsModule(object) && g.isAddressable(object));
  // What a change is read in: a file's declarations, or a template as one unit, the page or
  // component it shows.
  const units = (g: MapViewGraph, path: string) =>
    mapMiniprogramTemplate(path)
      ? g.objectsAt(path).filter((object) => mapIsModule(object) && object.parsing === "PARSED")
      : declarations(g, path);
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
    const inFile = units(graph, file.path);
    for (const [from, to] of file.lines) {
      const containing = inFile.filter(
        (object) => object.anchor.startLine <= to && from <= object.anchor.endLine,
      );
      // What a deletion took from top-level code is found in the base.
      if (!containing.length && from <= to) topLevel = true;
      // Keep the innermost: a changed method, not its whole class.
      for (const object of containing)
        if (
          !containing.some(
            (other) =>
              other !== object &&
              object.anchor.start <= other.anchor.start &&
              other.anchor.end <= object.anchor.end &&
              other.anchor.startLine <= to &&
              from <= other.anchor.endLine,
          )
        )
          hits.add(object.id);
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

  // Declarations the diff removed or renamed, and the code it left unchanged that still uses them.
  const rewrittenTests: { path: string; names: string[] }[] = [];
  const removedRoutes: string[] = [];
  const uncalled: string[] = [];
  if (base) {
    const before = new MapViewGraph(store, base);
    const registered = new Set<string>();
    for (const file of changes.files)
      if (file.status !== "DELETED")
        for (const route of routesIn(graph, file.path)) registered.add(route);
    for (const file of changes.files)
      if (file.basePath && file.status !== "ADDED")
        for (const route of routesIn(before, file.basePath))
          if (!registered.has(route) && !removedRoutes.includes(route)) removedRoutes.push(route);
    for (const file of changes.files)
      if (file.basePath && file.baseText !== undefined && mapTestPath(file.basePath)) {
        const names = await existingTestsChanged(before, graph, file, project);
        if (names.length) rewrittenTests.push({ path: file.path, names });
      }
    const beforeTracer = new Tracer(
      before,
      cache.memberCalls(store, base),
      new MapShapeUses(before, shapes.base, until),
    );
    const changedIn = new Map(
      changes.files.flatMap((file) => (file.basePath ? [[file.basePath, file]] : [])),
    );
    // Where a use in the base is in the working tree, when the diff left its lines alone.
    const nowAt = (anchor: Pick<MapAnchor, "path" | "startLine" | "endLine">) => {
      const file = changedIn.get(anchor.path);
      if (
        file &&
        (file.status === "DELETED" || overlaps(file.baseLines, anchor.startLine, anchor.endLine))
      )
        return undefined;
      return {
        path: file?.path ?? anchor.path,
        startLine: workingLine(file, anchor.startLine),
        endLine: workingLine(file, anchor.endLine),
      };
    };
    const samePlace = (
      anchor: MapAnchor,
      place: { path: string; startLine: number; endLine: number },
    ) =>
      anchor.path === place.path &&
      anchor.startLine === place.startLine &&
      anchor.endLine === place.endLine;
    // What took a removed declaration's place: one of its kind and name, as the method of a renamed
    // class or a moved function is. The code the diff left alone uses it where it used the old one.
    const replaces = (now: MapObject, removed: MapObject) =>
      now.kind === removed.kind && now.name === removed.name;
    const relationsNow = new Map<string, MapRelation[]>();
    const relationsIn = (path: string) => {
      let found = relationsNow.get(path);
      if (!found) {
        found = graph.relationsFrom(graph.objectsAt(path).map((object) => object.id));
        relationsNow.set(path, found);
      }
      return found;
    };
    // A use in the base that names what the diff removed, on lines the diff did not touch, which in
    // the working tree names nothing that took its place.
    const stillUses = (relation: MapRelation) => {
      const place = nowAt(relation.anchor);
      if (!place) return false;
      if (relation.to === undefined) return true;
      const used = before.object(relation.to);
      // A template is named by the tag that shows it, which a moved component keeps.
      const tag = mapIsModule(used);
      return !relationsIn(place.path).some(
        (use) =>
          NAMING_KINDS.has(use.kind) &&
          use.to !== undefined &&
          samePlace(use.anchor, place) &&
          (tag ? use.target === relation.target : replaces(graph.object(use.to), used)),
      );
    };
    const gone: string[] = [];
    // The fields and types each removed declaration takes away, whose uses are read once all are
    // known. A removed field or type counts alone: what is nested in it is reached through it, and
    // a generic access such as Operations[K]["request"] finds the same member of every key.
    const goneShapes: {
      shapes: readonly string[];
      inside: (ref: string) => boolean;
      usedBy: Set<string>;
    }[] = [];
    for (const file of changes.files) {
      if (!file.basePath || file.binary || mapTestPath(file.basePath)) continue;
      // Code names what a renamed file declares by its path (an import, a template's tag) as much
      // as by its name, so all of it is read: a declaration that kept its name counts as removed
      // where code the diff left alone still names it at the old path.
      const renamed = file.status === "RENAMED";
      if (!file.baseLines.length && !renamed) continue;
      const now = new Set(
        file.status === "DELETED"
          ? []
          : units(graph, file.path).map((o) => `${o.kind}\u0000${graph.qualifiedName(o.id)}`),
      );
      for (const object of units(before, file.basePath)) {
        if (!renamed && !overlaps(file.baseLines, object.anchor.startLine, object.anchor.endLine))
          continue;
        const kept = now.has(`${object.kind}\u0000${before.qualifiedName(object.id)}`);
        if (kept && !renamed) continue;
        // Only the outermost removed declaration: a removed class, not each of its methods.
        const parent = before.parent(object.id);
        if (parent && !mapIsModule(before.object(parent)) && gone.includes(parent)) continue;
        // Code outside it that names it or one of its members, as a removed class's methods are
        // called, or as a subclass extends it.
        const inside = (ref: string) => {
          for (let at: string | undefined = ref; at !== undefined; at = before.parent(at))
            if (at === object.id) return true;
          return false;
        };
        const usedBy = new Set<string>();
        for (const relation of before.relationsTo(
          before
            .objectsAt(file.basePath)
            .filter((member) => inside(member.id))
            .map((member) => member.id),
        )) {
          const owner = before.owner(relation.from);
          if (!NAMING_KINDS.has(relation.kind) || inside(owner) || !stillUses(relation)) continue;
          const user = before.object(owner);
          usedBy.add(
            mapIsModule(user)
              ? `${user.anchor.path}${mapMiniprogramTemplate(user.anchor.path) ? " (template)" : ": top-level code"}`
              : `${user.anchor.path}: ${before.qualifiedName(owner)}`,
          );
        }
        // Moved with its file and named by nothing at the old path: not removed.
        if (kept && !usedBy.size) continue;
        gone.push(object.id);
        goneShapes.push({
          shapes: mapIsShape(object)
            ? [object.id]
            : before
                .objectsAt(file.basePath)
                .filter((member) => inside(member.id) && mapIsShape(member))
                .map((member) => member.id),
          inside,
          usedBy,
        });
        removed.push({
          declaration: mapIsModule(object)
            ? `${file.basePath} (template)`
            : `${file.basePath}: ${before.qualifiedName(object.id)} ${mapDeclarationLabel(object)}`,
          usedBy,
        });
      }
    }
    // The code that reads or names the fields and types the diff removed, on lines it left alone,
    // unless the working tree reads there what took their place: a renamed type's fields, a moved
    // type. A field or type taking a place is declared in a changed file.
    await beforeTracer.shapes.read(goneShapes.flatMap((item) => item.shapes));
    const declared = new Map<string, MapObject[]>();
    for (const file of changes.files)
      if (file.status !== "DELETED")
        for (const object of graph.objectsAt(file.path))
          if (mapIsShape(object)) {
            const key = `${object.kind}\u0000${object.name}`;
            declared.set(key, [...(declared.get(key) ?? []), object]);
          }
    const successors = (shape: string) => {
      const removed = before.object(shape);
      return declared.get(`${removed.kind}\u0000${removed.name}`) ?? [];
    };
    await tracer.shapes.read(
      goneShapes.flatMap((item) =>
        item.shapes.flatMap((shape) => successors(shape).map((object) => object.id)),
      ),
    );
    const unfollowed = new Set<string>();
    for (const { shapes: inRemoved, inside, usedBy } of goneShapes)
      for (const shape of inRemoved) {
        if (beforeTracer.shapes.unread.has(shape))
          unclear.push(
            `${before.object(shape).anchor.path}: ${before.qualifiedName(shape)} was removed, and who used it was not read; search the code for its name`,
          );
        const now = successors(shape);
        for (const { owner, anchor } of beforeTracer.shapes.uses.get(shape) ?? []) {
          const place = nowAt(anchor);
          if (
            inside(owner) ||
            !place ||
            now.some((object) =>
              tracer.shapes.uses.get(object.id)?.some((use) => samePlace(use.anchor, place)),
            )
          )
            continue;
          if (now.some((object) => tracer.shapes.unread.has(object.id))) {
            unfollowed.add(`${before.object(shape).anchor.path}: ${before.qualifiedName(shape)}`);
            continue;
          }
          const user = before.object(owner);
          usedBy.add(
            mapIsModule(user)
              ? `${user.anchor.path}: top-level code`
              : `${user.anchor.path}: ${before.qualifiedName(owner)}`,
          );
        }
      }
    if (unfollowed.size)
      unclear.push(
        `${unfollowed.size} removed fields or types are used on lines the diff left alone, and whether that code now uses what took their place was not read (${[
          ...unfollowed,
        ]
          .sort()
          .slice(0, LIST.names)
          .join(
            ", ",
          )}${unfollowed.size > LIST.names ? ", …" : ""}); project_find_references lists their uses`,
      );
    // Template links the diff broke: a template's binding or tag that reached a method, a component
    // or an event in the base and reaches nothing now, as when a component stops emitting an event
    // a page binds, or app.json registers a component where there is none. No compiler checks a
    // template: what one the diff did not change still names is still used; on a line the diff
    // changed, it is new. What the diff removed is listed above.
    const removedAt = (ref: string) => {
      for (let at: string | undefined = ref; at !== undefined; at = before.parent(at))
        if (gone.includes(at)) return true;
      return false;
    };
    const lost = new Map<string, Set<string>>();
    const changedAt = new Map(changes.files.map((file) => [file.path, file]));
    for (const path of mappedPaths().filter(mapMiniprogramTemplate)) {
      const template = graph.objectsAt(path).find((object) => mapIsModule(object));
      if (!template) continue;
      const broken = graph
        .relationsFrom(graph.scope(template.id).refs)
        .filter((relation) => relation.to === undefined && NAMING_KINDS.has(relation.kind));
      if (!broken.length) continue;
      const file = changedAt.get(path);
      const basePath = file ? file.basePath : path;
      const was = basePath === undefined ? undefined : before.objectsAt(basePath).find(mapIsModule);
      const links = was ? before.relationsFrom(before.scope(was.id).refs) : [];
      for (const relation of broken) {
        const earlier = links.filter(
          (link) => link.kind === relation.kind && link.target === relation.target,
        );
        if (earlier.some((link) => link.to === undefined)) continue;
        const event = miniprogramEventOf(relation.target);
        const at = `${path}:${relation.anchor.startLine}`;
        if (file && overlaps(file.lines, relation.anchor.startLine, relation.anchor.endLine)) {
          unclear.push(
            event
              ? `${at} binds the ${event.event} event of <${event.tag}>, which it does not emit`
              : relation.kind === "REFERENCES"
                ? `${at} puts <${relation.target}>, which its registration does not find`
                : `${at} binds ${relation.target}, which its page or component does not register`,
          );
          continue;
        }
        // An event is named by the component that no longer emits it.
        const reached = event
          ? links.find((link) => link.kind === "REFERENCES" && link.target === event.tag)?.to
          : earlier.find((link) => link.to !== undefined)?.to;
        if (reached === undefined || removedAt(reached)) continue;
        const object = before.object(reached);
        const name = mapIsModule(object)
          ? `${object.anchor.path} (template)${event ? `: ${event.event} event` : ""}`
          : `${object.anchor.path}: ${before.qualifiedName(reached)} ${mapDeclarationLabel(object)}`;
        const users = lost.get(name) ?? new Set();
        users.add(`${path} (template)`);
        lost.set(name, users);
      }
    }
    for (const [declaration, users] of lost) removed.push({ declaration, usedBy: users });

    // Top-level code the diff removed: imports, calls and registrations outside any declaration,
    // not the declarations it holds.
    for (const file of changes.files) {
      if (!file.basePath || file.status === "DELETED" || mapTestPath(file.basePath)) continue;
      const module = before.objectsAt(file.basePath).find(mapIsModule);
      if (
        module &&
        mapLanguageOf(file.basePath) !== undefined &&
        before
          .relationsFrom(before.scope(module.id).refs)
          .some(
            (relation) =>
              relation.kind !== "CONTAINS" &&
              overlaps(file.baseLines, relation.anchor.startLine, relation.anchor.endLine),
          )
      )
        topLevelChanged(file.path);
    }
    if (gone.length) {
      await beforeTracer.trace(gone, gone, true);
      // The base's trace names the base's files and lines. Each is taken to where the working
      // tree has it: a renamed file by its new path, a line by where the diff moved it, and a test
      // file the diff deleted runs nothing. A route the diff removed keeps the base's site.
      // A file of the base where the working tree has it: none for a deleted file.
      const pathNow = (path: string) => {
        const file = changedIn.get(path);
        return file?.status === "DELETED" ? undefined : (file?.path ?? path);
      };
      const siteNow = (site: string) => {
        const at = site.lastIndexOf(":");
        const line = Number(site.slice(at + 1));
        const place = nowAt({ path: site.slice(0, at), startLine: line, endLine: line });
        return place && `${place.path}:${place.startLine}`;
      };
      // A declaration's label starts with its file's path: "src/cli.ts: main".
      const labelNow = (label: string) => {
        const at = label.indexOf(": ");
        const file = at < 0 ? label : label.slice(0, at);
        const now = pathNow(file);
        return now === undefined ? undefined : `${now}${label.slice(file.length)}`;
      };
      for (const entry of beforeTracer.entries.values()) {
        const label = entry.route ? entry.label : labelNow(entry.label);
        if (label === undefined || tracer.entries.has(label)) continue;
        const removed = entry.route && removedRoutes.includes(entry.label);
        const site = entry.site && (removed ? entry.site : siteNow(entry.site));
        tracer.entries.set(label, {
          label,
          route: entry.route,
          chain: entry.chain,
          ...(site ? { site } : {}),
          certain: entry.certain,
          ...(removed ? { removed: true } : {}),
        });
      }
      for (const [path, test] of beforeTracer.tests) {
        const now = pathNow(path);
        if (now === undefined) continue;
        tracer.test(now, undefined, test.why, test.rank);
        for (const name of test.names) tracer.test(now, name, test.why, test.rank);
      }
      for (const [area, known] of beforeTracer.areas)
        for (const [path, names] of known.tests) {
          const now = pathNow(path);
          const place = pathNow(area);
          if (now !== undefined && place !== undefined)
            tracer.shareArea(place, known.through, now, names);
        }
      unclear.push(...beforeTracer.unclear);
      if (beforeTracer.truncated) tracer.truncated = true;
    }

    // Declarations the diff took the last caller from, as when it replaces old code with new: the
    // base called them from the lines it removed or changed, and nothing outside tests calls them
    // now. Only those the base called from outside tests; the ones the diff removed are listed above.
    const moved = new Map(
      changes.files.flatMap((file) =>
        file.basePath ? [[file.basePath, file.status === "DELETED" ? undefined : file.path]] : [],
      ),
    );
    const called = new Set<string>();
    for (const file of changes.files) {
      if (!file.basePath || !file.baseLines.length || file.binary || mapTestPath(file.basePath))
        continue;
      for (const relation of before.relationsFrom(
        before.objectsAt(file.basePath).map((object) => object.id),
      ))
        if (
          CALLER_KINDS.has(relation.kind) &&
          relation.to !== undefined &&
          overlaps(file.baseLines, relation.anchor.startLine, relation.anchor.endLine)
        )
          called.add(before.owner(relation.to));
    }
    const outsideTests = (callers: { ref: string }[], g: MapViewGraph) =>
      callers.filter((caller) => !mapTestPath(g.object(caller.ref).anchor.path));
    const candidates: { path: string; name: string; now: MapObject; tested: boolean }[] = [];
    for (const ref of called) {
      const object = before.object(ref);
      if (mapIsModule(object) || mapTestPath(object.anchor.path) || gone.includes(ref)) continue;
      const path = moved.has(object.anchor.path)
        ? moved.get(object.anchor.path)
        : object.anchor.path;
      if (path === undefined) continue;
      const name = before.qualifiedName(ref);
      const now = declarations(graph, path).find(
        (candidate) => candidate.kind === object.kind && graph.qualifiedName(candidate.id) === name,
      );
      if (!now) continue;
      // What the trace read of a field's uses is weighed below, with those of the fields it did not.
      const calls = tracer.callers(now.id).filter((caller) => !caller.uses);
      if (outsideTests(calls, graph).length || tracer.usesWithoutCalls(now.id).length) continue;
      if (!outsideTests(beforeTracer.callers(ref), before).length) continue;
      candidates.push({ path, name, now, tested: calls.length > 0 });
    }
    // A field's other reads are not all in the map; it counts only if a search finds none.
    await tracer.shapes.read(candidates.map(({ now }) => now.id));
    const unknown: string[] = [];
    for (const { path, name, now, tested } of candidates) {
      if (tracer.shapes.unread.has(now.id)) unknown.push(name);
      else if (
        !tracer.shapes.uses
          .get(now.id)
          ?.some(({ owner, write }) => !write && !mapTestPath(graph.object(owner).anchor.path))
      ) {
        uncalled.push(
          `${path}: ${name} ${mapDeclarationLabel(now)}${tested ? " (only tests call it now)" : ""}`,
        );
      }
    }
    uncalled.sort();
    if (unknown.length)
      unclear.push(
        `${unknown.length} fields lost callers the diff removed, and whether others use them was not read (${unknown
          .sort()
          .slice(0, LIST.names)
          .join(
            ", ",
          )}${unknown.length > LIST.names ? ", …" : ""}); project_find_references lists their uses`,
      );
  }

  return {
    changed,
    removed: removed.map(({ declaration, usedBy }) => ({
      declaration,
      usedBy: [...usedBy].sort(),
    })),
    rewrittenTests,
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
    removedRoutes,
    uncalled,
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
  const changedIn = new Map(changes.files.map((file) => [file.path, file]));
  const onUnchanged = after.contexts.flatMap(({ configPath, errors }) => {
    const unchanged = errors.filter((item) => {
      const file = changedIn.get(item.path);
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
  const inBase = new Map(
    changes.files.flatMap((file) => (file.basePath ? [[file.basePath, file]] : [])),
  );
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

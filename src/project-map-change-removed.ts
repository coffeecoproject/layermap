import type { CodeIndexStore } from "./code-index-store";
import {
  changedInBase,
  changedInWorkingTree,
  overlaps,
  workingLine,
} from "./project-map-change-diff";
import { existingTestsChanged, routesIn } from "./project-map-change-tests";
import { CALLER_KINDS, changeUnits, NAMING_KINDS, Tracer } from "./project-map-change-trace";
import { LIST, type MapChangeImpact, type MapChanges } from "./project-map-change-types";
import { mapLanguageOf } from "./project-map-language";
import { mapMiniprogramTemplate, miniprogramEventOf } from "./project-map-miniprogram";
import { type MapShapeReader, MapShapeUses, mapIsShape } from "./project-map-shapes";
import { type MapAnchor, type MapObject, type MapRelation, mapTestPath } from "./project-map-types";
import type { MapViewCache } from "./project-map-view";
import { MapViewGraph, mapDeclarationLabel, mapIsModule } from "./project-map-view-graph";

// What a change took away, read in the base: the declarations, routes and template links it
// removed with the code it left alone that still uses them, the existing tests it rewrote, the
// declarations it took the last caller from, and what the removed code reached, placed where the
// working tree has it.

export type MapRemovedImpact = Pick<
  MapChangeImpact,
  "removed" | "rewrittenTests" | "removedRoutes" | "uncalled" | "unclear"
> &
  Readonly<{
    /** Files whose top-level code (imports, calls, registrations) the diff removed lines of. */
    topLevel: readonly string[];
  }>;

/**
 * Reads the base for what the diff removed. It adds to the change's trace: what the removed code
 * reached in the base (its entry points, tests and the areas they share, placed where the working
 * tree has them, and whether that trace stopped at its limits), and the uses it reads of the fields
 * and types that took the removed ones' place or lost their callers.
 */
export async function mapRemovedImpact(
  input: Readonly<{
    store: CodeIndexStore;
    cache: MapViewCache;
    base: string;
    /** The working tree's graph and the trace of the change in it. */
    graph: MapViewGraph;
    tracer: Tracer;
    changes: MapChanges;
    shapes: MapShapeReader;
    until: number;
    project?: string;
    mappedPaths: () => readonly string[];
  }>,
): Promise<MapRemovedImpact> {
  const { store, base, graph, tracer, changes } = input;
  const unclear: string[] = [];
  const before = new MapViewGraph(store, base);
  const removedRoutes: string[] = [];
  const registered = new Set<string>();
  for (const file of changes.files)
    if (file.status !== "DELETED")
      for (const route of routesIn(graph, file.path)) registered.add(route);
  for (const file of changes.files)
    if (file.basePath && file.status !== "ADDED")
      for (const route of routesIn(before, file.basePath))
        if (!registered.has(route) && !removedRoutes.includes(route)) removedRoutes.push(route);
  const rewrittenTests: { path: string; names: string[] }[] = [];
  for (const file of changes.files)
    if (file.basePath && file.baseText !== undefined && mapTestPath(file.basePath)) {
      const names = await existingTestsChanged(before, graph, file, input.project);
      if (names.length) rewrittenTests.push({ path: file.path, names });
    }
  const beforeTracer = new Tracer(
    before,
    input.cache.memberCalls(store, base),
    new MapShapeUses(before, input.shapes, input.until),
  );
  const changedIn = changedInBase(changes.files);
  // A file of the base where the working tree has it: none for a deleted file.
  const pathNow = (path: string) => {
    const file = changedIn.get(path);
    return file?.status === "DELETED" ? undefined : (file?.path ?? path);
  };
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
  const removed: { declaration: string; usedBy: Set<string> }[] = [];
  const gone = new Set<string>();
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
        : changeUnits(graph, file.path).map((object) => graph.declarationKey(object)),
    );
    for (const object of changeUnits(before, file.basePath)) {
      if (!renamed && !overlaps(file.baseLines, object.anchor.startLine, object.anchor.endLine))
        continue;
      const kept = now.has(before.declarationKey(object));
      if (kept && !renamed) continue;
      // Only the outermost removed declaration: a removed class, not each of its methods.
      const parent = before.parent(object.id);
      if (parent && !mapIsModule(before.object(parent)) && gone.has(parent)) continue;
      // Code outside it that names it or one of its members, as a removed class's methods are
      // called, or as a subclass extends it.
      const inside = (ref: string) => before.lineage(ref).includes(object.id);
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
      gone.add(object.id);
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
  const lost = new Map<string, Set<string>>();
  const changedAt = changedInWorkingTree(changes.files);
  for (const path of input.mappedPaths().filter(mapMiniprogramTemplate)) {
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
      if (reached === undefined || before.lineage(reached).some((at) => gone.has(at))) continue;
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
  const topLevel: string[] = [];
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
      topLevel.push(file.path);
  }
  if (gone.size) {
    await beforeTracer.trace([...gone], [...gone], true);
    // The base's trace names the base's files and lines. Each is taken to where the working
    // tree has it: a renamed file by its new path, a line by where the diff moved it, and a test
    // file the diff deleted runs nothing. A route the diff removed keeps the base's site.
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
    if (mapIsModule(object) || mapTestPath(object.anchor.path) || gone.has(ref)) continue;
    const path = pathNow(object.anchor.path);
    if (path === undefined) continue;
    const key = before.declarationKey(object);
    const now = graph
      .declarationsAt(path)
      .find((candidate) => graph.declarationKey(candidate) === key);
    if (!now) continue;
    // What the trace read of a field's uses is weighed below, with those of the fields it did not.
    const calls = tracer.callers(now.id).filter((caller) => !caller.uses);
    if (outsideTests(calls, graph).length || tracer.usesWithoutCalls(now.id).length) continue;
    if (!outsideTests(beforeTracer.callers(ref), before).length) continue;
    candidates.push({ path, name: before.qualifiedName(ref), now, tested: calls.length > 0 });
  }
  // A field's other reads are not all in the map; it counts only if a search finds none.
  await tracer.shapes.read(candidates.map(({ now }) => now.id));
  const uncalled: string[] = [];
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

  return {
    removed: removed.map(({ declaration, usedBy }) => ({
      declaration,
      usedBy: [...usedBy].sort(),
    })),
    rewrittenTests,
    removedRoutes,
    uncalled,
    topLevel,
    unclear,
  };
}

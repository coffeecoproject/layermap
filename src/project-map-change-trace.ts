import { LIMITS, type Lines, type MapChangeEntry } from "./project-map-change-types";
import { mapRegisteredRoute } from "./project-map-clients";
import { mapLanguageOf } from "./project-map-language";
import { mapMiniprogramTemplate } from "./project-map-miniprogram";
import { type MapShapeUses, mapIsShape } from "./project-map-shapes";
import {
  type MapAnchor,
  type MapRelation,
  mapRunnableTest,
  mapTestPath,
} from "./project-map-types";
import type { MapViewCache } from "./project-map-view";
import { type MapViewGraph, mapIsModule } from "./project-map-view-graph";

// Following a change up its callers to the entry points and tests that run it.

export const CALLER_KINDS = new Set<MapRelation["kind"]>(["CALLS", "REFERENCES"]);
/** The relations whose source names their target, which removing the target breaks. */
export const NAMING_KINDS = new Set<MapRelation["kind"]>([
  "CALLS",
  "REFERENCES",
  "EXTENDS",
  "IMPLEMENTS",
]);
// The relations to a declaration that use it without calling it, as the user's verb.
const USED_BY: Partial<Record<MapRelation["kind"], string>> = {
  EXTENDS: "extended",
  IMPLEMENTS: "implemented",
  OVERRIDES: "overridden",
};
// An event reaches its handler only where the template binding it is, and that template's own
// relation says so: followed up to the component that emits it, the trace would reach every page
// showing that component.
const runsTarget = (relation: MapRelation) => CALLER_KINDS.has(relation.kind) && !relation.event;
export const IMPORT_KINDS = new Set<MapRelation["kind"]>(["IMPORTS", "TEST_IMPORTS"]);

// A declaration the trace reached, and the one below it on the way from the change; used: it was
// reached by reading or naming a field or type, not by calling; shaped: it was reached from the
// change through such uses alone, so what the change did to a type may have changed it too.
type Reached = {
  ref: string;
  depth: number;
  certain: boolean;
  via?: string;
  used?: boolean;
  shaped?: boolean;
};
// uses: a declaration that reads or names a field or type, which is not known to depend on what
// changed in it, rather than one that calls it. holds: the declaration around a local nothing outside
// tests is seen to call, which is the only way left that it runs.
type Caller = {
  ref: string;
  anchor: MapAnchor;
  route?: string;
  certain: boolean;
  uses?: boolean;
  holds?: boolean;
};
// Where a changed declaration is followed from. own: the declarations whose own code changed, not
// only the locals inside them.
export type ChangeStart = Readonly<{ refs: readonly string[]; own: readonly string[] }>;
const callerFrom = (ref: string, relation: MapRelation, certain: boolean): Caller => ({
  ref,
  anchor: relation.anchor,
  ...(mapRegisteredRoute(relation) ? { route: mapRegisteredRoute(relation) } : {}),
  certain,
});

// The unit a feature lives in: a package in Go and Java, a module (file) elsewhere.
const areaOf = (file: string) =>
  /\.(?:go|java|kt)$/u.test(file) ? file.slice(0, file.lastIndexOf("/") + 1) || "./" : file;

export class Tracer {
  readonly reached = new Map<string, Reached>();
  readonly entries = new Map<string, MapChangeEntry>();
  readonly tests = new Map<string, { names: Set<string>; why: string; rank: number }>();
  /** Tests that certainly call the change, by the area of the declaration they call it through. */
  readonly areas = new Map<string, { through: Set<string>; tests: Map<string, Set<string>> }>();
  readonly unclear: string[] = [];
  truncated = false;
  private readonly callerCount = new Map<string, number>();
  private readonly owners = new Set<string>();
  // Declarations the diff removed that the trace starts from.
  private readonly removed = new Set<string>();
  private readonly known = new Map<string, Caller[]>();
  // Declarations a decorator maps to a route: entry points already, never "top of a chain".
  private readonly routes = new Set<string>();
  /** The declarations each route entry reaches the change through: its handlers. */
  readonly handlers = new Map<string, Set<string>>();
  /**
   * The test files found to request each route, by its label: not those that may request it, as
   * the path a request of theirs is sent to is not worked out.
   */
  readonly requests = new Map<string, Set<string>>();
  /**
   * The test files that may request each route, by its label: they reach the code registering it
   * and send a request whose path is not worked out, by a method the route serves.
   */
  readonly mayRequest = new Map<string, Set<string>>();
  /**
   * The test files whose requests the map does not read, their language's, naming a stretch of
   * each route's path: as far as their text tells, they request it. Unlike a request found, a
   * mention does not hold the route; the trace still climbs on to the app's tests.
   */
  readonly mentions = new Map<string, Set<string>>();
  /**
   * Test support files that call the changed code and that no test is found to call, as fixtures
   * injected by name are: the tests beside and below them may use it.
   */
  readonly support = new Set<string>();
  /**
   * The steps from route handlers to the code registering them, by route, held until the tests
   * requesting each route are looked for: the trace climbs on only for a route none is found to
   * request, where the map cannot tell whether a test requests it.
   */
  readonly held = new Map<string, { current: Reached; caller: Caller }[]>();
  // Routes the trace climbs on from: none is found to request them, and the map cannot tell
  // that none does.
  private readonly released = new Set<string>();
  // The reached declarations whose tests by name and entry points were recorded.
  private readonly finished = new Set<string>();

  constructor(
    private readonly graph: MapViewGraph,
    private readonly memberCalls: ReturnType<MapViewCache["memberCalls"]>,
    /** Who uses the fields and types traced, read as the trace reaches them. */
    readonly shapes: MapShapeUses,
    /**
     * Whether the trace stops at route handlers until the tests requesting each route are looked
     * for (held, then released); only the trace of the change itself looks for them.
     */
    private readonly holdsRoutes = false,
  ) {}

  // The trace walks the declarations relations name, closures and locals among them; a reader sees
  // the addressable declaration around each.
  private name = (ref: string) => this.graph.qualifiedName(this.graph.owner(ref));
  // A module is named by its path alone.
  private where = (ref: string) => {
    const object = this.graph.object(this.graph.owner(ref));
    return mapIsModule(object) ? object.anchor.path : `${object.anchor.path}: ${this.name(ref)}`;
  };

  /**
   * Follows callers up from the given declarations, recording entry points and tests. The code of
   * one in own may flow into its members: the map keeps no reads of its locals, so they may be
   * affected, unlike what calls it. Declarations the diff removed are no entry point, and nothing
   * calling one says nothing of how it is reached.
   */
  async trace(starts: readonly string[], own: readonly string[] = [], removed = false) {
    const frontier: Reached[] = [];
    for (const ref of starts)
      if (!this.reached.has(ref)) {
        if (removed) this.removed.add(ref);
        const start = { ref, depth: 0, certain: true, shaped: true };
        this.reached.set(ref, start);
        this.owners.add(this.graph.owner(ref));
        frontier.push(start);
      }
    for (const start of frontier)
      for (const ref of new Set([start.ref, this.graph.owner(start.ref)])) this.byName(ref);
    // Uncertain steps wait until every certain path has been walked: a declaration both reach,
    // however much shorter the uncertain way, is certainly affected.
    const uncertain: { current: Reached; caller: Caller }[] = [];
    for (const ref of own) {
      const current = this.reached.get(ref);
      if (current)
        for (const member of this.members(ref))
          uncertain.push({
            current,
            caller: { ref: member, anchor: this.graph.object(member).anchor, certain: false },
          });
    }
    await this.walk(frontier, uncertain);
  }

  /** Climbs on from the handlers of these routes to the code registering them, and above. */
  async release(routes: Iterable<string>) {
    const frontier: Reached[] = [];
    const uncertain: { current: Reached; caller: Caller }[] = [];
    for (const route of routes) {
      this.released.add(route);
      for (const { current, caller } of this.held.get(route) ?? [])
        if (current.certain && caller.certain) frontier.push(...this.step(current, caller, true));
        else uncertain.push({ current, caller });
      this.held.delete(route);
    }
    await this.walk(frontier, uncertain);
  }

  private async walk(
    frontier: Reached[],
    uncertain: { current: Reached; caller: Caller }[],
  ): Promise<void> {
    while (frontier.length || uncertain.length) {
      if (!frontier.length)
        frontier = uncertain
          .splice(0)
          .flatMap(({ current, caller }) => this.step(current, caller, false));
      const next: Reached[] = [];
      // A field's value flows to the code reading it. A type exists only for the compiler: who names
      // it depends on the change only when the change altered it, not when a value it describes did.
      await this.shapes.read(
        frontier
          .filter(({ ref, shaped }) => {
            const object = this.graph.object(ref);
            // What a local's field or type is used for stays inside the declaration around it.
            return (
              this.graph.isAddressable(object) &&
              !mapTestPath(object.anchor.path) &&
              (shaped || object.kind === "PROPERTY")
            );
          })
          .map(({ ref }) => ref),
      );
      for (const current of frontier) {
        const object = this.graph.object(current.ref);
        if (mapTestPath(object.anchor.path)) continue;
        this.decoratorRoutes(current);
        const callers = this.callers(current.ref);
        this.callerCount.set(current.ref, callers.length);
        for (const caller of callers) {
          const site = `${caller.anchor.path}:${caller.anchor.startLine}`;
          const certain = current.certain && caller.certain;
          if (caller.route) this.entry(caller.route, true, current, site, certain);
          const callerObject = this.graph.object(caller.ref);
          if (mapTestPath(callerObject.anchor.path)) {
            const entries = testEntries(this.graph, this.graph.owner(caller.ref));
            // Test support no test calls (conftest.py fixtures, setup files, module-level code)
            // reaches its tests by injection, which the map does not see: any test beside it may
            // use it. A helper tests call stands for those tests alone.
            if (!entries.length) this.support.add(callerObject.anchor.path);
            for (const [file, name] of entries) {
              this.test(
                file,
                name,
                `${caller.uses ? "uses" : "calls"} ${this.name(current.ref)}`,
                // Tests closer to the change come first; all of them rank before other relations.
                current.depth / 10,
              );
              if (certain) this.area(current.ref, file, name);
            }
            continue;
          }
          // The framework runs a handler when its route is requested: the tests requesting the
          // route run the change, not every test building the app that registers it.
          const route = caller.route;
          if (route && this.holdsRoutes && !this.released.has(route)) {
            this.held.set(route, [...(this.held.get(route) ?? []), { current, caller }]);
            continue;
          }
          if (certain) next.push(...this.step(current, caller, true));
          else uncertain.push({ current, caller });
        }
      }
      frontier = next;
    }
    // Tests that call a reached method's name on a receiver of unknown type, as untyped Python and
    // JavaScript tests do (client.get, request.url_for): they may run it. A name called too often
    // by name says nothing, so such names are left to the CHECK BY HAND count.
    const reachedNow = [...this.reached.values()].filter(({ ref }) => !this.finished.has(ref));
    for (const reached of reachedNow) this.finished.add(reached.ref);
    for (const reached of reachedNow) {
      const object = this.graph.object(reached.ref);
      const language = mapLanguageOf(object.anchor.path);
      if (object.kind !== "METHOD" || !language || /^__\w+__$/u.test(object.name)) continue;
      const calls = this.memberCalls.get(`${language}\u0000${object.name}`) ?? [];
      if (calls.length > LIMITS.byName) continue;
      for (const call of calls)
        if (mapTestPath(call.path))
          this.test(
            call.path,
            this.name(this.graph.owner(call.from)),
            `may call ${this.graph.qualifiedName(reached.ref)} through a receiver of unknown type`,
            3.5,
          );
    }
    // Declarations nothing calls are where the chains start: commands, jobs, framework-wired
    // handlers, or code that is not used. Routes already name the more useful entry points.
    for (const reached of reachedNow) {
      if (
        this.callerCount.get(reached.ref) !== 0 ||
        this.shapes.unread.has(reached.ref) ||
        this.removed.has(reached.ref)
      )
        continue;
      const object = this.graph.object(reached.ref);
      if (mapTestPath(object.anchor.path) || this.routes.has(reached.ref)) continue;
      // A page's template that changed is the entry itself: the page shows it.
      if (reached.depth === 0 && !mapMiniprogramTemplate(object.anchor.path)) {
        const uses = this.usesWithoutCalls(reached.ref);
        this.unclear.push(
          uses.length
            ? `${this.where(reached.ref)} has no callers in the map, and is used without a call: ${uses.join("; ")}`
            : mapIsShape(object)
              ? `${this.where(reached.ref)} has no callers in the map, and a search for references found no use: it may be read through reflection, serialization or a value of unknown type, or be unused`
              : `${this.where(reached.ref)} has no callers in the map: it may be wired by a framework, called dynamically, or unused`,
        );
        // Nothing runs from a type, or from a field that only uses another field or type. A field
        // that holds a function others call by key is an entry point.
      } else if (!mapIsShape(object) || (!reached.used && object.kind === "PROPERTY"))
        this.entry(this.where(reached.ref), false, reached, undefined, reached.certain, true);
    }
  }

  private step(current: Reached, caller: Caller, certain: boolean): Reached[] {
    const known = this.reached.get(caller.ref);
    if (known) {
      // Whichever came first, what a call also reaches does more than use the change.
      if (!caller.uses) known.used = false;
      // What a value reached first and uses alone reach too goes on, now with its own uses.
      if (!caller.uses || !current.shaped || known.shaped) return [];
      known.shaped = true;
      this.known.delete(caller.ref);
      return [known];
    }
    const depth = this.climb(current.ref, caller.ref, current.depth, this.owners);
    if (depth === undefined) {
      this.truncated = true;
      return [];
    }
    const reached = {
      ref: caller.ref,
      depth,
      certain,
      via: current.ref,
      ...(caller.uses ? { used: true, ...(current.shaped ? { shaped: true } : {}) } : {}),
    };
    this.reached.set(caller.ref, reached);
    return [reached];
  }

  // The depth of a step from one declaration to another, unless it passes the trace's limits. The
  // limits count what a reader sees: moving between the locals of one declaration climbs nothing.
  private climb(from: string, to: string, depth: number, owners: Set<string>) {
    const owner = this.graph.owner(to);
    const next = depth + (owner === this.graph.owner(from) ? 0 : 1);
    if (next > LIMITS.depth || (!owners.has(owner) && owners.size >= LIMITS.declarations))
      return undefined;
    owners.add(owner);
    return next;
  }

  // Whether a relation starts in the declaration, not in an addressable declaration inside it.
  private within(from: string, ref: string) {
    for (let at: string | undefined = from; at !== undefined; at = this.graph.parent(at)) {
      if (at === ref) return true;
      if (this.graph.isAddressable(this.graph.object(at))) return false;
    }
    return false;
  }

  /**
   * The locals of a declaration that code outside it calls, as the methods of the object a factory
   * returns. Fields and types are read by name, not called, so they have none.
   */
  members(ref: string): string[] {
    const object = this.graph.object(ref);
    if (mapIsModule(object) || mapIsShape(object)) return [];
    return this.graph
      .scope(ref)
      .refs.slice(1)
      .filter((local) =>
        this.callers(local).some((caller) => this.graph.owner(caller.ref) !== ref),
      );
  }

  /**
   * Where a change on the lines of a declaration is followed from: the innermost local around each
   * line that runs apart from it, as a function does or as what others call does, and the declaration
   * itself for lines in none. Fields and types change as a whole.
   */
  startsAt(ref: string, lines: Lines): ChangeStart {
    const object = this.graph.object(ref);
    if (mapIsModule(object) || mapIsShape(object)) return { refs: [ref], own: [] };
    const locals = this.graph
      .scope(ref)
      .refs.slice(1)
      .map((local) => this.graph.object(local))
      .filter((local) => local.execution || this.callers(local.id).some((caller) => !caller.holds));
    const refs = new Set<string>();
    let own = false;
    const at = (from: number, to: number) => {
      const around = locals.filter(
        (local) => local.anchor.startLine <= to && from <= local.anchor.endLine,
      );
      for (const local of around)
        if (
          !around.some(
            (other) =>
              other !== local &&
              local.anchor.start <= other.anchor.start &&
              other.anchor.end <= local.anchor.end,
          )
        )
          refs.add(local.id);
      if (!around.length) own = true;
    };
    for (const [from, to] of lines) {
      // A pure deletion is the point between two lines, around which only code containing both is.
      if (from > to) {
        if (object.anchor.startLine <= to && from <= object.anchor.endLine) at(from, to);
        continue;
      }
      const last = Math.min(to, object.anchor.endLine);
      for (let line = Math.max(from, object.anchor.startLine); line <= last; line++) at(line, line);
    }
    if (own) refs.add(ref);
    return { refs: [...refs], own: own ? [ref] : [] };
  }

  /**
   * The uses outside tests the map sees of a declaration besides calls: a class others extend or
   * implement, a member that overrides another or that others override, and a decorator that may
   * wire it to be run (a route, a task, a registry). A decorator of the language's own library
   * (dataclass, staticmethod) only shapes the declaration. Reading a value of module state is a
   * reference, so a caller; writing one is not a use, as a value nothing reads is unused.
   */
  usesWithoutCalls(ref: string): string[] {
    const uses: string[] = [];
    for (const relation of this.graph.relationsTo([ref])) {
      const verb = USED_BY[relation.kind];
      const owner = this.graph.owner(relation.from);
      if (verb && owner !== ref && !mapTestPath(this.graph.object(owner).anchor.path))
        uses.push(`${verb} by ${this.where(owner)}`);
    }
    for (const relation of this.graph.relationsFrom([ref]))
      if (relation.kind === "OVERRIDES")
        uses.push(
          `overrides ${relation.to === undefined ? relation.target : this.where(this.graph.owner(relation.to))}`,
        );
      else if (relation.kind === "DECORATED_BY" && relation.unresolvedReason !== "COMPILER_LIBRARY")
        uses.push(`decorated by ${relation.target}`);
    return [...new Set(uses)];
  }

  /**
   * How code in the files runs each declaration: "call" when it calls it, directly or through other
   * code (their module-scope code counts, and other test code is passed through); "route" when it
   * does not, but one of the handlers is the declaration or calls it. Callers are followed from all
   * the declarations at once, as the trace follows them, and what reaches a caller reaches what it
   * calls. `by` names, for each declaration reached, the files that run it: those calling it, and
   * those requesting a route of a handler it is or that calls it. Steps from a handler up to the
   * code registering its route are not followed where `heldOnly` is given and the trace held them:
   * that code runs the route only for tests requesting it.
   */
  reach(
    refs: readonly string[],
    files: ReadonlySet<string>,
    handlers: ReadonlyMap<string, ReadonlySet<string>>,
    heldOnly = false,
  ): {
    how: Map<string, "call" | "route">;
    by: Map<string, Set<string>>;
    truncated: boolean;
  } {
    const how = new Map<string, "call" | "route">();
    const by = new Map<string, Set<string>>();
    const runBy = (ref: string, file: string) => by.set(ref, (by.get(ref) ?? new Set()).add(file));
    const held = new Set(
      heldOnly
        ? [...this.held.values()].flatMap((steps) =>
            steps.map(({ current, caller }) => `${current.ref}\u0000${caller.ref}`),
          )
        : [],
    );
    const below = new Map<string, string[]>();
    const depths = new Map(refs.map((ref) => [ref, 0]));
    const owners = new Set(refs.map((ref) => this.graph.owner(ref)));
    let truncated = false;
    let frontier = [...depths.keys()];
    while (frontier.length) {
      const next: string[] = [];
      for (const current of frontier) {
        const requesting = handlers.get(current);
        if (requesting) {
          how.set(current, "route");
          for (const file of requesting) runBy(current, file);
        }
        for (const caller of this.callers(current)) {
          if (held.has(`${current}\u0000${caller.ref}`)) continue;
          const file = this.graph.object(caller.ref).anchor.path;
          if (files.has(file)) {
            how.set(current, "call");
            runBy(current, file);
            continue;
          }
          const callees = below.get(caller.ref);
          if (callees) callees.push(current);
          else below.set(caller.ref, [current]);
          if (depths.has(caller.ref)) continue;
          const depth = this.climb(current, caller.ref, depths.get(current) ?? 0, owners);
          if (depth === undefined) {
            truncated = true;
            continue;
          }
          depths.set(caller.ref, depth);
          next.push(caller.ref);
        }
      }
      frontier = next;
    }
    // A call reaches down first, so a declaration a route also reaches still counts as called.
    for (const kind of ["call", "route"] as const) {
      const pending = [...how].filter(([, found]) => found === kind).map(([ref]) => ref);
      for (let ref = pending.pop(); ref !== undefined; ref = pending.pop())
        for (const callee of below.get(ref) ?? [])
          if (!how.has(callee)) {
            how.set(callee, kind);
            pending.push(callee);
          }
    }
    // What runs a caller runs what it calls.
    const pending = [...by.keys()];
    for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
      const running = by.get(ref) ?? new Set<string>();
      for (const callee of below.get(ref) ?? []) {
        const known = by.get(callee) ?? new Set<string>();
        const before = known.size;
        for (const file of running) known.add(file);
        if (known.size === before) continue;
        by.set(callee, known);
        pending.push(callee);
      }
    }
    return { how, by, truncated };
  }

  callers(ref: string): Caller[] {
    const known = this.known.get(ref);
    if (known) return known;
    const callers: Caller[] = [];
    for (const relation of this.graph.relationsTo([ref]))
      if (runsTarget(relation) && !this.within(relation.from, ref))
        callers.push(callerFrom(relation.from, relation, true));
    // Who reads or names a field or type: what changes in it may or may not matter to them.
    for (const use of this.shapes.uses.get(ref) ?? [])
      callers.push({ ref: use.owner, anchor: use.anchor, certain: false, uses: true });
    // Members the language runs without naming them run wherever their class is used: a
    // constructor where it is instantiated, a special method (__call__, __aenter__, __getitem__)
    // through syntax, a decorated property when it is read. The class's users are their callers too.
    const object = this.graph.object(ref);
    const parent = this.graph.parent(ref);
    const constructs =
      object.execution === "CONSTRUCTOR" ||
      object.name === "__init__" ||
      object.name === "constructor";
    if (parent && this.graph.object(parent).kind === "CLASS") {
      const implicit =
        constructs ||
        /^__\w+__$/u.test(object.name) ||
        this.graph
          .relationsFrom([ref])
          .some(
            (relation) => relation.kind === "DECORATED_BY" && /property$/u.test(relation.target),
          );
      // Only a call of the class certainly constructs it; a class passed as a value (a factory,
      // functools.partial, isinstance) may construct it or not.
      if (implicit)
        for (const relation of this.graph.relationsTo([parent]))
          if (
            runsTarget(relation) &&
            !this.within(relation.from, ref) &&
            !this.within(relation.from, parent)
          )
            callers.push(
              callerFrom(relation.from, relation, constructs && relation.kind === "CALLS"),
            );
    }
    const local = !this.graph.isAddressable(object);
    // A call through an interface or base member may reach this implementation, or another;
    // with no other implementation in the project, it reaches this one. A constructor is not
    // dispatched: the base's constructor, or super().__init__ in a sibling class, never runs it.
    // A local implementation is made by the code around it and handed on, as an option's callback
    // is: where running code has several, a call of the contract says nothing of whose it runs, and
    // following it would reach everything using that contract, so it runs through what holds it.
    // Test doubles run in no running code, so they do not make it one of several.
    if (!constructs)
      for (const override of this.graph.relationsFrom([ref]))
        if (override.kind === "OVERRIDES" && override.to !== undefined) {
          const contract = override.to;
          const relations = this.graph.relationsTo([contract]);
          const only =
            relations.filter(
              (relation) =>
                relation.kind === "OVERRIDES" && !(local && mapTestPath(relation.anchor.path)),
            ).length === 1;
          if (local && !only) continue;
          for (const relation of relations)
            if (runsTarget(relation) && !this.within(relation.from, ref))
              callers.push(callerFrom(relation.from, relation, only));
        }
    // A local nothing is seen to call runs through what holds it: a callback through the code passing
    // it, a method of the object a factory returns through whoever gets that object. Called only by
    // tests, it may still run that way, through a call the map could not resolve.
    // A handler registered under a route runs when the route is requested, as its calls, which carry
    // the route, say.
    if (
      parent &&
      local &&
      callers.every((caller) => mapTestPath(this.graph.object(caller.ref).anchor.path))
    ) {
      const route = this.graph
        .relationsFrom([ref])
        .map(mapRegisteredRoute)
        .find((found) => found !== undefined);
      callers.push({
        ref: parent,
        anchor: object.anchor,
        certain: callers.length === 0,
        holds: true,
        ...(route ? { route } : {}),
      });
    }
    this.known.set(ref, callers);
    return callers;
  }

  private decoratorRoutes(current: Reached) {
    for (const relation of this.graph.relationsFrom([current.ref])) {
      if (relation.kind !== "DECORATED_BY") continue;
      const route = mapRegisteredRoute(relation);
      if (!route) continue;
      this.routes.add(current.ref);
      this.entry(
        route,
        true,
        current,
        `${relation.anchor.path}:${relation.anchor.startLine}`,
        current.certain,
      );
    }
  }

  // Calls of a method's name on receivers of unknown type may reach it; they are only counted.
  private byName(ref: string) {
    const object = this.graph.object(ref);
    const language = mapLanguageOf(object.anchor.path);
    if (object.kind !== "METHOD" || !language || /^__\w+__$/u.test(object.name)) return;
    const calls = this.memberCalls.get(`${language}\u0000${object.name}`) ?? [];
    if (calls.length)
      this.unclear.push(
        `${calls.length} calls of a member named ${object.name} on receivers of unknown type may reach ${this.graph.qualifiedName(ref)}; a text search finds them`,
      );
  }

  private entry(
    label: string,
    route: boolean,
    at: Reached,
    site: string | undefined,
    certain: boolean,
    top = false,
  ) {
    if (route) this.handlers.set(label, (this.handlers.get(label) ?? new Set()).add(at.ref));
    const chain: string[] = [];
    // The chain runs from the declaration the entry reaches toward the change, each declaration once
    // however many of its locals the trace passed; a declaration at the top of a chain is the entry
    // itself, so its chain starts below it.
    let shown = top ? this.graph.owner(at.ref) : undefined;
    let step: Reached | undefined = at;
    for (; step && chain.length < LIMITS.chain; ) {
      const owner = this.graph.owner(step.ref);
      if (owner !== shown) chain.push(this.name(owner));
      shown = owner;
      step = step.via ? this.reached.get(step.via) : undefined;
    }
    const known = this.entries.get(label);
    if (known && (known.certain || !certain)) return;
    this.entries.set(label, { label, route, chain, ...(site ? { site } : {}), certain });
  }

  private area(ref: string, test: string, name: string | undefined) {
    this.shareArea(
      areaOf(this.graph.object(ref).anchor.path),
      [this.name(ref)],
      test,
      name && !name.startsWith("<") ? [name] : [],
    );
  }

  /** A test certainly calling the change through these declarations of an area. */
  shareArea(area: string, through: Iterable<string>, test: string, names: Iterable<string>) {
    const known = this.areas.get(area) ?? { through: new Set<string>(), tests: new Map() };
    for (const name of through) known.through.add(name);
    const into = known.tests.get(test) ?? new Set<string>();
    for (const name of names) into.add(name);
    known.tests.set(test, into);
    this.areas.set(area, known);
  }

  /** A test file found to request a route, or that may: its request's path is not worked out. */
  requester(route: string, file: string, maybe = false) {
    const into = maybe ? this.mayRequest : this.requests;
    into.set(route, (into.get(route) ?? new Set()).add(file));
  }

  /** A test file whose requests the map does not read naming a stretch of a route's path. */
  mentioner(route: string, file: string) {
    this.mentions.set(route, (this.mentions.get(route) ?? new Set()).add(file));
  }

  /** A related test file; the closest relation (lowest rank) explains it. */
  test(path: string, name: string | undefined, why: string, rank: number) {
    // Fixtures, helpers and conftest files support tests but are not run on their own.
    if (!mapRunnableTest(path)) return;
    const known = this.tests.get(path) ?? { names: new Set<string>(), why, rank };
    if (rank < known.rank) Object.assign(known, { why, rank });
    if (name && !name.startsWith("<")) known.names.add(name);
    this.tests.set(path, known);
  }
}

// The runnable tests that run a declaration of test code: the tests themselves, which the runner
// calls and no test code does, and for a helper, even one in a test file (Go's setupRouter, a
// Python _client()), the tests calling it, a few calls up. A helper no test is found to call is
// kept as it is, in its file.
const entriesOf = new WeakMap<MapViewGraph, Map<string, [string, string][]>>();
export function testEntries(graph: MapViewGraph, ref: string): [string, string][] {
  let known = entriesOf.get(graph);
  if (!known) {
    known = new Map();
    entriesOf.set(graph, known);
  }
  let entries = known.get(ref);
  if (!entries) {
    entries = findTestEntries(graph, ref);
    known.set(ref, entries);
  }
  return entries;
}
function findTestEntries(graph: MapViewGraph, ref: string): [string, string][] {
  const found: [string, string][] = [];
  const kept: [string, string][] = [];
  const entry = (at: string): [string, string] => [
    graph.object(at).anchor.path,
    graph.qualifiedName(at),
  ];
  const seen = new Set([ref]);
  let level = [ref];
  for (let depth = 0; level.length; depth++) {
    const next: string[] = [];
    for (const at of level) {
      const object = graph.object(at);
      const runnable = mapRunnableTest(object.anchor.path);
      const callers = mapIsModule(object)
        ? []
        : graph
            .relationsTo([at])
            .filter(runsTarget)
            .map((relation) => graph.owner(relation.from))
            .filter((caller) => caller !== at && mapTestPath(graph.object(caller).anchor.path));
      if (!callers.length || depth === 4) {
        if (runnable) found.push(entry(at));
        continue;
      }
      if (runnable) kept.push(entry(at));
      for (const caller of callers)
        if (!seen.has(caller)) {
          seen.add(caller);
          next.push(caller);
        }
    }
    level = next;
  }
  return found.length ? found : kept;
}

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CodeIndexStore } from "./code-index-store";
import { ProjectEvidenceError } from "./core";
import { GitRunner } from "./git-runner";
import { mapLanguageOf } from "./project-map-language";
import { type MapStrandedName, strandedNameLine, strandedNames } from "./project-map-names";
import { type MapObject, type MapRelation, mapTestPath } from "./project-map-types";
import { MapViewCache } from "./project-map-view";
import { MapViewGraph, mapDeclarationLabel, mapIsModule } from "./project-map-view-graph";

// "What does this change affect?": the declarations a diff touches, the entry points and tests
// their callers reach, and what a static map cannot see. It borrows test impact analysis practice:
// tests are chosen by file (call paths only explain them), an import graph backs up the call
// graph, and anything uncertain is named rather than ruled out.

/** Inclusive 1-based line ranges. */
type Lines = readonly (readonly [number, number])[];

export type MapChangedFile = Readonly<{
  /** Path in the working tree; for a deleted file, its path in the base. */
  path: string;
  /** Path in the base, when the file existed there. */
  basePath?: string;
  status: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";
  /** Lines added or changed in the working tree; a pure deletion marks the lines around it. */
  lines: Lines;
  /** Lines removed or changed in the base. */
  baseLines: Lines;
  binary: boolean;
  /** A changed test file's text in the base, to tell which of its existing tests changed. */
  baseText?: string;
}>;

export type MapChanges = Readonly<{
  base: string;
  commit: string;
  files: readonly MapChangedFile[];
  /** Environment variables and configuration keys the diff removed that other files still use. */
  stranded: readonly MapStrandedName[];
}>;

const git = new GitRunner();
const gitOptions = (cwd: string, signal: AbortSignal) => ({
  cwd,
  signal,
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
});
const EVERYTHING: readonly [number, number] = [1, Number.MAX_SAFE_INTEGER];

/** The commit a base (a commit, branch or tag) names. */
export async function resolveMapBase(
  project: string,
  base: string,
  signal: AbortSignal,
): Promise<string> {
  if (!/^[\w./@^~-]{1,200}$/u.test(base) || base.startsWith("-"))
    throw new ProjectEvidenceError("LAYERMAP_BASE_INVALID", false);
  let commit: string;
  try {
    commit = (
      await git.run(
        ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
        gitOptions(project, signal),
      )
    ).stdout
      .toString()
      .trim();
  } catch {
    throw new ProjectEvidenceError("LAYERMAP_BASE_NOT_FOUND", false);
  }
  if (!/^[a-f0-9]{40,64}$/u.test(commit))
    throw new ProjectEvidenceError("LAYERMAP_BASE_NOT_FOUND", false);
  return commit;
}

/** The working tree's changes against a commit: tracked files from git diff, plus untracked files. */
export async function readMapChanges(
  project: string,
  base: string,
  signal: AbortSignal,
): Promise<MapChanges> {
  const commit = await resolveMapBase(project, base, signal);
  const diff = (
    await git.run(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=0",
        "-M",
        commit,
        "--",
      ],
      gitOptions(project, signal),
    )
  ).stdout.toString("utf8");
  const files = parseMapDiff(diff);
  for (const [index, file] of files.entries())
    if (file.basePath && file.status !== "ADDED" && !file.binary && testCode(file.basePath))
      files[index] = {
        ...file,
        baseText: (
          await git.run(["show", `${commit}:${file.basePath}`], gitOptions(project, signal))
        ).stdout.toString("utf8"),
      };
  const untracked = (
    await git.run(["ls-files", "--others", "--exclude-standard", "-z"], gitOptions(project, signal))
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const path of untracked)
    files.push({ path, status: "ADDED", lines: [EVERYTHING], baseLines: [], binary: false });
  const stranded = await strandedNames(
    project,
    diff,
    files,
    (file) => nonCodeKind(file) === "configuration",
    git,
    gitOptions(project, signal),
  );
  return { base, commit, files, stranded };
}

/** Files and changed line ranges from `git diff --unified=0 -M`. */
export function parseMapDiff(text: string): MapChangedFile[] {
  const files: MapChangedFile[] = [];
  type Draft = {
    path: string;
    basePath?: string;
    status: MapChangedFile["status"];
    lines: [number, number][];
    baseLines: [number, number][];
    binary: boolean;
  };
  let current: Draft | undefined;
  const finish = () => {
    if (!current) return;
    // A path quoted by git (tabs, newlines) cannot be matched to the map; it is left out.
    if (!current.path.startsWith('"')) files.push(current);
    current = undefined;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      current = {
        path: match?.[2] ?? "",
        basePath: match?.[1] ?? "",
        status: "MODIFIED",
        lines: [],
        baseLines: [],
        binary: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.status = "ADDED";
      current.basePath = undefined;
    } else if (line.startsWith("deleted file mode")) {
      current.status = "DELETED";
      current.path = current.basePath ?? current.path;
    } else if (line.startsWith("rename from ")) {
      current.status = "RENAMED";
      current.basePath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) current.binary = true;
    else if (line.startsWith("@@ ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (!hunk) continue;
      const [oldStart, oldCount, newStart, newCount] = [
        Number(hunk[1]),
        hunk[2] === undefined ? 1 : Number(hunk[2]),
        Number(hunk[3]),
        hunk[4] === undefined ? 1 : Number(hunk[4]),
      ];
      if (oldCount > 0) current.baseLines.push([oldStart, oldStart + oldCount - 1]);
      // Lines removed with nothing added in their place change the code around that point.
      current.lines.push(
        newCount > 0 ? [newStart, newStart + newCount - 1] : [Math.max(newStart, 1), newStart + 1],
      );
    }
  }
  finish();
  return files;
}

// Test code, including shared test fixtures that Gradle keeps in src/testFixtures.
const testCode = (file: string) => mapTestPath(file) || /(?:^|\/)testFixtures\//u.test(file);

const overlaps = (lines: Lines, start: number, end: number) =>
  lines.some(([from, to]) => from <= end && start <= to);

// Files whose effects a code map cannot follow: configuration, dependencies, builds, schemas,
// templates. A change to one widens what to check, as test impact tools run more when it happens.
const NON_CODE: readonly (readonly [RegExp, string])[] = [
  [
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|gradle\.lockfile)$/u,
    "dependency lock file",
  ],
  [
    /(?:^|\/)(?:package\.json|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Makefile|Dockerfile|tsconfig[^/]*\.json)$/u,
    "build or dependency file",
  ],
  [/(?:^|\/)migrations?\/|\.sql$/iu, "database migration or schema"],
  [/(?:^|\/)\.env[^/]*$|\.(?:ya?ml|toml|ini|properties|conf|cfg)$/iu, "configuration"],
  [/\.(?:html?|jinja2?|j2|hbs|ejs|tmpl|tpl|gohtml|vue|svelte)$/iu, "template"],
];
const nonCodeKind = (path: string) => NON_CODE.find(([pattern]) => pattern.test(path))?.[1];

export type MapChangeEntry = Readonly<{
  /** The route, or the declaration at the top of a call chain. */
  label: string;
  route: boolean;
  /** "via" chain from the entry down toward the changed declaration, a few hops at most. */
  chain: readonly string[];
  site?: string;
  certain: boolean;
}>;

export type MapChangeImpact = Readonly<{
  changed: readonly string[];
  removed: readonly string[];
  /** Existing tests whose code the diff changed or removed: expectations that held before it. */
  rewrittenTests: readonly Readonly<{ path: string; names: readonly string[] }>[];
  entries: readonly MapChangeEntry[];
  /** Related test files, closest first: rank 0 calls the change ... 4 imports it indirectly. */
  tests: readonly Readonly<{ path: string; names: readonly string[]; why: string; rank: number }>[];
  /**
   * The areas (a Go or Java package, another language's file) whose code the tests call the change
   * through, with those tests: more than one means the changed code serves several features.
   */
  areas: readonly Readonly<{
    area: string;
    through: readonly string[];
    tests: readonly Readonly<{ path: string; names: readonly string[] }>[];
  }>[];
  unclear: readonly string[];
  truncated: boolean;
}>;

const LIMITS = Object.freeze({ depth: 8, declarations: 800, changed: 200, chain: 3, byName: 40 });
const CALLER_KINDS = new Set<MapRelation["kind"]>(["CALLS", "REFERENCES"]);
const IMPORT_KINDS = new Set<MapRelation["kind"]>(["IMPORTS", "TEST_IMPORTS"]);
// A literal is a route when it is a path, optionally after its methods: "/x", "GET|POST /x".
const ROUTE = /^(?:[A-Z]+(?:\|[A-Z]+)* +)?\/\S*$/u;

// A declaration the trace reached, and the one below it on the way from the change.
type Reached = { ref: string; depth: number; certain: boolean; via?: string };

// The unit a feature lives in: a package in Go and Java, a module (file) elsewhere.
const areaOf = (file: string) =>
  /\.(?:go|java|kt)$/u.test(file) ? file.slice(0, file.lastIndexOf("/") + 1) || "./" : file;

class Tracer {
  readonly reached = new Map<string, Reached>();
  readonly entries = new Map<string, MapChangeEntry>();
  readonly tests = new Map<string, { names: Set<string>; why: string; rank: number }>();
  /** Tests that certainly call the change, by the area of the declaration they call it through. */
  readonly areas = new Map<string, { through: Set<string>; tests: Map<string, Set<string>> }>();
  readonly unclear: string[] = [];
  truncated = false;
  private readonly callerCount = new Map<string, number>();
  // Declarations a decorator maps to a route: entry points already, never "top of a chain".
  private readonly routes = new Set<string>();
  /** Test support files that call the changed code; the tests beside and below them may use it. */
  readonly support = new Set<string>();

  constructor(
    private readonly graph: MapViewGraph,
    private readonly memberCalls: ReturnType<MapViewCache["memberCalls"]>,
  ) {}

  private name = (ref: string) => this.graph.qualifiedName(ref);
  private where = (ref: string) => {
    const object = this.graph.object(ref);
    return `${object.anchor.path}: ${this.name(ref)}`;
  };

  /** Follows callers up from the given declarations, recording entry points and tests. */
  trace(starts: readonly string[]) {
    let frontier: Reached[] = [];
    for (const ref of starts)
      if (!this.reached.has(ref)) {
        const start = { ref, depth: 0, certain: true };
        this.reached.set(ref, start);
        frontier.push(start);
      }
    for (const start of frontier) this.byName(start.ref);
    while (frontier.length) {
      const next: Reached[] = [];
      for (const current of frontier) {
        const object = this.graph.object(current.ref);
        if (testCode(object.anchor.path)) continue;
        this.decoratorRoutes(current);
        const callers = this.callers(current.ref);
        this.callerCount.set(current.ref, callers.length);
        for (const caller of callers) {
          const site = `${caller.relation.anchor.path}:${caller.relation.anchor.startLine}`;
          const certain = current.certain && caller.certain;
          if (caller.relation.argument && ROUTE.test(caller.relation.argument))
            this.entry(caller.relation.argument, true, current, site, certain);
          const callerObject = this.graph.object(caller.ref);
          if (testCode(callerObject.anchor.path)) {
            // Test support (conftest.py, fixtures, helpers) reaches tests by injection or import.
            if (!mapRunnableTest(callerObject.anchor.path))
              this.support.add(callerObject.anchor.path);
            this.test(
              callerObject.anchor.path,
              this.name(caller.ref),
              `calls ${this.name(current.ref)}`,
              // Tests closer to the change come first; all of them rank before other relations.
              current.depth / 10,
            );
            if (certain && mapRunnableTest(callerObject.anchor.path))
              this.area(current.ref, callerObject.anchor.path, this.name(caller.ref));
            continue;
          }
          if (this.reached.has(caller.ref)) continue;
          if (current.depth + 1 > LIMITS.depth || this.reached.size >= LIMITS.declarations) {
            this.truncated = true;
            continue;
          }
          const reached = { ref: caller.ref, depth: current.depth + 1, certain, via: current.ref };
          this.reached.set(caller.ref, reached);
          next.push(reached);
        }
      }
      frontier = next;
    }
    // Tests that call a reached method's name on a receiver of unknown type, as untyped Python and
    // JavaScript tests do (client.get, request.url_for): they may run it. A name called too often
    // by name says nothing, so such names are left to the CHECK BY HAND count.
    for (const reached of this.reached.values()) {
      const object = this.graph.object(reached.ref);
      const language = mapLanguageOf(object.anchor.path);
      if (object.kind !== "METHOD" || !language || /^__\w+__$/u.test(object.name)) continue;
      const calls = this.memberCalls.get(`${language}\u0000${object.name}`) ?? [];
      if (calls.length > LIMITS.byName) continue;
      for (const call of calls)
        if (testCode(call.path))
          this.test(
            call.path,
            this.name(this.graph.owner(call.from)),
            `may call ${this.name(reached.ref)} through a receiver of unknown type`,
            3.5,
          );
    }
    // Declarations nothing calls are where the chains start: commands, jobs, framework-wired
    // handlers, or code that is not used. Routes already name the more useful entry points.
    for (const reached of this.reached.values()) {
      if (this.callerCount.get(reached.ref) !== 0) continue;
      const object = this.graph.object(reached.ref);
      if (testCode(object.anchor.path) || this.routes.has(reached.ref)) continue;
      if (reached.depth === 0)
        this.unclear.push(
          `${this.where(reached.ref)} has no callers in the map: it may be wired by a framework, called dynamically, or unused`,
        );
      else this.entry(this.where(reached.ref), false, reached, undefined, reached.certain, true);
    }
  }

  private callers(ref: string): { ref: string; relation: MapRelation; certain: boolean }[] {
    const callers: { ref: string; relation: MapRelation; certain: boolean }[] = [];
    for (const relation of this.graph.relationsTo([ref]))
      if (CALLER_KINDS.has(relation.kind)) {
        const owner = this.graph.owner(relation.from);
        if (owner !== ref) callers.push({ ref: owner, relation, certain: true });
      }
    // Members the language runs without naming them run wherever their class is used: a
    // constructor where it is instantiated, a special method (__call__, __aenter__, __getitem__)
    // through syntax, a property when it is read. The class's users are their callers too.
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
        object.kind === "PROPERTY" ||
        this.graph
          .relationsFrom([ref])
          .some(
            (relation) => relation.kind === "DECORATED_BY" && /property$/u.test(relation.target),
          );
      // Only a call of the class certainly constructs it; a class passed as a value (a factory,
      // functools.partial, isinstance) may construct it or not.
      if (implicit)
        for (const relation of this.graph.relationsTo([parent]))
          if (CALLER_KINDS.has(relation.kind)) {
            const owner = this.graph.owner(relation.from);
            if (owner !== ref && owner !== parent)
              callers.push({
                ref: owner,
                relation,
                certain: constructs && relation.kind === "CALLS",
              });
          }
    }
    // A call through an interface or base member may reach this implementation, or another;
    // with no other implementation in the project, it reaches this one. A constructor is not
    // dispatched: the base's constructor, or super().__init__ in a sibling class, never runs it.
    if (!constructs)
      for (const override of this.graph.relationsFrom([ref]))
        if (override.kind === "OVERRIDES" && override.to !== undefined) {
          const contract = override.to;
          const relations = this.graph.relationsTo([contract]);
          const only = relations.filter((relation) => relation.kind === "OVERRIDES").length === 1;
          for (const relation of relations)
            if (CALLER_KINDS.has(relation.kind)) {
              const owner = this.graph.owner(relation.from);
              if (owner !== ref) callers.push({ ref: owner, relation, certain: only });
            }
        }
    return callers;
  }

  private decoratorRoutes(current: Reached) {
    for (const relation of this.graph.relationsFrom([current.ref])) {
      if (relation.kind !== "DECORATED_BY") continue;
      const route = relation.route ?? relation.argument;
      if (!route || !ROUTE.test(route)) continue;
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
        `${calls.length} calls of a member named ${object.name} on receivers of unknown type may reach ${this.name(ref)}; a text search finds them`,
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
    const chain: string[] = [];
    // The chain runs from the declaration the entry reaches toward the change; a declaration at
    // the top of a chain is the entry itself, so its chain starts below it.
    let step: Reached | undefined = top && at.via ? this.reached.get(at.via) : at;
    for (; step && chain.length < LIMITS.chain; ) {
      chain.push(this.name(step.ref));
      step = step.via ? this.reached.get(step.via) : undefined;
    }
    const known = this.entries.get(label);
    if (known && (known.certain || !certain)) return;
    this.entries.set(label, { label, route, chain, ...(site ? { site } : {}), certain });
  }

  private area(ref: string, test: string, name: string) {
    const area = areaOf(this.graph.object(ref).anchor.path);
    const known = this.areas.get(area) ?? { through: new Set<string>(), tests: new Map() };
    known.through.add(this.name(ref));
    const names = known.tests.get(test) ?? new Set<string>();
    if (!name.startsWith("<")) names.add(name);
    known.tests.set(test, names);
    this.areas.set(area, known);
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

/** Test files a test runner runs, by the naming conventions of the mapped languages. */
export const mapRunnableTest = (file: string) =>
  /_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:Test|Tests|IT)\.(?:java|kt)$/u.test(
    file,
  );

export function mapChangeImpact(
  store: CodeIndexStore,
  working: string,
  base: string | undefined,
  changes: MapChanges,
  project?: string,
): MapChangeImpact {
  const graph = new MapViewGraph(store, working);
  const cache = new MapViewCache();
  const tracer = new Tracer(graph, cache.memberCalls(store, working));
  const changed: string[] = [];
  const unclear: string[] = [];
  const removed: string[] = [];
  const declarations = (g: MapViewGraph, path: string) =>
    g.objectsAt(path).filter((object) => !mapIsModule(object) && g.isAddressable(object));
  let changedCount = 0;
  const starts: string[] = [];

  for (const file of changes.files) {
    if (file.binary) continue;
    const kind = nonCodeKind(file.path);
    const objects = file.status === "DELETED" ? [] : graph.objectsAt(file.path);
    if (testCode(file.path)) {
      if (file.status !== "DELETED") tracer.test(file.path, undefined, "changed in this diff", 1);
      continue;
    }
    if (!objects.length) {
      if (file.status !== "DELETED" && kind)
        unclear.push(`${file.path} changed (${kind}): its effects are not mapped`);
      continue;
    }
    // The innermost declarations around each changed line; top-level lines belong to the file.
    const hits = new Set<string>();
    let topLevel = false;
    const inFile = declarations(graph, file.path);
    for (const [from, to] of file.lines) {
      const containing = inFile.filter(
        (object) => object.anchor.startLine <= to && from <= object.anchor.endLine,
      );
      if (!containing.length) topLevel = true;
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
        `${file.path}: ${graph.qualifiedName(ref)} ${mapDeclarationLabel(object)}${file.status === "ADDED" ? " (new file)" : ""}`,
      );
      starts.push(ref);
    }
    // Registrations: route literals on changed lines, wherever they are.
    for (const relation of graph.relationsFrom(objects.map((object) => object.id)))
      if (
        relation.argument &&
        ROUTE.test(relation.argument) &&
        overlaps(file.lines, relation.anchor.startLine, relation.anchor.endLine)
      )
        unclear.push(
          `the registration of ${JSON.stringify(relation.argument)} at ${relation.anchor.path}:${relation.anchor.startLine} changed; check that the route still reaches the right handler`,
        );
    if (topLevel && file.status !== "ADDED")
      unclear.push(`top-level code of ${file.path} changed (imports, constants or registrations)`);
    // A file's importers back up its callers: tests that import it, even without a mapped call.
    importerTests(graph, objects, tracer);
    sameDirectoryTests(store, working, file.path, tracer);
    mirroredTests(store, working, file.path, tracer);
  }
  tracer.trace(starts);
  if (project) routeTests(project, store, working, [...tracer.entries.values()], tracer);
  supportTests(store, working, tracer);

  // Declarations the diff removed or renamed: their callers in the base still expect them.
  const rewrittenTests: { path: string; names: string[] }[] = [];
  if (base) {
    const before = new MapViewGraph(store, base);
    for (const file of changes.files)
      if (file.basePath && file.baseText !== undefined && testCode(file.basePath)) {
        const names = existingTestsChanged(before, graph, file, project);
        if (names.length) rewrittenTests.push({ path: file.path, names });
      }
    const beforeTracer = new Tracer(before, cache.memberCalls(store, base));
    const gone: string[] = [];
    for (const file of changes.files) {
      if (!file.basePath || !file.baseLines.length || file.binary || testCode(file.basePath))
        continue;
      const now = new Set(
        file.status === "DELETED"
          ? []
          : declarations(graph, file.path).map(
              (o) => `${o.kind}\u0000${graph.qualifiedName(o.id)}`,
            ),
      );
      for (const object of declarations(before, file.basePath)) {
        if (!overlaps(file.baseLines, object.anchor.startLine, object.anchor.endLine)) continue;
        if (now.has(`${object.kind}\u0000${before.qualifiedName(object.id)}`)) continue;
        // Only the outermost removed declaration: a removed class, not each of its methods.
        const parent = before.parent(object.id);
        if (parent && !mapIsModule(before.object(parent)) && gone.includes(parent)) continue;
        gone.push(object.id);
        removed.push(
          `${file.basePath}: ${before.qualifiedName(object.id)} ${mapDeclarationLabel(object)}`,
        );
      }
    }
    if (gone.length) {
      beforeTracer.trace(gone);
      for (const entry of beforeTracer.entries.values())
        if (!tracer.entries.has(entry.label)) tracer.entries.set(entry.label, entry);
      for (const [path, test] of beforeTracer.tests) {
        const known = tracer.tests.get(path);
        if (known) for (const name of test.names) known.names.add(name);
        else tracer.tests.set(path, test);
      }
      for (const [area, known] of beforeTracer.areas) {
        const now = tracer.areas.get(area);
        if (!now) tracer.areas.set(area, known);
        else {
          for (const name of known.through) now.through.add(name);
          for (const [path, names] of known.tests)
            now.tests.set(path, new Set([...(now.tests.get(path) ?? []), ...names]));
        }
      }
      unclear.push(...beforeTracer.unclear.filter((line) => !line.includes("has no callers")));
      if (beforeTracer.truncated) tracer.truncated = true;
    }
  }

  return {
    changed,
    removed,
    rewrittenTests,
    entries: [...tracer.entries.values()].sort(
      (left, right) =>
        Number(right.certain) - Number(left.certain) ||
        Number(right.route) - Number(left.route) ||
        (left.label < right.label ? -1 : left.label > right.label ? 1 : 0),
    ),
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
    truncated: tracer.truncated,
  };
}

// The declarations of a changed test file that existed in the base and whose lines the diff changed
// or removed, innermost first: a test method, not its class. Comparing text, not diff hunks, keeps
// a test added beside an existing one from counting as a change to it, and catches lines moved out
// of an existing test, which git may show as a pure addition; a test that only gained lines kept
// every check it had.
function existingTestsChanged(
  before: MapViewGraph,
  after: MapViewGraph,
  file: MapChangedFile,
  project: string | undefined,
): string[] {
  if (!file.basePath || file.baseText === undefined) return [];
  const baseLines = file.baseText.split("\n");
  let workingLines: string[] = [];
  if (file.status !== "DELETED" && project)
    try {
      workingLines = readFileSync(path.join(project, file.path), "utf8").split("\n");
    } catch {}
  const key = (graph: MapViewGraph, object: MapObject) =>
    `${object.kind}\u0000${graph.qualifiedName(object.id)}`;
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
    (file.status === "DELETED" ? [] : after.objectsAt(file.path))
      .filter((object) => !mapIsModule(object) && after.isAddressable(object))
      .map((object) => [key(after, object), object]),
  );
  const changed = before
    .objectsAt(file.basePath)
    .filter((object) => !mapIsModule(object) && before.isAddressable(object))
    .filter((object) => {
      const counterpart = now.get(key(before, object));
      return !counterpart || !extended(body(baseLines, object), body(workingLines, counterpart));
    });
  // A class changes with its method; name the method.
  return changed
    .filter(
      (object) =>
        !changed.some(
          (other) =>
            other !== object &&
            object.anchor.start <= other.anchor.start &&
            other.anchor.end <= object.anchor.end,
        ),
    )
    .map((object) => before.qualifiedName(object.id))
    .sort();
}

// Tests that import a changed file, directly or through up to two importing modules.
function importerTests(graph: MapViewGraph, objects: readonly MapObject[], tracer: Tracer) {
  let modules = objects.filter((object) => mapIsModule(object)).map((object) => object.id);
  const seen = new Set(modules);
  for (let hop = 0; hop < 3 && modules.length; hop++) {
    const next: string[] = [];
    for (const relation of graph.relationsTo(modules)) {
      if (!IMPORT_KINDS.has(relation.kind)) continue;
      const importer = graph.object(relation.from);
      const module = mapIsModule(importer) ? importer.id : graph.owner(relation.from);
      if (testCode(relation.anchor.path))
        tracer.test(
          relation.anchor.path,
          undefined,
          hop ? "imports a changed file indirectly" : "imports a changed file",
          hop ? 4 : 2,
        );
      else if (!seen.has(module)) {
        seen.add(module);
        next.push(module);
      }
    }
    modules = next;
  }
}

// Tests that may use the change through test support (pytest's conftest.py, shared fixtures and
// helpers): fixtures are injected by name, so the tests beside and below the support file count.
function supportTests(store: CodeIndexStore, version: string, tracer: Tracer) {
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

// Tests of the same module in a mirrored test tree: tests/file/ for polar/file/service.py.
function mirroredTests(store: CodeIndexStore, version: string, file: string, tracer: Tracer) {
  const directories = file.split("/").slice(0, -1);
  const module = directories.at(-1);
  if (!module || directories.length < 1) return;
  for (const row of store.database
    .prepare(
      "SELECT DISTINCT path FROM project_map_objects WHERE version_ref = ? AND instr(path, ?) > 0",
    )
    .all(version, `/${module}/`)) {
    const candidate = String(row.path);
    const parts = candidate.split("/");
    const at = parts.lastIndexOf(module);
    if (at < 1 || at !== parts.length - 2) continue;
    if (!parts.slice(0, at).some((part) => /^(?:tests?|__tests__|specs?)$/iu.test(part))) continue;
    tracer.test(candidate, undefined, `tests the ${module} module`, 3);
  }
}

// Tests that request an affected route over HTTP: no call links them, but they mention its path.
// The longest literal stretch of the route is searched for, so parameters and prefixes added
// where the router is mounted do not hide it.
function routeTests(
  project: string,
  store: CodeIndexStore,
  version: string,
  entries: readonly MapChangeEntry[],
  tracer: Tracer,
) {
  const fragments = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.route) continue;
    const route = entry.label.slice(entry.label.indexOf("/"));
    const longest = route
      .split(/\/(?:\{[^}]*\}|:[^/]+|<[^>]*>|\*)(?=\/|$)/u)
      .sort((left, right) => right.length - left.length)[0];
    if (longest && longest.replace(/\//gu, "").length >= 4) fragments.set(longest, entry.label);
  }
  if (!fragments.size) return;
  let budget = 32 * 1024 * 1024;
  for (const row of store.database
    .prepare("SELECT DISTINCT path FROM project_map_objects WHERE version_ref = ?")
    .all(version)) {
    const candidate = String(row.path);
    if (!mapRunnableTest(candidate)) continue;
    let text: string;
    try {
      text = readFileSync(path.join(project, candidate), "utf8");
    } catch {
      continue;
    }
    budget -= text.length;
    if (budget < 0) return;
    for (const [fragment, label] of fragments)
      if (text.includes(fragment)) {
        // A mention alone is weak evidence; with another relation it is the strongest one.
        tracer.test(
          candidate,
          undefined,
          `mentions ${JSON.stringify(label)}`,
          tracer.tests.has(candidate) ? 2 : 3.5,
        );
        break;
      }
  }
}

// Test files beside a changed file, as Go's _test.go files and many projects keep them.
function sameDirectoryTests(store: CodeIndexStore, version: string, path: string, tracer: Tracer) {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  for (const row of store.database
    .prepare(
      "SELECT DISTINCT path FROM project_map_objects WHERE version_ref = ? AND path LIKE ? ESCAPE '\\'",
    )
    .all(version, `${directory.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`)) {
    const candidate = String(row.path);
    if (candidate.slice(directory.length).includes("/") || !mapTestPath(candidate)) continue;
    tracer.test(candidate, undefined, "in the same directory", 3);
  }
}

// The test functions among the test file's declarations that reach the change, else a few of them.
function testNames(names: readonly string[], limit: number = LIST.names): string {
  if (!names.length) return "";
  const tests = names.filter((name) => /(?:^|\.)(?:test|Test|should|it_)\w*$/u.test(name));
  const shown = (tests.length ? tests : names).slice(0, limit);
  const more = (tests.length ? tests : names).length - shown.length;
  return `: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

const LIST = Object.freeze({
  changed: 20,
  entries: 40,
  tests: 12,
  unclear: 20,
  stranded: 12,
  names: 6,
  areas: 8,
  areaTests: 3,
  areaNames: 3,
  through: 2,
});

/** The check as an agent reads it: the conclusion first, then each list, then what it cannot see. */
export function mapChangesText(changes: MapChanges, impact: MapChangeImpact): string {
  const files = changes.files.length;
  const direct = impact.tests.filter((test) => test.rank < 4);
  const indirect = impact.tests.filter((test) => test.rank >= 4);
  const routes = impact.entries.filter((entry) => entry.route);
  const lines = [
    `PROJECT MAP · CHANGES against ${changes.base} (${changes.commit.slice(0, 12)}) · ${files} changed file${files === 1 ? "" : "s"} · ${impact.changed.length} changed and ${impact.removed.length} removed declarations · ${routes.length} routes and ${impact.entries.length - routes.length} other entry points reached · ${direct.length} related test files${indirect.length ? ` (+${indirect.length} importing the changes indirectly)` : ""}`,
  ];
  if (!files) return `${lines[0]}\nNothing changed against ${changes.base}.`;
  const list = (title: string, items: readonly string[], limit: number) => {
    if (!items.length) return;
    lines.push(title, ...items.slice(0, limit).map((item) => `  ${item}`));
    if (items.length > limit) lines.push(`  +${items.length - limit} more`);
  };
  list("CHANGED", impact.changed, LIST.changed);
  list(
    "REMOVED OR RENAMED (their callers in the base still refer to them)",
    impact.removed,
    LIST.changed,
  );
  // Names read or set by text, which no compiler links: a rename on one side strands the other.
  if (changes.stranded.length) {
    list(
      "NAMES STILL USED ELSEWHERE (environment variables and configuration keys the diff removed from a file, found by text)",
      changes.stranded.map(strandedNameLine),
      LIST.stranded,
    );
    lines.push(
      "These places still read or set the old name. If the diff renamed or dropped it on purpose, update them too or keep the old name working. Names built at run time are not found.",
    );
  }
  // Expectations the diff rewrote: when the request did not ask for them, the code change reached
  // a feature it was not meant to change, and the rewritten test hides that.
  if (impact.rewrittenTests.length) {
    list(
      "EXISTING TESTS CHANGED (tests that existed before this diff, whose code it changed or removed)",
      impact.rewrittenTests.map(
        (test) =>
          `${test.path}: ${test.names.slice(0, LIST.names).join(", ")}${test.names.length > LIST.names ? `, +${test.names.length - LIST.names} more` : ""}`,
      ),
      LIST.tests,
    );
    lines.push(
      "For each, decide whether the request asks for that behavior to change. If it does not, the code change probably reached a feature it was not meant to: restore the test and narrow the change.",
    );
  }
  // The changed code serves several features: a change meant for one can leak into the others.
  if (impact.areas.length > 1) {
    list(
      `SHARED BY ${impact.areas.length} AREAS (tests that call the changed code, by the code they call it through)`,
      impact.areas.map((area) => {
        const through = `${area.through.slice(0, LIST.through).join(", ")}${area.through.length > LIST.through ? ", …" : ""}`;
        const tests = area.tests
          .slice(0, LIST.areaTests)
          .map((test) => `${test.path}${testNames(test.names, LIST.areaNames)}`);
        const more = area.tests.length - tests.length;
        return `${area.area} (${through}): ${tests.join("; ")}${more > 0 ? `; +${more} more files` : ""}`;
      }),
      LIST.areas,
    );
    lines.push(
      "Each area's tests pin its current behavior. Decide which areas the request is about: a failing test of another area means the change reached a feature the request may not cover; if it does not, narrow the change, for example to code only the requested area uses, rather than rewriting that test.",
    );
  }
  const entry = (item: MapChangeEntry) =>
    `${item.route ? JSON.stringify(item.label) : item.label}${item.chain.length ? ` → ${item.chain.join(" → ")}` : ""}${item.site ? ` (registered at ${item.site})` : ""}`;
  list(
    "AFFECTED ENTRY POINTS (through resolved calls)",
    impact.entries.filter((e) => e.certain).map(entry),
    LIST.entries,
  );
  list(
    "POSSIBLY AFFECTED (through a call on an interface or base member, which may dispatch elsewhere)",
    impact.entries.filter((e) => !e.certain).map(entry),
    LIST.entries,
  );
  list(
    "CHECK BY HAND (the map cannot see these)",
    [
      ...impact.unclear,
      ...(impact.truncated
        ? [
            `the trace stopped at ${LIMITS.depth} levels or ${LIMITS.declarations} declarations; continue with project_explore_map from the last ones`,
          ]
        : []),
    ],
    LIST.unclear,
  );
  if (direct.length) {
    list(
      "RELATED TESTS (closest first)",
      direct.map((test) => `${test.path}${testNames(test.names)} (${test.why})`),
      LIST.tests,
    );
    if (indirect.length)
      lines.push(
        `  +${indirect.length} more test files import the changed files through other modules; run them for a broader check`,
      );
    lines.push("If the change needs verifying, these existing tests are the ones to run.");
  } else if (indirect.length)
    lines.push(
      `RELATED TESTS: none call or import the changed code directly; ${indirect.length} test files import it through other modules, which a broader run covers.`,
    );
  lines.push(
    "Static estimate: calls through dependency injection, reflection, string dispatch, configuration and database coupling are not mapped, so an empty list does not prove the change is safe; confirm the entry points in source.",
  );
  return lines.join("\n");
}

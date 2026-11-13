import type { MapModuleDependency, MapReuseImport } from "./project-map-dependencies";
import type { MapStrandedNames } from "./project-map-names";
import type { MapSimilarCode } from "./project-map-reuse";

// The diff a change check reads and what the check finds in it: the shapes the reading, the
// trace, the test search and the report share.

/** Inclusive 1-based line ranges. */
export type Lines = readonly (readonly [number, number])[];
/** A diff hunk: where it starts and how many lines it spans in the base and in the working tree. */
export type Hunk = Readonly<{ baseStart: number; baseCount: number; start: number; count: number }>;

export type MapChangedFile = Readonly<{
  /** Path in the working tree; for a deleted file, its path in the base. */
  path: string;
  /** Path in the base, when the file existed there. */
  basePath?: string;
  status: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";
  /**
   * Lines added or changed in the working tree. A pure deletion is the point between two lines,
   * written as the range from the line after it back to the line before it: only code around both
   * contains it.
   */
  lines: Lines;
  /** Lines removed or changed in the base. */
  baseLines: Lines;
  /** The diff's hunks in order, which place each line it left unchanged in the working tree. */
  hunks: readonly Hunk[];
  /** The text of the lines removed or changed in the base, in order. */
  removed: readonly string[];
  binary: boolean;
  /** A changed test file's text in the base, to tell which of its existing tests changed. */
  baseText?: string;
}>;

export type MapChanges = Readonly<{
  base: string;
  commit: string;
  files: readonly MapChangedFile[];
  /** Environment variables and configuration keys the diff removed that other files still use. */
  stranded: MapStrandedNames;
}>;

export type MapChangeEntry = Readonly<{
  /** The route, or the declaration at the top of a call chain. */
  label: string;
  route: boolean;
  /** "via" chain from the entry down toward the changed declaration, a few hops at most. */
  chain: readonly string[];
  site?: string;
  certain: boolean;
  /** A route the diff removes: what the base's code reached through it, at the base's site. */
  removed?: boolean;
}>;

export type MapChangeImpact = Readonly<{
  changed: readonly string[];
  /** Removed or renamed declarations, with the code the diff left unchanged that still uses them. */
  removed: readonly Readonly<{ declaration: string; usedBy: readonly string[] }>[];
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
  /**
   * Changed files the map does not follow, by kind (configuration, dependencies, migrations even
   * where their code is mapped, templates, scripts, styles, binaries; not documentation): which
   * tests their change reaches is not known, as unclear also says.
   */
  unmapped: readonly Readonly<{ path: string; kind: string }>[];
  /** Routes the base registered in the changed files that they no longer register. */
  removedRoutes: readonly string[];
  /** Declarations the base called from lines the diff removed or changed, which nothing calls now. */
  uncalled: readonly string[];
  /** Imports between the overview's modules that the base did not have. */
  dependencies: readonly MapModuleDependency[];
  /** With test files given, the changed code they do not run as far as the map follows. */
  untested?: MapUntestedChanges;
  truncated: boolean;
}>;

export type MapUntestedChanges = Readonly<{
  /** The changed declarations no code in the given files calls, directly or through other code. */
  changed: readonly string[];
  /**
   * Of those, the ones the project's other related tests run, by a call or a route they request,
   * with those test files, closest first.
   */
  runByOthers: readonly Readonly<{ declaration: string; tests: readonly string[] }>[];
  /**
   * Of those, the ones the given tests may run, by sending a request whose path the map does not
   * work out to a route above them, with those given test files.
   */
  mayRun: readonly Readonly<{ declaration: string; tests: readonly string[] }>[];
  /** The entry points above those declarations. */
  entries: readonly MapChangeEntry[];
  /**
   * Changed declarations reached only through a route a given test requests or, where the map
   * does not read its requests, names a stretch of the path of.
   */
  throughRoutes: readonly string[];
  /** The routes above the change the given tests request. */
  routes: readonly string[];
  /** The given files the map has no code for. */
  missing: readonly string[];
  /** Whether following callers above the unreached declarations stopped at the trace's limits. */
  truncated: boolean;
}>;

export type MapReusableCode = MapSimilarCode & Readonly<{ imports: MapReuseImport }>;

export type MapCompileBreaks = Readonly<{
  errors: readonly string[];
  /** Packages the changed code needs that are not there: what comes from them has no type. */
  missing: readonly string[];
  /** Configurations the report says nothing of: they were not compiled on both sides. */
  unchecked: readonly string[];
}>;

// How far the trace follows a change; the report says so where it stopped.
export const LIMITS = Object.freeze({
  depth: 8,
  declarations: 800,
  changed: 200,
  chain: 3,
  byName: 40,
});

export const LIST = Object.freeze({
  changed: 20,
  entries: 40,
  tests: 12,
  unclear: 20,
  stranded: 12,
  clients: 8,
  names: 6,
  areas: 8,
  areaTests: 3,
  areaNames: 3,
  through: 2,
  dependencies: 12,
  sites: 2,
  similar: 10,
  similarNames: 3,
});

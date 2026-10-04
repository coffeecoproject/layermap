import { z } from "zod";
import type { CodeIndexStore } from "./code-index-store";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import {
  mapCodePath,
  mapExternalImport,
  mapImportTarget,
  mapLanguageOf,
} from "./project-map-language";
import { JAVA_MAP_LANGUAGE } from "./project-map-language-java";
import { type MapQueryOutputBudget, mapQueryPage } from "./project-map-query-page";
import {
  type MapObject,
  type MapRelation,
  mapPathAllowed,
  mapTestPath,
  PROJECT_MAP_LIMITS,
} from "./project-map-types";
import {
  MapViewGraph,
  mapDeclarationLabel,
  mapIsModule,
  mapSelectDeclarations,
} from "./project-map-view-graph";

export const MAP_VIEW_FORMAT = "PROJECT_MAP_VIEW_V1";
export const MAP_VIEW_LIMITS = Object.freeze({
  bothDepth: 3,
  directedDepth: 8,
  modules: 40,
  declarations: 400,
  groupLines: 200,
  members: 40,
  externalPackages: 20,
  unresolvedTargets: 12,
  // Call targets are written text; a long call chain keeps its receiver and its last members.
  targetText: 120,
  // Calls naming a method on an unknown receiver are listed up to this many, else counted.
  nameMatchedCalls: 20,
  sites: 4,
  collapsedOtherFiles: 10,
  unexpanded: 20,
  detailedListingBytes: 24 * 1024,
  compactListingBytes: 64 * 1024,
});

export type MapViewDirection = "INCOMING" | "OUTGOING" | "BOTH";
export type MapViewInput = Readonly<{
  version: string;
  path: string;
  name?: string;
  line?: number;
  direction?: MapViewDirection;
  depth?: number;
  includeTests?: boolean;
  includeUnresolved?: boolean;
  offset?: number;
  allowedPathPrefixes: readonly string[];
  outputBudget?: MapQueryOutputBudget;
  /** How views name the agent's search of source text, when its host has a tool for it. */
  textSearch?: string;
}>;
const DEFAULT_TEXT_SEARCH = "a text search";
export const MapViewPageSchema = z
  .object({
    format: z.literal(MAP_VIEW_FORMAT),
    view: z.enum(["DIRECTORY", "FILE", "DECLARATION"]),
    text: z.string(),
    nextOffset: z.number().int().positive().optional(),
    pageExhausted: z.boolean(),
  })
  .strict();
export type MapViewPage = z.infer<typeof MapViewPageSchema>;

const invalid = (): never => {
  throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
};
const notFound = (): never => {
  throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
};
const LEGEND =
  "Kinds: f function, c class, m method, p property, v variable, t type, i interface, e enum; numbers are 1-based source lines.";
const within = (path: string, directory: string) =>
  directory === "." || path.startsWith(`${directory}/`);
const parentDirectory = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
};
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const byCount = ([leftName, left]: [string, number], [rightName, right]: [string, number]) =>
  right - left || compareText(leftName, rightName);
const increment = (counts: Map<string, number>, key: string, count = 1) =>
  counts.set(key, (counts.get(key) ?? 0) + count);
const decoratorTag = (name: string, argument?: string) =>
  `@${name}${argument === undefined ? "" : `(${JSON.stringify(argument)})`}`;
const targetText = (target: string) => {
  const limit = MAP_VIEW_LIMITS.targetText;
  if (target.length <= limit) return target;
  const head = target.slice(0, Math.max(target.indexOf("."), 0));
  let tail = target.indexOf(".", head.length + 1);
  while (tail >= 0 && head.length + 1 + target.length - tail > limit)
    tail = target.indexOf(".", tail + 1);
  return head && tail >= 0
    ? `${head}…${target.slice(tail)}`
    : `${target.slice(0, limit / 2)}…${target.slice(target.length - limit / 2 + 1)}`;
};
const sites = (lines: readonly number[]) => {
  const unique = [...new Set(lines)].sort((left, right) => left - right);
  const shown = unique.slice(0, MAP_VIEW_LIMITS.sites).join(",");
  const more = unique.length - MAP_VIEW_LIMITS.sites;
  return `@${shown}${more > 0 ? `,+${more}` : ""}`;
};

// A block a page cannot hold (a generated file's thousands of exports, a directory of thousands
// of files) is split at its lines, and a line at its comma-separated items under the line's own
// label, so paging reaches all of it instead of failing the view.
function splitBlock(block: string, limit: number): string[] {
  if (Buffer.byteLength(block) <= limit) return [block];
  const lines = block.split("\n").flatMap((line) => {
    if (Buffer.byteLength(line) <= limit) return [line];
    const colon = line.indexOf(": ");
    const label = colon < 0 ? "" : line.slice(0, colon + 2);
    const pieces: string[] = [];
    let piece = "";
    for (const item of (colon < 0 ? line : line.slice(colon + 2)).split(", ")) {
      if (piece && Buffer.byteLength(label + piece + item) + 2 > limit) {
        pieces.push(label + piece);
        piece = "";
      }
      piece = piece ? `${piece}, ${item}` : item;
    }
    if (piece) pieces.push(label + piece);
    return pieces;
  });
  const chunks: string[] = [];
  let chunk: string[] = [];
  for (const line of lines) {
    if (chunk.length && Buffer.byteLength([...chunk, line].join("\n")) > limit) {
      chunks.push(chunk.join("\n"));
      chunk = [];
    }
    chunk.push(line);
  }
  if (chunk.length) chunks.push(chunk.join("\n"));
  return chunks;
}

function pageBlocks(
  view: MapViewPage["view"],
  head: readonly string[],
  whole: readonly string[],
  offset: number,
  budget: MapQueryOutputBudget | undefined,
): MapViewPage {
  const limit = Math.floor((budget?.maxBytes ?? PROJECT_MAP_LIMITS.queryBytes) / 4);
  const blocks = whole.flatMap((block) => splitBlock(block, limit));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > blocks.length) return invalid();
  const materialize = (count: number): MapViewPage => {
    const end = offset + count;
    const more = end < blocks.length;
    return {
      format: MAP_VIEW_FORMAT,
      view,
      text: [
        ...head,
        ...blocks.slice(offset, end),
        ...(more ? [`… ${blocks.length - end} more entries; continue with offset ${end}.`] : []),
      ].join("\n"),
      ...(more ? { nextOffset: end } : {}),
      pageExhausted: !more,
    };
  };
  if (offset === blocks.length) return materialize(0);
  return mapQueryPage(blocks.length - offset, materialize, (page) => page, budget);
}

type Module = Readonly<{ directory: string; direct: boolean }>;
const inModule = (path: string, module: Module) =>
  module.direct ? parentDirectory(path) === module.directory : within(path, module.directory);
const moduleLabel = (module: Module) =>
  module.direct
    ? `${module.directory === "." ? "" : `${module.directory}/`}* (files directly here)`
    : `${module.directory}/`;

function childModules(module: Module, files: readonly string[]): Module[] {
  if (module.direct) return [];
  const base = module.directory === "." ? "" : `${module.directory}/`;
  const directories = new Set<string>();
  let direct = false;
  for (const file of files) {
    if (!within(file, module.directory)) continue;
    const rest = file.slice(base.length);
    const slash = rest.indexOf("/");
    if (slash < 0) direct = true;
    else directories.add(`${base}${rest.slice(0, slash)}`);
  }
  return [
    ...[...directories].sort(compareText).map((directory) => ({ directory, direct: false })),
    ...(direct ? [{ directory: module.directory, direct: true }] : []),
  ];
}

function compressModule(module: Module, files: readonly string[]): Module {
  let current = module;
  for (;;) {
    const children = childModules(current, files);
    const only = children.length === 1 ? children[0] : undefined;
    if (!only || only.direct) return current;
    current = only;
  }
}

// The directory's own subdirectories are always modules, however many; split the largest further
// until another split would exceed the module limit.
export function mapModules(directory: string, files: readonly string[]): Module[] {
  if (!files.length) return [];
  let modules = [compressModule({ directory, direct: false }, files)];
  for (;;) {
    const next = modules
      .map((module) => ({
        module,
        size: files.filter((file) => inModule(file, module)).length,
        children: childModules(module, files).map((child) => compressModule(child, files)),
      }))
      .filter((candidate) => candidate.children.length > 1)
      .sort(
        (left, right) =>
          right.size - left.size || compareText(left.module.directory, right.module.directory),
      )
      .find(
        (candidate) =>
          modules.length === 1 ||
          modules.length - 1 + candidate.children.length <= MAP_VIEW_LIMITS.modules,
      );
    if (!next) break;
    modules = [...modules.filter((module) => module !== next.module), ...next.children];
  }
  return modules.sort(
    (left, right) =>
      compareText(left.directory, right.directory) || Number(left.direct) - Number(right.direct),
  );
}

type CallResolution = { resolved: number; unresolved: number; external: number };
type DirectoryFacts = Readonly<{
  files: ReadonlyMap<string, Readonly<{ lines: number; parsed: boolean; language?: string }>>;
  calls: ReadonlyMap<string, Readonly<CallResolution>>;
  exported: ReadonlyMap<string, readonly Readonly<{ text: string; start: number }>[]>;
  imports: readonly Readonly<{
    source: string;
    target: string | null;
    specifier: string;
    count: number;
  }>[];
}>;

// Whole-version reads scan rows in storage order: walking a version index would fetch every
// row at random. Versions are immutable, so one scan serves every directory view.
function loadDirectoryFacts(store: CodeIndexStore, version: string): DirectoryFacts {
  const files = new Map<string, { lines: number; parsed: boolean; language?: string }>();
  const declarations: {
    ref: string;
    path: string;
    kind: MapObject["kind"];
    name: string;
    startLine: number;
    endLine: number;
    start: number;
  }[] = [];
  for (const row of store.database
    .prepare(`SELECT entity_ref, path, kind, name,
        json_extract(object_json, '$.anchor.startLine') AS start_line,
        json_extract(object_json, '$.anchor.endLine') AS end_line,
        json_extract(object_json, '$.anchor.start') AS start,
        json_extract(object_json, '$.parsing') AS parsing,
        json_extract(object_json, '$.language') AS language
      FROM project_map_objects NOT INDEXED
      WHERE version_ref = ?
        AND (kind IN ('FILE', 'PACKAGE', 'CONFIG') OR json_extract(object_json, '$.exported') = 1)`)
    .all(version)) {
    const kind = String(row.kind) as MapObject["kind"];
    if (mapIsModule({ kind }))
      files.set(String(row.path), {
        lines: Number(row.end_line),
        parsed: row.parsing !== "NOT_PARSED",
        ...(row.language ? { language: String(row.language) } : {}),
      });
    else
      declarations.push({
        ref: String(row.entity_ref),
        path: String(row.path),
        kind,
        name: String(row.name),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        start: Number(row.start),
      });
  }
  const decorators = new Map<string, string[]>();
  const classes = declarations.filter((item) => item.kind === "CLASS").map((item) => item.ref);
  const decoratorQuery = store.database.prepare(`SELECT from_ref,
      json_extract(relation_json, '$.target') AS target,
      json_extract(relation_json, '$.argument') AS argument
    FROM project_map_relations WHERE version_ref = ?
      AND from_ref IN (SELECT value FROM json_each(?))
      AND json_extract(relation_json, '$.kind') = 'DECORATED_BY'`);
  for (let start = 0; start < classes.length; start += 256)
    for (const row of decoratorQuery.all(
      version,
      JSON.stringify(classes.slice(start, start + 256)),
    ))
      decorators.set(String(row.from_ref), [
        ...(decorators.get(String(row.from_ref)) ?? []),
        decoratorTag(String(row.target), row.argument === null ? undefined : String(row.argument)),
      ]);
  const exported = new Map<string, { text: string; start: number }[]>();
  for (const item of declarations) {
    // Overviews locate types and values by their first line; file views give full ranges.
    const endLine =
      item.kind === "TYPE" || item.kind === "VARIABLE" ? item.startLine : item.endLine;
    const label = mapDeclarationLabel({
      kind: item.kind,
      anchor: { startLine: item.startLine, endLine },
    });
    exported.set(item.path, [
      ...(exported.get(item.path) ?? []),
      {
        start: item.start,
        text: [`${item.name} ${label}`, ...(decorators.get(item.ref) ?? [])].join(" "),
      },
    ]);
  }
  for (const list of exported.values()) list.sort((left, right) => left.start - right.start);
  const imports = store.database
    .prepare(`SELECT r.path AS source, t.path AS target,
        json_extract(r.relation_json, '$.target') AS specifier, count(*) AS count
      FROM project_map_relations r NOT INDEXED
      LEFT JOIN project_map_objects t ON t.version_ref = r.version_ref AND t.entity_ref = r.to_ref
      WHERE r.version_ref = ? AND json_extract(r.relation_json, '$.kind') IN ('IMPORTS', 'TEST_IMPORTS')
      GROUP BY source, target, specifier`)
    .all(version)
    .map((row) => ({
      source: String(row.source),
      target: row.target === null ? null : String(row.target),
      specifier: String(row.specifier),
      count: Number(row.count),
    }));
  // Calls into the standard library or into declarations that are not loaded (usually packages)
  // have no project target; the rest either link to a project declaration or have an unknown callee.
  const calls = new Map<string, CallResolution>();
  for (const row of store.database
    .prepare(`SELECT path, count(*) AS total, sum(to_ref IS NOT NULL) AS resolved,
        sum(to_ref IS NULL AND json_extract(relation_json, '$.unresolvedReason')
          IN ('COMPILER_LIBRARY', 'OUTSIDE_SOURCE_CONTEXT', 'DECLARATION_NOT_AVAILABLE')) AS external
      FROM project_map_relations NOT INDEXED
      WHERE version_ref = ? AND json_extract(relation_json, '$.kind') = 'CALLS'
      GROUP BY path`)
    .all(version)) {
    const resolved = Number(row.resolved);
    const external = Number(row.external);
    calls.set(String(row.path), {
      resolved,
      external,
      unresolved: Number(row.total) - resolved - external,
    });
  }
  return { files, calls, exported, imports };
}

// Unresolved member calls (x.name(...)) whose receiver's type is unknown, by the caller's
// language and the member's name: such a call may reach a method of that name the map could not
// link. A call into a package or the standard library has a known callee and is left out.
type MemberCall = Readonly<{ from: string; path: string; line: number; target: string }>;
type MemberCalls = ReadonlyMap<string, readonly MemberCall[]>;
const MEMBER_NAME = /\.([A-Za-z_$][\w$]*)$/u;
const memberKey = (language: string, name: string) => `${language}\u0000${name}`;

function loadMemberCalls(store: CodeIndexStore, version: string): MemberCalls {
  const calls = new Map<string, MemberCall[]>();
  for (const row of store.database
    .prepare(`SELECT from_ref, path, json_extract(relation_json, '$.anchor.startLine') AS line,
        json_extract(relation_json, '$.target') AS target
      FROM project_map_relations
      WHERE version_ref = ? AND to_ref IS NULL AND json_extract(relation_json, '$.kind') = 'CALLS'
        AND json_extract(relation_json, '$.unresolvedReason') IN ('SYMBOL_NOT_RESOLVED', 'SYNTAX_ONLY')`)
    .all(version)) {
    const path = String(row.path);
    const target = String(row.target);
    const name = MEMBER_NAME.exec(target)?.[1];
    const language = mapLanguageOf(path);
    if (!name || !language) continue;
    const call = { from: String(row.from_ref), path, line: Number(row.line), target };
    const key = memberKey(language, name);
    const known = calls.get(key);
    if (known) known.push(call);
    else calls.set(key, [call]);
  }
  return calls;
}

// Per-version facts views share; a few recent versions are kept.
class VersionCache<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly load: (store: CodeIndexStore, version: string) => T) {}

  get(store: CodeIndexStore, version: string): T {
    let value = this.values.get(version);
    if (value === undefined) {
      value = this.load(store, version);
      this.values.set(version, value);
      for (const key of this.values.keys()) {
        if (this.values.size <= 4) break;
        this.values.delete(key);
      }
    }
    return value;
  }

  clear(): void {
    this.values.clear();
  }
}

// Limits of a whole map worth stating where it is entered, by the coverage gap that records them.
const MAP_LIMITS: Readonly<Record<string, string>> = {
  JAVA_RUNTIME_UNAVAILABLE:
    "no Java runtime of 21 or later was found, so Java files have no declarations or links",
  JAVA_ANALYZER_NOT_BUILT:
    "the Java analyzer was not built (no JDK 21+ at build time), so Java files have no declarations or links",
  GO_ANALYZER_NOT_BUILT:
    "the Go analyzer was not built (no Go 1.24 at build time), so Go files have no declarations or links",
  LOMBOK_CONFIG_NOT_APPLIED:
    "lombok.config settings are not applied, so names Lombok generates may differ from the build's",
  NO_JAVA_BUILD: "Java files outside a Gradle or Maven build are analyzed together as one program",
  NO_ADMITTED_TSCONFIG: "TypeScript and JavaScript files outside a tsconfig use inferred settings",
  NO_PYTHON_CONFIGURATION: "Python files outside a project configuration use inferred settings",
};

type MapCoverageNotes = Readonly<{
  // What each file's coverage gaps say (a syntax error, not in any analyzed program).
  files: ReadonlyMap<string, readonly string[]>;
  limits: readonly string[];
}>;

function loadCoverageNotes(store: CodeIndexStore, version: string): MapCoverageNotes {
  const row = store.database
    .prepare("SELECT coverage_json FROM project_map_coverage WHERE version_ref = ?")
    .get(version);
  const gaps = row
    ? (JSON.parse(String(row.coverage_json)) as { gaps: { code: string; path?: string }[] }).gaps
    : [];
  const files = new Map<string, string[]>();
  const limits = new Set<string>();
  for (const gap of gaps) {
    if (gap.path === undefined) {
      const limit = MAP_LIMITS[gap.code];
      if (limit) limits.add(limit);
      continue;
    }
    if (!mapCodePath(gap.path)) continue;
    const codes = files.get(gap.path) ?? [];
    if (!codes.includes(gap.code)) codes.push(gap.code);
    files.set(gap.path, codes);
  }
  // A file left out of every program for a reason of its own (a syntax error) says only that.
  for (const [path, codes] of files)
    if (codes.length > 1 && codes.includes("NOT_IN_PARSED_CONTEXT"))
      files.set(
        path,
        codes.filter((code) => code !== "NOT_IN_PARSED_CONTEXT"),
      );
  return { files, limits: [...limits] };
}

export class MapViewCache {
  private readonly facts = new VersionCache(loadDirectoryFacts);
  private readonly calls = new VersionCache(loadMemberCalls);
  private readonly coverage = new VersionCache(loadCoverageNotes);

  directoryFacts(store: CodeIndexStore, version: string): DirectoryFacts {
    return this.facts.get(store, version);
  }

  coverageNotes(store: CodeIndexStore, version: string): MapCoverageNotes {
    return this.coverage.get(store, version);
  }

  memberCalls(store: CodeIndexStore, version: string): MemberCalls {
    return this.calls.get(store, version);
  }

  clear(): void {
    this.facts.clear();
    this.calls.clear();
    this.coverage.clear();
  }
}

function directoryView(
  facts: DirectoryFacts,
  coverage: MapCoverageNotes,
  entries: readonly ProjectEvidenceRevisionFileEntryV1[],
  input: MapViewInput,
  directory: string,
  prefixes: readonly string[],
): MapViewPage {
  const showTests = input.includeTests === true || mapTestPath(`${directory}/`);
  const inScope = entries.filter(
    (entry) => within(entry.path, directory) && mapPathAllowed(entry.path, prefixes),
  );
  if (!inScope.length) return notFound();
  const visible = inScope.filter((entry) => showTests || !mapTestPath(entry.path));
  const hiddenTests = inScope.length - visible.length;
  const visiblePaths = new Set(visible.map((entry) => entry.path));
  const code = visible
    .filter((entry) => entry.state === "TEXT" && mapCodePath(entry.path))
    .map((entry) => entry.path);
  const modules = mapModules(directory, code);
  const moduleOf = (path: string) => modules.find((module) => inModule(path, module));
  const outside = (path: string) => {
    const parts = path.split("/");
    return `${parts.slice(0, Math.min(2, parts.length - 1)).join("/") || "."}/ (outside)`;
  };
  const moduleImports = new Map<string, Map<string, number>>();
  const external = new Map<string, number>();
  let unresolvedLocal = 0;
  for (const row of facts.imports) {
    const { source, target, specifier, count } = row;
    const from = visiblePaths.has(source) ? moduleOf(source) : undefined;
    if (!from) continue;
    if (target === null) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) unresolvedLocal += count;
      else increment(external, mapExternalImport(source, specifier), count);
      continue;
    }
    if (!mapPathAllowed(target, prefixes) || (!showTests && mapTestPath(target))) continue;
    const to = within(target, directory) ? moduleOf(target) : undefined;
    if (to === from) continue;
    const edges = moduleImports.get(moduleLabel(from)) ?? new Map<string, number>();
    increment(edges, to ? moduleLabel(to) : outside(target), count);
    moduleImports.set(moduleLabel(from), edges);
  }

  const blocks: string[] = [];
  if (modules.length > 1) {
    const sizes = new Map<string, number>();
    for (const path of code) {
      const module = moduleOf(path);
      if (module) increment(sizes, moduleLabel(module));
    }
    blocks.push(
      [
        "MODULES (code files)",
        ...modules.map((module) => `${moduleLabel(module)} ${sizes.get(moduleLabel(module)) ?? 0}`),
      ].join("\n"),
    );
  }
  if (moduleImports.size || unresolvedLocal)
    blocks.push(
      [
        "MODULE IMPORTS (import statements)",
        ...[...moduleImports]
          .sort(([left], [right]) => compareText(left, right))
          .map(
            ([source, targets]) =>
              `${source} → ${[...targets]
                .sort(byCount)
                .map(([target, count]) => `${target} ${count}`)
                .join(", ")}`,
          ),
        ...(unresolvedLocal
          ? [`${unresolvedLocal} relative imports did not resolve to source`]
          : []),
      ].join("\n"),
    );
  if (external.size) {
    const packages = [...external].sort(byCount);
    const shown = packages.slice(0, MAP_VIEW_LIMITS.externalPackages);
    blocks.push(
      `EXTERNAL PACKAGES (import statements): ${shown
        .map(([name, count]) => `${name} ${count}`)
        .join(
          ", ",
        )}${packages.length > shown.length ? `, +${packages.length - shown.length} more` : ""}`,
    );
  }

  // A file that was not parsed has no line count, only why (its coverage gaps).
  const lineCount = (path: string) => {
    const file = facts.files.get(path);
    const gaps = coverage.files.get(path) ?? [];
    if (file?.parsed === false) return `[not parsed${gaps.length ? `: ${gaps.join("; ")}` : ""}]`;
    return `${file ? `${file.lines}L` : "?L"}${gaps.length ? ` [${gaps.join("; ")}]` : ""}`;
  };
  // Other files group under their highest ancestor without code, so data, migration and
  // documentation trees collapse to one line while files beside code stay listed.
  const codeDirectories = new Set<string>();
  for (const path of code)
    for (
      let parent = parentDirectory(path);
      parent !== "." && !codeDirectories.has(parent);
      parent = parentDirectory(parent)
    )
      codeDirectories.add(parent);
  const groupOf = (path: string) => {
    let group = parentDirectory(path);
    for (
      let parent = group;
      parent !== "." && parent !== directory && !codeDirectories.has(parent);
      parent = parentDirectory(parent)
    )
      group = parent;
    return group;
  };
  const other = new Map<string, typeof visible>();
  for (const entry of visible)
    if (entry.state !== "TEXT" || !mapCodePath(entry.path)) {
      const group = groupOf(entry.path);
      const into = other.get(group);
      if (into) into.push(entry);
      else other.set(group, [entry]);
    }
  const listedOther: typeof visible = [];
  const collapsed: [string, string][] = [];
  for (const [parent, list] of other) {
    if (list.length <= MAP_VIEW_LIMITS.collapsedOtherFiles) {
      listedOther.push(...list);
      continue;
    }
    const extensions = new Map<string, number>();
    for (const entry of list) {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      increment(extensions, name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name);
    }
    const prefix = `${parent}/`;
    collapsed.push([
      prefix,
      `${prefix} ${list.length} other files (${[...extensions]
        .sort(byCount)
        .map(([extension, count]) => `${extension} ${count}`)
        .join(", ")})`,
    ]);
  }
  const detailed: [string, string][] = [
    ...code.map((path): [string, string] => {
      const declarations = (facts.exported.get(path) ?? []).map(({ text }) => text);
      return [
        path,
        `${path} ${lineCount(path)}${declarations.length ? `: ${declarations.join(", ")}` : ""}`,
      ];
    }),
    ...listedOther.map((entry): [string, string] => [
      entry.path,
      `${entry.path} ${
        entry.state === "TEXT"
          ? `${Math.max(1, Math.round(entry.byteLength / 1024))}KB`
          : entry.state
      }`,
    ]),
    ...collapsed,
  ];
  const directories = new Map<string, string[]>();
  for (const entry of [
    ...code.map((path) => ({ path, item: lineCount(path) })),
    ...listedOther.map((entry) => ({
      path: entry.path,
      item: entry.state === "TEXT" ? "" : `(${entry.state})`,
    })),
  ].sort((left, right) => compareText(left.path, right.path))) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const parent = parentDirectory(entry.path);
    directories.set(parent, [
      ...(directories.get(parent) ?? []),
      entry.item ? `${name} ${entry.item}` : name,
    ]);
  }
  const compact: [string, string][] = [
    ...[...directories].map(([parent, items]): [string, string] => [
      `${parent}/`,
      `${parent}/: ${items.join(", ")}`,
    ]),
    ...collapsed,
  ];
  const bytes = (lines: readonly [string, string][]) =>
    lines.reduce((total, [, line]) => total + Buffer.byteLength(line, "utf8") + 1, 0);
  const tier = mapDirectoryTier(bytes(detailed), bytes(compact), modules.length);
  if (tier !== "MODULES")
    blocks.push(
      ...(tier === "DETAILED" ? detailed : compact)
        .sort(([left], [right]) => compareText(left, right))
        .map(([, line]) => line),
    );
  const text = visible.filter((entry) => entry.state === "TEXT").length;
  const resolution = new Map<string, CallResolution>();
  for (const path of code) {
    const counts = facts.calls.get(path);
    if (!counts) continue;
    const language = facts.files.get(path)?.language ?? "unknown";
    const total = resolution.get(language) ?? { resolved: 0, unresolved: 0, external: 0 };
    total.resolved += counts.resolved;
    total.unresolved += counts.unresolved;
    total.external += counts.external;
    resolution.set(language, total);
  }
  const externalCalls = [...resolution.values()].reduce((sum, value) => sum + value.external, 0);
  const rates = [...resolution]
    .filter(([, value]) => value.resolved + value.unresolved > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([language, { resolved, unresolved }]) => {
      const total = resolved + unresolved;
      return `${language} ${Math.floor((resolved / total) * 100)}% (${resolved} of ${total})`;
    });
  const head = [
    `PROJECT MAP · DIRECTORY ${directory} · ${code.length} code files · ${text - code.length} other text files${
      visible.length > text ? ` · ${visible.length - text} unreadable entries` : ""
    }${hiddenTests ? ` · ${hiddenTests} test files hidden (includeTests)` : ""}${
      prefixes.includes(".") ? "" : " · limited to authorized paths"
    }`,
    tier === "DETAILED"
      ? `${LEGEND} Code files list line count and exported declarations; other files show size.`
      : tier === "COMPACT"
        ? "File lines give a directory, then its files with line counts; join them for a path. Declarations are omitted to keep this overview small: open a file, or a directory with fewer files, to see them."
        : "Files are omitted because this directory is large: open a module directory to list its files.",
    ...(rates.length
      ? [
          `Static calls linked to project declarations: ${rates.join(", ")}; the rest have a callee of unknown type, such as a value from a package whose types are not loaded. ${externalCalls} calls into the standard library or into packages that are not loaded are not counted.`,
        ]
      : []),
    ...(directory === "." && coverage.limits.length
      ? [`Map limits: ${coverage.limits.join("; ")}.`]
      : []),
  ];
  return pageBlocks("DIRECTORY", head, blocks, input.offset ?? 0, input.outputBudget);
}

/**
 * The entry view stays bounded: declarations while the listing is small, file names by
 * directory while those fit, and otherwise modules only (unless there is nothing to open).
 */
export function mapDirectoryTier(detailedBytes: number, compactBytes: number, modules: number) {
  if (detailedBytes <= MAP_VIEW_LIMITS.detailedListingBytes) return "DETAILED" as const;
  if (compactBytes <= MAP_VIEW_LIMITS.compactListingBytes || modules < 2) return "COMPACT" as const;
  return "MODULES" as const;
}

const OUTGOING: Readonly<Partial<Record<MapRelation["kind"], string>>> = {
  CALLS: "calls",
  REFERENCES: "uses as value",
  WRITES: "writes",
  IMPORTS: "imports",
  TEST_IMPORTS: "test imports",
};
const INCOMING: Readonly<Partial<Record<MapRelation["kind"], string>>> = {
  CALLS: "called by",
  REFERENCES: "used as value by",
  WRITES: "written by",
  EXTENDS: "extended by",
  IMPLEMENTS: "implemented by",
  DECORATED_BY: "decorates",
};
const IMPORT_KINDS = new Set<MapRelation["kind"]>(["IMPORTS", "TEST_IMPORTS"]);
// A last page means the view is complete, not that every runtime caller is mapped.
const callerCoverage = (textSearch: string) =>
  `Callers are direct calls, uses as a value (stored, passed, returned or selected, then usually invoked through that value) and calls through an interface, type or base member that a declaration here implements (dispatched from). Calls through dependency injection, framework routing, reflection or computed names are not mapped, so a complete view is not a complete caller list; confirm impact with project_find_references or ${textSearch}. Possible callers by name are calls elsewhere, in the same language, of a member with a method's name on a receiver of unknown type (an untyped value, or one an unloaded package produced); they may or may not reach that method.`;
const DISPATCH_LEGEND =
  "dispatches to lists the members that implement an interface, type or base member, which a call through it may reach; trace stops names calls whose target is a function value, a member without a mapped implementation or a computed key, which only source reading can follow.";
// Python's special methods run through the language's protocols, not by name.
const SPECIAL_METHOD = /^__\w+__$/u;
// Calls whose target is only known at runtime, so a static trace cannot continue past them.
type Stop = { target: string; reason: string; lines: number[] };

type Aggregate = {
  arrow: "→" | "←";
  label: string;
  other: MapObject;
  lines: number[];
  // The path the relation registers under, such as a route; each path is its own item.
  argument?: string;
};

class DeclarationGroups {
  constructor(
    private readonly graph: MapViewGraph,
    private readonly input: MapViewInput,
    private readonly prefixes: readonly string[],
    private readonly showTests: boolean,
    private readonly memberCalls: () => MemberCalls,
  ) {}

  private visible(path: string) {
    return mapPathAllowed(path, this.prefixes) && (this.showTests || !mapTestPath(path));
  }

  private entry(object: MapObject, imported = false) {
    if (mapIsModule(object)) return imported ? "(file)" : "(module scope)";
    return `${this.graph.qualifiedName(object.id)} ${mapDeclarationLabel(object)}`;
  }

  // A call stops a static trace when its target is a runtime value, a member nothing is mapped
  // to implement, or a computed key; calls through implemented members dispatch on instead.
  private stop(relation: MapRelation): string | undefined {
    const target = relation.to === undefined ? undefined : this.graph.object(relation.to);
    // A field initializer runs at construction; calling the field calls the value it produced.
    const callable = target?.execution === "FUNCTION" || target?.execution === "CLOSURE";
    if (relation.target.endsWith("[…]")) return callable ? undefined : "computed key";
    if (!target || callable) return undefined;
    if (!["METHOD", "FUNCTION", "PROPERTY", "VARIABLE"].includes(target.kind)) return undefined;
    // Java calls a field only through a generated accessor, which reads or writes it.
    if (
      ["PROPERTY", "VARIABLE"].includes(target.kind) &&
      JAVA_MAP_LANGUAGE.claims(target.anchor.path)
    )
      return undefined;
    if (this.graph.implemented(target.id)) return undefined;
    // A function or method without a body (abstract, declared) has no code of its own to follow.
    return ["METHOD", "FUNCTION"].includes(target.kind)
      ? "no implementation mapped"
      : "function value";
  }

  group(ref: string, depth: number) {
    const graph = this.graph;
    const focus = graph.object(ref);
    const direction = this.input.direction ?? "BOTH";
    const outgoing = direction !== "INCOMING";
    const incoming = direction !== "OUTGOING";
    const { refs, members } = graph.scope(ref);
    const owned = new Set(refs);
    const tags: string[] = [];
    const aggregates = new Map<string, Aggregate>();
    const unresolved = new Map<string, { lines: number[]; library: boolean }>();
    const stops = new Map<string, Stop>();
    let omittedTests = 0;
    const add = (
      arrow: Aggregate["arrow"],
      label: string,
      other: MapObject,
      line: number,
      argument?: string,
    ) => {
      const key = `${arrow}${label}\u0000${other.id}\u0000${argument ?? ""}`;
      const value = aggregates.get(key) ?? {
        arrow,
        label,
        other,
        lines: [],
        ...(argument === undefined ? {} : { argument }),
      };
      value.lines.push(line);
      aggregates.set(key, value);
    };
    // Implementations connect a contract member's callers to the members that implement it.
    const dispatch = (
      arrow: Aggregate["arrow"],
      label: string,
      ref: string,
      path: string,
      line: number,
    ) => {
      const other = graph.object(graph.owner(ref));
      if (owned.has(other.id)) return;
      if (!this.visible(path)) {
        if (mapPathAllowed(path, this.prefixes)) omittedTests++;
        return;
      }
      add(arrow, label, other, line);
    };
    for (const relation of graph.relationsFrom(refs)) {
      if (relation.kind === "OVERRIDES") {
        if (incoming && relation.to !== undefined) {
          const target = graph.object(relation.to);
          dispatch(
            "←",
            "dispatched from",
            target.id,
            target.anchor.path,
            relation.anchor.startLine,
          );
        }
        continue;
      }
      if (!outgoing || relation.kind === "CONTAINS") continue;
      const reason = relation.kind === "CALLS" ? this.stop(relation) : undefined;
      if (reason) {
        const target = targetText(relation.target);
        const key = `${reason}\u0000${target}`;
        const value = stops.get(key) ?? { target, reason, lines: [] };
        value.lines.push(relation.anchor.startLine);
        stops.set(key, value);
        if (relation.to === undefined) continue;
      }
      // Static imports belong to the file view; imports inside a declaration load dynamically.
      if (IMPORT_KINDS.has(relation.kind) && mapIsModule(graph.object(relation.from))) continue;
      if (relation.to === undefined) {
        if (relation.kind === "DECORATED_BY")
          tags.push(decoratorTag(relation.target, relation.argument));
        else if (relation.kind === "EXTENDS" || relation.kind === "IMPLEMENTS")
          tags.push(`${relation.kind.toLowerCase()} ${relation.target}`);
        else {
          const key = `${relation.kind === "CALLS" ? "" : `${relation.kind.toLowerCase()} `}${targetText(relation.target)}`;
          const value = unresolved.get(key) ?? {
            lines: [],
            library: relation.unresolvedReason === "COMPILER_LIBRARY",
          };
          value.lines.push(relation.anchor.startLine);
          unresolved.set(key, value);
        }
        continue;
      }
      const other = graph.object(graph.owner(relation.to));
      if (owned.has(other.id)) continue;
      if (!this.visible(other.anchor.path)) {
        if (mapPathAllowed(other.anchor.path, this.prefixes)) omittedTests++;
        continue;
      }
      if (relation.kind === "DECORATED_BY")
        tags.push(decoratorTag(graph.qualifiedName(other.id), relation.argument));
      else if (relation.kind === "EXTENDS" || relation.kind === "IMPLEMENTS")
        tags.push(`${relation.kind.toLowerCase()} ${graph.qualifiedName(other.id)}`);
      else
        add(
          "→",
          OUTGOING[relation.kind] ?? relation.kind.toLowerCase(),
          other,
          relation.anchor.startLine,
          relation.argument,
        );
    }
    for (const relation of graph.relationsTo(refs)) {
      if (relation.kind === "OVERRIDES") {
        if (outgoing)
          dispatch(
            "→",
            "dispatches to",
            relation.from,
            relation.anchor.path,
            relation.anchor.startLine,
          );
        continue;
      }
      if (!incoming || relation.kind === "CONTAINS" || IMPORT_KINDS.has(relation.kind)) continue;
      const other = graph.object(graph.owner(relation.from));
      if (owned.has(other.id)) continue;
      if (!this.visible(relation.anchor.path)) {
        if (mapPathAllowed(relation.anchor.path, this.prefixes)) omittedTests++;
        continue;
      }
      const label =
        relation.kind === "CALLS" && focus.kind === "CLASS"
          ? "instantiated by"
          : (INCOMING[relation.kind] ?? relation.kind.toLowerCase());
      // A decorator's argument belongs to the declaration it decorates, shown there as a tag.
      add(
        "←",
        label,
        other,
        relation.anchor.startLine,
        relation.kind === "DECORATED_BY" ? undefined : relation.argument,
      );
    }
    // Calls elsewhere, in the method's language, naming it on a receiver of unknown type may reach
    // it; those in hidden test files are counted apart.
    const possible: MemberCall[] = [];
    let possibleInTests = 0;
    const language = mapLanguageOf(focus.anchor.path);
    if (incoming && language && focus.kind === "METHOD" && !SPECIAL_METHOD.test(focus.name))
      for (const call of this.memberCalls().get(memberKey(language, focus.name)) ?? []) {
        if (!mapPathAllowed(call.path, this.prefixes)) continue;
        if (!this.visible(call.path)) possibleInTests++;
        else if (!owned.has(graph.owner(call.from))) possible.push(call);
      }

    const lines = [
      `${depth === 0 ? "DECLARATION" : `[${depth}]`} ${focus.anchor.path}: ${this.entry(focus)}${
        focus.exported ? " exported" : ""
      }${[...new Set(tags)].map((tag) => ` ${tag}`).join("")}`,
    ];
    if (members.length) {
      const shown = members.slice(0, MAP_VIEW_LIMITS.members);
      lines.push(
        `  members: ${shown
          .map(
            (member) =>
              `${member.name} ${mapDeclarationLabel(member)}${
                member.anchor.path === focus.anchor.path ? "" : ` (${member.anchor.path})`
              }`,
          )
          .join(", ")}${
          members.length > shown.length
            ? `, +${members.length - shown.length} more in the file view`
            : ""
        }`,
      );
    }
    const files = new Map<string, Aggregate[]>();
    for (const aggregate of aggregates.values()) {
      const key = `${aggregate.arrow === "→" ? 0 : 1}\u0000${aggregate.label}\u0000${aggregate.other.anchor.path}`;
      const into = files.get(key);
      if (into) into.push(aggregate);
      else files.set(key, [aggregate]);
    }
    const entries = [...files]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, items]) => {
        const [first] = items;
        if (!first) return "";
        return `  ${first.arrow} ${first.label} ${first.other.anchor.path}: ${items
          .sort(
            (left, right) =>
              left.other.anchor.start - right.other.anchor.start ||
              compareText(left.argument ?? "", right.argument ?? ""),
          )
          .map(
            (item) =>
              `${this.entry(item.other, item.label.endsWith("imports"))} ${sites(item.lines)}${
                item.argument === undefined ? "" : ` ${JSON.stringify(item.argument)}`
              }`,
          )
          .join(", ")}`;
      });
    lines.push(...entries.slice(0, MAP_VIEW_LIMITS.groupLines));
    if (entries.length > MAP_VIEW_LIMITS.groupLines)
      lines.push(
        `  … ${entries.length - MAP_VIEW_LIMITS.groupLines} more files; project_find_references lists every site`,
      );
    const inTests = possibleInTests ? `; +${possibleInTests} in test files (includeTests)` : "";
    if (possible.length > MAP_VIEW_LIMITS.nameMatchedCalls)
      lines.push(
        `  ← possible callers by name: ${possible.length} calls name a member ${focus.name} on a receiver of unknown type; ${this.input.textSearch ?? DEFAULT_TEXT_SEARCH} finds them${inTests}`,
      );
    else if (possible.length) {
      const files = new Map<string, string[]>();
      possible.sort(
        (left, right) =>
          compareText(left.path, right.path) ||
          left.line - right.line ||
          compareText(left.target, right.target),
      );
      for (const call of possible) {
        const owner = graph.object(graph.owner(call.from));
        const item = `${this.entry(owner)} @${call.line} ${targetText(call.target)}`;
        const into = files.get(call.path);
        if (into) into.push(item);
        else files.set(call.path, [item]);
      }
      lines.push(
        `  ← possible callers by name: ${[...files]
          .map(([path, items]) => `${path}: ${items.join(", ")}`)
          .join("; ")}${inTests}`,
      );
    } else if (possibleInTests)
      lines.push(`  ← possible callers by name: ${possibleInTests} in test files (includeTests)`);
    const all = this.input.includeUnresolved === true;
    const listed = [...unresolved].filter(([, value]) => all || !value.library);
    const library = unresolved.size - listed.length;
    if (listed.length || library) {
      const shown = all ? listed : listed.slice(0, MAP_VIEW_LIMITS.unresolvedTargets);
      lines.push(
        `  → unresolved: ${[
          ...shown.map(([target, value]) =>
            all
              ? `${target} ${sites(value.lines)}`
              : `${target}${value.lines.length > 1 ? ` ×${value.lines.length}` : ""}`,
          ),
          ...(listed.length > shown.length
            ? [`+${listed.length - shown.length} more (includeUnresolved)`]
            : []),
          ...(library ? [`${library} standard-library targets (includeUnresolved)`] : []),
        ].join(", ")}`,
      );
    }
    if (stops.size) {
      const listed = [...stops.values()].sort(
        (left, right) =>
          Math.min(...left.lines) - Math.min(...right.lines) ||
          compareText(left.target, right.target) ||
          compareText(left.reason, right.reason),
      );
      const shown = all ? listed : listed.slice(0, MAP_VIEW_LIMITS.unresolvedTargets);
      lines.push(
        `  → trace stops: ${[
          ...shown.map((stop) => `${stop.target} ${sites(stop.lines)} (${stop.reason})`),
          ...(listed.length > shown.length
            ? [`+${listed.length - shown.length} more (includeUnresolved)`]
            : []),
        ].join(", ")}`,
      );
    }
    if (omittedTests) lines.push(`  omitted: ${omittedTests} test relationships (includeTests)`);
    const neighbors = [...aggregates.values()]
      .map((aggregate) => aggregate.other)
      .filter((other) => !mapIsModule(other))
      .map((other) => other.id);
    return { lines, neighbors: [...new Set(neighbors)] };
  }
}

function fileView(
  store: CodeIndexStore,
  coverage: MapCoverageNotes,
  graph: MapViewGraph,
  input: MapViewInput,
  path: string,
  prefixes: readonly string[],
): MapViewPage {
  const entry = store.getEntry(input.version, path);
  if (!entry || !mapPathAllowed(path, prefixes)) return notFound();
  const showTests = input.includeTests === true || mapTestPath(path);
  const module = mapCodePath(path)
    ? graph.objectsAt(path).find((object) => mapIsModule(object))
    : undefined;
  const gaps = coverage.files.get(path) ?? [];
  const head = [
    `PROJECT MAP · FILE ${path} · ${
      entry.state !== "TEXT"
        ? entry.state
        : module
          ? module.parsing === "NOT_PARSED"
            ? `not parsed${gaps.length ? ` (${gaps.join("; ")})` : ""}; read it as text`
            : `${module.anchor.endLine} lines${gaps.length ? ` · ${gaps.join("; ")}` : ""}`
          : `${entry.byteLength} bytes, not analyzed; read it as text`
    }`,
    LEGEND,
  ];
  if (!module || entry.state !== "TEXT")
    return pageBlocks("FILE", head, [], input.offset ?? 0, input.outputBudget);
  const blocks: string[] = [];
  const { members } = graph.scope(module.id);
  const nested = new Map(
    members
      .filter((member) => member.kind !== "FUNCTION" && member.kind !== "ENUM")
      .map((member) => [member.id, graph.scope(member.id).members] as const),
  );
  const tags = new Map<string, string[]>();
  const tagged = [...members, ...[...nested.values()].flat()].map((object) => object.id);
  for (const relation of graph.relationsFrom(tagged)) {
    if (!["DECORATED_BY", "EXTENDS", "IMPLEMENTS"].includes(relation.kind)) continue;
    const list = tags.get(relation.from) ?? [];
    list.push(
      relation.kind === "DECORATED_BY"
        ? decoratorTag(relation.target, relation.argument)
        : `${relation.kind.toLowerCase()} ${relation.target}`,
    );
    tags.set(relation.from, list);
  }
  // Members declared in another file (Go methods can be) name that file beside their lines.
  const describe = (object: MapObject) =>
    [
      `${object.name} ${mapDeclarationLabel(object)}${object.anchor.path === path ? "" : ` (${object.anchor.path})`}`,
      ...(tags.get(object.id) ?? []),
    ].join(" ");
  const declarations: string[] = [];
  for (const member of members) {
    declarations.push(`${member.exported ? "*" : " "}${describe(member)}`);
    const children = nested.get(member.id) ?? [];
    const listed =
      member.kind === "CLASS" ? children : children.filter((child) => child.kind === "METHOD");
    const fields = children.length - listed.length;
    if (listed.length || fields)
      declarations.push(
        `    ${[...listed.map(describe), ...(fields ? [`${fields} fields`] : [])].join(", ")}`,
      );
  }
  // Members declared here for a type declared in another file.
  const elsewhere = new Map<string, MapObject[]>();
  for (const object of graph.objectsAt(path)) {
    const parent = mapIsModule(object) ? undefined : graph.parent(object.id);
    if (parent === undefined || !graph.isAddressable(object)) continue;
    const container = graph.object(parent);
    if (mapIsModule(container) || container.anchor.path === path) continue;
    const into = elsewhere.get(parent);
    if (into) into.push(object);
    else elsewhere.set(parent, [object]);
  }
  for (const [parent, list] of [...elsewhere].sort(
    ([, left], [, right]) =>
      Math.min(...left.map((object) => object.anchor.start)) -
      Math.min(...right.map((object) => object.anchor.start)),
  ))
    declarations.push(
      ` ${graph.qualifiedName(parent)} (${graph.object(parent).anchor.path}): ${list
        .sort((left, right) => left.anchor.start - right.anchor.start)
        .map((object) => `${object.name} ${mapDeclarationLabel(object)}`)
        .join(", ")}`,
    );
  if (declarations.length) blocks.push(["DECLARATIONS (* exported)", ...declarations].join("\n"));

  const imports = new Set<string>();
  const external = new Set<string>();
  // Includes dynamic imports made inside declarations; those also appear in their declarations.
  const fileObjects = graph.objectsAt(path).map((object) => object.id);
  for (const relation of graph.relationsFrom(fileObjects)) {
    if (!IMPORT_KINDS.has(relation.kind)) continue;
    if (relation.to === undefined) external.add(relation.target);
    else {
      const target = graph.object(relation.to).anchor.path;
      if (mapPathAllowed(target, prefixes)) imports.add(mapImportTarget(target));
    }
  }
  const importers = new Set<string>();
  const testImporters = new Set<string>();
  // An import of a package (such as a Go package) points at one of its files; the rest of the
  // package shares its importers.
  const imported = mapImportTarget(path);
  const packageModules =
    imported === path
      ? [module.id]
      : store
          .listEntries(input.version)
          .filter((entry) => mapImportTarget(entry.path) === imported)
          .flatMap((entry) => graph.objectsAt(entry.path).filter((object) => mapIsModule(object)))
          .map((object) => object.id);
  for (const relation of graph.relationsTo(packageModules)) {
    if (!IMPORT_KINDS.has(relation.kind)) continue;
    const source = relation.anchor.path;
    if (!mapPathAllowed(source, prefixes)) continue;
    (!showTests && mapTestPath(source) ? testImporters : importers).add(source);
  }
  if (imports.size) blocks.push(`IMPORTS → ${[...imports].sort(compareText).join(", ")}`);
  if (external.size)
    blocks.push(`UNRESOLVED IMPORTS: ${[...external].sort(compareText).join(", ")}`);
  if (importers.size || testImporters.size)
    blocks.push(
      `IMPORTED BY ← ${[
        ...[...importers].sort(compareText),
        ...(testImporters.size ? [`+${testImporters.size} test files (includeTests)`] : []),
      ].join(", ")}`,
    );
  // The module's members are the declarations above; keep only top-level statement effects.
  const scope = new DeclarationGroups(
    graph,
    { ...input, direction: "OUTGOING" },
    prefixes,
    showTests,
    // Outgoing groups list no callers.
    () => new Map(),
  )
    .group(module.id, 0)
    .lines.slice(1)
    .filter((line) => !line.startsWith("  members: "));
  if (scope.length) blocks.push(["MODULE SCOPE (top-level statements)", ...scope].join("\n"));
  return pageBlocks("FILE", head, blocks, input.offset ?? 0, input.outputBudget);
}

function declarationView(
  graph: MapViewGraph,
  input: MapViewInput,
  path: string,
  prefixes: readonly string[],
  memberCalls: () => MemberCalls,
): MapViewPage {
  const requested = input.depth ?? 1;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > MAP_VIEW_LIMITS.directedDepth
  )
    return invalid();
  // One direction follows callers or callees to entry points; both directions fan out quickly.
  const both = (input.direction ?? "BOTH") === "BOTH";
  const depth = both ? Math.min(requested, MAP_VIEW_LIMITS.bothDepth) : requested;
  const { name, line } = input;
  const selected = mapSelectDeclarations(graph, path, name, line);
  if (!selected.length) return notFound();
  const showTests = input.includeTests === true || mapTestPath(path);
  const groups = new DeclarationGroups(graph, input, prefixes, showTests, memberCalls);
  const blocks: string[] = [];
  const seen = new Set<string>();
  let frontier = selected.map((object) => object.id);
  const boundary = new Set<string>();
  // Declarations scheduled but never shown because the declaration limit stopped expansion.
  const pending: string[] = [];
  let truncated = false;
  for (let level = 0; level < depth && frontier.length && !truncated; level++) {
    const next: string[] = [];
    for (const [index, ref] of frontier.entries()) {
      if (seen.has(ref)) continue;
      if (seen.size >= MAP_VIEW_LIMITS.declarations) {
        truncated = true;
        pending.push(...frontier.slice(index), ...next);
        break;
      }
      seen.add(ref);
      const group = groups.group(ref, level);
      blocks.push(group.lines.join("\n"));
      if (level < depth - 1) next.push(...group.neighbors);
      else for (const neighbor of group.neighbors) boundary.add(neighbor);
    }
    frontier = next;
  }
  // Limits hide relationships further out; name the declarations the expansion can continue from.
  // Declarations at the depth limit are checked for relationships further out, at most as many as
  // a view shows; the others are counted as unchecked, which bounds the work of one view.
  const waiting = new Set(pending.filter((ref) => !seen.has(ref)));
  const candidates =
    depth > 1 ? [...boundary].filter((ref) => !seen.has(ref) && !waiting.has(ref)) : [];
  const checked = candidates.slice(0, MAP_VIEW_LIMITS.declarations);
  const unchecked = candidates.length - checked.length;
  const unexpanded = [
    ...waiting,
    ...checked.filter((ref) =>
      groups.group(ref, depth).neighbors.some((neighbor) => !seen.has(neighbor)),
    ),
  ];
  if (unexpanded.length || unchecked) {
    const shown = unexpanded.slice(0, MAP_VIEW_LIMITS.unexpanded);
    const more = unexpanded.length - shown.length + unchecked;
    blocks.push(
      `NOT EXPANDED (${truncated ? `${MAP_VIEW_LIMITS.declarations} declarations reached` : `depth ${depth} reached`}): ${[
        ...shown.map((ref) => `${graph.object(ref).anchor.path}: ${graph.qualifiedName(ref)}`),
        ...(more
          ? [
              `+${more} more${unchecked ? ` (${unchecked} not checked for relationships further out)` : ""}`,
            ]
          : []),
      ].join(", ")}; continue with project_explore_map from them.`,
    );
  }
  const head = [
    `PROJECT MAP · DECLARATION ${path}${name === undefined ? "" : ` ${name}`}${
      line === undefined ? "" : ` line ${line}`
    } · direction ${input.direction ?? "BOTH"} · depth ${depth}${
      depth < requested ? ` (BOTH is limited to ${MAP_VIEW_LIMITS.bothDepth})` : ""
    }${prefixes.includes(".") ? "" : " · limited to authorized paths"}`,
    `${LEGEND} @n marks where a relationship occurs and +n counts further sites, which project_find_references lists; a quoted path after the sites is what the call or value is registered under there, such as a route. Static relationships are grouped by the declaration that owns them; closures and locals belong to their container; ${DISPATCH_LEGEND}${
      truncated ? ` Expansion stopped at ${MAP_VIEW_LIMITS.declarations} declarations.` : ""
    }`,
    ...((input.direction ?? "BOTH") === "OUTGOING"
      ? []
      : [callerCoverage(input.textSearch ?? DEFAULT_TEXT_SEARCH)]),
  ];
  return pageBlocks("DECLARATION", head, blocks, input.offset ?? 0, input.outputBudget);
}

export function mapView(
  store: CodeIndexStore,
  input: MapViewInput,
  cache = new MapViewCache(),
): MapViewPage {
  const prefixes = input.allowedPathPrefixes;
  const entry = input.path === "." ? undefined : store.getEntry(input.version, input.path);
  const graph = new MapViewGraph(store, input.version);
  if (input.name !== undefined || input.line !== undefined) {
    if (!entry || !mapPathAllowed(input.path, prefixes)) return notFound();
    return declarationView(graph, input, input.path, prefixes, () =>
      cache.memberCalls(store, input.version),
    );
  }
  const coverage = cache.coverageNotes(store, input.version);
  return entry
    ? fileView(store, coverage, graph, input, input.path, prefixes)
    : directoryView(
        cache.directoryFacts(store, input.version),
        coverage,
        store.listEntries(input.version),
        input,
        input.path,
        prefixes,
      );
}

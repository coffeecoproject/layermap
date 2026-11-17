import type { CodeIndexStore } from "./code-index-store";
import { MAP_RELATION_TARGET_JOIN } from "./project-map-query-selection";
import { type MapRelation, mapTestPath } from "./project-map-types";

type UnresolvedReason = NonNullable<MapRelation["unresolvedReason"]>;

/**
 * A version's import statements, one by importing file, line, file imported and specifier: tests'
 * too. One the map has no file of the project for has no target and says why, as the map was
 * built to.
 */
export type MapImports = readonly Readonly<
  { source: string; line: number; specifier: string } & (
    | { target: string }
    | { target: null; reason: UnresolvedReason }
  )
>[];

// Whole-version reads scan rows in storage order: walking a version index would fetch every
// row at random. Versions are immutable, so one scan serves every reader of a version.
export function loadMapImports(store: CodeIndexStore, version: string): MapImports {
  return store.database
    .prepare(`SELECT DISTINCT r.path AS source, t.path AS target,
        json_extract(r.relation_json, '$.anchor.startLine') AS line,
        json_extract(r.relation_json, '$.target') AS specifier,
        json_extract(r.relation_json, '$.unresolvedReason') AS reason
      FROM project_map_relations r NOT INDEXED
      ${MAP_RELATION_TARGET_JOIN}
      WHERE r.version_ref = ? AND json_extract(r.relation_json, '$.kind') = 'IMPORTS'
      ORDER BY source, line, target, specifier`)
    .all(version)
    .map((row) => {
      const site = {
        source: String(row.source),
        line: Number(row.line),
        specifier: String(row.specifier),
      };
      return row.target === null
        ? { ...site, target: null, reason: String(row.reason) as UnresolvedReason }
        : { ...site, target: String(row.target) };
    });
}

// Every import of a version, as facts for a program that keeps a project's own boundaries over the
// whole project rather than over a diff. Code in test files is left out, as the change check leaves
// it out of the edges a diff adds.

export type MapProjectImports = Readonly<{
  /**
   * Imports of a file of the project, by the importing file, its line and the importing text. A Go
   * import names a package, which the map anchors at one of its files.
   */
  imports: readonly Readonly<{ from: string; line: number; to: string; specifier: string }>[];
  /**
   * Imports the map has no file of the project for, with why. The reason says what the compiler
   * found, not whether the import is the project's own; the specifier tells that apart.
   * - SYMBOL_NOT_RESOLVED: nothing. A path or path alias to no file, a file that is not code (a
   *   stylesheet), or a package that is not installed or has no types (Node's own modules without
   *   @types/node).
   * - OUTSIDE_SOURCE_CONTEXT: a file outside the sources the map reads, as a package's types are.
   * - DECLARATION_NOT_AVAILABLE: a package of Go, Python or Java the map does not hold.
   * - COMPILER_LIBRARY: the language's own library.
   * - SOURCE_DECLARATION_UNMAPPED: a file of the project the map holds no declaration for.
   * - SYNTAX_ONLY: the importing file was only parsed, so no import of it was resolved.
   */
  unresolved: readonly Readonly<{
    from: string;
    line: number;
    specifier: string;
    reason: UnresolvedReason;
  }>[];
}>;

export function mapProjectImports(rows: MapImports): MapProjectImports {
  const imports: MapProjectImports["imports"][number][] = [];
  const unresolved: MapProjectImports["unresolved"][number][] = [];
  for (const row of rows) {
    if (mapTestPath(row.source)) continue;
    const { source: from, line, specifier } = row;
    if (row.target === null) unresolved.push({ from, line, specifier, reason: row.reason });
    else if (row.target !== from) imports.push({ from, line, to: row.target, specifier });
  }
  return { imports, unresolved };
}

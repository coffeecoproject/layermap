import type { CodeIndexStore } from "./code-index-store";
import { ProjectEvidenceError } from "./core";
import { canonicalJson } from "./digest";
import { mapQueryPathSql, mapQuerySelection } from "./project-map-query-selection";
import {
  assertMapSearchActive,
  type MapSearchFocus,
  mapSearchAllowedSql,
  mapSearchFocus,
} from "./project-map-search-focus";
import {
  type MapObject,
  MapObjectKindSchema,
  MapObjectSchema,
  type MapSearchInput,
  type MapSearchMatchField,
  type MapSearchRanking,
  type MapSearchRankingSignal,
  type MapSearchResult,
  mapTestPath,
} from "./project-map-types";

type SearchQuery = MapSearchResult["query"];
type SearchRow = Readonly<{ object: MapObject; ranking: MapSearchRanking }>;
const fields = ["NAME", "PATH", "DOCUMENTATION"] as const;
const testQuery = /(?:^|[^a-z0-9])(e2e|fixture|spec|test|tests)(?:[^a-z0-9]|$)/iu;
const generatedPath = /(?:^|\/)(?:generated|dist|build)(?:\/|$)|\.generated\./iu;
const kindWeight: Readonly<Record<MapObject["kind"], number>> = {
  CLASS: 600,
  FUNCTION: 550,
  METHOD: 550,
  INTERFACE: 500,
  TYPE: 500,
  ENUM: 450,
  FILE: 350,
  PROPERTY: 250,
  VARIABLE: 250,
  PACKAGE: 100,
  CONFIG: 100,
};
const declarationKinds = new Set<MapObject["kind"]>([
  "CLASS",
  "ENUM",
  "FUNCTION",
  "INTERFACE",
  "METHOD",
  "TYPE",
]);
const fileStem = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.(?:[cm]?[jt]sx?|vue|svelte|go|pyi?)$/iu, "");
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const compareRows = (left: SearchRow, right: SearchRow) =>
  right.ranking.score - left.ranking.score ||
  compareText(left.object.anchor.path, right.object.anchor.path) ||
  compareText(left.object.id, right.object.id);

export function mapSearchQuery(input: MapSearchInput): SearchQuery {
  if (!input.query.trim().length || Array.from(input.query).length > 256)
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  const matchMode = input.matchMode ?? "ANY";
  if (!["ANY", "ALL", "LITERAL"].includes(matchMode))
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  const terms =
    matchMode === "LITERAL"
      ? [input.query.toLowerCase()]
      : [
          ...new Set(
            input.query
              .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
              .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
              .toLowerCase()
              .match(/[\p{L}\p{N}]+/gu) ?? [],
          ),
        ];
  if (!terms.length) throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  if (
    input.focusRefs !== undefined &&
    (!Array.isArray(input.focusRefs) ||
      input.focusRefs.length > 8 ||
      input.focusRefs.some((ref) => typeof ref !== "string" || !ref.length || ref.length > 128))
  )
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  return {
    ...mapQuerySelection(input, MapObjectKindSchema.options),
    text: input.query,
    terms,
    matchMode,
    focusRefs: [...new Set(input.focusRefs ?? [])].sort(compareText),
  };
}

function rank(
  object: MapObject,
  documentation: readonly string[],
  relationCount: number,
  query: SearchQuery,
  focus?: MapSearchFocus,
): MapSearchRanking | undefined {
  const name = object.name.toLowerCase();
  const path = object.anchor.path.toLowerCase();
  const values: Readonly<Record<MapSearchMatchField, readonly string[]>> = {
    NAME: [name],
    PATH: [path],
    DOCUMENTATION: documentation.map((text) => text.toLowerCase()),
  };
  const matched = query.terms
    .map((term) => ({
      term,
      fields: fields.filter((field) => values[field].some((text) => text.includes(term))),
    }))
    .filter((term) => term.fields.length > 0);
  if (!matched.length || (query.matchMode === "ALL" && matched.length !== query.terms.length))
    return undefined;
  const matchedFields = fields.filter((field) =>
    matched.some((term) => term.fields.includes(field)),
  );
  const normalizedQuery = query.text.toLowerCase();
  const signals: MapSearchRankingSignal[] = [];
  let score = 0;
  if (name === normalizedQuery) {
    score += 12000;
    signals.push("EXACT_SYMBOL");
  } else if (name.startsWith(normalizedQuery)) {
    score += 9000;
    signals.push("SYMBOL_PREFIX");
  } else if (name.includes(normalizedQuery)) {
    score += 7000;
    signals.push("SYMBOL_CONTAINS");
  } else if (matchedFields.includes("NAME")) signals.push("SYMBOL_CONTAINS");
  if (object.kind === "FILE" && fileStem(path) === normalizedQuery) {
    score += 11000;
    signals.push("EXACT_FILE_STEM");
  }
  if (matchedFields.includes("PATH")) {
    score += path.includes(normalizedQuery) ? 2500 : 0;
    signals.push("PATH_CONTAINS");
  }
  if (matchedFields.includes("DOCUMENTATION")) {
    score += 1500;
    signals.push("SOURCE_DOCUMENTATION");
  }
  // Coverage is task relevance; a long path containing one common term should not dominate it.
  score += Math.floor((4000 * matched.length) / query.terms.length);
  score += matched.reduce(
    (total, term) =>
      total + (term.fields.includes("NAME") ? 2000 : term.fields.includes("PATH") ? 300 : 200),
    0,
  );
  score += kindWeight[object.kind] + Math.min(1200, relationCount * 20) + (focus?.score ?? 0);
  if (declarationKinds.has(object.kind)) signals.push("DECLARATION");
  if (relationCount > 0) signals.push("GRAPH_CONNECTED");
  const isTest = mapTestPath(path);
  const isGenerated = generatedPath.test(path);
  const hasTestIntent = query.terms.some((term) => testQuery.test(term));
  score += isTest ? (hasTestIntent ? 1000 : -5000) : 300;
  score += isGenerated ? -3000 : 300;
  if (isTest) signals.push("TEST_PATH");
  if (isGenerated) signals.push("GENERATED_PATH");
  if (!isTest && !isGenerated) signals.push("PRODUCTION_PATH");
  if (hasTestIntent) signals.push("TEST_QUERY");
  return {
    score,
    relationCount,
    signals,
    matchedTerms: matched.map((term) => term.term),
    matchedFields,
    ...(focus ? { focusDistance: focus.distance } : {}),
  };
}

function candidatePaths(version: string, terms: readonly string[]) {
  const ascii = terms.filter(
    (term) => Buffer.byteLength(term, "utf8") === term.length && !term.includes("\0"),
  );
  const long = ascii.filter((term) => term.length >= 3);
  const short = ascii.filter((term) => term.length < 3);
  const selects: string[] = [];
  const parameters: string[] = [];
  // Documents are shared between versions: a version lists one per text file.
  if (long.length) {
    selects.push(`SELECT navigation.path FROM project_map_navigation_fts fts
      JOIN project_map_navigation navigation ON navigation.document_ref = fts.rowid
      WHERE navigation.version_ref = ? AND project_map_navigation_fts MATCH ?`);
    parameters.push(version, long.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "));
  }
  if (short.length) {
    selects.push(`SELECT navigation.path FROM project_map_navigation navigation
      JOIN project_map_navigation_fts fts ON fts.rowid = navigation.document_ref
      WHERE navigation.version_ref = ?
        AND (${short.map(() => "instr(lower(fts.content), ?) > 0").join(" OR ")})`);
    parameters.push(version, ...short);
  }
  // SQLite's lower/FTS case folding differs from JavaScript's. Admit non-ASCII
  // content before the shared field matcher, including Unicode that folds to ASCII.
  // A NUL also makes these lengths differ and must not enter an FTS expression.
  selects.push(`SELECT navigation.path FROM project_map_navigation navigation
    JOIN project_map_navigation_fts fts ON fts.rowid = navigation.document_ref
    WHERE navigation.version_ref = ? AND length(CAST(fts.content AS BLOB)) <> length(fts.content)`);
  parameters.push(version);
  return { sql: selects.join(" UNION "), parameters };
}

export function mapSearchRows(
  store: CodeIndexStore,
  input: MapSearchInput,
  query: SearchQuery,
  scope: string,
  offset: number,
  signal: AbortSignal,
): readonly SearchRow[] {
  const focus = mapSearchFocus(store, input.version, query.focusRefs, scope, signal);
  const candidates = candidatePaths(input.version, query.terms);
  // Candidate-first joins avoid a version-wide relation scan for endpoint OR filters.
  const statement = store.database.prepare(`WITH
    candidates AS (${candidates.sql}),
    candidate_objects AS MATERIALIZED (
      SELECT object.object_json, object.entity_ref, object.version_ref, object.path
      FROM candidates CROSS JOIN project_map_objects object ON object.path = candidates.path
      WHERE object.version_ref = ? AND ${mapSearchAllowedSql("object.path")}
        AND ${mapQueryPathSql("object.path")}
        AND object.kind IN (SELECT value FROM json_each(?))
    )
    SELECT object.object_json,
      (SELECT count(*) FROM project_map_relations r
       LEFT JOIN project_map_objects t ON t.version_ref = r.version_ref AND t.entity_ref = r.to_ref
       WHERE r.version_ref = object.version_ref AND r.from_ref = object.entity_ref
         AND ${mapSearchAllowedSql("r.path")}
         AND (r.to_ref IS NULL OR ${mapSearchAllowedSql("t.path")})) +
      (SELECT count(*) FROM project_map_relations r
       JOIN project_map_objects f ON f.version_ref = r.version_ref AND f.entity_ref = r.from_ref
       WHERE r.version_ref = object.version_ref AND r.to_ref = object.entity_ref
         AND ${mapSearchAllowedSql("r.path")}
         AND ${mapSearchAllowedSql("f.path")}) AS relation_count,
      (SELECT json_group_array(json_extract(note.note_json, '$.text'))
       FROM project_map_notes note WHERE note.version_ref = object.version_ref
         AND note.entity_ref = object.entity_ref
         AND json_extract(note.note_json, '$.kind') = 'SOURCE_DOCUMENTATION'
         AND ${mapSearchAllowedSql("json_extract(note.note_json, '$.anchor.path')")}
      ) AS documentation
    FROM candidate_objects object`);
  const rows: SearchRow[] = [];
  for (const row of statement.iterate(
    ...candidates.parameters,
    input.version,
    scope,
    query.path,
    query.path,
    query.path,
    query.path,
    canonicalJson(query.kinds),
    scope,
    scope,
    scope,
    scope,
    scope,
  )) {
    assertMapSearchActive(signal);
    const object = MapObjectSchema.parse(JSON.parse(String(row.object_json)));
    const ranking = rank(
      object,
      JSON.parse(String(row.documentation)) as string[],
      Number(row.relation_count),
      query,
      focus.get(object.id),
    );
    if (ranking) rows.push({ object, ranking });
  }
  rows.sort(compareRows);
  const perPath = new Map<string, number>();
  const diversified = rows.map(({ object, ranking }) => {
    const pathRank = (perPath.get(object.anchor.path) ?? 0) + 1;
    perPath.set(object.anchor.path, pathRank);
    return {
      object,
      ranking: { ...ranking, score: ranking.score - Math.max(0, pathRank - 3) * 400 },
    };
  });
  assertMapSearchActive(signal);
  return diversified.sort(compareRows).slice(offset, offset + input.maxResults + 1);
}

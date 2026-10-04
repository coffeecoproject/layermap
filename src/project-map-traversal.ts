import { setImmediate } from "node:timers/promises";
import type { CodeIndexStore } from "./code-index-store";
import { ProjectEvidenceError } from "./core";
import { canonicalJson } from "./digest";
import { type MapQuerySelection, mapQueryPathSql } from "./project-map-query-selection";
import {
  MAP_RELATION_PRIORITY,
  type MapExploreInput,
  type MapExploreResult,
  type MapObject,
  MapObjectSchema,
  type MapRelation,
  MapRelationSchema,
} from "./project-map-types";

type Edge = MapExploreResult["relations"][number];
type Frontier = MapExploreResult["traversal"]["frontier"][number];
type RelationLink = Pick<MapRelation, "id" | "from" | "to" | "kind">;
export type MapTraversal = Readonly<{ relationRefs: readonly string[]; frontier: Frontier[] }>;
const allowed = (column: string) => `EXISTS (SELECT 1 FROM json_each(?) scope
  WHERE scope.value = '.' OR ${column} = scope.value OR substr(${column}, 1, length(scope.value) + 1) = scope.value || '/')`;
const relationOrder = `CASE json_extract(r.relation_json, '$.kind') ${Object.entries(
  MAP_RELATION_PRIORITY,
)
  .map(([kind, priority]) => `WHEN '${kind}' THEN ${priority}`)
  .join(" ")} END, r.relation_ref`;
const compareEdges = (left: RelationLink, right: RelationLink) =>
  MAP_RELATION_PRIORITY[left.kind] - MAP_RELATION_PRIORITY[right.kind] ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

export async function mapExploreTraversal(
  store: CodeIndexStore,
  input: Pick<MapExploreInput, "version" | "entityRef" | "direction"> & {
    scope: "RELATED" | "PROJECT";
    depth: number | null;
    authorizationScope: string;
    selection: MapQuerySelection<MapRelation["kind"]>;
  },
  signal: AbortSignal,
): Promise<MapTraversal> {
  const assertActive = () => {
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
  };
  const checkpoint = async () => {
    await setImmediate();
    assertActive();
  };
  await checkpoint();
  // Filter every endpoint before building adjacency. Hidden declarations cannot
  // bridge otherwise visible components, including in an unrestricted traversal.
  const statement = store.database.prepare(`
    SELECT r.relation_ref, r.from_ref, r.to_ref, json_extract(r.relation_json, '$.kind') AS kind
    FROM project_map_relations r
    JOIN project_map_objects f ON f.version_ref = r.version_ref AND f.entity_ref = r.from_ref
    LEFT JOIN project_map_objects t ON t.version_ref = r.version_ref AND t.entity_ref = r.to_ref
    WHERE r.version_ref = ? AND ${allowed("r.path")} AND ${allowed("f.path")}
      AND (r.to_ref IS NULL OR ${allowed("t.path")})
      AND ${mapQueryPathSql("r.path")}
      AND json_extract(r.relation_json, '$.kind') IN (SELECT value FROM json_each(?))
    ${input.scope === "PROJECT" ? `ORDER BY ${relationOrder}` : ""}`);
  const relationRefs: string[] = [];
  const adjacency = new Map<string, RelationLink[]>();
  const connect = (ref: string, edge: RelationLink) => {
    const existing = adjacency.get(ref);
    if (existing) existing.push(edge);
    else adjacency.set(ref, [edge]);
  };
  let inspected = 0;
  for (const row of statement.iterate(
    input.version,
    input.authorizationScope,
    input.authorizationScope,
    input.authorizationScope,
    input.selection.path,
    input.selection.path,
    input.selection.path,
    input.selection.path,
    canonicalJson(input.selection.kinds),
  )) {
    if (++inspected % 256 === 0) await checkpoint();
    const relation: RelationLink = {
      id: String(row.relation_ref),
      from: String(row.from_ref),
      ...(row.to_ref === null ? {} : { to: String(row.to_ref) }),
      kind: row.kind as MapRelation["kind"],
    };
    if (input.scope === "PROJECT") {
      relationRefs.push(relation.id);
      continue;
    }
    if (input.direction !== "INCOMING") connect(relation.from, relation);
    if (input.direction !== "OUTGOING" && relation.to && relation.to !== relation.from)
      connect(relation.to, relation);
    else if (input.direction === "INCOMING" && relation.to === relation.from)
      connect(relation.to, relation);
  }
  if (input.scope === "PROJECT") {
    assertActive();
    return { relationRefs, frontier: [] };
  }
  if (!input.entityRef) throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  const known = new Set([input.entityRef]);
  const seenRelations = new Set<string>();
  const frontier: Frontier[] = [];
  let seeds = [input.entityRef];
  let depth = 0;
  while (seeds.length && (input.depth === null || depth < input.depth)) {
    await checkpoint();
    depth++;
    const candidates = new Map<string, RelationLink>();
    for (const ref of seeds) {
      for (const edge of adjacency.get(ref) ?? []) {
        if (++inspected % 256 === 0) await checkpoint();
        if (!seenRelations.has(edge.id)) candidates.set(edge.id, edge);
      }
    }
    const next: string[] = [];
    for (const relation of [...candidates.values()].sort(compareEdges)) {
      if (++inspected % 256 === 0) await checkpoint();
      seenRelations.add(relation.id);
      relationRefs.push(relation.id);
      const neighbors =
        input.direction === "BOTH"
          ? [relation.from, ...(relation.to ? [relation.to] : [])]
          : input.direction === "INCOMING"
            ? [relation.from]
            : relation.to
              ? [relation.to]
              : [];
      for (const ref of neighbors) {
        if (known.has(ref)) continue;
        known.add(ref);
        next.push(ref);
      }
    }
    if (input.depth !== null && depth === input.depth)
      for (const ref of next) frontier.push({ entityRef: ref, direction: input.direction });
    seeds = next;
  }
  assertActive();
  return { relationRefs, frontier };
}

export function mapExplorePageRows(store: CodeIndexStore, version: string) {
  const relationQuery = store.database.prepare(
    "SELECT relation_json FROM project_map_relations WHERE version_ref = ? AND relation_ref = ?",
  );
  const objectQuery = store.database.prepare(
    "SELECT object_json FROM project_map_objects WHERE version_ref = ? AND entity_ref = ?",
  );
  const objects = new Map<string, MapObject>();
  const object = (ref: string) => {
    let parsed = objects.get(ref);
    if (!parsed) {
      const row = objectQuery.get(version, ref);
      if (!row) throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
      parsed = MapObjectSchema.parse(JSON.parse(String(row.object_json)));
      objects.set(ref, parsed);
    }
    return parsed;
  };
  return (ref: string): Edge => {
    const row = relationQuery.get(version, ref);
    if (!row) throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
    const relation = MapRelationSchema.parse(JSON.parse(String(row.relation_json)));
    return {
      relation,
      from: object(relation.from),
      ...(relation.to ? { to: object(relation.to) } : {}),
    };
  };
}

export function mapPageFrontier(frontier: readonly Frontier[], rows: readonly Edge[]) {
  const visible = new Set(
    rows.flatMap(({ relation }) => [relation.from, ...(relation.to ? [relation.to] : [])]),
  );
  return frontier.filter(({ entityRef }) => visible.has(entityRef)).map((node) => ({ ...node }));
}

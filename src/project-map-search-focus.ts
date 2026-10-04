import type { CodeIndexStore } from "./code-index-store";
import { ProjectEvidenceError } from "./core";
import { canonicalJson } from "./digest";
import type { MapRelation } from "./project-map-types";

export const mapSearchAllowedSql = (column: string) => `EXISTS (SELECT 1 FROM json_each(?) scope
  WHERE scope.value = '.' OR ${column} = scope.value OR substr(${column}, 1, length(scope.value) + 1) = scope.value || '/')`;

export const assertMapSearchActive = (signal: AbortSignal) => {
  if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
};

export type MapSearchFocus = Readonly<{ distance: number; score: number }>;

const relationWeight: Readonly<Record<MapRelation["kind"], number>> = {
  CALLS: 1200,
  WRITES: 1200,
  READS: 900,
  IMPORTS: 800,
  TEST_IMPORTS: 700,
  EXTENDS: 900,
  IMPLEMENTS: 900,
  OVERRIDES: 900,
  DECORATED_BY: 700,
  REFERENCES: 500,
  CONTAINS: 250,
};

export function mapSearchFocus(
  store: CodeIndexStore,
  version: string,
  refs: readonly string[],
  scope: string,
  signal: AbortSignal,
): ReadonlyMap<string, MapSearchFocus> {
  const found = new Map<string, MapSearchFocus>();
  if (!refs.length) return found;
  const seeds = store.database
    .prepare(`SELECT object.entity_ref FROM project_map_objects object
      WHERE object.version_ref = ? AND object.entity_ref IN (SELECT value FROM json_each(?))
      AND ${mapSearchAllowedSql("object.path")}`)
    .all(version, canonicalJson(refs), scope);
  if (seeds.length !== refs.length)
    throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
  for (const ref of refs) found.set(ref, { distance: 0, score: 1800 });

  let frontier = new Set(refs);
  const edges = store.database.prepare(`SELECT r.from_ref, r.to_ref,
      json_extract(r.relation_json, '$.kind') AS kind
    FROM project_map_relations r
    JOIN project_map_objects f ON f.version_ref = r.version_ref AND f.entity_ref = r.from_ref
    JOIN project_map_objects t ON t.version_ref = r.version_ref AND t.entity_ref = r.to_ref
    WHERE r.version_ref = ?
      AND (r.from_ref IN (SELECT value FROM json_each(?))
        OR r.to_ref IN (SELECT value FROM json_each(?)))
      AND ${mapSearchAllowedSql("r.path")}
      AND ${mapSearchAllowedSql("f.path")}
      AND ${mapSearchAllowedSql("t.path")}
    ORDER BY r.relation_ref`);
  for (let distance = 1; distance <= 2 && frontier.size; distance++) {
    assertMapSearchActive(signal);
    const frontierJson = canonicalJson([...frontier]);
    const next = new Set<string>();
    for (const row of edges.iterate(version, frontierJson, frontierJson, scope, scope, scope)) {
      assertMapSearchActive(signal);
      const from = String(row.from_ref);
      const to = String(row.to_ref);
      const weight = relationWeight[String(row.kind) as MapRelation["kind"]];
      if (weight === undefined)
        throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
      for (const [parent, neighbor] of [
        [from, to],
        [to, from],
      ] as const) {
        if (!frontier.has(parent)) continue;
        const previous = found.get(neighbor);
        if (previous && previous.distance < distance) continue;
        const parentScore = found.get(parent)?.score ?? 0;
        const score = Math.floor(Math.min(parentScore, weight) / distance);
        if (!previous || score > previous.score) found.set(neighbor, { distance, score });
        next.add(neighbor);
      }
    }
    frontier = next;
  }
  return found;
}

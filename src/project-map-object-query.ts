import type { CodeIndexStore } from "./code-index-store";
import { normalizeProjectEvidencePath, ProjectEvidenceError } from "./core";
import {
  type MapExploreInput,
  type MapObject,
  MapObjectKindSchema,
  MapObjectSchema,
  type MapSymbolSelector,
  mapPathAllowed,
} from "./project-map-types";
import { MapViewGraph, mapSelectDeclarations } from "./project-map-view-graph";

export function requireMapObject(
  store: CodeIndexStore,
  version: string,
  selector: Pick<MapExploreInput, "entityRef" | "locator"> & { symbol?: MapSymbolSelector },
  prefixes: readonly string[],
): MapObject {
  const { entityRef, locator, symbol } = selector;
  if (
    [entityRef, locator, symbol].filter((value) => value !== undefined).length !== 1 ||
    (entityRef !== undefined && !entityRef.length)
  )
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  if (symbol) {
    const path = normalizeProjectEvidencePath(symbol.path);
    if (!mapPathAllowed(path, prefixes))
      throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
    const selected = mapSelectDeclarations(
      new MapViewGraph(store, version),
      path,
      symbol.name,
      symbol.line,
    );
    // Same-named declarations need the start line printed by the map to disambiguate.
    if (selected.length > 1) throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    const [object] = selected;
    if (!object) throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
    return object;
  }
  let rows: Record<string, unknown>[];
  if (locator) {
    const path = normalizeProjectEvidencePath(locator.path);
    if (
      !Number.isSafeInteger(locator.start) ||
      locator.start < 0 ||
      (locator.kind !== undefined && !MapObjectKindSchema.safeParse(locator.kind).success)
    )
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    if (!mapPathAllowed(path, prefixes))
      throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
    rows = store.database
      .prepare(`SELECT object_json FROM project_map_objects
        WHERE version_ref = ? AND path = ? AND json_extract(object_json, '$.anchor.start') = ?
          AND (? IS NULL OR kind = ?) LIMIT 2`)
      .all(version, path, locator.start, locator.kind ?? null, locator.kind ?? null);
  } else {
    rows = store.database
      .prepare(
        "SELECT object_json FROM project_map_objects WHERE version_ref = ? AND entity_ref = ?",
      )
      .all(version, entityRef as string);
  }
  // A location may participate in several compiler contexts. Never guess which
  // contextual identity the caller intended; its entityRef remains unambiguous.
  if (rows.length > 1) throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  const object = rows[0]
    ? MapObjectSchema.parse(JSON.parse(String(rows[0].object_json)))
    : undefined;
  if (!object || !mapPathAllowed(object.anchor.path, prefixes))
    throw new ProjectEvidenceError("PROJECT_MAP_OBJECT_NOT_FOUND", false);
  return object;
}

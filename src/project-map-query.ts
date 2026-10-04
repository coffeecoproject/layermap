import { setImmediate } from "node:timers/promises";
import type { CodeIndexStore } from "./code-index-store";
import { normalizeProjectEvidencePath, ProjectEvidenceError } from "./core";
import { canonicalJson } from "./digest";
import { PROJECT_MAP_ANALYZER } from "./project-map-language";
import { mapExploreNavigation, mapSearchNavigation } from "./project-map-navigation";
import { requireMapObject } from "./project-map-object-query";
import { mapQueryPage } from "./project-map-query-page";
import { mapQuerySelection } from "./project-map-query-selection";
import { mapSearchQuery, mapSearchRows } from "./project-map-search";
import { mapSearchView } from "./project-map-search-view";
import {
  type MapTraversal,
  mapExplorePageRows,
  mapExploreTraversal,
  mapPageFrontier,
} from "./project-map-traversal";
import {
  MapContextSchema,
  type MapExploreInput,
  type MapExploreResult,
  type MapGap,
  MapNoteSchema,
  MapRelationKindSchema,
  type MapSearchInput,
  mapPathAllowed,
  PROJECT_MAP_LIMITS,
} from "./project-map-types";
import { MapViewCache, type MapViewInput, mapView } from "./project-map-view";

const admission = (
  input: {
    maxResults?: number;
    offset?: number;
    allowedPathPrefixes?: readonly string[];
  },
  limit: number = PROJECT_MAP_LIMITS.queryItems,
) => {
  const offset = input.offset ?? 0;
  const maxResults = input.maxResults ?? limit;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > limit
  ) {
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  }
  const prefixes = (input.allowedPathPrefixes ?? ["."]).map(
    (prefix) => normalizeProjectEvidencePath(prefix, true) || ".",
  );
  if (prefixes.length < 1 || prefixes.length > 64)
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  return { offset, maxResults, prefixes, scope: canonicalJson(prefixes) };
};
export const MAP_QUERY_GUIDANCE = Object.freeze({
  evidenceUse: "NAVIGATION_ONLY" as const,
  freshness: "MAP_NOT_CONTINUOUSLY_UPDATED" as const,
  sourceVerification: "READ_SOURCE_BEFORE_RELYING_ON_LOCATIONS" as const,
  authority: "CODE_FACTS_AND_SOURCE_DECLARATIONS_NOT_BUSINESS_AUTHORITY" as const,
  testing: "TEST_ASSOCIATION_IS_NOT_BEHAVIOR_VERIFICATION" as const,
});

export class ProjectMapQuery {
  private readonly traversals = new Map<string, MapTraversal>();
  private readonly views = new MapViewCache();
  private cachedReferences = 0;

  constructor(private readonly store: CodeIndexStore) {}

  clear(): void {
    this.traversals.clear();
    this.views.clear();
    this.cachedReferences = 0;
  }

  private rememberTraversal(key: string, traversal: MapTraversal) {
    const references = traversal.relationRefs.length + traversal.frontier.length;
    if (references > 250_000) return;
    const previous = this.traversals.get(key);
    if (previous) {
      this.cachedReferences -= previous.relationRefs.length + previous.frontier.length;
      this.traversals.delete(key);
    }
    this.traversals.set(key, traversal);
    this.cachedReferences += references;
    while (this.traversals.size > 8 || this.cachedReferences > 250_000) {
      const oldest = this.traversals.entries().next().value;
      if (!oldest) break;
      this.traversals.delete(oldest[0]);
      this.cachedReferences -= oldest[1].relationRefs.length + oldest[1].frontier.length;
    }
  }

  search(input: MapSearchInput, signal: AbortSignal) {
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    this.requireCurrentMap(input.version);
    if (!this.store.getIndexProgress(input.version).complete)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
    const { offset, scope, prefixes } = admission(input);
    const query = mapSearchQuery(input);
    const rows = mapSearchRows(this.store, input, query, scope, offset, signal);
    const metadata = { ...MAP_QUERY_GUIDANCE, query, gaps: this.gaps(input.version, prefixes) };
    return mapQueryPage(
      Math.min(rows.length, input.maxResults),
      (count) => {
        const selected = rows.slice(0, count);
        return {
          ...metadata,
          objects: selected.map((row) => row.object),
          rankings: selected.map((row) => row.ranking),
          ...(rows.length > count ? { nextOffset: offset + count } : {}),
          pageExhausted: rows.length <= count,
        };
      },
      mapSearchNavigation,
      input.outputBudget,
    );
  }

  searchView(input: MapSearchInput, signal: AbortSignal) {
    this.requireReadableMap(input.version, signal);
    const { offset, scope } = admission(input);
    const query = mapSearchQuery(input);
    const rows = mapSearchRows(this.store, input, query, scope, offset, signal);
    return mapSearchView(
      this.store,
      input.version,
      query,
      rows,
      offset,
      input.maxResults,
      input.outputBudget,
    );
  }

  view(input: MapViewInput, signal: AbortSignal) {
    this.requireReadableMap(input.version, signal);
    const { offset, prefixes } = admission(input);
    const path = normalizeProjectEvidencePath(input.path, true) || ".";
    const view = mapView(
      this.store,
      { ...input, path, offset, allowedPathPrefixes: prefixes },
      this.views,
    );
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    return view;
  }

  private requireReadableMap(version: string, signal: AbortSignal) {
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    this.requireCurrentMap(version);
    if (!this.store.getIndexProgress(version).complete)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
  }

  async explore(input: MapExploreInput, signal: AbortSignal): Promise<MapExploreResult> {
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    this.requireCurrentMap(input.version);
    if (!this.store.getIndexProgress(input.version).complete)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
    const {
      offset,
      maxResults,
      scope: authorizationScope,
      prefixes,
    } = admission(input, PROJECT_MAP_LIMITS.exploreItems);
    const scope = input.scope ?? "RELATED";
    const depth = input.depth ?? null;
    if (
      !["RELATED", "PROJECT"].includes(scope) ||
      (depth !== null && (!Number.isSafeInteger(depth) || depth < 1)) ||
      (scope === "PROJECT" &&
        (input.entityRef !== undefined ||
          input.locator !== undefined ||
          input.depth !== undefined ||
          input.direction !== "BOTH"))
    )
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    const selection = mapQuerySelection(input, MapRelationKindSchema.options);
    if (!["INCOMING", "OUTGOING", "BOTH"].includes(input.direction))
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    const object =
      scope === "RELATED"
        ? requireMapObject(this.store, input.version, input, prefixes)
        : undefined;
    const traversalInput = {
      version: input.version,
      ...(object ? { entityRef: object.id } : {}),
      direction: input.direction,
      depth,
      scope,
      authorizationScope,
      selection,
    };
    const traversalKey = canonicalJson(traversalInput);
    const traversal =
      this.traversals.get(traversalKey) ??
      (await mapExploreTraversal(this.store, traversalInput, signal));
    const { relationRefs, frontier } = traversal;
    const totalRelations = relationRefs.length;
    const notes = object
      ? this.store.database
          .prepare(`SELECT note_json FROM project_map_notes WHERE version_ref = ? AND entity_ref = ?
      ORDER BY CASE json_extract(note_json, '$.kind') WHEN 'SOURCE_DOCUMENTATION' THEN 0 WHEN 'CONTRACT_DECLARATION' THEN 1 ELSE 2 END,
      json_extract(note_json, '$.anchor.start') LIMIT 6`)
          .all(input.version, object.id)
          .map((row) => MapNoteSchema.parse(JSON.parse(String(row.note_json))))
          .filter((note) => mapPathAllowed(note.anchor.path, prefixes))
      : [];
    const selectedNotes = [];
    let noteBytes = 0;
    for (const note of notes.slice(0, 5)) {
      noteBytes += Buffer.byteLength(canonicalJson(note), "utf8");
      if (noteBytes > 8 * 1024) break;
      selectedNotes.push(note);
    }
    const metadata = {
      ...MAP_QUERY_GUIDANCE,
      query: { ...selection, scope, direction: input.direction, depth },
      ...(object
        ? { object, context: this.context(input.version, object.contextRef, prefixes) }
        : {}),
      notes: selectedNotes,
      notesTruncated: notes.length > selectedNotes.length,
      gaps: this.gaps(input.version, prefixes),
    };
    const rows: Array<MapExploreResult["relations"][number]> = [];
    const materialize = (count: number): MapExploreResult => ({
      ...metadata,
      relations: rows.slice(0, count),
      coverage: {
        totalRelations,
        returnedRelations: count,
        remainingRelations: Math.max(0, totalRelations - offset - count),
      },
      traversal: {
        semantics: "STATIC_RELATIONSHIPS" as const,
        frontier: mapPageFrontier(frontier, rows.slice(0, count)),
      },
      ...(totalRelations > offset + count ? { nextOffset: offset + count } : {}),
      pageExhausted: totalRelations <= offset + count,
    });
    const readRow = mapExplorePageRows(this.store, input.version);
    const end = Math.min(totalRelations, offset + maxResults);
    for (let position = offset; position < end; ) {
      const batchEnd = Math.min(end, position + 256);
      for (; position < batchEnd; position++) {
        const ref = relationRefs[position];
        if (ref === undefined)
          throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
        rows.push(readRow(ref));
      }
      await setImmediate();
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      if (position === end) break;
      const { nextOffset: _nextOffset, ...minimum } = mapExploreNavigation(
        materialize(rows.length),
      );
      // A later complete page can shed its cursor and shorten coverage counters.
      // File labels can also move when an anchor-only file gains a declaration.
      // Measure their shortest forms before deciding no longer prefix can fit.
      const minimumBytes = Buffer.byteLength(
        canonicalJson({
          ...minimum,
          text: minimum.text.replace(/\bF[1-9]\d*/gu, "F1"),
          pageExhausted: true,
          coverage: { ...minimum.coverage, remainingRelations: 0 },
        }),
      );
      if (
        minimumBytes + (input.outputBudget?.envelopeBytes ?? 0) >
        (input.outputBudget?.maxBytes ?? PROJECT_MAP_LIMITS.queryBytes)
      )
        break;
    }
    const page = mapQueryPage(rows.length, materialize, mapExploreNavigation, input.outputBudget);
    await setImmediate();
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    this.rememberTraversal(traversalKey, traversal);
    return page;
  }

  private requireCurrentMap(version: string) {
    if (this.store.requireVersion(version).analyzer !== PROJECT_MAP_ANALYZER)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
  }

  private context(version: string, ref: string, prefixes: readonly string[]) {
    const row = this.store.database
      .prepare(
        "SELECT context_json FROM project_map_contexts WHERE version_ref = ? AND context_ref = ?",
      )
      .get(version, ref);
    if (!row) throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
    const context = MapContextSchema.parse(JSON.parse(String(row.context_json)));
    return {
      ref: context.ref,
      mode: context.mode,
      optionsDigest: context.optionsDigest,
      ...(context.resolution ? { resolution: context.resolution } : {}),
      ...(context.configPath && mapPathAllowed(context.configPath, prefixes)
        ? { configPath: context.configPath }
        : {}),
    };
  }

  gaps(version: string, prefixes: readonly string[]): MapGap[] {
    const row = this.store.database
      .prepare("SELECT coverage_json FROM project_map_coverage WHERE version_ref = ?")
      .get(version);
    if (!row) throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
    const coverage = JSON.parse(String(row.coverage_json)) as { gaps: MapGap[] };
    const visible = coverage.gaps
      .filter((gap) => !gap.path || mapPathAllowed(gap.path, prefixes))
      .map((gap) => (!gap.path && !prefixes.includes(".") ? { code: gap.code } : gap));
    if (!prefixes.includes(".")) visible.unshift({ code: "QUERY_LIMITED_TO_AUTHORIZED_PATHS" });
    const summaries = new Map<
      string,
      Readonly<{ gap: MapGap; count: number; explicitCount: boolean }>
    >();
    for (const gap of visible) {
      const key = `${gap.code}\u0000${gap.path ?? ""}`;
      const existing = summaries.get(key);
      summaries.set(key, {
        gap: existing?.gap ?? gap,
        count: (existing?.count ?? 0) + (gap.count ?? 1),
        explicitCount: Boolean(existing?.explicitCount || gap.count),
      });
    }
    const gaps = [...summaries.values()].map(({ gap, count, explicitCount }) => ({
      code: gap.code,
      ...(gap.path ? { path: gap.path } : {}),
      ...(count > 1 || explicitCount ? { count } : {}),
    }));
    const selected: MapGap[] = [];
    let bytes = 0;
    for (const gap of gaps.slice(0, 19)) {
      bytes += Buffer.byteLength(canonicalJson(gap), "utf8");
      if (bytes > 4 * 1024) break;
      selected.push(gap);
    }
    return selected.length === gaps.length
      ? selected
      : [...selected, { code: "ADDITIONAL_COVERAGE_GAPS" }];
  }
}

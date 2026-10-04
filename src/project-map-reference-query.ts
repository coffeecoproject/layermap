import type { CodeIndexStore } from "./code-index-store";
import { normalizeProjectEvidencePath, ProjectEvidenceError } from "./core";
import { decodeQueryCursor, encodeQueryCursor } from "./cursor";
import { canonicalJson, digestValue } from "./digest";
import type { ProjectMapAnalyzer } from "./project-map-analyzer";
import { PROJECT_MAP_ANALYZER } from "./project-map-language";
import { mapReferenceNavigation } from "./project-map-navigation";
import { requireMapObject } from "./project-map-object-query";
import { MAP_QUERY_GUIDANCE, ProjectMapQuery } from "./project-map-query";
import { mapQueryPage } from "./project-map-query-page";
import { mapQueryPathMatches, mapQuerySelection } from "./project-map-query-selection";
import {
  type MapReferenceInput,
  MapReferenceKindSchema,
  type MapReferenceResult,
} from "./project-map-reference-types";
import { ProjectMapSourceReader, readAll } from "./project-map-source";
import { MapContextSchema, MapObjectSchema, mapPathAllowed } from "./project-map-types";

export class ProjectMapReferenceQuery {
  constructor(
    private readonly store: CodeIndexStore,
    private readonly analyzer: ProjectMapAnalyzer,
  ) {}

  async query(input: MapReferenceInput, signal: AbortSignal): Promise<MapReferenceResult> {
    const source = Object.freeze({
      ...input.source,
      directory: Object.freeze({ ...input.source.directory }),
    });
    const version = this.store.requireVersion(input.version);
    if (version.analyzer !== PROJECT_MAP_ANALYZER)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
    if (version.projectRef !== source.projectRef)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_ACCESS_REVOKED", false);
    if (!this.store.getIndexProgress(input.version).complete)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 200)
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    const prefixes = (input.allowedPathPrefixes ?? ["."]).map(
      (p) => normalizeProjectEvidencePath(p, true) || ".",
    );
    if (!prefixes.length || prefixes.length > 64)
      throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
    const selection = mapQuerySelection(input, MapReferenceKindSchema.options);
    const query = { path: selection.path, kinds: [...selection.kinds] };
    const object = requireMapObject(this.store, input.version, input, prefixes);
    if (object.symbolStart === undefined)
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", false);
    const availableContexts = this.store.database
      .prepare(`SELECT DISTINCT c.context_ref, c.context_json
      FROM project_map_contexts c, json_each(c.context_json, '$.inputFiles') f
      WHERE c.version_ref = ? AND f.value = ?
      AND json_extract(c.context_json, '$.mode') != 'SYNTAX_ONLY'
      ORDER BY c.context_ref`)
      .all(input.version, object.anchor.path)
      .map((value) => MapContextSchema.parse(JSON.parse(String(value.context_json))));
    if (!availableContexts.length)
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_CONTEXT_UNAVAILABLE", false);
    const contexts = availableContexts.filter((context) =>
      context.inputFiles.some((file) => mapQueryPathMatches(file, query.path)),
    );
    if (
      contexts.some((context) => context.inputFiles.some((file) => !mapPathAllowed(file, prefixes)))
    )
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_CONTEXT_NOT_AUTHORIZED", false);
    const scope = digestValue({
      version: input.version,
      source,
      target: object.id,
      prefixes,
      query,
      maxResults: input.maxResults,
    });
    const [cursorContext = 0, cursorOffset = 0] = input.cursor
      ? decodeQueryCursor(this.store.cursorSecret(), `REFERENCES\n${scope}`, input.cursor, 2)
      : [];
    const cursor = { context: cursorContext, offset: cursorOffset };
    const metadata = {
      ...MAP_QUERY_GUIDANCE,
      object,
      query,
      gaps: new ProjectMapQuery(this.store).gaps(input.version, prefixes),
    };
    if (!contexts.length) {
      if (input.cursor) throw new ProjectEvidenceError("PROJECT_CONTINUATION_INVALID", false);
      return mapQueryPage(
        0,
        (): MapReferenceResult => ({
          ...metadata,
          references: [],
          pageExhausted: true,
          coverage: { precedingContexts: 0, totalContexts: 0, contextComplete: true },
        }),
        mapReferenceNavigation,
        input.outputBudget,
      );
    }
    const context = contexts[cursor.context];
    if (!context) throw new ProjectEvidenceError("PROJECT_CONTINUATION_INVALID", false);
    const entries = context.inputFiles.map((file) => {
      const entry = this.store.getEntry(input.version, file);
      if (entry?.state !== "TEXT")
        throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
      return entry;
    });
    const reader = await ProjectMapSourceReader.open(source, signal, false);
    const files: Record<string, string> = Object.create(null);
    const contents = await readAll(entries, (entry) => reader.read(entry.path, entry));
    for (const [index, entry] of entries.entries()) {
      const value = contents[index];
      if (!value?.content) throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
      files[entry.path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        value.content,
      );
    }
    const page = await this.analyzer.references(
      {
        contextRef: context.ref,
        configPath: context.configPath,
        rootFiles: context.rootFiles,
        files,
        inventory: context.inputFiles,
        syntaxOnly: false,
        workspace: context.workspace,
      },
      {
        targetPath: object.anchor.path,
        symbolStart: object.symbolStart,
        offset: cursor.offset,
        maxResults: input.maxResults,
        ...query,
      },
      signal,
    );
    if (page.requiredFiles.length)
      throw new ProjectEvidenceError("PROJECT_MAP_CONTEXT_INCOMPLETE", false);
    if (
      page.nextOffset !== undefined &&
      (!page.references.length || page.nextOffset !== cursor.offset + page.references.length)
    )
      throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
    const references: MapReferenceResult["references"] = [];
    const locations = new Set<string>();
    for (const reference of page.references) {
      const text = files[reference.anchor.path];
      const location = canonicalJson(reference.anchor);
      if (
        text === undefined ||
        reference.anchor.start < 0 ||
        reference.anchor.end < reference.anchor.start ||
        reference.anchor.end > text.length ||
        !mapPathAllowed(reference.anchor.path, prefixes) ||
        !mapQueryPathMatches(reference.anchor.path, query.path) ||
        !query.kinds.includes(reference.kind) ||
        locations.has(location)
      )
        throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
      locations.add(location);
      const row = this.store.database
        .prepare(`SELECT object_json FROM project_map_objects
        WHERE version_ref = ? AND path = ?
        AND json_extract(object_json, '$.anchor.start') <= ? AND json_extract(object_json, '$.anchor.end') >= ?
        ORDER BY json_extract(object_json, '$.anchor.end') - json_extract(object_json, '$.anchor.start'), entity_ref LIMIT 1`)
        .get(input.version, reference.anchor.path, reference.anchor.start, reference.anchor.end);
      const owner = row ? MapObjectSchema.parse(JSON.parse(String(row.object_json))) : undefined;
      const item = { ...reference, contextRef: context.ref, ...(owner ? { owner } : {}) };
      references.push(item);
    }
    await reader.assertStable();
    if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    return mapQueryPage(
      references.length,
      (count): MapReferenceResult => {
        const contextComplete = count === references.length && page.nextOffset === undefined;
        const next = contextComplete
          ? { context: cursor.context + 1, offset: 0 }
          : { context: cursor.context, offset: cursor.offset + count };
        return {
          ...metadata,
          references: references.slice(0, count),
          pageExhausted: next.context >= contexts.length,
          ...(next.context < contexts.length
            ? {
                nextCursor: encodeQueryCursor(this.store.cursorSecret(), `REFERENCES\n${scope}`, [
                  next.context,
                  next.offset,
                ]),
              }
            : {}),
          coverage: {
            precedingContexts: cursor.context,
            totalContexts: contexts.length,
            contextComplete,
          },
        };
      },
      mapReferenceNavigation,
      input.outputBudget,
    );
  }
}

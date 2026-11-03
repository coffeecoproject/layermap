import type { CodeIndexStore } from "./code-index-store";
import type { CodeIndexSource } from "./code-index-types";
import { normalizeProjectEvidencePath, ProjectEvidenceError } from "./core";
import { decodeQueryCursor, encodeQueryCursor } from "./cursor";
import { canonicalJson, digestValue } from "./digest";
import type { ProjectMapAnalyzer } from "./project-map-analyzer";
import { mapReferenceNavigation } from "./project-map-navigation";
import { requireMapObject } from "./project-map-object-query";
import { MAP_QUERY_GUIDANCE, ProjectMapQuery } from "./project-map-query";
import { mapQueryPage } from "./project-map-query-page";
import { mapQueryPathMatches, mapQuerySelection } from "./project-map-query-selection";
import {
  type MapReference,
  type MapReferenceInput,
  MapReferenceKindSchema,
  type MapReferenceResult,
  type MapUses,
  type MapUsesInput,
} from "./project-map-reference-types";
import { ProjectMapSourceReader } from "./project-map-source";
import {
  type MapAnchor,
  type MapContext,
  MapContextSchema,
  type MapObject,
  MapObjectSchema,
  mapPathAllowed,
} from "./project-map-types";

const invalidProtocol = () => new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);

// Whether a reference is a span of the text its compile read.
const anchored = ({ anchor }: MapReference, files: Readonly<Record<string, string>>) => {
  const text = files[anchor.path];
  return (
    text !== undefined &&
    anchor.start >= 0 &&
    anchor.end >= anchor.start &&
    anchor.end <= text.length
  );
};

export class ProjectMapReferenceQuery {
  constructor(
    private readonly store: CodeIndexStore,
    private readonly analyzer: ProjectMapAnalyzer,
  ) {}

  // The source to read a complete map version from, once that version is this source's to read.
  private readable(version: string, input: CodeIndexSource) {
    const source = Object.freeze({
      ...input,
      directory: Object.freeze({ ...input.directory }),
    });
    const stored = this.store.requireVersion(version);
    if (stored.analyzer !== this.analyzer.id)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
    if (stored.projectRef !== source.projectRef)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_ACCESS_REVOKED", false);
    if (!this.store.getIndexProgress(version).complete)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_UNAVAILABLE", true);
    return source;
  }

  // The compiler contexts a file is in.
  private contexts(version: string, path: string) {
    return this.store.database
      .prepare(`SELECT DISTINCT c.context_ref, c.context_json
      FROM project_map_contexts c, json_each(c.context_json, '$.inputFiles') f
      WHERE c.version_ref = ? AND f.value = ?
      AND json_extract(c.context_json, '$.mode') != 'SYNTAX_ONLY'
      ORDER BY c.context_ref`)
      .all(version, path)
      .map((value) => MapContextSchema.parse(JSON.parse(String(value.context_json))));
  }

  // A context's sources, and the request for its compile.
  private async open(
    version: string,
    source: CodeIndexSource,
    context: MapContext,
    signal: AbortSignal,
  ) {
    const entries = context.inputFiles.map((file) => {
      const entry = this.store.getEntry(version, file);
      if (entry?.state !== "TEXT")
        throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
      return entry;
    });
    const reader = await ProjectMapSourceReader.open(source, signal, false);
    const files: Record<string, string> = Object.create(null);
    const contents = await reader.readAll(entries);
    for (const [index, entry] of entries.entries()) {
      const value = contents[index];
      if (!value?.content) throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
      files[entry.path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        value.content,
      );
    }
    return {
      reader,
      files,
      request: {
        contextRef: context.ref,
        configPath: context.configPath,
        rootFiles: context.rootFiles,
        files,
        inventory: context.inputFiles,
        syntaxOnly: false,
        workspace: context.workspace,
      },
    };
  }

  // The innermost object around a location.
  private owner(version: string, anchor: MapAnchor): MapObject | undefined {
    const row = this.store.database
      .prepare(`SELECT object_json FROM project_map_objects
      WHERE version_ref = ? AND path = ?
      AND json_extract(object_json, '$.anchor.start') <= ? AND json_extract(object_json, '$.anchor.end') >= ?
      ORDER BY json_extract(object_json, '$.anchor.end') - json_extract(object_json, '$.anchor.start'), entity_ref LIMIT 1`)
      .get(version, anchor.path, anchor.start, anchor.end);
    return row ? MapObjectSchema.parse(JSON.parse(String(row.object_json))) : undefined;
  }

  /**
   * The uses of many declarations of one version, each context they are in compiled once, for as
   * long as the deadline leaves. A declaration not read to the end says so, with what was found.
   */
  async uses(input: MapUsesInput, signal: AbortSignal): Promise<MapUses> {
    const source = this.readable(input.version, input.source);
    type Read = {
      uses: (MapReference & { owner?: MapObject })[];
      locations: Set<string>;
      waiting: number;
      complete: boolean;
    };
    const found = new Map<string, Read>();
    const contextsOf = new Map<string, MapContext[]>();
    const compiles = new Map<string, { context: MapContext; targets: MapObject[] }>();
    for (const ref of input.refs) {
      const object = requireMapObject(this.store, input.version, { entityRef: ref }, ["."]);
      const path = object.anchor.path;
      const contexts = contextsOf.get(path) ?? this.contexts(input.version, path);
      contextsOf.set(path, contexts);
      // Some declarations have no reference target, as in a file read only for its syntax.
      const readable = object.symbolStart === undefined ? [] : contexts;
      found.set(ref, {
        uses: [],
        locations: new Set(),
        waiting: readable.length,
        complete: readable.length > 0,
      });
      for (const context of readable) {
        const compile = compiles.get(context.ref) ?? { context, targets: [] };
        compile.targets.push(object);
        compiles.set(context.ref, compile);
      }
    }
    for (const { context, targets } of compiles.values()) {
      if (Date.now() > input.until) break;
      const { reader, files, request } = await this.open(input.version, source, context, signal);
      const { pages, requiredFiles } = await this.analyzer.references(
        request,
        targets.map((object) => ({
          targetPath: object.anchor.path,
          symbolStart: object.symbolStart as number,
          offset: 0,
          maxResults: input.maxResults,
        })),
        signal,
        input.until,
      );
      if (requiredFiles.length)
        throw new ProjectEvidenceError("PROJECT_MAP_CONTEXT_INCOMPLETE", false);
      if (pages.length > targets.length)
        throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
      for (const [at, page] of pages.entries()) {
        const read = found.get(targets[at]?.id ?? "") as Read;
        read.waiting--;
        if (!page || page.nextOffset !== undefined) read.complete = false;
        for (const reference of page?.references ?? []) {
          const location = canonicalJson(reference.anchor);
          if (!anchored(reference, files)) throw invalidProtocol();
          if (read.locations.has(location)) continue;
          read.locations.add(location);
          const owner = this.owner(input.version, reference.anchor);
          read.uses.push({ ...reference, ...(owner ? { owner } : {}) });
        }
      }
      await reader.assertStable();
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
    }
    return new Map(
      [...found].map(([ref, { uses, waiting, complete }]) => [
        ref,
        { uses, complete: complete && !waiting },
      ]),
    );
  }

  async query(input: MapReferenceInput, signal: AbortSignal): Promise<MapReferenceResult> {
    const source = this.readable(input.version, input.source);
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
    const availableContexts = this.contexts(input.version, object.anchor.path);
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
      gaps: new ProjectMapQuery(this.store, this.analyzer.id).gaps(input.version, prefixes),
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
    const { reader, files, request } = await this.open(input.version, source, context, signal);
    const {
      pages: [page],
      requiredFiles,
    } = await this.analyzer.references(
      request,
      [
        {
          targetPath: object.anchor.path,
          symbolStart: object.symbolStart,
          offset: cursor.offset,
          maxResults: input.maxResults,
          ...query,
        },
      ],
      signal,
    );
    if (requiredFiles.length)
      throw new ProjectEvidenceError("PROJECT_MAP_CONTEXT_INCOMPLETE", false);
    if (page === undefined) throw invalidProtocol();
    if (page === null)
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", false);
    if (
      page.nextOffset !== undefined &&
      (!page.references.length || page.nextOffset !== cursor.offset + page.references.length)
    )
      throw invalidProtocol();
    const references: MapReferenceResult["references"] = [];
    const locations = new Set<string>();
    for (const reference of page.references) {
      const location = canonicalJson(reference.anchor);
      if (
        !anchored(reference, files) ||
        !mapPathAllowed(reference.anchor.path, prefixes) ||
        !mapQueryPathMatches(reference.anchor.path, query.path) ||
        !query.kinds.includes(reference.kind) ||
        locations.has(location)
      )
        throw invalidProtocol();
      locations.add(location);
      const owner = this.owner(input.version, reference.anchor);
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

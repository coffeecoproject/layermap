import { z } from "zod";
import {
  type MapReferenceResult,
  MapReferenceResultSchema,
  MapReferenceSchema,
} from "./project-map-reference-types";
import {
  decodeMapText,
  encodeMapText,
  MapTextGraphSchema,
  MapTextObjectSchema,
} from "./project-map-text";
import {
  MapAnchorSchema,
  MapContextProjectionSchema,
  type MapExploreResult,
  MapGapSchema,
  type MapObject,
  MapObjectKindSchema,
  MapRelationKindSchema,
  MapSearchMatchFieldSchema,
  MapSearchMatchModeSchema,
  type MapSearchResult,
} from "./project-map-types";

const locationSchema = MapAnchorSchema.describe(
  "Source location: start/end are zero-based UTF-16 offsets with an exclusive end; line numbers are one-based.",
);
const location = ({ path, startLine, endLine, start, end }: MapObject["anchor"]) => ({
  path,
  startLine,
  endLine,
  start,
  end,
});

export const MapNavigationObjectSchema = MapTextObjectSchema.extend({ anchor: locationSchema });
export type MapNavigationObject = z.infer<typeof MapNavigationObjectSchema>;

const projected = ({ id, name, kind, anchor, execution }: MapObject): MapNavigationObject => ({
  id,
  name,
  kind,
  anchor: location(anchor),
  ...(execution ? { execution } : {}),
});
const objects = (values: readonly MapObject[]) =>
  [...new Map(values.map((object) => [object.id, object])).values()].map(projected);
const searchSymbolSchema = MapNavigationObjectSchema.omit({ anchor: true }).extend({
  ...locationSchema.omit({ path: true }).shape,
  match: z
    .object({
      terms: z.array(z.string()),
      fields: z.array(MapSearchMatchFieldSchema),
      focusDistance: z.number().int().min(0).max(2).optional(),
    })
    .strict(),
});
const searchFileSchema = z
  .object({ path: z.string(), symbols: z.array(searchSymbolSchema).min(1) })
  .strict();

const guidance = {
  evidenceUse: z.literal("NAVIGATION_ONLY"),
  freshness: z.literal("MAP_NOT_CONTINUOUSLY_UPDATED"),
  sourceVerification: z.literal("READ_SOURCE_BEFORE_RELYING_ON_LOCATIONS"),
  authority: z.literal("CODE_FACTS_AND_SOURCE_DECLARATIONS_NOT_BUSINESS_AUTHORITY"),
  testing: z.literal("TEST_ASSOCIATION_IS_NOT_BEHAVIOR_VERIFICATION"),
  gaps: z.array(MapGapSchema),
  nextOffset: z.number().int().nonnegative().optional(),
  pageExhausted: z.boolean(),
};
export const MapSearchNavigationSchema = z
  .object({
    ...guidance,
    query: z
      .object({
        path: z.string(),
        kinds: z.array(MapObjectKindSchema),
        text: z.string(),
        terms: z.array(z.string()),
        matchMode: MapSearchMatchModeSchema,
        focusRefs: z.array(z.string()),
      })
      .strict(),
    files: z.array(searchFileSchema),
  })
  .strict();
const exploreMetadata = {
  ...guidance,
  query: z
    .object({
      path: z.string(),
      kinds: z.array(MapRelationKindSchema),
      direction: z.enum(["INCOMING", "OUTGOING", "BOTH"]),
      scope: z.enum(["RELATED", "PROJECT"]),
      depth: z.number().int().positive().nullable(),
    })
    .strict(),
  context: MapContextProjectionSchema.omit({ ref: true, optionsDigest: true }).optional(),
  coverage: z
    .object({
      totalRelations: z.number().int().nonnegative(),
      returnedRelations: z.number().int().nonnegative(),
      remainingRelations: z.number().int().nonnegative(),
    })
    .strict(),
  notesTruncated: z.boolean(),
};

export const MapExploreDecodedSchema = z
  .object({ ...exploreMetadata, ...MapTextGraphSchema.shape })
  .passthrough();

export const MapExploreNavigationSchema = z
  .object({
    ...exploreMetadata,
    format: z.literal("CODE_MAP_TEXT_V1"),
    text: z.string().superRefine((text, context) => {
      try {
        decodeMapText(text);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid CODE_MAP_TEXT_V1 navigation." });
      }
    }),
  })
  .strict();

// Tool evidence carries a source/budget envelope. Decode the navigation once while
// preserving that envelope for existing evidence selectors and offline evaluators.
export const decodeMapExploreNavigation = (output: unknown) => {
  const {
    format: _format,
    text,
    ...metadata
  } = MapExploreNavigationSchema.passthrough().parse(output);
  return MapExploreDecodedSchema.parse({ ...metadata, ...decodeMapText(text) });
};

export const MapReferenceNavigationSchema = MapReferenceResultSchema.omit({
  object: true,
  references: true,
}).extend({
  targetRef: z.string(),
  objects: z.array(MapNavigationObjectSchema),
  references: z.array(
    MapReferenceSchema.extend({
      anchor: locationSchema,
      contextRef: z.string().optional(),
      ownerRef: z.string().optional(),
    }).strict(),
  ),
});

// All evidence consumers flatten the same public projection, never compiler objects.
export const MapNavigationObjectsSchema = z.union([
  MapExploreNavigationSchema.passthrough().transform(
    (value) => decodeMapExploreNavigation(value).objects,
  ),
  z
    .object({ files: z.array(searchFileSchema) })
    .passthrough()
    .refine((value) => !("format" in value), "Text navigation must decode through its format.")
    .transform((value): MapNavigationObject[] =>
      value.files.flatMap(({ path, symbols }) =>
        symbols.map(({ id, name, kind, startLine, endLine, start, end, execution }) => ({
          id,
          name,
          kind,
          anchor: { path, startLine, endLine, start, end },
          ...(execution ? { execution } : {}),
        })),
      ),
    ),
  z
    .object({ objects: z.array(MapNavigationObjectSchema) })
    .passthrough()
    .refine((value) => !("format" in value), "Text navigation must decode through its format.")
    .transform((value) => value.objects),
]);

export const mapNavigationObjects = (output: unknown): MapNavigationObject[] =>
  MapNavigationObjectsSchema.parse(output);

export const mapSearchNavigation = (result: MapSearchResult) => {
  const { objects: found, rankings, ...metadata } = result;
  const files: z.infer<typeof searchFileSchema>[] = [];
  for (const [index, object] of found.entries()) {
    const ranking = rankings[index];
    if (!ranking) throw new Error("PROJECT_MAP_SEARCH_RANKING_MISSING");
    const path = object.anchor.path;
    // Merge only adjacent hits: regrouping all hits for a file destroys relevance order.
    let file = files.at(-1);
    if (file?.path !== path) {
      file = { path, symbols: [] };
      files.push(file);
    }
    file.symbols.push({
      id: object.id,
      name: object.name,
      kind: object.kind,
      startLine: object.anchor.startLine,
      endLine: object.anchor.endLine,
      start: object.anchor.start,
      end: object.anchor.end,
      ...(object.execution ? { execution: object.execution } : {}),
      match: {
        terms: [...ranking.matchedTerms],
        fields: [...ranking.matchedFields],
        ...(ranking.focusDistance === undefined ? {} : { focusDistance: ranking.focusDistance }),
      },
    });
  }
  return { ...metadata, files };
};
export const mapExploreNavigation = (result: MapExploreResult) => {
  const { object, relations, notes, context, traversal, ...metadata } = result;
  const parsing = context
    ? (({ ref: _ref, optionsDigest: _digest, ...value }) => value)(context)
    : undefined;
  return {
    ...metadata,
    ...(parsing ? { context: parsing } : {}),
    format: "CODE_MAP_TEXT_V1" as const,
    text: encodeMapText({
      ...(object ? { targetRef: object.id } : {}),
      objects: objects([
        ...(object ? [object] : []),
        ...relations.flatMap((edge) => (edge.to ? [edge.from, edge.to] : [edge.from])),
      ]),
      traversal: {
        semantics: traversal.semantics,
        frontier: traversal.frontier.map((node) => ({ ...node })),
      },
      notes: notes.map((note) => ({ ...note, anchor: location(note.anchor) })),
      relations: relations.map(({ relation }) => ({
        relation: { ...relation, anchor: location(relation.anchor) },
      })),
    }),
  };
};
export const mapReferenceNavigation = (result: MapReferenceResult) => {
  const { object, references, ...metadata } = result;
  return {
    ...metadata,
    targetRef: object.id,
    objects: objects([
      object,
      ...references.flatMap((reference) => (reference.owner ? [reference.owner] : [])),
    ]),
    references: references.map(({ owner, contextRef, anchor, ...reference }) => ({
      ...reference,
      anchor: location(anchor),
      ...(result.coverage.totalContexts > 1 ? { contextRef } : {}),
      ...(owner ? { ownerRef: owner.id } : {}),
    })),
  };
};

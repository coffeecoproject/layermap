import { z } from "zod";
import type { CodeIndexSource } from "./code-index-types";
import type { MapQueryOutputBudget } from "./project-map-query-page";
import {
  MapAnchorSchema,
  type MapExploreInput,
  MapGapSchema,
  type MapObject,
  MapObjectSchema,
  type MapSymbolSelector,
} from "./project-map-types";

export const MapReferenceKindSchema = z.enum([
  "DECLARATION",
  "CALL",
  "WRITE",
  "READ",
  "IMPORT_EXPORT",
  "REFERENCE",
]);
export const MapReferenceSchema = z
  .object({
    anchor: MapAnchorSchema,
    kind: MapReferenceKindSchema,
  })
  .strict();
export type MapReference = z.infer<typeof MapReferenceSchema>;
/** The most references a request may ask of one declaration at a time. */
export const MAP_REFERENCES_MAX = 1000;
export const MapReferencePageSchema = z
  .object({
    references: z.array(MapReferenceSchema).max(MAP_REFERENCES_MAX),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict();
export type MapReferencePage = z.infer<typeof MapReferencePageSchema>;
/**
 * What one compile of a context found: a page for each request in order, null where the request
 * names no declaration to follow. It stops short of the last requests when a deadline passed.
 */
export const MapReferenceBatchSchema = z
  .object({
    pages: z.array(MapReferencePageSchema.nullable()),
    requiredFiles: z.array(z.string()),
  })
  .strict();
export type MapReferenceBatch = z.infer<typeof MapReferenceBatchSchema>;
export type MapReferenceRequest = Readonly<{
  targetPath: string;
  symbolStart: number;
  offset: number;
  maxResults: number;
  path?: string;
  kinds?: readonly z.infer<typeof MapReferenceKindSchema>[];
}>;
export type MapReferenceInput = Readonly<{
  version: string;
  source: CodeIndexSource;
  entityRef?: string;
  locator?: MapExploreInput["locator"];
  symbol?: MapSymbolSelector;
  maxResults: number;
  cursor?: string;
  allowedPathPrefixes?: readonly string[];
  path?: string;
  kinds?: readonly z.infer<typeof MapReferenceKindSchema>[];
  outputBudget?: MapQueryOutputBudget;
}>;
/** The uses of many declarations of one version, read by the context each is in. */
export type MapUsesInput = Readonly<{
  version: string;
  source: CodeIndexSource;
  refs: readonly string[];
  /** When to stop reading more; a compile under way finishes its first declaration. */
  until: number;
  maxResults: number;
}>;
/** What was found of each declaration; complete is false when any of its uses went unread. */
export type MapUses = ReadonlyMap<
  string,
  Readonly<{
    uses: readonly (MapReference & Readonly<{ owner?: MapObject }>)[];
    complete: boolean;
  }>
>;
export const MapReferenceResultSchema = z
  .object({
    evidenceUse: z.literal("NAVIGATION_ONLY"),
    freshness: z.literal("MAP_NOT_CONTINUOUSLY_UPDATED"),
    sourceVerification: z.literal("READ_SOURCE_BEFORE_RELYING_ON_LOCATIONS"),
    authority: z.literal("CODE_FACTS_AND_SOURCE_DECLARATIONS_NOT_BUSINESS_AUTHORITY"),
    testing: z.literal("TEST_ASSOCIATION_IS_NOT_BEHAVIOR_VERIFICATION"),
    object: MapObjectSchema,
    query: z.object({ path: z.string(), kinds: z.array(MapReferenceKindSchema) }).strict(),
    references: z.array(
      MapReferenceSchema.extend({
        contextRef: z.string(),
        owner: MapObjectSchema.optional(),
      }),
    ),
    gaps: z.array(MapGapSchema),
    nextCursor: z.string().optional(),
    pageExhausted: z.boolean(),
    coverage: z
      .object({
        precedingContexts: z.number().int().nonnegative(),
        totalContexts: z.number().int().nonnegative(),
        contextComplete: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type MapReferenceResult = z.infer<typeof MapReferenceResultSchema>;

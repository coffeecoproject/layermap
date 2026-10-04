import { z } from "zod";
import type { CodeIndexSource } from "./code-index-types";
import type { MapQueryOutputBudget } from "./project-map-query-page";
import {
  MapAnchorSchema,
  type MapExploreInput,
  MapGapSchema,
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
export const MapReferencePageSchema = z
  .object({
    references: z.array(MapReferenceSchema).max(200),
    nextOffset: z.number().int().nonnegative().optional(),
    requiredFiles: z.array(z.string()),
  })
  .strict();
export type MapReferencePage = z.infer<typeof MapReferencePageSchema>;
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

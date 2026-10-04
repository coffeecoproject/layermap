import { z } from "zod";
import {
  MapAnchorSchema,
  MapContextProjectionSchema,
  MapGapSchema,
  MapNoteSchema,
  MapObjectKindSchema,
  MapRelationKindSchema,
  MapRelationSchema,
} from "./project-map-types";

// Saved navigation predates execution ownership. Keep its exact semantic fields:
// adding live defaults here would change historical navigation selection hashes.
const archivedObject = z
  .object({
    id: z.string().min(1),
    contextRef: z.string().min(1),
    kind: MapObjectKindSchema,
    name: z.string().max(256),
    anchor: MapAnchorSchema,
    exported: z.boolean(),
    contextRole: z.enum(["DEFAULT", "DEPENDENCY"]).optional(),
    symbolStart: z.number().int().nonnegative().optional(),
    language: z.string().optional(),
    parsing: z
      .enum(["PARSED", "SYNTAX_ONLY", "NOT_PARSED", "NOT_ANALYZED", "CONFIGURATION_INPUT"])
      .optional(),
  })
  .strict();

export const ArchivedMapNavigationObjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    kind: MapObjectKindSchema,
    anchor: MapAnchorSchema,
  })
  .strict();

// This is the saved single-hop output, not an alternative live exploration contract.
// No depth or frontier is inferred for old records.
export const ArchivedMapExploreNavigationSchema = z
  .object({
    evidenceUse: z.literal("NAVIGATION_ONLY"),
    freshness: z.literal("MAP_NOT_CONTINUOUSLY_UPDATED"),
    sourceVerification: z.literal("READ_SOURCE_BEFORE_RELYING_ON_LOCATIONS"),
    authority: z.literal("CODE_FACTS_AND_SOURCE_DECLARATIONS_NOT_BUSINESS_AUTHORITY"),
    testing: z.literal("TEST_ASSOCIATION_IS_NOT_BEHAVIOR_VERIFICATION"),
    gaps: z.array(MapGapSchema),
    nextOffset: z.number().int().nonnegative().optional(),
    pageExhausted: z.boolean(),
    query: z
      .object({
        path: z.string(),
        kinds: z.array(MapRelationKindSchema),
        direction: z.enum(["INCOMING", "OUTGOING", "BOTH"]),
      })
      .strict(),
    targetRef: z.string(),
    context: MapContextProjectionSchema.omit({ ref: true, optionsDigest: true }),
    objects: z.array(ArchivedMapNavigationObjectSchema),
    notes: z.array(MapNoteSchema),
    notesTruncated: z.boolean(),
    relations: z.array(z.object({ relation: MapRelationSchema }).strict()),
  })
  .strict();

// Read-only support for saved tool evidence from before compact navigation. Live tools
// never accept this shape; keeping the full object preserves historical selection hashes.
export const ArchivedMapObjectSchema = archivedObject
  .extend({
    selector: z
      .object({ kind: z.literal("MAP_OBJECT"), path: z.string(), entityRef: z.string() })
      .strict(),
  })
  .superRefine((object, context) => {
    if (object.selector.path !== object.anchor.path || object.selector.entityRef !== object.id)
      context.addIssue({
        code: "custom",
        message: "Archived map selector does not identify its object.",
      });
  });

const archivedObjects = z
  .object({
    evidenceUse: z.literal("NAVIGATION_ONLY"),
    objects: z.array(ArchivedMapObjectSchema),
  })
  .passthrough();

export const archivedMapNavigationObjects = (
  output: unknown,
):
  | readonly Readonly<{
      semantic: z.infer<typeof archivedObject>;
      selector: Readonly<{ kind: "MAP_OBJECT"; path: string; entityRef: string }>;
    }>[]
  | undefined => {
  const parsed = archivedObjects.safeParse(output);
  if (!parsed.success) return undefined;
  return Object.freeze(
    parsed.data.objects.map(({ selector, ...semantic }) =>
      Object.freeze({ semantic: Object.freeze(semantic), selector: Object.freeze(selector) }),
    ),
  );
};

import { z } from "zod";
import type { CodeIndexSource } from "./code-index-types";
import { type MapWorkspacePlan, MapWorkspacePlanSchema } from "./project-map-configuration-types";
import type { MapQueryOutputBudget } from "./project-map-query-page";
import type { MapQuerySelection } from "./project-map-query-selection";

export const PROJECT_MAP_LIMITS = Object.freeze({
  queryItems: 200,
  queryBytes: 256 * 1024,
  queryMs: 120_000,
  exploreItems: 400_000,
  stopMs: 5_000,
});

export const MapAnchorSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict();
export type MapAnchor = z.infer<typeof MapAnchorSchema>;
export const MapObjectKindSchema = z.enum([
  "FILE",
  "PACKAGE",
  "CONFIG",
  "FUNCTION",
  "CLASS",
  "INTERFACE",
  "TYPE",
  "METHOD",
  "PROPERTY",
  "VARIABLE",
  "ENUM",
]);
export const MapRelationKindSchema = z.enum([
  "CONTAINS",
  "IMPORTS",
  "CALLS",
  "REFERENCES",
  "READS",
  "WRITES",
  "EXTENDS",
  "IMPLEMENTS",
  // A member that implements or overrides the target member, so calls to it may dispatch here.
  "OVERRIDES",
  "DECORATED_BY",
  "TEST_IMPORTS",
]);

export const MapObjectLocatorSchema = z
  .object({
    path: z.string().min(1),
    start: z.number().int().nonnegative(),
    kind: MapObjectKindSchema.optional(),
  })
  .strict();
export type MapObjectLocator = z.infer<typeof MapObjectLocatorSchema>;
export const MapSymbolSelectorSchema = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1).max(512),
    line: z.number().int().positive().optional(),
  })
  .strict();
export type MapSymbolSelector = z.infer<typeof MapSymbolSelectorSchema>;

export const MapExecutionKindSchema = z.enum([
  "MODULE",
  "FUNCTION",
  "CLOSURE",
  "CONSTRUCTOR",
  "INITIALIZER",
]);

export const MapObjectSchema = z
  .object({
    id: z.string().min(1),
    contextRef: z.string().min(1),
    kind: MapObjectKindSchema,
    name: z.string(),
    anchor: MapAnchorSchema,
    exported: z.boolean(),
    contextRole: z.enum(["DEFAULT", "DEPENDENCY"]).optional(),
    symbolStart: z.number().int().nonnegative().optional(),
    language: z.string().optional(),
    parsing: z
      .enum(["PARSED", "SYNTAX_ONLY", "NOT_PARSED", "NOT_ANALYZED", "CONFIGURATION_INPUT"])
      .optional(),
    execution: MapExecutionKindSchema.optional(),
  })
  .strict();
export type MapObject = z.infer<typeof MapObjectSchema>;

export const MapRelationSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1).optional(),
    kind: MapRelationKindSchema,
    anchor: MapAnchorSchema,
    target: z.string(),
    // A literal the relation carries: a decorator's first argument on the declaration itself, or
    // the path a call or value is registered under; both are usually routes.
    argument: z.string().min(1).max(256).optional(),
    basis: z.enum(["TYPE_RESOLVED", "SYNTAX_DECLARED", "UNRESOLVED"]),
    unresolvedReason: z
      .enum([
        "SYNTAX_ONLY",
        "SYMBOL_NOT_RESOLVED",
        "DECLARATION_NOT_AVAILABLE",
        "COMPILER_LIBRARY",
        "OUTSIDE_SOURCE_CONTEXT",
        "SOURCE_DECLARATION_UNMAPPED",
      ])
      .optional(),
  })
  .strict();
export type MapRelation = z.infer<typeof MapRelationSchema>;
export const MAP_RELATION_PRIORITY: Readonly<Record<MapRelation["kind"], number>> = Object.freeze({
  CALLS: 0,
  WRITES: 0,
  IMPORTS: 0,
  TEST_IMPORTS: 0,
  EXTENDS: 0,
  IMPLEMENTS: 0,
  OVERRIDES: 0,
  DECORATED_BY: 0,
  CONTAINS: 1,
  READS: 2,
  REFERENCES: 3,
});

export const MapNoteSchema = z
  .object({
    entityRef: z.string().min(1),
    kind: z.enum(["SOURCE_DOCUMENTATION", "STATE_WRITE", "CONTRACT_DECLARATION"]),
    text: z.string(),
    anchor: MapAnchorSchema,
    truncated: z.boolean(),
  })
  .strict();
export type MapNote = z.infer<typeof MapNoteSchema>;

export const MapGapSchema = z
  .object({
    code: z.string().min(1).max(128),
    path: z.string().optional(),
    count: z.number().int().positive().optional(),
  })
  .strict();
export type MapGap = z.infer<typeof MapGapSchema>;

export const MapSearchRankingSignalSchema = z.enum([
  "EXACT_SYMBOL",
  "SYMBOL_PREFIX",
  "SYMBOL_CONTAINS",
  "EXACT_FILE_STEM",
  "PATH_CONTAINS",
  "SOURCE_DOCUMENTATION",
  "DECLARATION",
  "GRAPH_CONNECTED",
  "PRODUCTION_PATH",
  "TEST_PATH",
  "GENERATED_PATH",
  "TEST_QUERY",
]);
export type MapSearchRankingSignal = z.infer<typeof MapSearchRankingSignalSchema>;
export const MapSearchMatchModeSchema = z.enum(["ANY", "ALL", "LITERAL"]);
export type MapSearchMatchMode = z.infer<typeof MapSearchMatchModeSchema>;
export const MapSearchMatchFieldSchema = z.enum(["NAME", "PATH", "DOCUMENTATION"]);
export type MapSearchMatchField = z.infer<typeof MapSearchMatchFieldSchema>;
export const MapSearchRankingSchema = z
  .object({
    score: z.number().int(),
    relationCount: z.number().int().nonnegative(),
    signals: z
      .array(MapSearchRankingSignalSchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length),
    matchedTerms: z.array(z.string()),
    matchedFields: z.array(MapSearchMatchFieldSchema),
    focusDistance: z.number().int().min(0).max(2).optional(),
  })
  .strict();
export type MapSearchRanking = z.infer<typeof MapSearchRankingSchema>;

export const MapContextSchema = z
  .object({
    ref: z.string().min(1),
    configPath: z.string().optional(),
    optionsDigest: z.string().min(1),
    mode: z.enum(["CONFIGURED", "INFERRED", "SYNTAX_ONLY"]),
    inputFiles: z.array(z.string()),
    configurationFiles: z.array(z.string()),
    rootFiles: z.array(z.string()).optional(),
    workspace: MapWorkspacePlanSchema.optional(),
    resolution: z.enum(["DECLARED", "WORKSPACE_SOURCE"]).optional(),
  })
  .strict();
export type MapContext = z.infer<typeof MapContextSchema>;
export const MapContextProjectionSchema = MapContextSchema.omit({
  inputFiles: true,
  configurationFiles: true,
  rootFiles: true,
  workspace: true,
});

export const MapAnalysisSchema = z
  .object({
    contexts: z.array(MapContextSchema),
    objects: z.array(MapObjectSchema),
    relations: z.array(MapRelationSchema),
    notes: z.array(MapNoteSchema),
    gaps: z.array(MapGapSchema),
    parsedFiles: z.array(z.string()),
    requiredFiles: z.array(z.string()),
  })
  .strict();
export type MapAnalysis = z.infer<typeof MapAnalysisSchema>;
export type MapBuildCoverage = Pick<MapAnalysis, "gaps" | "parsedFiles">;
export type MapWorkerInput = Readonly<{
  contextRef: string;
  configPath?: string;
  files: Readonly<Record<string, string>>;
  inventory: readonly string[];
  rootFiles?: readonly string[];
  compilerPath: string;
  syntaxOnly: boolean;
  workspace?: MapWorkspacePlan;
}>;

export type MapSearchInput = Readonly<{
  version: string;
  path: string;
  query: string;
  matchMode?: MapSearchMatchMode;
  focusRefs?: readonly string[];
  maxResults: number;
  offset?: number;
  allowedPathPrefixes?: readonly string[];
  kinds?: readonly MapObject["kind"][];
  outputBudget?: MapQueryOutputBudget;
}>;
export type MapExploreInput = Readonly<{
  version: string;
  scope?: "RELATED" | "PROJECT";
  entityRef?: string;
  locator?: Readonly<MapObjectLocator>;
  direction: "OUTGOING" | "INCOMING" | "BOTH";
  depth?: number;
  maxResults?: number;
  offset?: number;
  allowedPathPrefixes?: readonly string[];
  path?: string;
  kinds?: readonly MapRelation["kind"][];
  outputBudget?: MapQueryOutputBudget;
}>;

export type MapQueryGuidance = Readonly<{
  evidenceUse: "NAVIGATION_ONLY";
  freshness: "MAP_NOT_CONTINUOUSLY_UPDATED";
  sourceVerification: "READ_SOURCE_BEFORE_RELYING_ON_LOCATIONS";
  authority: "CODE_FACTS_AND_SOURCE_DECLARATIONS_NOT_BUSINESS_AUTHORITY";
  testing: "TEST_ASSOCIATION_IS_NOT_BEHAVIOR_VERIFICATION";
  gaps: readonly MapGap[];
  nextOffset?: number;
  pageExhausted: boolean;
}>;
export type MapSearchResult = MapQueryGuidance &
  Readonly<{
    query: MapQuerySelection<MapObject["kind"]> & {
      text: string;
      terms: readonly string[];
      matchMode: MapSearchMatchMode;
      focusRefs: readonly string[];
    };
    objects: readonly MapObject[];
    rankings: readonly MapSearchRanking[];
  }>;
export type MapExploreResult = MapQueryGuidance &
  Readonly<{
    object?: MapObject;
    query: MapQuerySelection<MapRelation["kind"]> & {
      scope: "RELATED" | "PROJECT";
      direction: MapExploreInput["direction"];
      depth: number | null;
    };
    traversal: Readonly<{
      semantics: "STATIC_RELATIONSHIPS";
      frontier: readonly Readonly<{
        entityRef: string;
        direction: "INCOMING" | "OUTGOING" | "BOTH";
      }>[];
    }>;
    coverage: Readonly<{
      totalRelations: number;
      returnedRelations: number;
      remainingRelations: number;
    }>;
    context?: z.infer<typeof MapContextProjectionSchema>;
    notes: readonly MapNote[];
    notesTruncated: boolean;
    relations: readonly Readonly<{ relation: MapRelation; from: MapObject; to?: MapObject }>[];
  }>;

export const mapPathAllowed = (relative: string, prefixes: readonly string[]) =>
  prefixes.some(
    (prefix) => prefix === "." || relative === prefix || relative.startsWith(`${prefix}/`),
  );
export const mapTestPath = (path: string) =>
  /(?:^|\/)(?:__tests__|tests?|fixtures?|e2e|testdata)(?:\/|$)|\.(?:spec|test)\.|_test\.(?:go|py)$|(?:^|\/)(?:test_[^/]*\.py|conftest\.py)$/iu.test(
    path,
  );

export type ProjectMapSource = CodeIndexSource;

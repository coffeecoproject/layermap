import { z } from "zod";
import { MapReferenceKindSchema } from "./project-map-reference-types";
import {
  MapObjectKindSchema,
  MapObjectLocatorSchema,
  MapSearchMatchModeSchema,
  MapSymbolSelectorSchema,
} from "./project-map-types";
import { MAP_VIEW_LIMITS } from "./project-map-view";

/** How a host names its own source reading and searching, and how far its reads may reach. */
export type MapToolHost = Readonly<{
  readResult: string;
  textSearch: string;
  readSource: string;
  readReference: string;
  /** Rules for hosts that grant reads by path; empty when the whole project is readable. */
  grantRules: string;
  /** What the project's readable files are called: "grant" or "project". */
  scope: string;
  /** Sentences that open each description, saying when to reach for the tool. */
  lead?: Readonly<{ search: string; explore: string; references: string }>;
}>;

/** A coding agent that reads and searches files with its own tools (MCP and the command line). */
export const AGENT_MAP_TOOL_HOST: MapToolHost = Object.freeze({
  readResult: "read its line range in the file",
  textSearch: "search the source text itself for exact text",
  readSource: "Read source at the printed line ranges.",
  readReference: "Read a reference at its line range.",
  grantRules: "",
  scope: "project",
  // Agents reach for grep by habit; these say which questions the map answers in one call.
  lead: {
    explore:
      "Use this before grep or reading files to answer what calls a function or method, what changing it affects (callers traced up to entry points such as HTTP routes, handlers, jobs and commands), what it calls, and what a directory or file contains: one call returns the callers or callees up to 8 levels deep, with file paths and line numbers, for TypeScript, JavaScript, Go, Python and Java.",
    search:
      "Use this to find where a function, method, class or type is declared, by name or by words in its name, path or documentation, before exploring its callers with project_explore_map.",
    references:
      "Use this to list every place a declaration is used (calls, imports, re-exports, reads and writes), compiled from current source: more complete than searching for its name.",
  },
});

export const MAP_TOOL_NAMES = Object.freeze({
  search: "project_search_map",
  explore: "project_explore_map",
  references: "project_find_references",
});

// Views print directories with a trailing slash (src/api/); one given back that way is the same.
export const mapDirectoryPath = (path: string) =>
  path.length > 1 && path.endsWith("/") && !path.endsWith("//") ? path.slice(0, -1) : path;

export const ProjectMapSearchInputSchema = z
  .object({
    path: z.string().default("."),
    query: z.string().min(1).max(256),
    matchMode: MapSearchMatchModeSchema.default("ANY").describe(
      "ANY matches one or more query terms; ALL requires every term; LITERAL matches the complete text literally.",
    ),
    kinds: z.array(MapObjectKindSchema).min(1).max(MapObjectKindSchema.options.length).optional(),
    maxResults: z.number().int().min(1).max(200).default(20),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();

export const ProjectMapExploreInputSchema = z
  .object({
    path: z
      .string()
      .default(".")
      .describe('"." or a directory for an overview, or a file for its declarations.'),
    name: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Declaration name or Container.member in the file, as printed by the map."),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Start line of a same-named declaration; without name, the declaration containing this line.",
      ),
    direction: z.enum(["INCOMING", "OUTGOING", "BOTH"]).default("BOTH"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(MAP_VIEW_LIMITS.directedDepth)
      .default(1)
      .describe(
        "Relationship hops for a declaration: up to 8 for INCOMING or OUTGOING (for example callers up to entry points), up to 3 for BOTH.",
      ),
    includeTests: z.boolean().default(false),
    includeUnresolved: z.boolean().default(false),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();

const locatorSchema = MapObjectLocatorSchema.describe(
  "Declaration location: path and UTF-16 start offset; include kind to distinguish declarations at the same offset.",
);
export const mapReferencesInputSchema = (host: MapToolHost) =>
  z
    .object({
      symbol: MapSymbolSelectorSchema.optional().describe(
        "Declaration as printed by the map: file path, name or Container.member, and start line when names repeat.",
      ),
      entityRef: z.string().min(1).max(128).optional(),
      locator: locatorSchema.optional(),
      path: z
        .string()
        .default(".")
        .describe(
          `Filter usage locations; compiler inputs and declarations may lie elsewhere in the ${host.scope}.`,
        ),
      kinds: z
        .array(MapReferenceKindSchema)
        .min(1)
        .max(MapReferenceKindSchema.options.length)
        .optional(),
      maxResults: z.number().int().min(1).max(200).default(20),
      cursor: z.string().max(2048).optional(),
    })
    .strict()
    .refine(
      (input) =>
        [input.symbol, input.entityRef, input.locator].filter((value) => value !== undefined)
          .length === 1,
      "Provide exactly one symbol, entityRef or locator.",
    );

export const mapToolDescriptions = (host: MapToolHost) => {
  const lead = (tool: keyof NonNullable<MapToolHost["lead"]>) =>
    host.lead ? `${host.lead[tool]} ` : "";
  return Object.freeze({
    search: `${lead("search")}Find declarations and files whose names, paths or source documentation match query terms. ANY (default) matches any term, ALL requires every term, LITERAL matches the exact text. Results are ranked by relevance and grouped by file with the declaration name, kind, 1-based line range and matched fields. Zoom into a result with project_explore_map({path,name}) or ${host.readResult}. This is not a full-text search and does not prove absence; ${host.textSearch}. Continue with offset and unchanged conditions.`,
    explore: `${lead("explore")}Read the static project map, zooming from the whole project to one declaration. path "." or a directory lists modules, module imports, external packages and its files: with exported declarations when the listing is small, as file names and line counts by directory when larger, and as modules only when very large. Start here to see what exists before searching or reading. A file path lists its declarations and members, imports, importers and top-level statements. A file path with name (or Container.member), optionally narrowed by its start line, or with a line alone, shows that declaration's calls, callers (including uses as a value), writes, heritage, decorators and members, aggregated per related declaration with @line sites; closures and locals are folded into their named container. depth also expands the related declarations hop by hop: up to 8 in one direction, which traces callers up to entry points (INCOMING) or callees down (OUTGOING), and up to 3 for BOTH. To find what a change affects, select the declaration with direction INCOMING and a depth up to 8, continue from any NOT EXPANDED declarations the view names, then confirm the entry points in source. Test files and standard-library call targets are hidden and counted by default; includeTests and includeUnresolved show them. ${host.readSource} The map is static: calls through an interface, type or base member continue to the members it links as implementations (dispatches to, dispatched from), while trace stops, possible callers by name (calls of a same-named member on a receiver of unknown type), framework wiring and unresolved targets need source reading, and a missing relationship does not prove absence. When a page reports more entries, continue with offset and otherwise unchanged arguments.`,
    references: `${lead("references")}Compute usages of a mapped declaration from current source, including aliases, re-exports and non-call references. Select it with symbol {path,name,line?} as printed by project_explore_map or project_search_map (line is its start line when names repeat), or with an entityRef or locator {path,start,kind}. Broader and more expensive than the cached callers in project_explore_map; file or unsupported declarations may lack a reference target. path and kinds filter usage locations before paging. ${host.grantRules}objects contains compact declarations; targetRef and reference ownerRef identify them. ${host.readReference} A file that several compiler contexts read (such as packages of one workspace) lists its references once per context, each with that context's configPath. Continue with nextCursor and unchanged conditions, including after an empty partial page. Filtered exhaustion and missing results do not prove absence.`,
  });
};

import { z } from "zod";
import { ProjectEvidenceError } from "../core";
import type { LayerMap } from "../layermap";
import {
  AGENT_MAP_TOOL_HOST,
  MAP_TOOL_NAMES,
  mapDirectoryPath,
  mapReferencesInputSchema,
  mapToolDescriptions,
  ProjectMapExploreInputSchema,
  ProjectMapSearchInputSchema,
} from "../tools";

const ReferencesInputSchema = mapReferencesInputSchema(AGENT_MAP_TOOL_HOST);
const descriptions = mapToolDescriptions(AGENT_MAP_TOOL_HOST);

/** The map tools as an agent sees them: name, description and JSON Schema of the arguments. */
export const agentMapTools = [
  {
    name: MAP_TOOL_NAMES.explore,
    title: "Callers, callees and impact of a change (LayerMap)",
    description: descriptions.explore,
    schema: ProjectMapExploreInputSchema,
  },
  {
    name: MAP_TOOL_NAMES.search,
    title: "Find a declaration (LayerMap)",
    description: descriptions.search,
    schema: ProjectMapSearchInputSchema,
  },
  {
    name: MAP_TOOL_NAMES.references,
    title: "All usages of a declaration (LayerMap)",
    description: descriptions.references,
    schema: ReferencesInputSchema,
  },
].map(({ schema, ...tool }) => {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
  return { ...tool, inputSchema, schema };
});

export type MapToolResult = Readonly<{ text: string; isError: boolean }>;

const more = (nextOffset: number | undefined) =>
  nextOffset === undefined
    ? ""
    : `\n\n[More entries: call again with offset ${nextOffset} and otherwise the same arguments.]`;

// What an agent can do about a failure, for the codes a wrong argument or a busy map produces.
const HINTS: Readonly<Record<string, string>> = {
  PROJECT_MAP_OBJECT_NOT_FOUND:
    "No such path or declaration in the map. Explore the parent directory or the file to see what it contains.",
  PROJECT_READ_SOURCE_CHANGED: "Files changed while the map was updating. Call again.",
  PROJECT_MAP_SOURCE_CHANGED: "Files changed while the map was updating. Call again.",
  PROJECT_CONTINUATION_INVALID:
    "The offset or cursor belongs to an earlier map or other arguments. Start again without it.",
  PROJECT_MAP_REFERENCE_CURSOR_INVALID:
    "The cursor belongs to an earlier map or other arguments. Start again without it.",
  PROJECT_READ_INPUT_INVALID: "The arguments do not describe a valid selection.",
  PROJECT_PATH_INVALID:
    "Paths are relative to the project root, use / and contain no . or .. parts.",
  PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE:
    "References are not available for this declaration; use its callers in project_explore_map.",
  LAYERMAP_NOT_A_GIT_REPOSITORY:
    "LayerMap maps Git repositories, and the agent was started outside one. Start it in a repository, or run layermap with --project naming one.",
  LAYERMAP_SQLITE_WITHOUT_FTS5:
    "This Node.js build has SQLite without FTS5 (as some package managers build it). Run LayerMap with the official Node.js 22.22 or later.",
};

/** A failure as an agent should read it: the code, and what to do about it when known. */
export const describeMapError = (error: unknown): string | undefined =>
  error instanceof ProjectEvidenceError
    ? `${error.code}${HINTS[error.code] ? `: ${HINTS[error.code]}` : ""}`
    : undefined;

export async function runMapTool(
  map: LayerMap,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<MapToolResult> {
  const tool = agentMapTools.find((candidate) => candidate.name === name);
  if (!tool) return { text: `Unknown tool ${name}.`, isError: true };
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success)
    return {
      text: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`).join("; ")}`,
      isError: true,
    };
  try {
    if (name === MAP_TOOL_NAMES.explore) {
      const input = parsed.data as z.infer<typeof ProjectMapExploreInputSchema>;
      const declaration = input.name !== undefined || input.line !== undefined;
      const page = await map.explore(
        {
          path: mapDirectoryPath(input.path),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.line === undefined ? {} : { line: input.line }),
          ...(declaration ? { direction: input.direction, depth: input.depth } : {}),
          includeTests: input.includeTests,
          includeUnresolved: input.includeUnresolved,
          offset: input.offset,
        },
        signal,
      );
      return { text: page.text + more(page.nextOffset), isError: false };
    }
    if (name === MAP_TOOL_NAMES.search) {
      const input = parsed.data as z.infer<typeof ProjectMapSearchInputSchema>;
      const page = await map.search({ ...input, path: mapDirectoryPath(input.path) }, signal);
      return { text: page.text + more(page.nextOffset), isError: false };
    }
    const input = parsed.data as z.infer<typeof ReferencesInputSchema>;
    return { text: JSON.stringify(await map.references(input, signal)), isError: false };
  } catch (error) {
    const text = describeMapError(error);
    if (text) return { text, isError: true };
    throw error;
  }
}

/** What an agent is told about the map once, when it connects. */
export const AGENT_MAP_INSTRUCTIONS =
  "Use the LayerMap tools before grep or reading files whenever a task asks what calls something, what a change affects, where something is used, or how the code is organized: project_explore_map on a declaration with direction INCOMING and depth up to 8 traces its callers up to the entry points (HTTP routes, handlers, jobs, commands) in one call, which grep can only approximate one name at a time. LayerMap is a static, layered map of this repository for TypeScript/JavaScript, Go, Python and Java: directories and modules, each file's declarations, and each declaration's callers and callees up to 8 hops. path \".\" shows what exists. Continue from any NOT EXPANDED declarations a view names, then confirm entry points in source. The map is static: dynamic dispatch, framework wiring and unresolved targets need source reading, and a missing relationship does not prove absence. The first call on a project builds its map, which can take minutes on a large repository; later calls update only what changed.";

/**
 * One sentence for an agent's own instructions file. Codex shows MCP tools only when it searches for
 * them, so the tool descriptions alone do not bring it to the map; this names the server and when to
 * reach for it (natural-adoption runs, 2026-10-04).
 */
export const AGENT_MAP_NOTE =
  "The layermap MCP server is available here. For questions about what calls a function, what a change affects or where code is used, start with its project_explore_map tool (direction INCOMING, depth up to 8) before grep, then confirm in source.";

import { parseArgs } from "node:util";
import {
  cacheDirectory,
  packageVersion,
  projectDirectory,
  pruneCache,
  resolveAnalyzers,
} from "./agent/environment";
import { serveMcp } from "./agent/mcp";
import { allowAgent, removeAgent, type SetupAgent, setupAgent } from "./agent/setup";
import { describeMapError, runMapTool } from "./agent/tools";
import { ProjectEvidenceError } from "./core";
import { LayerMap } from "./layermap";
import { MAP_TOOL_NAMES } from "./tools";

const USAGE = `LayerMap — a layered map of a codebase for coding agents.

Usage:
  layermap setup claude|codex [--scope user|project|local] [--no-instructions] [--dry-run]
  layermap allow claude [--scope user|project|local] [--dry-run]
                                          let the plugin's read-only tools run without a prompt
  layermap remove claude|codex [--scope user|project|local] [--dry-run]
  layermap mcp [--project DIR]            serve the map tools over MCP (stdio)
  layermap index [--project DIR]          build or update the map now
  layermap explore [PATH] [--name NAME] [--line N] [--direction INCOMING|OUTGOING|BOTH]
                   [--depth N] [--tests] [--unresolved] [--offset N]
  layermap search QUERY [--path DIR] [--mode ANY|ALL|LITERAL] [--max N] [--offset N]
  layermap refs PATH NAME [--line N] [--path DIR] [--max N] [--cursor C]

The project is the Git work tree around the current directory unless --project names one.
Maps are kept in ${cacheDirectory()}.`;

const log = (line: string) => process.stderr.write(`${line}\n`);
const usage = (code: number) => {
  (code ? process.stderr : process.stdout).write(`${USAGE}\n`);
  return code;
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      scope: { type: "string", default: "user" },
      "dry-run": { type: "boolean", default: false },
      "no-instructions": { type: "boolean", default: false },
      name: { type: "string" },
      line: { type: "string" },
      direction: { type: "string" },
      depth: { type: "string" },
      tests: { type: "boolean", default: false },
      unresolved: { type: "boolean", default: false },
      offset: { type: "string" },
      path: { type: "string" },
      mode: { type: "string" },
      max: { type: "string" },
      cursor: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command, ...rest] = positionals;
  const version = await packageVersion();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (values.help || !command) return usage(command ? 0 : 1);
  const { directory: project, git } = await projectDirectory(values.project ?? process.cwd());
  const cache = cacheDirectory();
  const open = async () => {
    if (!git) throw new ProjectEvidenceError("LAYERMAP_NOT_A_GIT_REPOSITORY", false);
    const map = await LayerMap.open({
      project,
      cacheDirectory: cache,
      analyzers: await resolveAnalyzers(cache, log),
    });
    await pruneCache(cache, map.project).catch((error: unknown) =>
      log(`LayerMap could not tidy its cache: ${String(error)}`),
    );
    return map;
  };

  if (command === "setup" || command === "allow" || command === "remove") {
    const agent = rest[0];
    if (agent !== "claude" && agent !== "codex") return usage(1);
    if (!["user", "project", "local"].includes(values.scope)) return usage(1);
    const done = await { setup: setupAgent, allow: allowAgent, remove: removeAgent }[command]({
      agent: agent as SetupAgent,
      scope: values.scope as "user" | "project" | "local",
      project,
      version,
      dryRun: values["dry-run"],
      instructions: !values["no-instructions"],
      log,
    });
    return done ? 0 : 1;
  }
  if (command === "mcp") {
    await serveMcp({ version, open, log });
    return 0;
  }

  const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
  const map = await open();
  const signal = new AbortController().signal;
  try {
    if (command === "index") {
      const started = performance.now();
      const mapVersion = await map.refresh(signal);
      log(
        `Mapped ${project} (${mapVersion.slice(0, 12)}) in ${Math.round(performance.now() - started)} ms.`,
      );
      return 0;
    }
    const call: Record<string, [string, Record<string, unknown>]> = {
      explore: [
        MAP_TOOL_NAMES.explore,
        {
          path: rest[0] ?? ".",
          name: values.name,
          line: number(values.line),
          direction: values.direction?.toUpperCase(),
          depth: number(values.depth),
          includeTests: values.tests,
          includeUnresolved: values.unresolved,
          offset: number(values.offset),
        },
      ],
      search: [
        MAP_TOOL_NAMES.search,
        {
          query: rest.join(" "),
          path: values.path,
          matchMode: values.mode?.toUpperCase(),
          maxResults: number(values.max),
          offset: number(values.offset),
        },
      ],
      refs: [
        MAP_TOOL_NAMES.references,
        {
          symbol: { path: rest[0], name: rest[1], line: number(values.line) },
          path: values.path,
          maxResults: number(values.max),
          cursor: values.cursor,
        },
      ],
    };
    const selected = call[command];
    if (!selected) return usage(1);
    const [tool, args] = selected;
    const defined = (value: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(value)
          .filter(([, field]) => field !== undefined)
          .map(([key, field]) => [
            key,
            field && typeof field === "object" && !Array.isArray(field)
              ? defined(field as Record<string, unknown>)
              : field,
          ]),
      );
    const result = await runMapTool(map, tool, defined(args), signal);
    (result.isError ? process.stderr : process.stdout).write(`${result.text}\n`);
    return result.isError ? 1 : 0;
  } finally {
    await map.close();
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  log(
    `layermap: ${describeMapError(error) ?? (error instanceof Error ? error.message : String(error))}`,
  );
  return 1;
});

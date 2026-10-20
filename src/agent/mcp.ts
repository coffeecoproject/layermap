import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { LayerMap } from "../layermap";
import { routeMapCall, type SessionStart } from "./projects";
import {
  AGENT_MAP_INSTRUCTIONS,
  agentMapTools,
  describeMapError,
  type MapToolResult,
  parseMapToolCall,
  runMapTool,
} from "./tools";

type Message = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type McpServerOptions = Readonly<{
  version: string;
  /** Where the session started; tool calls without a path are about its repository. */
  start: SessionStart;
  /** Opens a repository's map; the first call starts building it. */
  open: (project: string) => Promise<LayerMap>;
  /** How long a tool call waits for a map still being built before saying so. */
  buildWaitMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (line: string) => void;
}>;

/**
 * A Model Context Protocol server on standard input and output (JSON-RPC, one message per line)
 * offering the read-only map tools. Each call maps the Git repository its path names, so a session
 * can work across the repositories of a folder that holds several, or move to another. It builds
 * the starting repository's map as soon as the client is ready, so the first tool call usually
 * finds it done.
 */
export function serveMcp(options: McpServerOptions): Promise<void> {
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const send = (message: Record<string, unknown>) =>
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const calls = new Map<string | number, AbortController>();
  // Each repository's map, opened and built on its first call. A build ends with the session, so a
  // client that connects only to probe the server is not kept waiting.
  const maps = new Map<string, Readonly<{ opened: Promise<LayerMap>; built: Promise<unknown> }>>();
  const session = new AbortController();
  const map = (project: string) => {
    let entry = maps.get(project);
    if (!entry) {
      const opened = options.open(project);
      const built = opened
        .then(async (layermap) => {
          await layermap.refresh(session.signal);
          // The commit a change check compares with, built while the agent reads and edits; a
          // repository without commits has none.
          void layermap.prepareBase(session.signal).catch(() => {});
        })
        .catch((error: unknown) => {
          if (!session.signal.aborted) log(`LayerMap could not build the map: ${String(error)}`);
        });
      entry = { opened, built };
      maps.set(project, entry);
    }
    return entry;
  };

  const call = async (id: string | number, params: Record<string, unknown>) => {
    const controller = new AbortController();
    calls.set(id, controller);
    const name = String(params.name);
    let project: string | undefined;
    // Results name their repository, whose root their paths are relative to, so an agent that
    // moved to another sees which one it read.
    const respond = (text: string, isError: boolean) =>
      send({
        id,
        result: {
          content: [
            {
              type: "text",
              text: project ? `Project ${project} (paths are relative to it)\n\n${text}` : text,
            },
          ],
          isError,
        },
      });
    try {
      const parsed = parseMapToolCall(name, params.arguments);
      if ("text" in parsed) return respond(parsed.text, parsed.isError);
      const routed = await routeMapCall(options.start, parsed);
      if (typeof routed === "string") return respond(routed, true);
      project = routed.project;
      const { opened, built } = map(project);
      const timer = new AbortController();
      const ready = await Promise.race([
        built.then(() => true),
        delay(options.buildWaitMs ?? 40_000, false, {
          signal: AbortSignal.any([timer.signal, controller.signal]),
        }).catch(() => false),
      ]);
      timer.abort();
      if (controller.signal.aborted) return;
      const result: MapToolResult = ready
        ? await runMapTool(await opened, { name, args: routed.args }, controller.signal)
        : {
            text: `LayerMap is still building this project's map (a first build can take minutes on a large repository). Call ${name} again shortly, or read source meanwhile.`,
            isError: false,
          };
      respond(result.text, result.isError);
    } catch (error) {
      if (controller.signal.aborted) return;
      respond(describeMapError(error) ?? `LayerMap failed: ${String(error)}`, true);
    } finally {
      calls.delete(id);
    }
  };

  const handle = (message: Message) => {
    const { id, method, params = {} } = message;
    if (method === undefined) return;
    if (id === undefined || id === null) {
      if (method === "notifications/initialized" && options.start.git) map(options.start.directory);
      if (method === "notifications/cancelled")
        calls.get(params.requestId as string | number)?.abort();
      return;
    }
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            // Only tools are offered, whose shape every protocol revision shares.
            protocolVersion:
              typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "layermap", title: "LayerMap", version: options.version },
            instructions: AGENT_MAP_INSTRUCTIONS,
          },
        });
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({
          id,
          result: {
            tools: agentMapTools.map(({ name, title, description, inputSchema }) => ({
              name,
              title,
              description,
              inputSchema,
              annotations: {
                title,
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            })),
          },
        });
      case "tools/call":
        return void call(id, params);
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        return send({ id: null, error: { code: -32700, message: "Parse error" } });
      }
      try {
        handle(message);
      } catch (error) {
        if (message.id !== undefined)
          send({ id: message.id, error: { code: -32603, message: String(error) } });
      }
    });
    lines.on("close", async () => {
      session.abort();
      for (const controller of calls.values()) controller.abort();
      for (const { opened } of maps.values())
        await (await opened.catch(() => undefined))?.close().catch(() => undefined);
      resolve();
    });
  });
}

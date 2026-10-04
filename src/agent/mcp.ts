import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { LayerMap } from "../layermap";
import {
  AGENT_MAP_INSTRUCTIONS,
  agentMapTools,
  describeMapError,
  type MapToolResult,
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
  /** Opens the project's map; the first call starts building it. */
  open: () => Promise<LayerMap>;
  /** How long a tool call waits for a map still being built before saying so. */
  buildWaitMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (line: string) => void;
}>;

/**
 * A Model Context Protocol server on standard input and output (JSON-RPC, one message per line)
 * offering the three read-only map tools. It builds the map as soon as the client is ready, so
 * the first tool call usually finds it done.
 */
export function serveMcp(options: McpServerOptions): Promise<void> {
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const send = (message: Record<string, unknown>) =>
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const calls = new Map<string | number, AbortController>();
  let opened: Promise<LayerMap> | undefined;
  const map = () => {
    opened ??= options.open();
    return opened;
  };
  // The map build that starts with the session; tool calls wait for it, up to buildWaitMs.
  let warm: Promise<unknown> | undefined;
  const warmUp = () => {
    warm ??= map()
      .then((layermap) => layermap.refresh(new AbortController().signal))
      .catch((error: unknown) => log(`LayerMap could not build the map: ${String(error)}`));
    return warm;
  };

  const call = async (id: string | number, params: Record<string, unknown>) => {
    const controller = new AbortController();
    calls.set(id, controller);
    try {
      const timer = new AbortController();
      const built = await Promise.race([
        warmUp().then(() => true),
        delay(options.buildWaitMs ?? 40_000, false, {
          signal: AbortSignal.any([timer.signal, controller.signal]),
        }).catch(() => false),
      ]);
      timer.abort();
      if (controller.signal.aborted) return;
      const result: MapToolResult = built
        ? await runMapTool(await map(), String(params.name), params.arguments, controller.signal)
        : {
            text: `LayerMap is still building this project's map (a first build can take minutes on a large repository). Call ${String(params.name)} again shortly, or read source meanwhile.`,
            isError: false,
          };
      send({
        id,
        result: { content: [{ type: "text", text: result.text }], isError: result.isError },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      send({
        id,
        result: {
          content: [
            { type: "text", text: describeMapError(error) ?? `LayerMap failed: ${String(error)}` },
          ],
          isError: true,
        },
      });
    } finally {
      calls.delete(id);
    }
  };

  const handle = (message: Message) => {
    const { id, method, params = {} } = message;
    if (method === undefined) return;
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") void warmUp();
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
      for (const controller of calls.values()) controller.abort();
      if (opened) await (await opened.catch(() => undefined))?.close().catch(() => undefined);
      resolve();
    });
  });
}

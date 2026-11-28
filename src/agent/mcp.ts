import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { LayerMap } from "../layermap";
import type { MapCheckPhase } from "../project-map-changes";
import { MAP_TOOL_NAMES } from "../tools";
import type { MapCallRecord } from "./call-log";
import { projectDirectory } from "./environment";
import { projectHeading } from "./notes";
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
  result?: Record<string, unknown>;
};

// How long the session's start waits for the client to list its roots.
const ROOTS_WAIT_MS = 5_000;
/**
 * The notification LayerMap's launcher sends a server it has moved the session from: it takes no
 * more requests, and ends once the calls it has are answered or cancelled.
 */
export const RETIRE = "notifications/layermap/retire";
// A client that asked for progress hears it at least this often during a long step, so it can tell
// a slow call from a stuck one.
const PROGRESS_EVERY_MS = 15_000;

// The steps of a call, as a client shows them: waiting for a first build, a check's own steps, and
// the other tools reading the map.
type CallPhase = "WAIT" | "READ" | MapCheckPhase;
const PHASE_TEXT: Readonly<Record<CallPhase, string>> = {
  WAIT: "Waiting for the first build of the project's map",
  READ: "Reading the map",
  MAP: "Updating the map of the working tree",
  DIFF: "Reading the diff",
  BASE: "Building the map of the base commit",
  TRACE: "Tracing what the change reaches",
  REPORT: "Finding the code the report names",
  COMPILE: "Compiling the changed code",
};

export type McpServerOptions = Readonly<{
  version: string;
  /**
   * Where the server was started; tool calls without a path are about its repository unless the
   * client lists the roots it works in.
   */
  start: SessionStart;
  /** Opens a repository's map; the first call starts building it. */
  open: (project: string) => Promise<LayerMap>;
  /** How long a tool call waits for a map still being built before saying so. */
  buildWaitMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (line: string) => void;
  /** Keeps each answered or cancelled tool call, with the time each step took. */
  record?: (record: MapCallRecord) => unknown;
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
  let retiring = false;
  let end = () => {};
  const settle = () => {
    if (retiring && !calls.size) end();
  };
  // Each repository's map, opened and built on its first call. A build ends with the session, so a
  // client that connects only to probe the server is not kept waiting. A map that could not be
  // opened is opened again by the next call; one that could not be built is updated by each call.
  const maps = new Map<string, Readonly<{ opened: Promise<LayerMap>; built: Promise<unknown> }>>();
  const session = new AbortController();
  // A client may start its servers somewhere other than where the session works: Claude Code's
  // desktop app starts them in the main checkout of a session working in a linked worktree. A
  // client that lists its roots names that place, so its first root is where the session started.
  let start = options.start;
  let rooted: Promise<unknown> = Promise.resolve();
  let listsRoots = false;
  const replies = new Map<string | number, (message: Message) => void>();
  let requested = 0;
  const readRoots = () => {
    const id = `layermap-roots-${++requested}`;
    const reply = new Promise<Message>((resolve) => replies.set(id, resolve));
    send({ id, method: "roots/list" });
    rooted = Promise.race([reply, delay(ROOTS_WAIT_MS, undefined, { ref: false })])
      .then(async (message) => {
        replies.delete(id);
        const roots = message?.result?.roots;
        const root = Array.isArray(roots)
          ? roots.find((item) => typeof item?.uri === "string" && item.uri.startsWith("file:"))
          : undefined;
        if (!root) return;
        const directory = await projectDirectory(fileURLToPath(root.uri));
        // A later list, after the roots changed again, outranks this one.
        if (id === `layermap-roots-${requested}`) start = directory;
      })
      .catch(() => {});
    return rooted;
  };
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
      const opening = { opened, built };
      opened.catch(() => {
        if (maps.get(project) === opening) maps.delete(project);
      });
      entry = opening;
      maps.set(project, entry);
    }
    return entry;
  };

  const call = async (id: string | number, params: Record<string, unknown>) => {
    const controller = new AbortController();
    calls.set(id, controller);
    const name = String(params.name);
    let project: string | undefined;
    // Each step's time, and progress for a client that asked for it with a token.
    const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken;
    const started = performance.now();
    const phases: Record<string, number> = {};
    let current: CallPhase = "WAIT";
    let since = started;
    let progress = 0;
    const notify = (message: string) => {
      if (typeof token !== "string" && typeof token !== "number") return;
      send({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++progress, message },
      });
    };
    const tally = () => {
      const now = performance.now();
      phases[current] = (phases[current] ?? 0) + now - since;
      since = now;
    };
    const enter = (next: CallPhase) => {
      tally();
      current = next;
      notify(PHASE_TEXT[next]);
    };
    const beat = setInterval(
      () =>
        notify(
          `${PHASE_TEXT[current]} (${Math.round((performance.now() - started) / 1000)} s so far)`,
        ),
      PROGRESS_EVERY_MS,
    );
    let answered = false;
    const finish = (text: string, isError: boolean, cancelled: boolean) => {
      tally();
      void options.record?.({
        at: new Date().toISOString(),
        version: options.version,
        tool: name,
        ...(project ? { project } : {}),
        ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
        ms: Math.round(performance.now() - started),
        phases: Object.fromEntries(
          Object.entries(phases).map(([phase, ms]) => [phase, Math.round(ms)]),
        ),
        chars: text.length,
        head: text.split("\n", 1)[0]?.slice(0, 300) ?? "",
        isError,
        ...(cancelled ? { cancelled } : {}),
      });
    };
    // Results name their repository, whose root their paths are relative to, so an agent that
    // moved to another sees which one it read.
    const respond = (text: string, isError: boolean) => {
      answered = true;
      finish(text, isError, false);
      send({
        id,
        result: {
          content: [
            {
              type: "text",
              text: project ? `${projectHeading(project)}\n\n${text}` : text,
            },
          ],
          isError,
        },
      });
    };
    try {
      const parsed = parseMapToolCall(name, params.arguments);
      if ("text" in parsed) return respond(parsed.text, parsed.isError);
      await rooted;
      const routed = await routeMapCall(start, parsed);
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
      if (ready && name !== MAP_TOOL_NAMES.check) enter("READ");
      const result: MapToolResult = ready
        ? await runMapTool(await opened, { name, args: routed.args }, controller.signal, enter)
        : {
            text: `LayerMap is still building this project's map (a first build can take minutes on a large repository). Call ${name} again shortly, or read source meanwhile.`,
            isError: false,
          };
      respond(result.text, result.isError);
    } catch (error) {
      if (controller.signal.aborted) return;
      respond(describeMapError(error) ?? `LayerMap failed: ${String(error)}`, true);
    } finally {
      clearInterval(beat);
      if (!answered) finish("", false, true);
      calls.delete(id);
      settle();
    }
  };

  const handle = (message: Message) => {
    const { id, method, params = {} } = message;
    if (method === undefined) {
      if (id !== undefined && id !== null) replies.get(id)?.(message);
      return;
    }
    if (id === undefined || id === null) {
      if (method === "notifications/initialized")
        void (listsRoots ? readRoots() : rooted).then(() => {
          if (start.git) map(start.directory);
        });
      if (method === "notifications/roots/list_changed" && listsRoots) void readRoots();
      if (method === "notifications/cancelled")
        calls.get(params.requestId as string | number)?.abort();
      if (method === RETIRE) {
        retiring = true;
        settle();
      }
      return;
    }
    switch (method) {
      case "initialize":
        listsRoots = Boolean((params.capabilities as { roots?: unknown } | undefined)?.roots);
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
    const input = options.input ?? process.stdin;
    const lines = createInterface({ input, crlfDelay: Infinity });
    // Closing the lines only pauses the input, whose pipe would keep the process running.
    end = () => {
      lines.close();
      (input as { destroy?: () => void }).destroy?.();
    };
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

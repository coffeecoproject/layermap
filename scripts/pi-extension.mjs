// LayerMap for Pi. scripts/plugins.ts bundles it with the rules it shares with the Claude Code
// plugin's hooks into plugins/pi/layermap.mjs, which the npm package ships as its Pi extension
// (`pi install npm:layermap`).
//
// The map runs in LayerMap's own MCP server, started with Pi's Node in the session's directory; its
// tools become Pi tools of the same names. Like the Claude Code plugin's stop hook, the extension
// asks the agent once, before it settles, to check the code its tool calls changed.
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { AGENT_MAP_NOTE } from "../src/agent/notes";
import {
  changedFiles,
  checkedRepository,
  checkRequest,
  codeEdits,
  commandFiles,
  fileStates,
  repositoryAt,
} from "../src/agent/session-changes";

const CHECK_TOOL = "project_check_changes";
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.mjs");
// Tools that only read; any other tool call (edit, write, apply_patch, bash, …) may change files.
const READS = new Set(["read", "grep", "find", "ls"]);
// Tools that change the one file their path names, relative to the session's directory.
const WRITES = new Set(["edit", "write"]);
// The Codex patch tool (pi-codex-tools), which replaces them for OpenAI models: its patch names
// each file it adds, updates, deletes or moves one to, relative to the session's directory.
const PATCH = "apply_patch";
const PATCH_FILES = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

// LayerMap's MCP server over stdio: one JSON-RPC message per line.
class MapServer {
  constructor(cwd) {
    this.pending = new Map();
    this.next = 1;
    this.child = spawn(process.execPath, [CLI, "mcp"], {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", () => this.fail(new Error("The LayerMap server stopped.")));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }
  fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.dead = true;
  }
  send(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  request(method, params, signal) {
    if (this.dead) return Promise.reject(new Error("The LayerMap server is not running."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          this.send({ method: "notifications/cancelled", params: { requestId: id } });
          reject(new Error("Cancelled."));
        },
        { once: true },
      );
      this.send({ id, method, params });
    });
  }
  async start(version) {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "layermap-pi", version },
    });
    // The server starts building the map as soon as it is told the client is ready.
    this.send({ method: "notifications/initialized" });
    return (await this.request("tools/list", {})).tools;
  }
  async stop() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    await this.exited;
    clearTimeout(timer);
  }
}

// The files a tool call names to change, relative to the session's directory.
function namedFiles({ toolName, input }) {
  if (WRITES.has(toolName)) return typeof input?.path === "string" ? [input.path] : [];
  if (toolName === PATCH && typeof input?.patch === "string")
    return [...input.patch.matchAll(PATCH_FILES)].map((match) => match[1].trim());
  return [];
}

export default function layermap(pi) {
  let server;
  let starting;
  let cwd;
  const registered = new Set();
  // The repository the session started in, "" outside one.
  let start = "";
  // The session's code edits and checks, in the order its tool calls ended; the files each running
  // shell command names, as it started, by the tool call's id; and what the agent was last asked
  // to check.
  const changes = [];
  const running = new Map();
  let asked = "";

  const ensureServer = async () => {
    if (server && !server.dead) return server;
    starting ??= (async () => {
      const next = new MapServer(cwd);
      const tools = await next.start(__VERSION__);
      for (const tool of tools) {
        if (registered.has(tool.name)) continue;
        registered.add(tool.name);
        pi.registerTool({
          name: tool.name,
          label: tool.title ?? tool.name,
          description: tool.description,
          promptSnippet: tool.title,
          promptGuidelines: tool.name === "project_explore_map" ? [AGENT_MAP_NOTE] : [],
          parameters: Type.Unsafe(tool.inputSchema),
          async execute(_id, params, signal) {
            const running = await ensureServer();
            const result = await running.request(
              "tools/call",
              { name: tool.name, arguments: params ?? {} },
              signal,
            );
            const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
            if (result.isError) throw new Error(text);
            const repository = tool.name === CHECK_TOOL && checkedRepository(text);
            if (repository) changes.push({ kind: "check", repository });
            return { content: [{ type: "text", text }], details: {} };
          },
        });
      }
      server = next;
      return next;
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    start = await repositoryAt(cwd);
    changes.length = 0;
    running.clear();
    asked = "";
    await ensureServer().catch((error) =>
      ctx.ui?.notify?.(`LayerMap could not start: ${error.message}`, "warning"),
    );
  });

  pi.on("tool_call", async (event) => {
    if (READS.has(event.toolName) || registered.has(event.toolName) || !cwd) return;
    const command = event.input?.command;
    if (namedFiles(event).length || typeof command !== "string") return;
    const files = await commandFiles(cwd, command);
    if (files.length) running.set(event.toolCallId, await fileStates(files));
  });

  pi.on("tool_result", async (event) => {
    if (!cwd) return;
    const before = running.get(event.toolCallId);
    running.delete(event.toolCallId);
    const files = before
      ? changedFiles(before, await fileStates(Object.keys(before)))
      : event.isError
        ? []
        : namedFiles(event).map((file) => path.resolve(cwd, file));
    changes.push(...(await codeEdits(files)));
  });

  pi.on("agent_before_settle", async (event) => {
    if (process.env.LAYERMAP_STOP_CHECK === "0") return;
    const request = await checkRequest(changes, start, asked);
    if (!request) return;
    asked = request.fingerprint;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "layermap-check",
          content: request.text,
          display: false,
        },
      ],
      continue: true,
    };
  });

  pi.on("session_shutdown", async () => {
    const running = server;
    server = undefined;
    await running?.stop();
  });
}

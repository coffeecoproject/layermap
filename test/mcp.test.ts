import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { serveMcp } from "../src/agent/mcp";
import type { LayerMap } from "../src/layermap";
import { FILES, openMap, project } from "./support";

const session = (open: () => Promise<LayerMap>, buildWaitMs?: number) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveMcp({
    version: "0.0.0-test",
    open,
    input,
    output,
    buildWaitMs,
    log: () => {},
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: output }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(++id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const close = () => {
    input.end();
    return served;
  };
  return { request, notify, close };
};

test("an MCP client lists the read-only map tools and explores the project", async () => {
  const { root } = await project(FILES);
  const client = session(() => openMap(root));
  try {
    const initialized = (await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    })) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    assert.equal(initialized.result.serverInfo.name, "layermap");
    assert.match(initialized.result.instructions, /direction INCOMING/u);
    client.notify("notifications/initialized");

    const listed = (await client.request("tools/list")) as {
      result: {
        tools: {
          name: string;
          inputSchema: { type: string };
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "project_explore_map",
        "project_search_map",
        "project_find_references",
        "project_check_changes",
      ],
    );
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.annotations.readOnlyHint, true);
    }

    const explored = (await client.request("tools/call", {
      name: "project_explore_map",
      arguments: { path: "src/", name: "target", direction: "INCOMING" },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(explored.result.isError, true);
    assert.match(
      explored.result.content[0]?.text ?? "",
      /PROJECT_MAP_OBJECT_NOT_FOUND|PROJECT_READ_INPUT_INVALID/u,
    );

    const declaration = (await client.request("tools/call", {
      name: "project_explore_map",
      arguments: { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 2 },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(declaration.result.isError, false);
    assert.match(declaration.result.content[0]?.text ?? "", /← called by src\/helper\.ts: helper/u);

    const invalid = (await client.request("tools/call", {
      name: "project_search_map",
      arguments: { query: "" },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0]?.text ?? "", /^Invalid arguments: query/u);

    // An agent that has not loaded the schema guesses arguments; the check ignores those it lacks.
    const guessed = (await client.request("tools/call", {
      name: "project_check_changes",
      arguments: { path: ".", project_root: root },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.doesNotMatch(guessed.result.content[0]?.text ?? "", /Invalid arguments/u);

    const unknown = (await client.request("resources/list")) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  } finally {
    await client.close();
  }
});

test("a tool call says the map is still building instead of waiting past the agent's timeout", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { root } = await project(FILES);
  const client = session(async () => {
    await blocked;
    return openMap(root);
  }, 50);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    client.notify("notifications/initialized");
    const early = (await client.request("tools/call", {
      name: "project_explore_map",
      arguments: { path: "." },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(early.result.isError, false);
    assert.match(early.result.content[0]?.text ?? "", /still building/u);
  } finally {
    release();
    await client.close();
  }
});

test("a client that disconnects during the first build stops it instead of waiting for it", async () => {
  let aborted = false;
  const building = {
    refresh: (signal: AbortSignal) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      ),
    close: async () => {},
  } as unknown as LayerMap;
  const client = session(async () => building);
  await client.request("initialize", { protocolVersion: "2025-06-18" });
  client.notify("notifications/initialized");
  await client.close();
  assert.equal(aborted, true);
});

test("outside a Git repository the tools say so instead of mapping the directory", async () => {
  const { ProjectEvidenceError } = await import("../src/core");
  const client = session(async () => {
    throw new ProjectEvidenceError("LAYERMAP_NOT_A_GIT_REPOSITORY", false);
  });
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    client.notify("notifications/initialized");
    const call = (await client.request("tools/call", {
      name: "project_explore_map",
      arguments: { path: "." },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(call.result.isError, true);
    assert.match(
      call.result.content[0]?.text ?? "",
      /^LAYERMAP_NOT_A_GIT_REPOSITORY: LayerMap maps Git repositories/u,
    );
  } finally {
    await client.close();
  }
});

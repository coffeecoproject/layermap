import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { serveMcp } from "../src/agent/mcp";
import type { SessionStart } from "../src/agent/projects";
import type { LayerMap } from "../src/layermap";
import { FILES, openMap, project, sandbox } from "./support";

const session = (
  start: SessionStart,
  open: (project: string) => Promise<LayerMap>,
  buildWaitMs?: number,
) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveMcp({
    version: "0.0.0-test",
    start,
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
  // This test is about the tools, not the build wait: a first build that must also build the
  // language analyzers can take longer than the default wait.
  const client = session({ directory: root, git: true }, openMap, 10 * 60_000);
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
    assert.ok(
      declaration.result.content[0]?.text.startsWith(
        `Project ${root} (paths are relative to it)\n`,
      ),
      "a result names the repository its paths are relative to",
    );
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
  const client = session(
    { directory: root, git: true },
    async (directory) => {
      await blocked;
      return openMap(directory);
    },
    50,
  );
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
  const client = session({ directory: await sandbox(), git: true }, async () => building);
  await client.request("initialize", { protocolVersion: "2025-06-18" });
  client.notify("notifications/initialized");
  await client.close();
  assert.equal(aborted, true);
});

const run = promisify(execFile);
type CallResult = { result: { content: { text: string }[]; isError: boolean } };

// A folder holding two repositories, a/ and b/, beside a directory outside both.
async function workspace() {
  const folder = await sandbox();
  for (const name of ["a", "b"]) {
    await project(FILES, path.join(folder, name));
    // A change check compares with a commit.
    await run("git", ["add", "-A"], { cwd: path.join(folder, name) });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
      cwd: path.join(folder, name),
    });
  }
  await mkdir(path.join(folder, "notes"));
  const opened: string[] = [];
  const open = (directory: string) => {
    opened.push(directory);
    return openMap(directory);
  };
  return { folder, a: path.join(folder, "a"), b: path.join(folder, "b"), opened, open };
}

const named = (call: CallResult, project: string) =>
  call.result.content[0]?.text.startsWith(`Project ${project} (paths are relative to it)\n`);

test("a session started in a folder holding several repositories maps the one each call names", async () => {
  const { folder, a, b, opened, open } = await workspace();
  const client = session({ directory: folder, git: false }, open, 10 * 60_000);
  const call = (name: string, args: Record<string, unknown>) =>
    client.request("tools/call", { name, arguments: args }) as Promise<CallResult>;
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    client.notify("notifications/initialized");

    const overview = await call("project_explore_map", { path: "." });
    assert.equal(overview.result.isError, true);
    assert.equal(
      overview.result.content[0]?.text,
      `LAYERMAP_NOT_A_GIT_REPOSITORY: This session started in ${folder}, which is not in a Git repository. Name a file or directory in one, relative to that folder or absolute, such as a/, b/.`,
    );
    const empty = await call("project_explore_map", { path: "" });
    assert.equal(empty.result.content[0]?.text, overview.result.content[0]?.text);
    // Arguments are checked before any repository is looked for.
    const invalid = await call("project_explore_map", { path: 5 });
    assert.match(invalid.result.content[0]?.text ?? "", /^Invalid arguments: path/u);
    const unknown = await call("project_nope", {});
    assert.equal(unknown.result.content[0]?.text, "Unknown tool project_nope.");
    const outside = await call("project_explore_map", { path: "notes/todo.ts" });
    assert.equal(outside.result.isError, true);
    assert.equal(
      outside.result.content[0]?.text,
      `LAYERMAP_NOT_A_GIT_REPOSITORY: ${path.join(folder, "notes", "todo.ts")} is not in a Git repository; LayerMap maps Git repositories. Name a file or directory in one, relative to ${folder} or absolute, such as a/, b/.`,
    );

    const inA = await call("project_explore_map", {
      path: "a/src/target.ts",
      name: "target",
      direction: "INCOMING",
      depth: 2,
    });
    assert.equal(inA.result.isError, false, inA.result.content[0]?.text ?? "");
    assert.ok(named(inA, a));
    assert.match(inA.result.content[0]?.text ?? "", /← called by src\/helper\.ts: helper/u);

    const inB = await call("project_search_map", { path: path.join(b, "src"), query: "helper" });
    assert.equal(inB.result.isError, false, inB.result.content[0]?.text ?? "");
    assert.ok(named(inB, b), "an absolute path names its repository");

    const references = await call("project_find_references", {
      symbol: { path: "a/src/target.ts", name: "target" },
      path: "a/src",
    });
    assert.equal(references.result.isError, false, references.result.content[0]?.text ?? "");
    assert.ok(named(references, a));
    assert.match(references.result.content[0]?.text ?? "", /src\/helper\.ts/u);
    const elsewhere = await call("project_find_references", {
      symbol: { path: "a/src/target.ts", name: "target" },
      path: "b/src",
    });
    assert.equal(elsewhere.result.isError, true);
    assert.match(elsewhere.result.content[0]?.text ?? "", /^PROJECT_PATH_INVALID: path b\/src/u);

    const unnamed = await call("project_check_changes", {});
    assert.equal(unnamed.result.isError, true);
    assert.match(unnamed.result.content[0]?.text ?? "", /^LAYERMAP_NOT_A_GIT_REPOSITORY/u);
    const checked = await call("project_check_changes", { path: "b" });
    assert.equal(checked.result.isError, false, checked.result.content[0]?.text ?? "");
    assert.ok(named(checked, b));

    assert.deepEqual(opened, [a, b], "each repository's map is opened once");
  } finally {
    await client.close();
  }
});

test("a session that moves to another repository maps it when given its path", async () => {
  const { a, b, opened, open } = await workspace();
  const client = session({ directory: a, git: true }, open, 10 * 60_000);
  const explore = (target: string) =>
    client.request("tools/call", {
      name: "project_explore_map",
      arguments: { path: target, name: "target", direction: "INCOMING" },
    }) as Promise<CallResult>;
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    client.notify("notifications/initialized");
    const here = await explore("src/target.ts");
    assert.equal(here.result.isError, false, here.result.content[0]?.text ?? "");
    assert.ok(named(here, a), "a relative path is the starting repository's");
    const relative = await explore("../b/src/target.ts");
    assert.equal(relative.result.isError, false, relative.result.content[0]?.text ?? "");
    assert.ok(named(relative, b), "a path out of the starting repository names the one it reaches");
    const absolute = await explore(path.join(b, "src", "target.ts"));
    assert.ok(named(absolute, b));
    assert.deepEqual(opened, [a, b]);
  } finally {
    await client.close();
  }
});

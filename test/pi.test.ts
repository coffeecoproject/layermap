import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { generatedFiles } from "../scripts/plugins";
import {
  AGENT_MAP_NOTE,
  AGENT_STOP_CHECK,
  AGENT_STOP_CHECK_REPOSITORIES,
} from "../src/agent/tools";
import { sandbox } from "./support";

const run = promisify(execFile);

// The package as npm installs it: the extension in pi/, a stand-in server at dist/cli.mjs that
// answers like LayerMap's (one tool, echoing its arguments), and the typebox Pi provides.
async function installed(): Promise<string> {
  const root = await sandbox();
  await mkdir(path.join(root, "pi"));
  await mkdir(path.join(root, "dist"));
  await mkdir(path.join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(
    path.join(root, "pi", "layermap.mjs"),
    generatedFiles("1.2.3")["plugins/pi/layermap.mjs"] ?? "",
  );
  await writeFile(
    path.join(root, "node_modules", "typebox", "package.json"),
    JSON.stringify({ name: "typebox", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    path.join(root, "node_modules", "typebox", "index.js"),
    "export const Type = { Unsafe: (schema) => schema };\n",
  );
  await writeFile(
    path.join(root, "dist", "cli.mjs"),
    `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  if (method === "tools/list") send({ id, result: { tools: [{ name: "project_check_changes", title: "Check", description: "d", inputSchema: { type: "object" } }] } });
  if (method === "tools/call") send({ id, result: { content: [{ type: "text", text: "cwd " + process.cwd() + " args " + JSON.stringify(params.arguments) }], isError: params.arguments.fail === true } });
});
`,
  );
  return root;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = {
  name: string;
  promptGuidelines: string[];
  execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
};

test("the Pi extension serves LayerMap's tools from its server and asks once to check edited code", async (t) => {
  const pkg = await installed();
  const repo = await sandbox();
  await writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
  await run("git", ["init", "-q"], { cwd: repo });
  await run("git", ["add", "-A"], { cwd: repo });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: repo,
  });

  const handlers = new Map<string, Handler>();
  const tools: Tool[] = [];
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerTool: (tool: Tool) => tools.push(tool),
  };
  const { default: extension } = await import(
    pathToFileURL(path.join(pkg, "pi", "layermap.mjs")).href
  );
  extension(pi);
  const ctx = { cwd: repo, ui: { notify: () => {} } };
  await handlers.get("session_start")?.({}, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));

  // The server's tools, started in the session's directory, with the note on how to use the map.
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["project_check_changes"],
  );
  const result = await tools[0]?.execute("1", { base: "HEAD" }, undefined);
  assert.match(result?.content[0]?.text ?? "", /^cwd .* args \{"base":"HEAD"\}$/u);
  assert.ok(!(tools[0]?.promptGuidelines ?? []).length, "the note goes with project_explore_map");

  const settle = handlers.get("agent_before_settle") as Handler;
  const ask = async () =>
    (await settle({ entries: [] }, ctx)) as
      | { entries: { content: string }[]; continue: boolean }
      | undefined;
  // No edit yet: nothing to ask. A command that changes code, then a settle: ask once for these
  // changes.
  assert.equal(await ask(), undefined);
  const command = { toolName: "bash", toolCallId: "c1", input: { command: "sed -i … a.ts" } };
  await handlers.get("tool_call")?.(command, ctx);
  await writeFile(path.join(repo, "a.ts"), "export const a = 2;\n");
  await handlers.get("tool_result")?.(command, ctx);
  const asked = await ask();
  assert.equal(asked?.continue, true);
  assert.equal(asked?.entries[0]?.content, AGENT_STOP_CHECK);
  assert.equal(await ask(), undefined, "not twice for the same changes");
  // A check that failed does not count; checked changes are not asked about, later ones are.
  await writeFile(path.join(repo, "a.ts"), "export const a = 4;\n");
  await assert.rejects(tools[0]?.execute("2", { fail: true }, undefined) ?? Promise.resolve());
  assert.equal((await ask())?.continue, true);
  await tools[0]?.execute("3", {}, undefined);
  assert.equal(await ask(), undefined);
  await writeFile(path.join(repo, "a.ts"), "export const a = 3;\n");
  assert.equal((await ask())?.continue, true);
});

test("the generated Pi extension carries the notes and this version", () => {
  const source = generatedFiles("1.2.3")["plugins/pi/layermap.mjs"] ?? "";
  assert.ok(source.includes(JSON.stringify(AGENT_MAP_NOTE)));
  assert.ok(source.includes(JSON.stringify(AGENT_STOP_CHECK)));
  assert.ok(source.includes('"1.2.3"'));
  assert.doesNotMatch(source, /__[A-Z_]+__/u);
});

test("the Pi extension asks about each repository an edit names until a check of it", async (t) => {
  const pkg = await installed();
  const folder = await realpath(await sandbox());
  const repo = async (name: string) => {
    const root = path.join(folder, name);
    await mkdir(root);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
      cwd: root,
    });
    return root;
  };
  const [a, b] = [await repo("a"), await repo("b")];
  await mkdir(path.join(folder, "notes"));

  const handlers = new Map<string, Handler>();
  const tools: Tool[] = [];
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerTool: (tool: Tool) => tools.push(tool),
  };
  const { default: extension } = await import(
    `${pathToFileURL(path.join(pkg, "pi", "layermap.mjs")).href}?several`
  );
  extension(pi);
  const ctx = { cwd: folder, ui: { notify: () => {} } };
  await handlers.get("session_start")?.({}, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  const settle = handlers.get("agent_before_settle") as Handler;
  const ask = async () =>
    ((await settle({ entries: [] }, ctx)) as { entries: { content: string }[] } | undefined)
      ?.entries[0]?.content;
  const edit = async (file: string) => {
    await handlers.get("tool_call")?.({ toolName: "edit", input: { path: file } }, ctx);
    await writeFile(path.join(folder, file), "export const a = 2;\n");
  };

  // Started in the folder holding both: other tools name no repository, edits name theirs.
  await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "…" } }, ctx);
  assert.equal(await ask(), undefined);
  await edit("a/a.ts");
  await edit("b/a.ts");
  assert.equal(await ask(), `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${a}, ${b}.`);
  // A check without a path checks no repository here; one with a path checks its repository.
  await writeFile(path.join(a, "a.ts"), "export const a = 3;\n");
  await tools[0]?.execute("1", {}, undefined);
  await tools[0]?.execute("2", { path: "b" }, undefined);
  assert.equal(await ask(), `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${a}.`);
  await tools[0]?.execute("3", { path: path.join(a, "a.ts") }, undefined);
  assert.equal(await ask(), undefined);
});

test("the Pi extension takes the repositories of the files an apply_patch patch names", async (t) => {
  const pkg = await installed();
  const folder = await realpath(await sandbox());
  const repo = async (name: string) => {
    const root = path.join(folder, name);
    await mkdir(root);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
      cwd: root,
    });
    return root;
  };
  const [a, b] = [await repo("a"), await repo("b")];
  const { default: extension } = await import(
    `${pathToFileURL(path.join(pkg, "pi", "layermap.mjs")).href}?patch`
  );
  // A session in cwd that patches the files, as pi-codex-tools' apply_patch takes them.
  const session = async (cwd: string, patch: string) => {
    const handlers = new Map<string, Handler>();
    extension({
      on: (name: string, h: Handler) => handlers.set(name, h),
      registerTool: () => {},
    });
    const ctx = { cwd, ui: { notify: () => {} } };
    await handlers.get("session_start")?.({}, ctx);
    t.after(() => handlers.get("session_shutdown")?.({}, ctx));
    await handlers.get("tool_call")?.({ toolName: "apply_patch", input: { patch } }, ctx);
    for (const [, file] of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm))
      await writeFile(path.resolve(cwd, file as string), "export const a = 2;\n");
    const settle = handlers.get("agent_before_settle") as Handler;
    return ((await settle({ entries: [] }, ctx)) as { entries: { content: string }[] } | undefined)
      ?.entries[0]?.content;
  };

  assert.equal(
    await session(
      folder,
      "*** Begin Patch\n*** Add File: a/b.ts\n+x\n*** Update File: b/a.ts\n@@\n-x\n+y\n*** End Patch\n",
    ),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${a}, ${b}.`,
  );
  await run("git", ["checkout", "-q", "."], { cwd: b });
  assert.equal(
    await session(a, "*** Begin Patch\n*** Update File: ../b/a.ts\n@@\n-x\n+y\n*** End Patch\n"),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${b}.`,
  );
});

test("the Pi extension takes the repositories in which a shell command changed code", async (t) => {
  const pkg = await installed();
  const folder = await realpath(await sandbox());
  const repo = async (name: string) => {
    const root = path.join(folder, name);
    await mkdir(root);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
      cwd: root,
    });
    return root;
  };
  const [a, b] = [await repo("a"), await repo("b")];
  const { default: extension } = await import(
    `${pathToFileURL(path.join(pkg, "pi", "layermap.mjs")).href}?command`
  );
  const session = async (cwd: string) => {
    const handlers = new Map<string, Handler>();
    extension({ on: (name: string, h: Handler) => handlers.set(name, h), registerTool: () => {} });
    const ctx = { cwd, ui: { notify: () => {} } };
    await handlers.get("session_start")?.({}, ctx);
    t.after(() => handlers.get("session_shutdown")?.({}, ctx));
    let calls = 0;
    return {
      // A bash call of the command, during which change() runs.
      run: async (command: string, change = async () => {}) => {
        calls += 1;
        const event = { toolName: "bash", toolCallId: `c${calls}`, input: { command } };
        await handlers.get("tool_call")?.(event, ctx);
        await change();
        await handlers.get("tool_result")?.(event, ctx);
      },
      ask: async () =>
        (
          (await (handlers.get("agent_before_settle") as Handler)({ entries: [] }, ctx)) as
            | { entries: { content: string }[] }
            | undefined
        )?.entries[0]?.content,
    };
  };

  // In the folder: the repository of a folder the command names, when the command changed it.
  const inFolder = await session(folder);
  await inFolder.run("cd b && sed -i '' s/1/2/ a.ts", () =>
    writeFile(path.join(b, "a.ts"), "export const a = 2;\n"),
  );
  assert.equal(await inFolder.ask(), `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${b}.`);

  // In a: a change made between commands is not the session's; one made during a command is.
  const inA = await session(a);
  await writeFile(path.join(a, "a.ts"), "export const a = 9;\n");
  await inA.run("ls");
  assert.equal(await inA.ask(), undefined);
  await inA.run("npm run generate", () => writeFile(path.join(a, "b.ts"), "export const b = 1;\n"));
  assert.equal(await inA.ask(), AGENT_STOP_CHECK);
});

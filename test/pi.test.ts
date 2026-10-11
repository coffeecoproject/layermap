import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { generatedFiles } from "../scripts/plugins";
import { AGENT_MAP_NOTE, AGENT_STOP_CHECK } from "../src/agent/tools";
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
  // No edit yet: nothing to ask. An edit to code, then a settle: ask once for these changes.
  assert.equal(await ask(), undefined);
  await handlers.get("tool_call")?.({ toolName: "apply_patch", input: { patch: "…" } }, ctx);
  await writeFile(path.join(repo, "a.ts"), "export const a = 2;\n");
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

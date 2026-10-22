import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
  projectHeading,
} from "../src/agent/notes";
import { gitRoot, sandbox } from "./support";

const run = promisify(execFile);

// The package as npm installs it: the extension in pi/, a stand-in server at dist/cli.mjs that
// answers like LayerMap's (one tool, echoing its arguments under the heading that names the
// repository its path is in, failing outside one), and the typebox Pi provides.
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
    `import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const repository = (given) => {
  let directory = path.resolve(given ?? ".");
  while (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) directory = path.dirname(directory);
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
};
const heading = (project) => ${JSON.stringify(projectHeading("PROJECT"))}.replace("PROJECT", project);
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  if (method === "tools/list") send({ id, result: { tools: [{ name: "project_check_changes", title: "Check", description: "d", inputSchema: { type: "object" } }] } });
  if (method === "tools/call") {
    const project = repository(params.arguments.path);
    const text = "cwd " + process.cwd() + " args " + JSON.stringify(params.arguments);
    send({ id, result: { content: [{ type: "text", text: project ? heading(project) + "\\n\\n" + text : text }], isError: !project || params.arguments.fail === true } });
  }
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
  assert.match(
    result?.content[0]?.text ?? "",
    /^Project .* \(paths are relative to it\)\n\ncwd .* args \{"base":"HEAD"\}$/u,
  );
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
  // After the check, a change another session makes is not this one's; one it makes is.
  await writeFile(path.join(repo, "a.ts"), "export const a = 3;\n");
  assert.equal(await ask(), undefined);
  const again = { toolName: "bash", toolCallId: "c2", input: { command: "sed -i … a.ts" } };
  await handlers.get("tool_call")?.(again, ctx);
  await writeFile(path.join(repo, "a.ts"), "export const a = 5;\n");
  await handlers.get("tool_result")?.(again, ctx);
  assert.equal((await ask())?.continue, true);
});

test("the generated Pi extension carries the notes and this version", () => {
  const source = generatedFiles("1.2.3")["plugins/pi/layermap.mjs"] ?? "";
  assert.ok(source.includes(JSON.stringify(AGENT_MAP_NOTE)));
  assert.ok(source.includes(JSON.stringify(AGENT_STOP_CHECK)));
  assert.ok(source.includes('"1.2.3"'));
  assert.doesNotMatch(source, /__VERSION__/u);
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
  // Each repository as Git names it, and so the reminder: C:/… on Windows.
  const [gitA, gitB] = [await gitRoot(a), await gitRoot(b)];
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
    const event = { toolName: "edit", toolCallId: file, input: { path: file }, isError: false };
    await handlers.get("tool_call")?.(event, ctx);
    await writeFile(path.join(folder, file), "export const a = 2;\n");
    await handlers.get("tool_result")?.(event, ctx);
  };

  // Started in the folder holding both: other tools name no repository, edits name theirs.
  await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "…" } }, ctx);
  assert.equal(await ask(), undefined);
  await edit("a/a.ts");
  await edit("b/a.ts");
  assert.equal(
    await ask(),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${gitA}, ${gitB}.`,
  );
  // A check without a path fails here; one with a path checks its repository.
  await writeFile(path.join(a, "a.ts"), "export const a = 3;\n");
  await assert.rejects(tools[0]?.execute("1", {}, undefined) ?? Promise.resolve());
  await tools[0]?.execute("2", { path: "b" }, undefined);
  assert.equal(await ask(), `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${gitA}.`);
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
  // Each repository as Git names it, and so the reminder: C:/… on Windows.
  const [gitA, gitB] = [await gitRoot(a), await gitRoot(b)];
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
    const event = { toolName: "apply_patch", toolCallId: "p1", input: { patch }, isError: false };
    await handlers.get("tool_call")?.(event, ctx);
    for (const [, file] of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm))
      await writeFile(path.resolve(cwd, file as string), "export const a = 2;\n");
    await handlers.get("tool_result")?.(event, ctx);
    const settle = handlers.get("agent_before_settle") as Handler;
    return ((await settle({ entries: [] }, ctx)) as { entries: { content: string }[] } | undefined)
      ?.entries[0]?.content;
  };

  assert.equal(
    await session(
      folder,
      "*** Begin Patch\n*** Add File: a/b.ts\n+x\n*** Update File: b/a.ts\n@@\n-x\n+y\n*** End Patch\n",
    ),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${gitA}, ${gitB}.`,
  );
  await run("git", ["checkout", "-q", "."], { cwd: b });
  assert.equal(
    await session(a, "*** Begin Patch\n*** Update File: ../b/a.ts\n@@\n-x\n+y\n*** End Patch\n"),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${gitB}.`,
  );
});

test("the Pi extension takes the code files a shell command names and changed", async (t) => {
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
  // The repository as Git names it, and so the reminder: C:/… on Windows.
  const gitB = await gitRoot(b);
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
      // A bash call of the command, during which change() runs; one that fails.
      run: async (command: string, change = async () => {}, isError = false) => {
        calls += 1;
        const event = { toolName: "bash", toolCallId: `c${calls}`, input: { command }, isError };
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
  assert.equal(
    await inFolder.ask(),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${gitB}.`,
  );

  // In a: a change made between commands is not the session's, nor one a command makes to a file
  // it does not name, as a generator does; a change to a file it names is, even when it fails.
  const inA = await session(a);
  await writeFile(path.join(a, "a.ts"), "export const a = 9;\n");
  await inA.run("ls");
  assert.equal(await inA.ask(), undefined);
  await inA.run("npm run generate", () => writeFile(path.join(a, "b.ts"), "export const b = 1;\n"));
  assert.equal(await inA.ask(), undefined);
  await inA.run(
    "node generate.mjs b.ts && false",
    () => writeFile(path.join(a, "b.ts"), "export const b = 2;\n"),
    true,
  );
  assert.equal(await inA.ask(), AGENT_STOP_CHECK);
});

// A repository's own config may name programs for Git to run, as a cloned or downloaded one may
// come with; the extension still sees its changes, and runs none of them.
test("the Pi extension runs no program the repository's Git config names", async (t) => {
  const pkg = await installed();
  const root = path.join(await realpath(await sandbox()), "repo");
  await mkdir(root);
  await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, ".gitattributes"), "*.ts filter=evil\n");
  const git = (...args: string[]) => run("git", args, { cwd: root });
  await git("init", "-q");
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const marker = (name: string) => path.join(root, "..", name);
  await git("config", "filter.evil.clean", `sh -c 'touch "${marker("filter")}"; cat'`);
  await git("config", "filter.evil.required", "true");
  await git("config", "core.fsmonitor", `sh -c 'touch "${marker("fsmonitor")}"'`);
  const { default: extension } = await import(
    `${pathToFileURL(path.join(pkg, "pi", "layermap.mjs")).href}?filters`
  );
  const handlers = new Map<string, Handler>();
  extension({ on: (name: string, h: Handler) => handlers.set(name, h), registerTool: () => {} });
  const ctx = { cwd: root, ui: { notify: () => {} } };
  await handlers.get("session_start")?.({}, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  const event = { toolName: "bash", toolCallId: "c1", input: { command: "touch a.ts" } };
  await handlers.get("tool_call")?.(event, ctx);
  await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  await handlers.get("tool_result")?.(event, ctx);
  const asked = (await (handlers.get("agent_before_settle") as Handler)({ entries: [] }, ctx)) as
    | { entries: { content: string }[] }
    | undefined;
  assert.equal(asked?.entries[0]?.content, AGENT_STOP_CHECK);
  assert.equal(existsSync(marker("filter")), false);
  assert.equal(existsSync(marker("fsmonitor")), false);
});

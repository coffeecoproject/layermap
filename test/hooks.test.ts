import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENT_STOP_CHECK, AGENT_STOP_CHECK_REPOSITORIES } from "../src/agent/tools";
import { gitRoot, project, sandbox } from "./support";

const run = promisify(execFile);
const hooks = fileURLToPath(new URL("../plugins/claude/hooks/", import.meta.url));

// Runs a Claude Code hook script the way Claude Code does: its input JSON on stdin.
async function hook(
  name: string,
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<string> {
  const child = execFile("sh", [path.join(hooks, name)], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  child.stdin?.end(JSON.stringify(input));
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  return output;
}

test("the stop hook asks once per set of code changes made in the session", async () => {
  const { root, write } = await project({ "src/a.ts": "export const a = 1;\n", "notes.md": "x\n" });
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await git("add", "-A");
  await git("commit", "-qm", "base");
  const env = { TMPDIR: await sandbox() };
  const input = { session_id: "s1", cwd: root, stop_hook_active: false };

  const started = await hook("session-start.sh", input, env);
  assert.match(JSON.parse(started).hookSpecificOutput.additionalContext, /project_check_changes/u);
  assert.equal(await hook("stop-check.sh", input, env), "", "nothing changed yet");

  await write("notes.md", "y\n");
  assert.equal(await hook("stop-check.sh", input, env), "", "only code changes count");

  await write("src/a.ts", "export const a = 2;\n");
  const blocked = JSON.parse(await hook("stop-check.sh", input, env));
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /project_check_changes/u);
  assert.equal(
    await hook("stop-check.sh", input, env),
    "",
    "the same changes are asked about once",
  );
  await write("src/b.ts", "export const b = 1;\n");
  assert.equal(
    await hook("stop-check.sh", { ...input, stop_hook_active: true }, env),
    "",
    "never while Claude is already continuing for a stop hook",
  );
  assert.equal(
    (JSON.parse(await hook("stop-check.sh", input, env)) as { decision: string }).decision,
    "block",
  );
  assert.equal(await hook("stop-check.sh", input, { ...env, LAYERMAP_STOP_CHECK: "0" }), "");

  // A new session that starts with these uncommitted changes and makes none is not asked.
  const next = { ...input, session_id: "s2" };
  await hook("session-start.sh", next, env);
  assert.equal(await hook("stop-check.sh", next, env), "");
});

test("the stop hook asks only about this session's own edits, and not after it checked", async () => {
  const { root, write } = await project({ "src/a.ts": "export const a = 1;\n" });
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await git("add", "-A");
  await git("commit", "-qm", "base");
  const env = { TMPDIR: await sandbox() };
  const transcript = path.join(await sandbox(), "transcript.jsonl");
  const line = (name: string, file = path.join(root, "src/a.ts")) =>
    JSON.stringify({
      message: { content: [{ type: "tool_use", name, input: { file_path: file } }] },
    });
  const input = { session_id: "s", cwd: root, transcript_path: transcript };
  await hook("session-start.sh", input, env);

  // Changes another session made in the shared work tree, or edits elsewhere, are not this one's.
  await write("src/a.ts", "export const a = 9;\n");
  await writeFile(transcript, line("Edit", "/somewhere/else/a.ts"));
  assert.equal(await hook("stop-check.sh", input, env), "");

  await write("src/a.ts", "export const a = 2;\n");
  await writeFile(
    transcript,
    [line("Edit"), line("mcp__plugin_layermap_layermap__project_check_changes")].join("\n"),
  );
  assert.equal(await hook("stop-check.sh", input, env), "");

  await write("src/a.ts", "export const a = 3;\n");
  await writeFile(
    transcript,
    [line("Edit"), line("mcp__plugin_layermap_layermap__project_check_changes"), line("Edit")].join(
      "\n",
    ),
  );
  assert.equal(JSON.parse(await hook("stop-check.sh", input, env)).decision, "block");
});

test("the stop hook reads the calls, not Claude Code's copies of the messages it sent", async () => {
  const { root, write } = await project({ "src/a.ts": "export const a = 1;\n" });
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await git("add", "-A");
  await git("commit", "-qm", "base");
  const env = { TMPDIR: await sandbox() };
  const transcript = path.join(await sandbox(), "transcript.jsonl");
  const edit = {
    type: "tool_use",
    name: "Edit",
    input: { file_path: path.join(root, "src/a.ts") },
  };
  const check = { type: "tool_use", name: "mcp__layermap__project_check_changes", input: {} };
  // As Claude Code 2.1.300 writes them: each call of a reply on a line of its own, and the reply
  // once more, whole, as a copy of the request that sent it back.
  const entry = (call: object) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [call] } });
  const copy = (...calls: object[]) =>
    JSON.stringify({
      type: "api-request-blob",
      sessionId: "s",
      hash: "h",
      message: { role: "assistant", content: calls },
    });
  await write("src/a.ts", "export const a = 2;\n");

  let sessions = 0;
  const stop = async (...lines: string[]) => {
    await writeFile(transcript, lines.join("\n"));
    sessions += 1;
    const input = { session_id: `s${sessions}`, cwd: root, transcript_path: transcript };
    return hook("stop-check.sh", input, env);
  };
  assert.equal(await stop(entry(edit), entry(check), copy(edit, check)), "");
  assert.equal(
    JSON.parse(await stop(entry(check), entry(edit), copy(check, edit))).decision,
    "block",
  );
});

test("the stop hook reads CodeBuddy's transcript, whose arguments are a JSON string", async () => {
  const { root, write } = await project({ "src/a.ts": "export const a = 1;\n" });
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await git("add", "-A");
  await git("commit", "-qm", "base");
  const env = { TMPDIR: await sandbox() };
  const transcript = path.join(await sandbox(), "transcript.jsonl");
  const line = (name: string) =>
    JSON.stringify({
      type: "function_call",
      name,
      arguments: JSON.stringify({ file_path: path.join(root, "src/a.ts"), new_string: "x" }),
    });
  const input = { session_id: "s", cwd: root, transcript_path: transcript };
  await hook("session-start.sh", input, env);

  await write("src/a.ts", "export const a = 2;\n");
  await writeFile(transcript, line("Edit"));
  assert.equal(JSON.parse(await hook("stop-check.sh", input, env)).decision, "block");

  await write("src/a.ts", "export const a = 3;\n");
  await writeFile(
    transcript,
    [line("Edit"), line("mcp__layermap__project_check_changes")].join("\n"),
  );
  assert.equal(await hook("stop-check.sh", input, env), "");
});

test("outside a Git repository the hooks only print the note", async () => {
  const directory = path.join(await sandbox(), "plain");
  await mkdir(directory);
  const env = { TMPDIR: await sandbox() };
  const input = { session_id: "s", cwd: directory };
  assert.match(await hook("session-start.sh", input, env), /hookSpecificOutput/u);
  assert.equal(await hook("stop-check.sh", input, env), "");
});

test("hook fields are unescaped, so Windows paths reach git with single backslashes", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(path.join(hooks, "stop-check.sh"), "utf8");
  const field = script.split("\n").find((line) => line.startsWith("field()"));
  assert.ok(field);
  const snippet = path.join(await sandbox(), "field.sh");
  await writeFile(snippet, `input=$(cat | tr -d '\\n')\n${field}\nfield cwd\n`);
  const child = execFile("sh", [snippet]);
  child.stdin?.end(JSON.stringify({ cwd: "C:\\Users\\me\\project" }));
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(output.trim(), "C:\\Users\\me\\project");
});

test("the stop hook asks about each repository the session edited until a check of it", async () => {
  const folder = await realpath(await sandbox());
  const repo = async (name: string) => {
    const { root } = await project(
      { "src/a.ts": "export const a = 1;\n" },
      path.join(folder, name),
    );
    const git = (...args: string[]) =>
      run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
    await git("add", "-A");
    await git("commit", "-qm", "base");
    return root;
  };
  const [a, b] = [await repo("a"), await repo("b")];
  // Each repository as Git names it, and so the reminder: C:/… on Windows.
  const [gitA, gitB] = [await gitRoot(a), await gitRoot(b)];
  const env = { TMPDIR: await sandbox() };
  const transcript = path.join(await sandbox(), "transcript.jsonl");
  const edit = (file: string) =>
    JSON.stringify({
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] },
    });
  const check = (input: Record<string, string> = {}) =>
    JSON.stringify({
      message: {
        content: [
          { type: "tool_use", name: "mcp__plugin_layermap_layermap__project_check_changes", input },
        ],
      },
    });
  let sessions = 0;
  const stop = async (cwd: string, ...lines: string[]) => {
    await writeFile(transcript, lines.join("\n"));
    sessions += 1;
    const output = await hook(
      "stop-check.sh",
      { session_id: `s${sessions}`, cwd, transcript_path: transcript },
      env,
    );
    return output ? (JSON.parse(output) as { reason: string }).reason : "";
  };
  await writeFile(path.join(a, "src/a.ts"), "export const a = 2;\n");
  await writeFile(path.join(b, "src/a.ts"), "export const a = 2;\n");

  // Started in the folder holding both: each edited repository is named, as a check needs a path.
  const both = await stop(folder, edit(path.join(a, "src/a.ts")), edit(path.join(b, "src/a.ts")));
  assert.ok(both.endsWith(`${AGENT_STOP_CHECK_REPOSITORIES}${gitA}, ${gitB}.`), both);
  const unchecked = await stop(folder, edit(path.join(a, "src/a.ts")), check());
  assert.ok(
    unchecked.endsWith(`${AGENT_STOP_CHECK_REPOSITORIES}${gitA}.`),
    "a check needs a path here",
  );
  const left = await stop(
    folder,
    edit(path.join(a, "src/a.ts")),
    edit(path.join(b, "src/a.ts")),
    check({ path: "a/src" }),
  );
  assert.ok(left.endsWith(`${AGENT_STOP_CHECK_REPOSITORIES}${gitB}.`), left);
  assert.equal(
    await stop(
      folder,
      edit(path.join(a, "src/a.ts")),
      edit(path.join(b, "src/a.ts")),
      check({ path: "a/src" }),
      check({ path: b }),
    ),
    "",
  );

  // Started in a: a check without a path or with a relative one is a's, and ../b is b's.
  assert.equal(await stop(a, edit(path.join(a, "src/a.ts"))), AGENT_STOP_CHECK);
  const other = await stop(a, edit(path.join(b, "src/a.ts")), check());
  assert.ok(other.endsWith(`${AGENT_STOP_CHECK_REPOSITORIES}${gitB}.`), other);
  assert.equal(await stop(a, edit(path.join(b, "src/a.ts")), check({ path: "../b" }), check()), "");
  assert.equal(await stop(a, edit(path.join(b, "src/a.ts")), check({ path: "b" })), other);
});

test("the command hook notes the code files a shell command changes, for the stop hook", async () => {
  const folder = await realpath(await sandbox());
  const repo = async (name: string) => {
    const { root } = await project(
      { "src/a.ts": "export const a = 1;\n" },
      path.join(folder, name),
    );
    const git = (...args: string[]) =>
      run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
    await git("add", "-A");
    await git("commit", "-qm", "base");
    return root;
  };
  const [a, b] = [await repo("a"), await repo("b")];
  // Each repository as Git names it, and so the reminder and the notes: C:/… on Windows.
  const [gitA, gitB] = [await gitRoot(a), await gitRoot(b)];
  const env = { TMPDIR: await sandbox() };
  const transcript = path.join(await sandbox(), "transcript.jsonl");
  const check = (input: Record<string, string>) =>
    JSON.stringify({
      message: {
        content: [{ type: "tool_use", name: "mcp__layermap__project_check_changes", input }],
      },
    });
  const lines = ['{"type":"user"}'];
  const at = async (session: string, cwd: string, event: string, extra = {}) => {
    await writeFile(transcript, lines.join("\n"));
    const input = { session_id: session, cwd, transcript_path: transcript, ...extra };
    const script = { SessionStart: "session-start.sh", Stop: "stop-check.sh" }[event];
    return hook(script ?? "command-changes.sh", { ...input, hook_event_name: event }, env);
  };
  const command = (id: string, text: string) => ({
    tool_name: "Bash",
    tool_input: { command: text },
    tool_use_id: id,
  });
  const reason = (output: string) =>
    output ? (JSON.parse(output) as { reason: string }).reason : "";

  // Started in the folder: a command run there names a file in b, last, then changes it.
  await at("s1", folder, "SessionStart");
  const sed = command("c1", "sed -i '' s/1/2/ b/src/a.ts");
  await at("s1", folder, "PreToolUse", sed);
  await writeFile(path.join(b, "src/a.ts"), "export const a = 2;\n");
  await at("s1", folder, "PostToolUse", sed);
  assert.ok(
    reason(await at("s1", b, "Stop")).endsWith(`${AGENT_STOP_CHECK_REPOSITORIES}${gitB}.`),
    "the command's change is the session's",
  );
  lines.push(check({ path: b }));
  assert.equal(await at("s1", b, "Stop"), "", "and a check of b covers it");

  // Started in a, which another session changed before the command: a command there that changes
  // nothing adds no edit, and after cd b a check without a path is still a's.
  await writeFile(path.join(a, "src/a.ts"), "export const a = 9;\n");
  await at("s2", a, "SessionStart");
  await writeFile(path.join(a, "src/b.ts"), "export const b = 1;\n");
  const list = command("c2", "ls src");
  await at("s2", a, "PreToolUse", list);
  await at("s2", a, "PostToolUse", list);
  assert.equal(
    await at("s2", a, "Stop"),
    "",
    "a change made between commands is not the session's",
  );
  const touch = command("c3", "printf x >> src/b.ts");
  await at("s2", a, "PreToolUse", touch);
  await writeFile(path.join(a, "src/b.ts"), "export const b = 2;\n");
  await at("s2", a, "PostToolUse", touch);
  lines.push(check({}));
  assert.equal(await at("s2", b, "Stop"), "", "the session started in a, though its shell is in b");

  // A command that ran over a minute: what another session changed meanwhile is not the session's,
  // the file the command names is.
  await at("s3", a, "SessionStart");
  const generate = command("c4", "node scripts/generate.mjs src/generated.ts");
  await at("s3", a, "PreToolUse", generate);
  const started = path.join(env.TMPDIR, "layermap-claude", "s3.c4.before.time");
  await writeFile(started, `${Math.floor(Date.now() / 1000) - 120}\n`);
  await writeFile(path.join(a, "src/a.ts"), "export const a = 10;\n");
  await writeFile(path.join(a, "src/generated.ts"), "export const g = 1;\n");
  await at("s3", a, "PostToolUse", generate);
  const edits = await readFile(path.join(env.TMPDIR, "layermap-claude", "s3.edits"), "utf8");
  assert.deepEqual(
    [
      ...new Set(
        edits
          .trim()
          .split("\n")
          .map((line) => line.split("\t").slice(1).join(" ")),
      ),
    ],
    [`${gitA} src/generated.ts`],
  );
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { project, sandbox } from "./support";

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
  const child = execFile("sh", ["-c", `input=$(cat | tr -d '\\n')\n${field}\nfield cwd`]);
  child.stdin?.end(JSON.stringify({ cwd: "C:\\Users\\me\\project" }));
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(output.trim(), "C:\\Users\\me\\project");
});

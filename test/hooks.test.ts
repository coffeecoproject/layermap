import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENT_STOP_CHECK,
  AGENT_STOP_CHECK_REPOSITORIES,
  projectHeading,
} from "../src/agent/notes";
import { gitRoot, project, sandbox } from "./support";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../plugins/claude/hooks/layermap.mjs", import.meta.url));
const CHECK = "mcp__plugin_layermap_layermap__project_check_changes";

// Runs the Claude Code plugin's hook script the way Claude Code does: its input JSON on stdin, with
// the system's temporary directory in temp.
async function hook(
  input: Record<string, unknown>,
  temp: string,
  env: Record<string, string> = {},
): Promise<string> {
  const child = execFile(process.execPath, [script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: temp, TEMP: temp, TMP: temp, ...env },
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

// A Git work tree with a commit of the files.
async function committed(files: Record<string, string>, root?: string) {
  const made = await project(files, root);
  await run("git", ["add", "-A"], { cwd: made.root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: made.root,
  });
  return made;
}

// A session's hooks as Claude Code runs them for each tool call, started in cwd.
function session(id: string, cwd: string, temp: string, env: Record<string, string> = {}) {
  let calls = 0;
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    hook({ session_id: id, cwd, hook_event_name: event, ...extra }, temp, env);
  return {
    start: () => send("SessionStart"),
    end: () => send("SessionEnd"),
    // A Write call of the file; extra adds to its hook input, as a subagent's does.
    write: async (file: string, content: string, extra: Record<string, unknown> = {}) => {
      calls += 1;
      await writeFile(file, content);
      await send("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: file, content },
        tool_use_id: `w${calls}`,
        ...extra,
      });
    },
    // A Write call of the file that failed, as CodeBuddy reports it: the file is left as it was.
    failedWrite: async (file: string, content: string) => {
      calls += 1;
      await send("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: file, content },
        tool_use_id: `w${calls}`,
        tool_response: { is_error: true, error: "File has not been read yet." },
      });
    },
    // A Bash call of the command, during which change() runs: one that fails, or one Claude Code
    // sent to the background as the task named.
    bash: async (
      command: string,
      change: () => Promise<unknown> = async () => {},
      { fails = false, task }: { fails?: boolean; task?: string } = {},
    ) => {
      calls += 1;
      const call = { tool_name: "Bash", tool_input: { command }, tool_use_id: `b${calls}` };
      await send("PreToolUse", call);
      await change();
      await send(
        fails ? "PostToolUseFailure" : "PostToolUse",
        fails
          ? { ...call, error: "Exit code 1" }
          : {
              ...call,
              tool_response: {
                stdout: "",
                stderr: "",
                ...(task ? { backgroundTaskId: task } : {}),
              },
            },
      );
    },
    // A check whose result names the repository, as LayerMap's server heads it; or one that failed,
    // as Claude Code reports it, or as CodeBuddy does, with the server's text headed the same.
    check: async (repository: string, { fails }: { fails?: "Claude Code" | "CodeBuddy" } = {}) => {
      calls += 1;
      const text = `${projectHeading(repository)}\n\nPROJECT MAP · CHANGES against HEAD`;
      const call = { tool_name: CHECK, tool_input: {}, tool_use_id: `c${calls}` };
      if (fails === "Claude Code")
        await send("PostToolUseFailure", { ...call, error: "LAYERMAP_NOT_A_GIT_REPOSITORY" });
      else
        await send("PostToolUse", {
          ...call,
          tool_response:
            fails === "CodeBuddy" ? { is_error: true, error: text } : [{ type: "text", text }],
        });
    },
    // What the stop hook asks Claude, "" for nothing.
    stop: async (extra: Record<string, unknown> = {}) => {
      const output = await send("Stop", {
        stop_hook_active: false,
        background_tasks: [],
        ...extra,
      });
      if (!output) return "";
      const blocked = JSON.parse(output) as { decision: string; reason: string };
      assert.equal(blocked.decision, "block");
      return blocked.reason;
    },
  };
}

test("the stop hook asks once per set of code changes the session made", async () => {
  const { root } = await committed({ "src/a.ts": "export const a = 1;\n", "notes.md": "x\n" });
  const temp = await sandbox();
  const s = session("s1", root, temp);

  const started = JSON.parse(await s.start());
  assert.match(started.hookSpecificOutput.additionalContext, /project_check_changes/u);
  assert.equal(await s.stop(), "", "nothing changed yet");
  await s.write(path.join(root, "notes.md"), "y\n");
  assert.equal(await s.stop(), "", "only code changes count");

  await s.write(path.join(root, "src/a.ts"), "export const a = 2;\n");
  assert.equal(await s.stop(), AGENT_STOP_CHECK);
  assert.equal(await s.stop(), "", "the same changes are asked about once");
  await s.write(path.join(root, "src/b.ts"), "export const b = 1;\n");
  assert.equal(
    await s.stop({ stop_hook_active: true }),
    "",
    "never while Claude is already continuing for a stop hook",
  );
  assert.equal(await s.stop(), AGENT_STOP_CHECK);

  // Edits undone, so Git sees none of them changed, leave nothing to check.
  await s.write(path.join(root, "src/a.ts"), "export const a = 1;\n");
  await rm(path.join(root, "src/b.ts"));
  assert.equal(await s.stop(), "");
  // A mini-program template is mapped with its page.
  await s.write(path.join(root, "src/home.wxml"), "<view/>\n");
  assert.equal(await s.stop(), AGENT_STOP_CHECK);

  const off = session("s2", root, temp, { LAYERMAP_STOP_CHECK: "0" });
  assert.match(await off.start(), /hookSpecificOutput/u, "the note still comes");
  await off.write(path.join(root, "src/a.ts"), "export const a = 3;\n");
  assert.equal(await off.stop(), "");
});

test("the stop hook asks a session only about its own edits, not another's in the same work tree", async () => {
  const { root } = await committed({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
  });
  const temp = await sandbox();
  const mine = session("mine", root, temp);
  const other = session("other", root, temp);
  await mine.start();
  await other.start();

  // The other session edits while this one runs commands that name no file, and between them.
  await other.write(path.join(root, "src/b.ts"), "export const b = 2;\n");
  await mine.bash("npm test", () =>
    other.write(path.join(root, "src/b.ts"), "export const b = 3;\n"),
  );
  await mine.bash("ls src");
  assert.equal(await mine.stop(), "");
  assert.equal(await other.stop(), AGENT_STOP_CHECK);
  // An edit this session undid leaves nothing of its own, whatever else the tree holds.
  await mine.write(path.join(root, "src/a.ts"), "export const a = 2;\n");
  await mine.write(path.join(root, "src/a.ts"), "export const a = 1;\n");
  assert.equal(await mine.stop(), "");

  // Nor does a write of the other's file that failed.
  await mine.failedWrite(path.join(root, "src/b.ts"), "export const b = 4;\n");
  assert.equal(await mine.stop(), "");

  // This session's edit of a file the other changed too is its own.
  await mine.write(path.join(root, "src/b.ts"), "export const b = 4;\n");
  assert.equal(await mine.stop(), AGENT_STOP_CHECK);
});

test("a subagent's edits are the session's", async () => {
  const { root } = await committed({ "src/a.ts": "export const a = 1;\n" });
  const s = session("s", root, await sandbox());
  await s.start();
  await s.write(path.join(root, "src/sub.ts"), "export const sub = 2;\n", {
    agent_id: "a59a6bf58ef9826f9",
    agent_type: "general-purpose",
  });
  assert.equal(await s.stop(), AGENT_STOP_CHECK);
});

test("a check covers the repository its result names, after the edits before it", async () => {
  const folder = await realpath(await sandbox());
  const a = (await committed({ "src/a.ts": "export const a = 1;\n" }, path.join(folder, "a"))).root;
  const b = (await committed({ "src/a.ts": "export const a = 1;\n" }, path.join(folder, "b"))).root;
  // Each repository as Git names it, and so the server and the request: C:/… on Windows.
  const [gitA, gitB] = [await gitRoot(a), await gitRoot(b)];
  const temp = await sandbox();
  let sessions = 0;
  // A new session started in cwd, which runs the steps, then stops.
  const asked = async (cwd: string, steps: (s: ReturnType<typeof session>) => Promise<void>) => {
    sessions += 1;
    const s = session(`s${sessions}`, cwd, temp);
    await s.start();
    await steps(s);
    return s.stop();
  };
  let version = 1;
  const edit = (s: ReturnType<typeof session>, root: string) =>
    s.write(path.join(root, "src/a.ts"), `export const a = ${++version};\n`);
  const several = (...repositories: string[]) =>
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${repositories.join(", ")}.`;

  // Started in the folder holding both: each edited repository is named, as a check needs a path.
  assert.equal(
    await asked(folder, async (s) => {
      await edit(s, a);
      await edit(s, b);
    }),
    several(gitA, gitB),
  );
  assert.equal(
    await asked(folder, async (s) => {
      await edit(s, a);
      await edit(s, b);
      await s.check(gitA, { fails: "Claude Code" });
      await s.check(gitB, { fails: "CodeBuddy" });
    }),
    several(gitA, gitB),
    "a failed check covers nothing",
  );
  assert.equal(
    await asked(folder, async (s) => {
      await edit(s, a);
      await s.check(gitA);
      await edit(s, b);
      await s.check(gitB);
    }),
    "",
  );
  assert.equal(
    await asked(folder, async (s) => {
      await edit(s, a);
      await s.check(gitA);
      await edit(s, a);
    }),
    several(gitA),
    "an edit after the check is not covered by it",
  );

  // Started in a: its own changes need no path; another repository's are named.
  assert.equal(await asked(a, (s) => edit(s, a)), AGENT_STOP_CHECK);
  assert.equal(
    await asked(a, async (s) => {
      await edit(s, b);
      await s.check(gitA);
    }),
    several(gitB),
  );
});

test("a shell command's changes count for the code files it names, even when it fails", async () => {
  const folder = await realpath(await sandbox());
  const a = (await committed({ "src/a.ts": "export const a = 1;\n" }, path.join(folder, "a"))).root;
  const b = (await committed({ "src/a.ts": "export const a = 1;\n" }, path.join(folder, "b"))).root;
  const temp = await sandbox();

  // In the folder: a file named relative to a directory the command changes to.
  const inFolder = session("folder", folder, temp);
  await inFolder.start();
  await inFolder.bash("cd b && sed -i '' s/1/2/ src/a.ts", () =>
    writeFile(path.join(b, "src/a.ts"), "export const a = 2;\n"),
  );
  assert.equal(
    await inFolder.stop(),
    `${AGENT_STOP_CHECK} ${AGENT_STOP_CHECK_REPOSITORIES}${await gitRoot(b)}.`,
  );

  // In a: a generator that names no file it writes is not seen; one that names its output is.
  const inA = session("a", a, temp);
  await inA.start();
  await inA.bash("npm run generate", () =>
    writeFile(path.join(a, "src/gen.ts"), "export const g = 1;\n"),
  );
  assert.equal(await inA.stop(), "");
  await inA.bash("node scripts/gen.mjs > src/gen.ts", () =>
    writeFile(path.join(a, "src/gen.ts"), "export const g = 2;\n"),
  );
  assert.equal(await inA.stop(), AGENT_STOP_CHECK);

  // A command that changed a file before it failed.
  await run("git", ["checkout", "-q", "."], { cwd: b });
  const failing = session("failing", b, temp);
  await failing.start();
  await failing.bash(
    "sed -i '' s/1/3/ src/a.ts && false",
    () => writeFile(path.join(b, "src/a.ts"), "export const a = 3;\n"),
    { fails: true },
  );
  assert.equal(await failing.stop(), AGENT_STOP_CHECK);
});

test("a command sent to the background counts what it changes until it ends", async () => {
  const { root } = await committed({ "src/a.ts": "export const a = 1;\n" });
  const s = session("s", root, await sandbox());
  await s.start();
  await s.bash('sleep 3 && echo "export const late = 3;" > src/late.ts', undefined, {
    task: "bg1",
  });
  const running = { background_tasks: [{ id: "bg1", type: "shell", status: "running" }] };
  assert.equal(await s.stop(running), "", "nothing changed yet");

  await writeFile(path.join(root, "src/late.ts"), "export const late = 3;\n");
  assert.equal(await s.stop(), AGENT_STOP_CHECK, "it changed the file, and ended");
  await s.check(await gitRoot(root));
  await writeFile(path.join(root, "src/late.ts"), "export const late = 4;\n");
  assert.equal(await s.stop(running), "", "what changes after it ended is not its change");
});

test("a session's ledger goes with it, and so do those of sessions that ended without their end hook", async () => {
  const { root } = await committed({ "src/a.ts": "export const a = 1;\n" });
  const temp = await sandbox();
  const ledgers = path.join(temp, "layermap-sessions");
  // The state hooks of LayerMap 0.1.26 and earlier kept.
  await mkdir(path.join(temp, "layermap-claude"));
  await writeFile(path.join(temp, "layermap-claude", "s.edits"), "");

  const old = session("old", root, temp);
  await old.start();
  await old.write(path.join(root, "src/a.ts"), "export const a = 2;\n");
  const week = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(path.join(ledgers, "old.jsonl"), week, week);
  const ended = session("ended", root, temp);
  await ended.start();
  assert.deepEqual(await readdir(ledgers), ["ended.jsonl"]);
  assert.equal(existsSync(path.join(temp, "layermap-claude")), false);
  await ended.end();
  assert.deepEqual(await readdir(ledgers), []);
});

test("outside a Git repository the hooks only print the note", async () => {
  const directory = path.join(await sandbox(), "plain");
  await mkdir(directory);
  const s = session("s", directory, await sandbox());
  assert.match(await s.start(), /hookSpecificOutput/u);
  await s.write(path.join(directory, "a.ts"), "export const a = 1;\n");
  await s.bash("touch a.ts", () =>
    writeFile(path.join(directory, "a.ts"), "export const a = 2;\n"),
  );
  assert.equal(await s.stop(), "");
});

// A repository's own config may name programs for Git to run, as a cloned or downloaded one may
// come with; the hooks still see its changes, and run none of them.
test("the hooks run no program the repository's Git config names", async () => {
  const { root } = await committed({
    "src/a.ts": "export const a = 1;\n",
    ".gitattributes": "*.ts filter=evil\n",
  });
  const git = (...args: string[]) => run("git", args, { cwd: root });
  const marker = (name: string) => path.join(root, "..", name);
  await git("config", "filter.evil.clean", `sh -c 'touch "${marker("filter")}"; cat'`);
  await git("config", "filter.evil.required", "true");
  await git("config", "core.fsmonitor", `sh -c 'touch "${marker("fsmonitor")}"'`);
  const s = session("s", root, await sandbox());
  await s.start();
  await s.bash("touch src/a.ts", () =>
    writeFile(path.join(root, "src/a.ts"), "export const a = 2;\n"),
  );
  await s.write(path.join(root, "src/b.ts"), "export const b = 1;\n");
  assert.equal(await s.stop(), AGENT_STOP_CHECK);
  assert.equal(existsSync(marker("filter")), false);
  assert.equal(existsSync(marker("fsmonitor")), false);
});

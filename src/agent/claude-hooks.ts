// The Claude Code plugin's hooks, which CodeBuddy Code runs too: one script for every event, its
// input JSON on stdin. Each session keeps a ledger in the system's temporary directory, a line per
// entry: the code its edit tools and shell commands changed and the checks it ran, as each tool
// call ended, including those of its subagents, which hooks name by the same session. The stop
// hook asks the agent once per set of those changes to check them; LAYERMAP_STOP_CHECK=0 leaves
// only the note the session starts with.
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_MAP_NOTE } from "./notes";
import {
  changedFiles,
  checkedRepository,
  checkRequest,
  codeEdits,
  commandFiles,
  type FileStates,
  fileStates,
  repositoryAt,
  type SessionChange,
} from "./session-changes";

type Entry =
  | SessionChange
  // Where the session started, which the map server resolves a check's path from.
  | Readonly<{ kind: "start"; directory: string }>
  // The files a shell command names, as it started or as the stop hook last compared them.
  | Readonly<{ kind: "before"; call: string; states: FileStates }>
  // A command that went on in the background, compared at each stop until it is no longer running.
  | Readonly<{ kind: "background"; call: string; task: string }>
  | Readonly<{ kind: "ended"; call: string }>
  // What the stop hook last asked the agent to check.
  | Readonly<{ kind: "asked"; fingerprint: string }>;

type Input = Readonly<{
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
  background_tasks?: readonly Readonly<{ id?: string; status?: string }>[];
}>;

const LEDGERS = path.join(os.tmpdir(), "layermap-sessions");
// A ledger no hook wrote to for this long belongs to a session that ended without its end hook.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CHECK_TOOL = /(?:^|__)project_check_changes$/u;

const stdin = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

async function main(input: Input) {
  const event = input.hook_event_name;
  const session = (input.session_id ?? "").replace(/[^A-Za-z0-9_-]/gu, "") || "unknown";
  const ledger = path.join(LEDGERS, `${session}.jsonl`);
  const cwd = input.cwd || process.cwd();
  const read = async (): Promise<Entry[]> =>
    (await readFile(ledger, "utf8").catch(() => "")).split("\n").flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as Entry] : [];
      } catch {
        return [];
      }
    });
  // Appended whole, a line per entry, so hooks of calls that end together do not mix their lines.
  const note = async (...entries: Entry[]) => {
    if (!entries.length) return;
    await mkdir(LEDGERS, { recursive: true });
    await appendFile(ledger, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  };
  const checking = process.env.LAYERMAP_STOP_CHECK !== "0";

  if (event === "SessionStart") {
    if (checking) {
      await sweep();
      if (!(await read()).some((entry) => entry.kind === "start"))
        await note({ kind: "start", directory: cwd });
    }
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: AGENT_MAP_NOTE } })}\n`,
    );
    return;
  }
  if (event === "SessionEnd") return rm(ledger, { force: true });
  if (!checking) return;

  const tool = input.tool_name ?? "";
  const call = input.tool_use_id ?? "";
  if (event === "PreToolUse" && tool === "Bash" && call) {
    const command = input.tool_input?.command;
    const files = typeof command === "string" ? await commandFiles(cwd, command) : [];
    if (files.length) await note({ kind: "before", call, states: await fileStates(files) });
    return;
  }
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    if (tool === "Bash") {
      const before = lastBefore(await read(), call);
      if (!before) return;
      // Claude Code answers for a command sent to the background as soon as it starts.
      const task = (input.tool_response as { backgroundTaskId?: unknown } | undefined)
        ?.backgroundTaskId;
      if (typeof task === "string") return note({ kind: "background", call, task });
      const edits = await codeEdits(changedFiles(before, await fileStates(Object.keys(before))));
      return note(...edits, { kind: "ended", call });
    }
    // A call that failed, which comes as PostToolUseFailure in Claude Code and marked as an error
    // in CodeBuddy, wrote nothing and checked nothing.
    const response = input.tool_response as { is_error?: unknown; isError?: unknown } | undefined;
    if (event === "PostToolUseFailure" || response?.is_error || response?.isError) return;
    if (EDIT_TOOLS.has(tool)) {
      const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof file === "string") await note(...(await codeEdits([path.resolve(cwd, file)])));
      return;
    }
    const repository = CHECK_TOOL.test(tool) ? checkedRepository(response) : undefined;
    if (repository) await note({ kind: "check", repository });
    return;
  }
  if (event === "Stop" && !input.stop_hook_active) {
    await compareBackground(await read(), input, note);
    const entries = await read();
    const start = entries.find((entry) => entry.kind === "start")?.directory ?? cwd;
    const asked = entries.findLast((entry) => entry.kind === "asked")?.fingerprint ?? "";
    const request = await checkRequest(
      entries.filter(
        (entry): entry is SessionChange => entry.kind === "edit" || entry.kind === "check",
      ),
      await repositoryAt(start),
      asked,
    );
    if (!request) return;
    await note({ kind: "asked", fingerprint: request.fingerprint });
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: request.text })}\n`);
  }
}

// The files a command named, as it started or as last compared.
const lastBefore = (entries: readonly Entry[], call: string) =>
  entries.findLast(
    (entry): entry is Extract<Entry, { kind: "before" }> =>
      entry.kind === "before" && entry.call === call,
  )?.states;

// Notes what each command still running in the background changed since it was last compared, and
// ends those no longer running.
async function compareBackground(
  entries: readonly Entry[],
  input: Input,
  note: (...entries: Entry[]) => Promise<void>,
) {
  const ended = new Set(entries.flatMap((entry) => (entry.kind === "ended" ? [entry.call] : [])));
  const running = new Set(
    (input.background_tasks ?? []).flatMap((task) =>
      task.status === "running" && task.id ? [task.id] : [],
    ),
  );
  for (const entry of entries) {
    if (entry.kind !== "background" || ended.has(entry.call)) continue;
    ended.add(entry.call);
    const before = lastBefore(entries, entry.call);
    if (!before) continue;
    const now = await fileStates(Object.keys(before));
    const changed = changedFiles(before, now);
    await note(
      ...(await codeEdits(changed)),
      ...(changed.length ? [{ kind: "before" as const, call: entry.call, states: now }] : []),
      ...(running.has(entry.task) ? [] : [{ kind: "ended" as const, call: entry.call }]),
    );
  }
}

// Removes the ledgers of sessions that ended without their end hook, and the state hooks of
// LayerMap 0.1.26 and earlier kept.
async function sweep() {
  const now = Date.now();
  for (const name of await readdir(LEDGERS).catch(() => [])) {
    const file = path.join(LEDGERS, name);
    const modified = (await stat(file).catch(() => undefined))?.mtimeMs ?? now;
    if (now - modified > STALE_MS) await rm(file, { force: true });
  }
  await rm(path.join(os.tmpdir(), "layermap-claude"), { recursive: true, force: true });
}

// A hook that fails says nothing: the session goes on as if it had not run.
try {
  await main(JSON.parse(await stdin()) as Input);
} catch {}

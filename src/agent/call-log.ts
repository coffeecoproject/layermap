import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

/**
 * One tool call as the MCP server answered it, kept to review how the tools are used and where
 * their time goes: no source, only the repository, the call's own arguments, the time each step
 * took and the first line of the answer.
 */
export type MapCallRecord = Readonly<{
  at: string;
  version: string;
  tool: string;
  project?: string;
  arguments?: unknown;
  ms: number;
  /** Milliseconds in each step of the call: waiting for a first build, then the tool's own. */
  phases: Readonly<Record<string, number>>;
  chars: number;
  /** The first line of the answer: a check's counts, a view's heading, or the error. */
  head: string;
  isError: boolean;
  /** The client gave up on the call before it was answered. */
  cancelled?: boolean;
}>;

// Past this size the log is moved aside to calls.1.jsonl, replacing the one there.
const LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Appends each record to logs/calls.jsonl in the cache, a line each, which the servers of several
 * sessions write to together. A record that cannot be written is dropped: the log never fails a call.
 */
export function mapCallLog(cache: string): (record: MapCallRecord) => Promise<void> {
  const directory = path.join(cache, "logs");
  const file = path.join(directory, "calls.jsonl");
  let queue = Promise.resolve();
  return (record) => {
    queue = queue
      .then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (((await stat(file).catch(() => undefined))?.size ?? 0) > LIMIT_BYTES)
          await rename(file, path.join(directory, "calls.1.jsonl"));
        await appendFile(file, `${JSON.stringify({ ...record, pid: process.pid })}\n`, {
          mode: 0o600,
        });
      })
      .catch(() => {});
    return queue;
  };
}

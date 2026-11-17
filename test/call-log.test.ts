import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { type MapCallRecord, mapCallLog } from "../src/agent/call-log";
import { sandbox } from "./support";

const record = (tool: string): MapCallRecord => ({
  at: "2026-11-17T00:00:00.000Z",
  version: "0.0.0-test",
  tool,
  ms: 5,
  phases: { WAIT: 1, READ: 4 },
  chars: 10,
  head: "PROJECT MAP",
  isError: false,
});

test("calls are kept a line each in the cache's log, moved aside once it grows past 2 MB", async () => {
  const cache = await sandbox();
  const log = mapCallLog(cache);
  const file = path.join(cache, "logs", "calls.jsonl");
  await Promise.all([log(record("first")), log(record("second"))]);
  const lines = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map(({ tool }) => tool),
    ["first", "second"],
  );
  assert.equal(lines[0].pid, process.pid);

  await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
  await log(record("third"));
  assert.equal(
    (await readFile(path.join(cache, "logs", "calls.1.jsonl"), "utf8")).length,
    2 * 1024 * 1024 + 1,
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).tool, "third");
});

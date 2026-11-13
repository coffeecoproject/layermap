import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { test } from "node:test";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import { ProjectEvidenceError } from "../src/core";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import type { MapAnalyzerEvent } from "../src/project-map-language";
import { inOrder, TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { ProjectMapStopUnconfirmedError } from "../src/project-map-process";
import { analyzers, project, sandbox, signal } from "./support";

test("contexts are analyzed at once, the larger started first and all accepted in discovery order", {
  skip: availableParallelism() < 2,
}, async (t) => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] });
  const { root } = await project({
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "a" }, { path: "b" }] }),
    "a/tsconfig.json": tsconfig,
    "a/src/a.ts": "export function a() {\n  return 1;\n}\n",
    "b/tsconfig.json": tsconfig,
    // b, discovered after a, has more root files.
    "b/src/b1.ts": "export function b1() {\n  return 1;\n}\n",
    "b/src/b2.ts": "export function b2() {\n  return 2;\n}\n",
    "b/src/b3.ts": "export function b3() {\n  return 3;\n}\n",
  });
  const events: MapAnalyzerEvent[] = [];
  const store = new CodeIndexStore(
    openMapDatabase(
      mapDatabasePath(await sandbox(), root),
    ) as unknown as CodeIndexStore["database"],
  );
  const index = new CodeIndex(
    store,
    undefined,
    new ProjectMapAnalyzer([new TypeScriptMapAnalyzer((await analyzers()).typescript)], (event) => {
      if (event.operation === "BUILD") events.push(event);
    }),
  );
  t.after(async () => {
    await index.quiesce();
    index.close();
    store.database.close();
  });
  const stat = await lstat(root, { bigint: true });
  await index.prepare(
    {
      kind: "WORKTREE",
      projectRef: "test:parallel",
      directory: { canonicalPath: root, device: String(stat.dev), inode: String(stat.ino) },
    },
    signal(),
  );
  const started = events.filter((event) => event.phase === "STARTED");
  assert.equal(started.length, 2, "two projects, two contexts");
  const firstFinished = events.findIndex((event) => event.phase === "FINISHED");
  assert.equal(
    events.slice(0, firstFinished).filter((event) => event.phase === "STARTED").length,
    2,
    "the second context starts before the first finishes",
  );
  const [first, second] = started;
  assert.ok(first && second && first.inputFiles > second.inputFiles, "b, the larger, starts first");
  assert.deepEqual(
    events
      .filter((event) => event.phase === "STAGED" && event.contextRef !== undefined)
      .map((event) => event.contextRef)
      .filter((ref) => ref === first.contextRef || ref === second.contextRef),
    [second.contextRef, first.contextRef],
    "a, discovered first, is accepted first",
  );
});

// A task that finishes when told to, and says when it was stopped.
function gate<T>(value: T) {
  let finish!: () => void;
  let started = false;
  let stopped = false;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const task = async (signal: AbortSignal) => {
    started = true;
    await Promise.race([
      finished,
      new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => {
          stopped = true;
          reject(new ProjectEvidenceError("PROJECT_READ_CANCELLED", true));
        }),
      ),
    ]);
    return value;
  };
  return {
    task,
    finish: () => finish(),
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("tasks run a few at a time and are taken in task order", { timeout: 10_000 }, async () => {
  const gates = [gate("a"), gate("b"), gate("c")];
  const taken: string[] = [];
  const done = inOrder(
    gates.map((g) => g.task),
    (value) => taken.push(value),
    signal(),
    2,
    [0, 0, 0],
  );
  await settle();
  assert.deepEqual(
    gates.map((g) => g.started),
    [true, true, false],
  );
  gates[1]?.finish();
  await settle();
  assert.equal(gates[2]?.started, true, "a finished task hands its slot on");
  assert.deepEqual(taken, [], "a later result waits for the ones before it");
  gates[2]?.finish();
  gates[0]?.finish();
  await done;
  assert.deepEqual(taken, ["a", "b", "c"]);
});

test("larger tasks start first and are still taken in task order", {
  timeout: 10_000,
}, async () => {
  const started: string[] = [];
  const taken: string[] = [];
  const task = (value: string) => async () => {
    started.push(value);
    return value;
  };
  await inOrder(
    [task("small"), task("large"), task("middle")],
    (value) => taken.push(value),
    signal(),
    1,
    [1, 3, 2],
  );
  assert.deepEqual(started, ["large", "middle", "small"]);
  assert.deepEqual(taken, ["small", "large", "middle"]);
});

test("the first failure stops the other tasks and is thrown", { timeout: 10_000 }, async () => {
  const waiting = gate("a");
  const failing = async () => {
    throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
  };
  await assert.rejects(
    inOrder([waiting.task, failing], () => {}, signal(), 2, [0, 0]),
    (error: ProjectEvidenceError) => error.code === "PROJECT_MAP_PROTOCOL_INVALID",
  );
  assert.equal(waiting.stopped, true);
});

test("a worker not confirmed stopped outranks the failure that stopped it", {
  timeout: 10_000,
}, async () => {
  const failing = async () => {
    throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
  };
  const unstoppable = (signal: AbortSignal) =>
    new Promise<string>((_, reject) =>
      signal.addEventListener("abort", () => reject(new ProjectMapStopUnconfirmedError())),
    );
  await assert.rejects(
    inOrder([unstoppable, failing], () => {}, signal(), 2, [0, 0]),
    ProjectMapStopUnconfirmedError,
  );
});

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

test("contexts are analyzed at once", {
  skip: availableParallelism() < 2,
}, async (t) => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] });
  const { root } = await project({
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "a" }, { path: "b" }] }),
    "a/tsconfig.json": tsconfig,
    "a/src/a.ts": "export function a() {\n  return 1;\n}\n",
    "b/tsconfig.json": tsconfig,
    "b/src/b.ts": "export function b() {\n  return 2;\n}\n",
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
  const started = events.filter((event) => event.phase === "STARTED").map((e) => e.contextRef);
  assert.ok(started.length >= 2, "two projects, two contexts");
  const firstFinished = events.findIndex((event) => event.phase === "FINISHED");
  assert.ok(
    events.slice(0, firstFinished).filter((event) => event.phase === "STARTED").length >= 2,
    "a second context starts before the first finishes",
  );
  assert.deepEqual(
    events
      .filter((event) => event.phase === "STAGED" && started.includes(event.contextRef))
      .map((e) => e.contextRef),
    started,
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

test("the first failure stops the other tasks and is thrown", { timeout: 10_000 }, async () => {
  const waiting = gate("a");
  const failing = async () => {
    throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
  };
  await assert.rejects(
    inOrder([waiting.task, failing], () => {}, signal(), 2),
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
    inOrder([unstoppable, failing], () => {}, signal(), 2),
    ProjectMapStopUnconfirmedError,
  );
});

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "@photostructure/sqlite";
import { CodeCommitReader } from "../src/code-commit-reader";
import type { CodeIndexStore } from "../src/code-index-store";
import { GitRunner } from "../src/git-runner";
import { LayerMap, mapDatabasePath } from "../src/layermap";
import { analyzers, FILES, openMap, project, sandbox, signal } from "./support";

const run = promisify(execFile);
const target = (factor: number) =>
  `export function target(value: number): number {\n  return value * ${factor};\n}\n`;

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

// Runs a module body in a process of its own, with the package's sources, and returns its exit code
// and what it wrote to stderr.
const inProcess = (body: string) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", body], {
      cwd: packageRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stderr }));
  });

test("processes opening a new map at once all open it", async () => {
  const file = path.join(await sandbox(), "projects", "map.sqlite");
  const layermap = pathToFileURL(path.join(packageRoot, "src", "layermap.ts")).href;
  const opened = await Promise.all(
    Array.from({ length: 4 }, () =>
      inProcess(
        `const { openMapDatabase } = await import(${JSON.stringify(layermap)}); openMapDatabase(${JSON.stringify(file)}).close();`,
      ),
    ),
  );
  assert.deepEqual(
    opened.map(({ code, stderr }) => (code === 0 ? "opened" : stderr.split("\n")[0])),
    ["opened", "opened", "opened", "opened"],
  );
});

// The analyzers, with a TypeScript worker that notes each start before it runs the real one.
async function countedAnalyzers() {
  const resources = await analyzers();
  const directory = await sandbox();
  const log = path.join(directory, "starts");
  const worker = path.join(directory, "worker.mjs");
  await writeFile(
    worker,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "start\\n");\nawait import(${JSON.stringify(pathToFileURL(resources.typescript.workerPath).href)});\n`,
  );
  return {
    analyzers: { ...resources, typescript: { ...resources.typescript, workerPath: worker } },
    starts: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").length - 1,
  };
}

// A session's map of the project, closed when the test ends.
async function openCounted(
  t: TestContext,
  root: string,
  cacheDirectory: string,
  counted: Awaited<ReturnType<typeof countedAnalyzers>>,
) {
  const map = await LayerMap.open({ project: root, cacheDirectory, analyzers: counted.analyzers });
  t.after(() => map.close());
  return map;
}

test("sessions that open a project at once build its map once, and each finds it", async (t) => {
  const { root } = await project(FILES);
  // One session alone, for how many analyses a build of the project takes.
  const alone = await countedAnalyzers();
  await (await openCounted(t, root, path.join(await sandbox(), "cache"), alone)).refresh(signal());
  const build = await alone.starts();
  assert.ok(build > 0);

  const shared = await countedAnalyzers();
  const cache = path.join(await sandbox(), "cache");
  const sessions = [
    await openCounted(t, root, cache, shared),
    await openCounted(t, root, cache, shared),
  ];
  const [first, second] = await Promise.all(sessions.map((map) => map.refresh(signal())));
  assert.equal(first, second);
  assert.equal(await shared.starts(), build);
});

// Bounded: a build that went on waiting would otherwise hold the run open.
test("a build waits while another process builds the project's map, and goes on once that one is killed", {
  timeout: 60_000,
}, async (t) => {
  const { root, write } = await project(FILES);
  const cache = path.join(await sandbox(), "cache");
  const counted = await countedAnalyzers();
  const map = await openCounted(t, root, cache, counted);
  const version = await map.refresh(signal());
  // A process stopped part way through a build, holding the project's lock until it is killed.
  const lock = path.join(path.dirname(mapDatabasePath(cache, map.project)), "build.lock");
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      // Kept referenced: a collected connection closes, ending its transaction.
      `import { DatabaseSync } from "@photostructure/sqlite"; globalThis.lock = new DatabaseSync(${JSON.stringify(lock)}); globalThis.lock.exec("BEGIN EXCLUSIVE"); process.stdout.write("held\\n"); setInterval(() => {}, 1000);`,
    ],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await once(holder.stdout, "data");
  // A directory whose map is built meanwhile needs no build, and does not wait.
  assert.equal(await map.refresh(signal()), version);

  await write("src/target.ts", target(3));
  const built = await counted.starts();
  const refreshed = map.refresh(signal());
  // A build still waiting stops when its caller cancels it.
  const other = await openCounted(t, root, cache, counted);
  const cancel = new AbortController();
  const cancelled = other.refresh(cancel.signal);
  await delay(1_500);
  // Neither has started analyzing while the other process builds.
  assert.equal(await counted.starts(), built);
  cancel.abort();
  await assert.rejects(cancelled, { code: "PROJECT_READ_CANCELLED" });

  holder.kill("SIGKILL");
  assert.notEqual(await refreshed, version);
});

test("a version another process holds outlasts this one's cleanup, until the hold expires", async (t) => {
  const { root, write } = await project(FILES);
  const cache = path.join(await sandbox(), "cache");
  const map = await openMap(root, cache);
  t.after(() => map.close());
  const first = await map.refresh(signal());
  // Another process reading the first version, as a change check does while the base builds.
  const other = new DatabaseSync(mapDatabasePath(cache, map.project));
  t.after(() => other.close());
  other.prepare("INSERT INTO layermap_version_holds VALUES (?, 'other', ?)").run(first, Date.now());
  const kept = () =>
    Boolean(other.prepare("SELECT 1 FROM project_code_versions WHERE version_ref = ?").get(first));

  for (const factor of [3, 4, 5, 6]) {
    await write("src/target.ts", target(factor));
    await map.refresh(signal());
  }
  assert.equal(kept(), true);
  // A process that stopped without releasing its hold.
  other.prepare("UPDATE layermap_version_holds SET held_at = 0 WHERE holder = 'other'").run();
  await write("src/target.ts", target(7));
  await map.refresh(signal());
  assert.equal(kept(), false);
});

test("a map publishes while another read of its connection is part way through", async (t) => {
  const { root, write } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  await map.refresh(signal());
  // A read stopped after its first row, as a traversal that yields part way through leaves one.
  const { database } = (map as unknown as { store: CodeIndexStore }).store;
  const reading = database.prepare("SELECT path FROM project_code_files").iterate();
  assert.equal(reading.next().done, false);

  for (const factor of [3, 4]) {
    await write("src/target.ts", target(factor));
    await map.refresh(signal());
  }
  reading.return?.();
});

test("a commit is captured once, and later checks against it reuse its map", async (t) => {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  const cache = path.join(await sandbox(), "cache");
  const captures = t.mock.method(CodeCommitReader, "open");
  const map = await openMap(root, cache);
  await map.prepareBase(signal());
  const captured = captures.mock.callCount();
  assert.ok(captured > 0);

  // Edits make versions of the working tree; the base stays, in this session and the next.
  for (const factor of [3, 4, 5, 6]) {
    await write("src/target.ts", target(factor));
    await map.refresh(signal());
  }
  await map.prepareBase(signal());
  await map.close();
  const next = await openMap(root, cache);
  t.after(() => next.close());
  await next.prepareBase(signal());
  assert.equal(captures.mock.callCount(), captured);
});

test("a commit's files are read many to a Git process, as its map is captured and built", async (t) => {
  const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `src/part${index}.ts`,
      `export const part${index} = ${index};\n`,
    ]),
  );
  const { root, write } = await project({ ...FILES, ...many });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  // The base differs from the working tree, so its map is built, not found.
  await write("src/target.ts", target(3));
  const map = await openMap(root);
  t.after(() => map.close());
  await map.refresh(signal());
  const runs = t.mock.method(GitRunner.prototype, "run");
  await map.prepareBase(signal());
  const blobReads = runs.mock.calls.filter(({ arguments: [args] }) => args.includes("cat-file"));
  // One to capture the files, one to analyze them and one to confirm what was analyzed.
  assert.ok(blobReads.length <= 3, `${blobReads.length} Git processes read blobs`);
});

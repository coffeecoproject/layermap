import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "@photostructure/sqlite";
import { CodeCommitReader } from "../src/code-commit-reader";
import { GitRunner } from "../src/git-runner";
import { mapDatabasePath } from "../src/layermap";
import { FILES, openMap, project, sandbox, signal } from "./support";

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

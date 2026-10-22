import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import { FILES, openMap, project, signal } from "./support";

const run = promisify(execFile);
const git = (root: string, ...args: string[]) => run("git", args, { cwd: root });

const HANDLER_CALLS_TARGET =
  'import { target } from "./target";\n\nexport function handler() {\n  return target(20);\n}\n';

// Runs edit once, as the first analysis of a build starts, then analyzes as usual.
const duringFirstBuild = (t: { mock: typeof test.mock }, edit: () => Promise<void>) => {
  const analyze = ProjectMapAnalyzer.prototype.analyze;
  let builds = 0;
  t.mock.method(
    ProjectMapAnalyzer.prototype,
    "analyze",
    async function (this: ProjectMapAnalyzer, ...args: Parameters<typeof analyze>) {
      if (builds++ === 0) await edit();
      return analyze.apply(this, args);
    },
  );
  return () => builds;
};

test("a sparse checkout is mapped from the files it has", async (t) => {
  const { root } = await project({ ...FILES, "docs/example.ts": "export const example = 1;\n" });
  await git(root, "add", ".");
  await git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await git(root, "sparse-checkout", "set", "--no-cone", "/src/", "/tsconfig.json");
  // A file marked skip-worktree that is still on disk is mapped as it is there.
  await git(root, "update-index", "--skip-worktree", "src/helper.ts");
  const map = await openMap(root);
  t.after(() => map.close());

  const overview = await map.explore({ path: "." }, signal());
  assert.match(overview.text, /src\//u);
  assert.doesNotMatch(overview.text, /docs|tools/u);
  const callers = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 3 },
    signal(),
  );
  assert.match(callers.text, /← called by src\/handler\.ts: handler/u);
});

test("files added while a map builds leave it built, and the next query maps them", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  // New files change the directories that hold them, the project's own included.
  const builds = duringFirstBuild(t, async () => {
    await writeFile(path.join(root, "notes.txt"), "notes\n");
    await writeFile(path.join(root, "src", "extra.ts"), "export const extra = 1;\n");
  });

  const first = await map.refresh(signal());
  assert.equal(builds(), 1);
  const overview = await map.explore({ path: "src" }, signal());
  assert.match(overview.text, /extra\.ts/u);
  assert.notEqual(await map.refresh(signal()), first);
});

test("a file edited while a map builds is captured and mapped again", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  const builds = duringFirstBuild(t, () =>
    writeFile(path.join(root, "src", "handler.ts"), HANDLER_CALLS_TARGET),
  );

  const callers = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.equal(builds(), 2);
  assert.match(callers.text, /← called by src\/handler\.ts: handler/u);
});

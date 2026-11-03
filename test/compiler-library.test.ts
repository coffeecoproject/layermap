import assert from "node:assert/strict";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cacheDirectory, resolveAnalyzers } from "../src/agent/environment";
import { LayerMap, type LayerMapAnalyzers } from "../src/layermap";
import { analyzers, project, sandbox, sharedCache, signal } from "./support";

const NO_LIBRARY = /standard library was not found/u;
const NOT_INSTALLED = /fw are not installed in this directory/u;

/**
 * `this` has its type only through the standard library's ThisType. The other two files the
 * configuration names do not exist, and neither is one of the compiler's library files.
 */
const FILES = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true },
    files: ["src/page.ts", "src/lib.missing.d.ts", "../outside.d.ts"],
  }),
  "src/page.ts":
    "function typed<T>(page: T & ThisType<T>) {\n  return page;\n}\n\nexport const page = typed({\n  helper() {},\n  run() {\n    this.helper();\n  },\n});\n",
};

/** The same `this`, through a framework's types that the tsconfig names and nothing imports. */
const FRAMEWORK_PAGE = {
  ".gitignore": "node_modules\n",
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, types: ["fw"] },
    include: ["src"],
  }),
  "src/page.ts": "Page({\n  helper() {},\n  run() {\n    this.helper();\n  },\n});\nexport {};\n",
};
const installFramework = async (root: string) => {
  await mkdir(path.join(root, "node_modules/fw"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/fw/package.json"),
    JSON.stringify({ name: "fw", version: "1.0.0", types: "index.d.ts" }),
  );
  await writeFile(
    path.join(root, "node_modules/fw/index.d.ts"),
    "declare function Page<T>(options: T & ThisType<T>): void;\n",
  );
};

async function views(
  t: { after: (run: () => void) => void },
  root: string,
  resources: LayerMapAnalyzers,
) {
  const map = await LayerMap.open({
    project: root,
    cacheDirectory: path.join(await sandbox(), "cache"),
    analyzers: resources,
  });
  t.after(() => map.close());
  return {
    run: await map.explore(
      { path: "src/page.ts", name: "run", direction: "OUTGOING", depth: 1 },
      signal(),
    ),
    overview: await map.explore({ path: "." }, signal()),
  };
}

const withCompiler = async (compilerPath: string): Promise<LayerMapAnalyzers> => {
  const resources = await analyzers();
  return { ...resources, typescript: { ...resources.typescript, compilerPath } };
};

/** A compiler with the one library file it needs to start, and none of those a program needs. */
async function partialCompiler(): Promise<string> {
  const { compilerPath } = (await analyzers()).typescript;
  const directory = path.join(await sandbox(), "native");
  await mkdir(directory);
  const partial = path.join(directory, path.basename(compilerPath));
  await copyFile(compilerPath, partial);
  await copyFile(
    path.join(path.dirname(compilerPath), "lib.d.ts"),
    path.join(directory, "lib.d.ts"),
  );
  return partial;
}

test("a compiler in a directory reached through a link has its standard library", async (t) => {
  const { compilerPath } = (await analyzers()).typescript;
  const link = path.join(await sandbox(), "native");
  await symlink(path.dirname(compilerPath), link, "junction");
  const { root } = await project(FILES);
  const { run, overview } = await views(
    t,
    root,
    await withCompiler(path.join(link, path.basename(compilerPath))),
  );
  assert.match(run.text, /→ calls src\/page\.ts: page\.helper /u);
  assert.doesNotMatch(overview.text, NO_LIBRARY);
});

// Linking a file on Windows takes a privilege.
const fileLinks = { skip: process.platform === "win32" };
test("a compiler that is itself a link has its standard library", fileLinks, async (t) => {
  const { compilerPath } = (await analyzers()).typescript;
  const link = path.join(await sandbox(), path.basename(compilerPath));
  await symlink(compilerPath, link);
  const { root } = await project(FILES);
  const { run } = await views(t, root, await withCompiler(link));
  assert.match(run.text, /→ calls src\/page\.ts: page\.helper /u);
});

test("a LAYERMAP_CACHE reached through a link keeps this typed by an installed package", async (t) => {
  await analyzers();
  const link = path.join(await sandbox(), "cache");
  await symlink(sharedCache, link, "junction");
  const resources = await resolveAnalyzers(cacheDirectory({ LAYERMAP_CACHE: link }), () => {}, {});
  assert.ok(resources.typescript.compilerPath.startsWith(link));
  const { root } = await project(FRAMEWORK_PAGE);
  await installFramework(root);
  const { run, overview } = await views(t, root, resources);
  assert.match(run.text, /→ calls src\/page\.ts: helper /u);
  assert.doesNotMatch(overview.text, NO_LIBRARY);
  assert.doesNotMatch(overview.text, NOT_INSTALLED);
});

test("a map says so when the compiler has only part of its standard library", async (t) => {
  const { root } = await project(FILES);
  const { run, overview } = await views(t, root, await withCompiler(await partialCompiler()));
  assert.match(run.text, /→ unresolved: this\.helper/u);
  assert.match(overview.text, NO_LIBRARY);
});

test("a package not installed is not taken for a missing standard library", async (t) => {
  const { root } = await project(FRAMEWORK_PAGE);
  const { overview } = await views(t, root, await analyzers());
  assert.match(overview.text, NOT_INSTALLED);
  assert.doesNotMatch(overview.text, NO_LIBRARY);
});

test("a missing standard library is not taken for a package not installed", async (t) => {
  const { root } = await project(FRAMEWORK_PAGE);
  await installFramework(root);
  const { overview } = await views(t, root, await withCompiler(await partialCompiler()));
  assert.match(overview.text, NO_LIBRARY);
  assert.doesNotMatch(overview.text, NOT_INSTALLED);
});

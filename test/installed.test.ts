import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { mapInstalledDigest, mapMissingPackage, mapPackageOf } from "../src/project-map-installed";
import { MapVirtualFiles } from "../src/project-map-virtual-files";
import { mapWorkspaceMembership } from "../src/project-map-workspace-membership";
import { openMap, project, sandbox, signal } from "./support";

const run = promisify(execFile);
const commit = async (root: string) => {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
};

// A page whose `this` the framework's types give: without the package, the call in run has no
// target. The application's tsconfig names the package in `types`, so nothing imports it.
const PAGE = {
  ".gitignore": "node_modules\n",
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, types: ["fw"] },
    include: ["src"],
  }),
  "src/page.ts": `Page({
  helper() {
    return 1;
  },
  run() {
    return this.helper();
  },
});
export {};
`,
};
const FRAMEWORK = "declare function Page<T>(options: T & ThisType<T>): void;\n";

const put = async (root: string, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
};
const installFramework = (root: string, version = "1.0.0", text = FRAMEWORK) =>
  put(root, {
    "node_modules/fw/package.json": JSON.stringify({ name: "fw", version, types: "index.d.ts" }),
    "node_modules/fw/index.d.ts": text,
  });
// What a check says of a change to helper, which only run calls.
const editHelper = (write: (name: string, text: string) => Promise<void>) =>
  write("src/page.ts", PAGE["src/page.ts"].replace("return 1;", "return 2;"));

test("a package's types give a framework page's this, and never enter the map", async (t) => {
  const { root, write } = await project(PAGE);
  await installFramework(root);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const view = await map.explore(
    { path: "src/page.ts", name: "helper", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.match(view.text, /← called by src\/page\.ts: run /u);
  // The references read the same packages, or they would disagree with the map.
  const { references } = await map.references(
    { symbol: { path: "src/page.ts", name: "helper" }, maxResults: 20 },
    signal(),
  );
  assert.ok(references.some(({ kind }) => kind === "CALL"));
  await editHelper(write);
  const { text } = await map.checkChanges({}, signal());
  assert.match(text, /src\/page\.ts: run → helper/u);
  assert.doesNotMatch(text, /has no callers in the map/u);
  assert.doesNotMatch(text, /PACKAGES NOT FOUND/u);
  const overview = await map.explore({ path: "." }, signal());
  assert.doesNotMatch(overview.text, /node_modules/u);
  assert.doesNotMatch(overview.text, /are not installed/u);
  const files = await map.search({ path: ".", query: "Page", maxResults: 20 }, signal());
  assert.doesNotMatch(files.text, /node_modules/u);
});

test("a project without its packages says which, and what the result lacks", async (t) => {
  const { root, write } = await project({
    ...PAGE,
    "src/uses.ts": 'import { thing } from "absent-pkg";\nexport const value = thing();\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const overview = await map.explore({ path: "." }, signal());
  assert.match(overview.text, /Map limits: .*absent-pkg, fw are not installed in this directory/u);
  await editHelper(write);
  const { text } = await map.checkChanges({}, signal());
  // Named by the `types` entry alone: nothing imports the framework.
  assert.match(text, /^PACKAGES NOT FOUND \(.*fw.*\): are dependencies installed/mu);
  assert.match(text, /this report can miss what the change reaches/u);
  assert.match(text, /src\/page\.ts: helper .*has no callers|helper has no callers/u);
});

test("a package installed without types is not reported as missing", async (t) => {
  const { root } = await project({
    ".gitignore": "node_modules\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/uses.ts": 'import "untyped";\nimport "node:fs";\nimport "@/alias";\nexport {};\n',
  });
  await put(root, { "node_modules/untyped/index.js": "module.exports = {};\n" });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  assert.doesNotMatch((await map.explore({ path: "." }, signal())).text, /not installed/u);
});

test("an import in a file no tsconfig holds still tells a check of the missing package", async (t) => {
  const { root, write } = await project({
    "scripts/job.mjs":
      'import { go } from "absent-pkg";\nexport function job() {\n  return go();\n}\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write(
    "scripts/job.mjs",
    'import { go } from "absent-pkg";\nexport function job() {\n  return go(1);\n}\n',
  );
  assert.match((await map.checkChanges({}, signal())).text, /^PACKAGES NOT FOUND \(absent-pkg\)/mu);
});

test("installing, upgrading and removing packages each make the map current", async (t) => {
  const { root, write } = await project(PAGE);
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const called = async () =>
    (
      await map.explore(
        { path: "src/page.ts", name: "helper", direction: "INCOMING", depth: 1 },
        signal(),
      )
    ).text;
  const absent = await map.refresh(signal());
  assert.doesNotMatch(await called(), /called by/u);
  await installFramework(root);
  const installed = await map.refresh(signal());
  assert.notEqual(installed, absent);
  assert.match(await called(), /← called by src\/page\.ts: run /u);
  assert.equal(await map.refresh(signal()), installed);
  // The upgrade's types take this away: the same sources with other packages give another map.
  await installFramework(root, "2.0.0", "declare function Page(options: any): void;\n");
  const upgraded = await map.refresh(signal());
  assert.notEqual(upgraded, installed);
  assert.doesNotMatch(await called(), /called by/u);
  await rm(path.join(root, "node_modules"), { recursive: true });
  assert.equal(await map.refresh(signal()), absent);

  // A commit's map, reused between checks, follows too: what the base called is read with the
  // same packages as the working tree.
  await installFramework(root);
  await write("src/page.ts", PAGE["src/page.ts"].replace("return this.helper();", "return 3;"));
  assert.match(
    (await map.checkChanges({}, signal())).text,
    /^LEFT WITHOUT CALLERS[^\n]*\n {2}src\/page\.ts: helper /mu,
  );
  await rm(path.join(root, "node_modules"), { recursive: true });
  assert.doesNotMatch((await map.checkChanges({}, signal())).text, /^LEFT WITHOUT CALLERS/mu);
});

test("the digest follows what a package manager installed, its dependencies too", async () => {
  const root = await sandbox();
  const digest = () => mapInstalledDigest(root, ["apps/web/src/a.ts", "tsconfig.json"]);
  const nothing = digest();
  await put(root, {
    "node_modules/.package-lock.json": '{"packages":{"node_modules/deep":{"version":"1.0.0"}}}',
    "node_modules/direct/package.json": '{"version":"1.0.0"}',
    "node_modules/deep/package.json": '{"version":"1.0.0"}',
  });
  const npm = digest();
  assert.notEqual(npm, nothing);
  // A dependency's dependency: no package at the top changes, only the record.
  await put(root, {
    "node_modules/.package-lock.json": '{"packages":{"node_modules/deep":{"version":"1.0.1"}}}',
  });
  const transitive = digest();
  assert.notEqual(transitive, npm);
  // Caches beside the packages are not what is installed.
  await put(root, { "node_modules/.vite/deps.json": "{}", "node_modules/.bin/tool": "#!" });
  assert.equal(digest(), transitive);
  // Other directories above the project's files count, and those above no file do not.
  await put(root, { "other/node_modules/x/package.json": '{"version":"1"}' });
  assert.equal(digest(), transitive);
  await put(root, { "apps/web/node_modules/x/package.json": '{"version":"1"}' });
  const nested = digest();
  assert.notEqual(nested, transitive);
  await put(root, { "apps/web/node_modules/x/package.json": '{"version":"2"}' });
  assert.notEqual(digest(), nested);
});

for (const [record, first, second] of [
  [".pnpm/lock.yaml", "packages:\n  deep@1.0.0: {}\n", "packages:\n  deep@1.0.1: {}\n"],
  [".yarn-state.yml", '"deep@npm:1.0.0":\n', '"deep@npm:1.0.1":\n'],
  [
    ".yarn-integrity",
    '{"lockfileEntries":{"deep@1":"1.0.0"}}',
    '{"lockfileEntries":{"deep@1":"1.0.1"}}',
  ],
] as const)
  test(`the digest reads ${record}`, async () => {
    const root = await sandbox();
    const digest = () => mapInstalledDigest(root, ["a.ts"]);
    await put(root, { [`node_modules/${record}`]: first });
    const before = digest();
    await put(root, { [`node_modules/${record}`]: second });
    assert.notEqual(digest(), before);
  });

test("without a package manager's record the digest reads the lockfile beside the packages", async () => {
  const root = await sandbox();
  const digest = () => mapInstalledDigest(root, ["a.ts"]);
  await put(root, {
    "node_modules/direct/package.json": '{"version":"1.0.0"}',
    "node_modules/@scope/inner/package.json": '{"version":"1.0.0"}',
    "bun.lock": "deep 1.0.0\n",
  });
  const first = digest();
  await put(root, { "bun.lock": "deep 1.0.1\n" });
  const relocked = digest();
  assert.notEqual(relocked, first);
  await put(root, { "node_modules/direct/package.json": '{"version":"1.0.1"}' });
  const direct = digest();
  assert.notEqual(direct, relocked);
  await put(root, { "node_modules/@scope/inner/package.json": '{"version":"1.0.1"}' });
  assert.notEqual(digest(), direct);
});

test("links inside the project are followed, and links out of it count as not installed", async (t) => {
  const outside = await sandbox();
  await put(outside, {
    "fw/package.json": JSON.stringify({ name: "fw", version: "1.0.0", types: "index.d.ts" }),
    "fw/index.d.ts": FRAMEWORK,
  });

  // A package store inside the project: the package finds its own dependency beside it.
  const stored = await project({
    ...PAGE,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: ["fw"] },
      include: ["src"],
    }),
  });
  await put(stored.root, {
    "node_modules/.pnpm/fw@1.0.0/node_modules/fw/package.json": JSON.stringify({
      name: "fw",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    "node_modules/.pnpm/fw@1.0.0/node_modules/fw/index.d.ts":
      'import type { Options } from "fw-types";\ndeclare global { function Page<T>(options: Options<T>): void; }\nexport {};\n',
    "node_modules/.pnpm/fw@1.0.0/node_modules/fw-types/package.json": JSON.stringify({
      name: "fw-types",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    "node_modules/.pnpm/fw@1.0.0/node_modules/fw-types/index.d.ts":
      "export type Options<T> = T & ThisType<T>;\n",
  });
  await symlink(".pnpm/fw@1.0.0/node_modules/fw", path.join(stored.root, "node_modules/fw"));
  await commit(stored.root);
  const storedMap = await openMap(stored.root);
  t.after(() => storedMap.close());
  const inside = await storedMap.explore(
    { path: "src/page.ts", name: "helper", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.match(inside.text, /← called by src\/page\.ts: run /u);

  // npm link, or a store shared between projects: one package links out.
  const linked = await project(PAGE);
  await mkdir(path.join(linked.root, "node_modules"));
  await symlink(path.join(outside, "fw"), path.join(linked.root, "node_modules/fw"));
  await commit(linked.root);
  const linkedMap = await openMap(linked.root);
  t.after(() => linkedMap.close());
  const out = await linkedMap.explore(
    { path: "src/page.ts", name: "helper", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.doesNotMatch(out.text, /called by/u);
  assert.match(
    (await linkedMap.explore({ path: "." }, signal())).text,
    /fw are not installed in this directory/u,
  );

  // A checkout borrowing node_modules from elsewhere.
  const borrowed = await project(PAGE);
  await put(outside, {
    "modules/fw/package.json": JSON.stringify({
      name: "fw",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    "modules/fw/index.d.ts": FRAMEWORK,
  });
  await symlink(path.join(outside, "modules"), path.join(borrowed.root, "node_modules"));
  await commit(borrowed.root);
  const borrowedMap = await openMap(borrowed.root);
  t.after(() => borrowedMap.close());
  assert.doesNotMatch(
    (
      await borrowedMap.explore(
        { path: "src/page.ts", name: "helper", direction: "INCOMING", depth: 1 },
        signal(),
      )
    ).text,
    /called by/u,
  );

  // Yarn Plug'n'Play keeps packages in archives, with no node_modules at all.
  const pnp = await project({ ...PAGE, ".pnp.cjs": "module.exports = {};\n" });
  await commit(pnp.root);
  const pnpMap = await openMap(pnp.root);
  t.after(() => pnpMap.close());
  assert.match(
    (await pnpMap.explore({ path: "." }, signal())).text,
    /fw are not installed in this directory/u,
  );
});

test("a tsconfig extending an installed package is read as the compiler reads it", async (t) => {
  // The package's configuration leaves other/ out of the project, so its file gets our options and
  // is not compiled. Before the package is installed, the tsconfig holds every file.
  const lib = "export const value: string = '';\n";
  const { root, write } = await project({
    ".gitignore": "node_modules\n",
    "tsconfig.json": JSON.stringify({ extends: "shared-config/tsconfig.json" }),
    "src/lib.ts": lib,
    "other/use.ts": 'import { value } from "../src/lib";\nexport const text: string = value;\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  await write("src/lib.ts", lib.replace("value: string = ''", "value: number = 1"));
  const error = /^NEW COMPILE ERRORS[^\n]*\n {2}other\/use\.ts:2 /mu;
  assert.match((await map.checkChanges({}, signal())).text, error);
  await put(root, {
    "node_modules/shared-config/package.json": '{"name":"shared-config","version":"1.0.0"}',
    "node_modules/shared-config/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["../../src"],
    }),
  });
  assert.doesNotMatch((await map.checkChanges({}, signal())).text, error);
});

test("a workspace package's output directories can come from an installed configuration", async (t) => {
  // The workspace's import names dist/, which the sources build to only by what the installed
  // configuration says, so finding the source takes reading that configuration in discovery.
  const { root } = await project({
    ".gitignore": "node_modules\n",
    "package.json": '{"name":"root","private":true}',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/lib/package.json": JSON.stringify({
      name: "@x/lib",
      version: "1.0.0",
      types: "./dist/index.d.ts",
    }),
    "packages/lib/tsconfig.json": JSON.stringify({ extends: "shared-config/tsconfig.json" }),
    "packages/lib/src/index.ts": "export function shared() {\n  return 1;\n}\n",
    "packages/app/package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "@x/lib": "workspace:*" },
    }),
    "packages/app/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src"],
    }),
    "packages/app/src/main.ts":
      'import { shared } from "@x/lib";\nexport function main() {\n  return shared();\n}\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const callers = async () =>
    (
      await map.explore(
        { path: "packages/lib/src/index.ts", name: "shared", direction: "INCOMING", depth: 1 },
        signal(),
      )
    ).text;
  assert.doesNotMatch(await callers(), /called by/u);
  await put(root, {
    "node_modules/shared-config/package.json": '{"name":"shared-config","version":"1.0.0"}',
    "node_modules/shared-config/tsconfig.json": `{
      "compilerOptions": { "rootDir": "\${configDir}/src", "outDir": "\${configDir}/dist", "strict": true },
      "include": ["\${configDir}/src"]
    }`,
  });
  assert.match(await callers(), /← called by packages\/app\/src\/main\.ts: main /u);
});

test("a pnpm workspace links its packages when its file holds other settings too", async (t) => {
  const options = { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler" };
  const { root } = await project({
    ".gitignore": "node_modules\n",
    "package.json": '{"name":"root","private":true}',
    "pnpm-workspace.yaml":
      "allowBuilds:\n  esbuild: true\n\npackages:\n  - packages/*\n\noverrides:\n  esbuild: ^0.28.1\n",
    "packages/lib/package.json": JSON.stringify({
      name: "@x/lib",
      version: "1.0.0",
      exports: { "./sub": "./src/sub.ts" },
    }),
    "packages/lib/tsconfig.json": JSON.stringify({ compilerOptions: options, include: ["src"] }),
    "packages/lib/src/sub.ts": "export function shared() {\n  return 1;\n}\n",
    "packages/app/package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "@x/lib": "workspace:*" },
    }),
    "packages/app/tsconfig.json": JSON.stringify({ compilerOptions: options, include: ["src"] }),
    "packages/app/src/main.ts":
      'import { shared } from "@x/lib/sub";\nexport function main() {\n  return shared();\n}\n',
  });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());
  const { text } = await map.explore(
    { path: "packages/lib/src/sub.ts", name: "shared", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.match(text, /← called by packages\/app\/src\/main\.ts: main /u);
});

test("a pnpm workspace's package list is read only in the shapes it is known by", () => {
  const read = (text: string) => {
    const membership = mapWorkspaceMembership({ "pnpm-workspace.yaml": text });
    return membership.code ?? ["apps/web", "tools/x"].filter((dir) => membership.contains(dir));
  };
  assert.deepEqual(read("packages:\n  - apps/*\n"), ["apps/web"]);
  assert.deepEqual(read("onlyBuiltDependencies:\n  - esbuild\npackages:\n- apps/*\n"), [
    "apps/web",
  ]);
  assert.deepEqual(read("packages:\n  - '*/*'\n  - \"!tools/*\"\ncatalog:\n  zod: 4.4.3\n"), [
    "apps/web",
  ]);
  for (const unknown of [
    "packages: [apps/*]\n",
    "packages:\n  - apps/*\npackages:\n  - tools/*\n",
    "packages:\n  apps: '*'\n",
    "allowBuilds:\n  esbuild: true\n",
  ])
    assert.equal(read(unknown), "WORKSPACE_CONFIGURATION_UNSUPPORTED", unknown);
});

test("the compiler is shown only what lies in the project", async () => {
  const library = await sandbox();
  await put(library, { tsc: "" });
  const outside = await sandbox();
  await put(outside, { "linked/index.d.ts": "export {};\n" });
  const root = await sandbox();
  await put(root, {
    "node_modules/kept/index.d.ts": "export {};\n",
    "node_modules/kept/package.json": "{}",
  });
  await symlink(path.join(outside, "linked"), path.join(root, "node_modules/linked"));
  await symlink(path.join(root, "node_modules/kept"), path.join(root, "node_modules/inner"));
  const { fs } = new MapVirtualFiles({
    contextRef: "c",
    files: {},
    inventory: [],
    compilerPath: path.join(library, "tsc"),
    syntaxOnly: false,
    dependencies: root,
  });
  const entries = fs.getAccessibleEntries?.("/layermap/node_modules");
  assert.deepEqual(entries?.directories.sort(), ["inner", "kept"]);
  assert.equal(fs.readFile?.("/layermap/node_modules/kept/index.d.ts"), "export {};\n");
  assert.equal(fs.readFile?.("/layermap/node_modules/linked/index.d.ts"), null);
  assert.equal(fs.fileExists?.("/layermap/node_modules/linked/index.d.ts"), false);
  assert.equal(fs.directoryExists?.("/layermap/node_modules/linked"), false);
  // Not a package: the compiler reads nothing else of the directory.
  await put(root, { "secret.d.ts": "export {};\n" });
  assert.equal(fs.readFile?.("/layermap/secret.d.ts"), null);
  assert.equal(
    fs.realpath?.("/layermap/node_modules/inner/index.d.ts"),
    "/layermap/node_modules/kept/index.d.ts",
  );
});

test("a package's name is what an import or a diagnostic names", () => {
  assert.equal(mapPackageOf("react"), "react");
  assert.equal(mapPackageOf("react/jsx-runtime"), "react");
  assert.equal(mapPackageOf("@scope/pkg/sub"), "@scope/pkg");
  for (const other of [
    "./local",
    "../up",
    "/abs",
    "@/alias",
    "~/alias",
    "fs",
    "node:fs",
    "virtual:x",
  ])
    assert.equal(mapPackageOf(other), other === "~/alias" ? "~" : undefined, other);
  assert.equal(mapMissingPackage(2307, "Cannot find module 'pkg/sub' or its types."), "pkg");
  assert.equal(mapMissingPackage(2792, "Cannot find module '@s/p'. Did you mean..."), "@s/p");
  assert.equal(mapMissingPackage(2688, "Cannot find type definition file for 'fw'."), "fw");
  assert.equal(mapMissingPackage(2307, "Cannot find module './local'."), undefined);
  assert.equal(mapMissingPackage(2345, "Argument of type 'x'."), undefined);
});

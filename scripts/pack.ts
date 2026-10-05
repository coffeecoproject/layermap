// Builds the npm package into .pack/package and packs it into .pack/layermap-<version>.tgz: the CLI
// bundled into one file, the analyzers built once (go-map for every release platform, the
// TypeScript compiler left to npm's per-platform typescript packages, Java to the user's JDK),
// the published manifest and the license files.
//
// usage: node --import tsx scripts/pack.ts   (needs Go 1.24 and a JDK 21+ for a complete build)
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { buildGoMap, buildProjectMapParser } from "./build.mjs";
import { MCP_NAME } from "./plugins";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(packageRoot, ".pack");
const target = path.join(out, "package");
// go-map is a native program; Node names these platforms process.platform and process.arch.
const PLATFORMS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
] as const;

const source = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
await rm(out, { recursive: true, force: true });
await mkdir(path.join(target, "dist"), { recursive: true });

await build({
  absWorkingDir: packageRoot,
  entryPoints: [path.join(packageRoot, "src/cli.ts")],
  outfile: path.join(target, "dist/cli.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // The typescript dependency brings the compiler for the user's platform, and the SQLite package
  // its prebuilt binary; both stay outside.
  external: ["typescript", "typescript/*", "@photostructure/sqlite"],
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as layermapCreateRequire } from "node:module"; const require = layermapCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});

await chmod(path.join(target, "dist/cli.mjs"), 0o755);

const analyzers = path.join(target, "analyzers");
const parser = await buildProjectMapParser(analyzers);
if (!parser.javaResources.runtimePath)
  throw new Error("The release build needs a JDK 21+ for java-map.jar.");
await rm(path.join(analyzers, "project-map-native"), { recursive: true, force: true });
await rm(path.join(analyzers, "project-map-go"), { recursive: true, force: true });
for (const platform of PLATFORMS)
  await buildGoMap(
    path.join(analyzers, "go", `${platform.platform}-${platform.arch}`, "go-map"),
    platform,
  );
const relative = (file: string) => path.relative(analyzers, file);
await writeFile(
  path.join(analyzers, "analyzers.json"),
  `${JSON.stringify(
    {
      typescript: {
        workerPath: relative(parser.resources.workerPath),
        compilerPath: "@typescript/native",
      },
      go: {
        workerPath: relative(parser.goResources.workerPath),
        compilerPath: "go/{platform}-{arch}/go-map",
      },
      python: {
        workerPath: relative(parser.pythonResources.workerPath),
        compilerPath: relative(parser.pythonResources.compilerPath),
      },
      java: {
        workerPath: relative(parser.javaResources.workerPath),
        compilerPath: relative(parser.javaResources.compilerPath),
      },
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "layermap",
      version: source.version,
      mcpName: MCP_NAME,
      description: source.description,
      license: "Apache-2.0",
      type: "module",
      bin: { layermap: "dist/cli.mjs" },
      files: ["dist", "analyzers", "LICENSE", "NOTICE", "README.md"],
      engines: { node: ">=22.22" },
      os: ["darwin", "linux"],
      dependencies: {
        "@photostructure/sqlite": source.dependencies["@photostructure/sqlite"],
        typescript: source.dependencies.typescript,
      },
      homepage: "https://github.com/coffeecoproject/layermap",
      repository: { type: "git", url: "git+https://github.com/coffeecoproject/layermap.git" },
      keywords: ["code-map", "call-graph", "impact-analysis", "mcp", "claude-code", "codex"],
    },
    null,
    2,
  )}\n`,
);
for (const file of ["LICENSE", "NOTICE", "README.md"])
  await copyFile(path.join(packageRoot, file), path.join(target, file));
const { stdout } = await run("npm", ["pack", "--pack-destination", out], { cwd: target });
process.stdout.write(`Packed ${path.join(out, stdout.trim().split("\n").at(-1) ?? "")}\n`);

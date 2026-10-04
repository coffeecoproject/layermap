import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveAnalyzers } from "../src/agent/environment";
import { LayerMap } from "../src/layermap";

export const signal = () => new AbortController().signal;
const run = promisify(execFile);

// Analyzers are built once per test run into the shared cache; maps go to each test's own.
export const sharedCache = path.join(tmpdir(), "layermap-cache");
export const analyzers = () => resolveAnalyzers(sharedCache, () => {});

export async function sandbox(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "layermap-")));
}

/** A Git work tree holding the given files. */
export async function project(files: Record<string, string>): Promise<{
  root: string;
  write: (name: string, content: string) => Promise<void>;
}> {
  const root = path.join(await sandbox(), "project");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  const write = async (name: string, content: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  };
  for (const [name, content] of Object.entries(files)) await write(name, content);
  return { root, write };
}

export async function openMap(root: string, cacheDirectory?: string): Promise<LayerMap> {
  return LayerMap.open({
    project: root,
    cacheDirectory: cacheDirectory ?? path.join(await sandbox(), "cache"),
    analyzers: await analyzers(),
  });
}

/** A small TypeScript and Python project: a handler calls a target through one helper. */
export const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  "src/target.ts": "export function target(value: number): number {\n  return value * 2;\n}\n",
  "src/helper.ts":
    'import { target } from "./target";\n\nexport function helper(value: number) {\n  return target(value) + 1;\n}\n',
  "src/handler.ts":
    'import { helper } from "./helper";\n\nexport function handler() {\n  return helper(20);\n}\n',
  "tools/report.py":
    "def total(values):\n    return sum(values)\n\n\ndef report():\n    return total([1, 2])\n",
};

// Runs the tests with Node's test runner, one file at a time, in a scratch HOME and TMPDIR where
// the language analyzers are built once first (the tests look for them there).
//
// usage: node scripts/test.mjs [test files]   (all of test/ by default)
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((file) => path.resolve(file))
  : (await readdir(path.join(packageRoot, "test")))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => path.join(packageRoot, "test", name));
const sandbox = await mkdtemp(path.join(os.tmpdir(), "layermap-test-"));
const env = {
  PATH: process.env.PATH,
  ...(process.env.LAYERMAP_JAVA_HOME ? { LAYERMAP_JAVA_HOME: process.env.LAYERMAP_JAVA_HOME } : {}),
  ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
  HOME: sandbox,
  TMPDIR: sandbox,
  TMP: sandbox,
  TEMP: sandbox,
  NO_COLOR: "1",
};
const node = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", ...args],
      { cwd: packageRoot, env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

const environment = path.join(packageRoot, "src/agent/environment.ts");
const cache = path.join(sandbox, "layermap-cache");
let code = await node([
  "--input-type=module",
  "-e",
  `const { resolveAnalyzers } = await import(${JSON.stringify(environment)}); await resolveAnalyzers(${JSON.stringify(cache)}, (line) => console.log(line));`,
]);
if (code === 0) code = await node(["--test", "--test-concurrency=1", ...files]);
await rm(sandbox, { recursive: true, force: true });
process.exitCode = code;

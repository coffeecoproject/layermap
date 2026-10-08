import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// An executable's file name: Windows runs a program only by a name with an extension.
const executable = (name, platform = process.platform) =>
  platform === "win32" ? `${name}.exe` : name;

// The Go analyzer's identity (go-1.24-map-v6) assumes this toolchain; another version must bump it.
const GO_VERSION = /^go1\.24(?:\.\d+)?$/u;
// The Java analyzer's identity (javac-lombok-1.18.48-map-v3) pins this Lombok, vendored with its
// license; javac comes from any JDK of 21 or later and is recorded with each map.
const LOMBOK = {
  file: "lombok-1.18.48.jar",
  sha256: "85477a4655ebb2c074a9099cfb749be454449fee564d4282610df1b85f7c508b",
};

const run = (command, args, options) =>
  new Promise((resolve, reject) =>
    execFile(command, args, options, (error, stdout, stderr) =>
      error
        ? reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`))
        : resolve(stdout),
    ),
  );

// The package's own files: sources, go-map and java-map.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
// The directory whose node_modules holds the compilers: esbuild works from it and build inputs are
// named relative to it (the repository root in a checkout, the consumer's root once installed).
const inputRoot = (() => {
  for (let directory = packageRoot; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "node_modules", "typescript"))) return directory;
    if (path.dirname(directory) === directory)
      throw new Error("The map parser build needs typescript installed above the package.");
  }
})();

// Builds go-map without cgo, network or toolchain downloads, and without the user's go env
// settings (GOENV off) or version control stamps, so the binary depends on its sources alone.
// target names another platform as Node does (darwin/linux, arm64/x64), for release builds.
export async function buildGoMap(output, target) {
  const source = path.join(packageRoot, "go-map");
  const env = {
    ...process.env,
    ...(target
      ? {
          GOOS: target.platform === "win32" ? "windows" : target.platform,
          GOARCH: target.arch === "x64" ? "amd64" : target.arch,
        }
      : {}),
    CGO_ENABLED: "0",
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOFLAGS: "",
    GOWORK: "off",
  };
  const version = String(await run("go", ["env", "GOVERSION"], { cwd: source, env })).trim();
  if (!GO_VERSION.test(version)) throw new Error(`go-map is built with Go 1.24; found ${version}.`);
  const binary = path.resolve(output);
  await mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
  await run("go", ["build", "-trimpath", "-buildvcs=false", "-o", binary, "."], {
    cwd: source,
    env,
  });
  return source;
}

// A language whose toolchain is missing is left unbuilt: its files are then mapped without facts,
// and the map says so. The build goes on for the other languages.
const unavailable = (language, error) => {
  console.warn(
    `The ${language} map analyzer was not built (${error instanceof Error ? error.message : String(error)}); ${language} files will be mapped without declarations or links.`,
  );
  return undefined;
};

// Builds the Python map worker: Pyright from its pinned source (pyright-root), bundled and run in
// process, with the standard library stubs of the same typeshed (third-party stubs are left out).
// Every input is passed to record(file) for the build's input digests.
export async function buildPythonMap(directory, record = async () => {}) {
  const require = createRequire(import.meta.url);
  const pyright = path.join(
    path.dirname(require.resolve("pyright-root/package.json")),
    "packages/pyright-internal",
  );
  const workerPath = path.join(directory, "project-map-python-worker.mjs");
  const typeshed = path.join(directory, "project-map-python", "typeshed");
  await mkdir(path.dirname(typeshed), { recursive: true, mode: 0o700 });
  const worker = await build({
    absWorkingDir: inputRoot,
    entryPoints: [path.join(packageRoot, "src/project-map-python-worker.ts")],
    outfile: workerPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    alias: { "pyright-internal": path.join(pyright, "src") },
    nodePaths: [path.join(inputRoot, "node_modules")],
    // Pyright compiles with legacy decorators and ES2020 class fields; esbuild does not read
    // tsconfig files inside node_modules.
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
    banner: {
      js: 'import { createRequire as layermapCreateRequire } from "node:module"; const require = layermapCreateRequire(import.meta.url);',
    },
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  for (const file of Object.keys(worker.metafile.inputs)) await record(file);
  for (const output of worker.outputFiles)
    await writeFile(output.path, output.contents, { mode: 0o600 });
  const stubs = path.join(pyright, "typeshed-fallback");
  await cp(path.join(stubs, "stdlib"), path.join(typeshed, "stdlib"), { recursive: true });
  for (const name of ["LICENSE", "commit.txt"])
    await copyFile(path.join(stubs, name), path.join(typeshed, name));
  // The worker bundles Pyright's source; its license goes with it.
  const pyrightLicense = path.join(
    path.dirname(require.resolve("pyright-root/package.json")),
    "LICENSE.txt",
  );
  await record(pyrightLicense);
  await copyFile(pyrightLicense, path.join(path.dirname(typeshed), "LICENSE-pyright.txt"));
  for (const name of (await readdir(path.join(typeshed, "stdlib"), { recursive: true })).sort())
    if (name.endsWith(".pyi") || name === "VERSIONS")
      await record(path.join(stubs, "stdlib", name));
  return { workerPath, compilerPath: typeshed };
}

// A JDK of 21 or later: LAYERMAP_JAVA_HOME, JAVA_HOME, the java on PATH, the package manager homes
// the runtime also looks in (discoverJavaRuntime), then macOS's java_home.
export async function findJava() {
  const homes = [process.env.LAYERMAP_JAVA_HOME, process.env.JAVA_HOME];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const java = path.join(directory, executable("java"));
    if (directory && existsSync(java)) homes.push(path.dirname(path.dirname(await realpath(java))));
  }
  homes.push(
    ...["/opt/homebrew/opt", "/usr/local/opt"].flatMap((prefix) =>
      ["openjdk@25", "openjdk@21", "openjdk"].map(
        (formula) => `${prefix}/${formula}/libexec/openjdk.jdk/Contents/Home`,
      ),
    ),
    ...(process.env.HOME ? [path.join(process.env.HOME, ".sdkman/candidates/java/current")] : []),
  );
  if (process.platform === "darwin")
    homes.push(
      String(await run("/usr/libexec/java_home", ["-v", "21+"], {}).catch(() => "")).trim(),
    );
  for (const home of homes) {
    if (!home || !existsSync(path.join(home, "bin", executable("javac")))) continue;
    const release = await readFile(path.join(home, "release"), "utf8").catch(() => "");
    const version = /^JAVA_VERSION="([^"]+)"/mu.exec(release)?.[1];
    if (version && Number(version.split(".", 1)[0]) >= 21) return { home, version };
  }
  throw new Error("The Java map analyzer needs a JDK of 21 or later; set LAYERMAP_JAVA_HOME.");
}

// Builds the Java map analyzer: java-map.jar compiled for Java 21, the pinned Lombok beside it,
// and the Node relay worker. Every input is passed to record(file) for the build's input digests.
export async function buildJavaMap(directory, record = async () => {}) {
  const source = path.join(packageRoot, "java-map");
  const output = path.join(directory, "project-map-java");
  const workerPath = path.join(directory, "project-map-java-worker.mjs");
  const java = await findJava().catch((error) => unavailable("Java", error));
  if (!java) return { workerPath, compilerPath: path.join(output, "java-map.jar") };
  const { home, version } = java;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sources = (await readdir(path.join(source, "javamap")))
    .filter((name) => name.endsWith(".java"))
    .sort()
    .map((name) => path.join(source, "javamap", name));
  for (const file of sources) await record(file);
  const classes = await mkdtemp(path.join(directory, "java-map-classes-"));
  try {
    await run(
      path.join(home, "bin", executable("javac")),
      ["--release", "21", "-Xlint:all", "-Werror", "-d", classes, ...sources],
      {},
    );
    await run(
      path.join(home, "bin", "jar"),
      ["--create", "--file", path.join(output, "java-map.jar"), "-C", classes, "."],
      {},
    );
  } finally {
    await rm(classes, { recursive: true, force: true });
  }
  const lombok = path.join(source, "lib", LOMBOK.file);
  const digest = createHash("sha256")
    .update(await readFile(lombok))
    .digest("hex");
  if (digest !== LOMBOK.sha256) throw new Error("The vendored Lombok jar does not match its pin.");
  await record(lombok);
  await copyFile(lombok, path.join(output, "lombok.jar"));
  await copyFile(path.join(source, "lib", "LICENSE-lombok"), path.join(output, "LICENSE-lombok"));
  const worker = await build({
    absWorkingDir: inputRoot,
    entryPoints: [path.join(packageRoot, "src/project-map-java-worker.ts")],
    outfile: workerPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  for (const file of Object.keys(worker.metafile.inputs)) await record(file);
  for (const file of worker.outputFiles) await writeFile(file.path, file.contents, { mode: 0o600 });
  return {
    workerPath,
    compilerPath: path.join(output, "java-map.jar"),
    runtimePath: path.join(home, "bin", executable("java")),
    runtimeVersion: version,
  };
}

export async function buildProjectMapParser(directory) {
  const require = createRequire(import.meta.url);
  const compilerRequire = createRequire(require.resolve("typescript/package.json"));
  const compilerPackage = compilerRequire.resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  const compilerDirectory = path.join(path.dirname(compilerPackage), "lib");
  const nativeDirectory = path.join(directory, "project-map-native");
  const workerPath = path.join(directory, "project-map-worker.mjs");
  const compilerPath = path.join(nativeDirectory, executable("tsc"));
  // Outputs of an earlier build (library files of another compiler version, a stale analyzer)
  // must not outlive it.
  for (const name of [
    "project-map-native",
    "project-map-go",
    "project-map-python",
    "project-map-java",
  ])
    await rm(path.join(directory, name), { recursive: true, force: true });
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
  const built = await build({
    absWorkingDir: inputRoot,
    entryPoints: [path.join(packageRoot, "src/project-map-worker.ts")],
    outfile: workerPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    banner: {
      js: 'import { createRequire as layermapCreateRequire } from "node:module"; const require = layermapCreateRequire(import.meta.url);',
    },
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const inputs = {};
  const record = async (file) => {
    const relative = path.relative(inputRoot, path.resolve(inputRoot, file));
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Map parser build input outside the build root.");
    inputs[relative] = createHash("sha256")
      .update(await readFile(path.join(inputRoot, relative)))
      .digest("hex");
  };
  for (const file of Object.keys(built.metafile.inputs)) await record(file);
  for (const output of built.outputFiles)
    await writeFile(output.path, output.contents, { mode: 0o600 });
  const compiler = path.join(compilerDirectory, executable("tsc"));
  await record(compiler);
  await copyFile(compiler, compilerPath);
  await chmod(compilerPath, 0o755);
  for (const name of await readdir(compilerDirectory)) {
    if (!/^lib(?:\.[a-z0-9_-]+)*\.d\.ts$/u.test(name)) continue;
    const source = path.join(compilerDirectory, name);
    await record(source);
    await copyFile(source, path.join(nativeDirectory, name));
  }
  const goWorkerPath = path.join(directory, "project-map-go-worker.mjs");
  const goMapPath = path.join(directory, "project-map-go", executable("go-map"));
  const goWorker = await build({
    absWorkingDir: inputRoot,
    entryPoints: [path.join(packageRoot, "src/project-map-go-worker.ts")],
    outfile: goWorkerPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  for (const file of Object.keys(goWorker.metafile.inputs)) await record(file);
  for (const output of goWorker.outputFiles)
    await writeFile(output.path, output.contents, { mode: 0o600 });
  const goSource = await buildGoMap(goMapPath).catch((error) => unavailable("Go", error));
  if (goSource)
    for (const name of (await readdir(goSource)).sort())
      if (name.endsWith(".go") || name === "go.mod") await record(path.join(goSource, name));
  const pythonResources = await buildPythonMap(directory, record);
  const javaResources = await buildJavaMap(directory, record);
  await record(fileURLToPath(import.meta.url));
  return {
    resources: { workerPath, compilerPath },
    goResources: { workerPath: goWorkerPath, compilerPath: goMapPath },
    pythonResources,
    javaResources,
    inputs,
  };
}

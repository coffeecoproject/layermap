import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { childEnvironment, executableName, findExecutable } from "../src/platform";
import { mapForwardSlashes } from "../src/project-map-virtual-files";
import { sandbox } from "./support";

test("Windows executables carry .exe; POSIX ones do not", () => {
  assert.equal(executableName("go-map", "win32"), "go-map.exe");
  assert.equal(executableName("go-map", "darwin"), "go-map");
  assert.equal(executableName("tsc", "linux"), "tsc");
});

test("an executable is found on PATH", async () => {
  const directory = path.join(await sandbox(), "bin");
  await mkdir(directory);
  await writeFile(path.join(directory, "git"), "");
  await chmod(path.join(directory, "git"), 0o755);
  assert.equal(
    findExecutable("git", { PATH: `/nonexistent:${directory}` }, "darwin"),
    path.join(directory, "git"),
  );
  assert.equal(findExecutable("git", { PATH: "/nonexistent" }, "darwin"), undefined);
});

test("a Windows child keeps the system variables it needs; a POSIX child gets only what is given", () => {
  const env = { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", SECRET: "x", PATH: "C:\\bin" };
  assert.deepEqual(childEnvironment({ LANG: "C" }, "win32", env), {
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    LANG: "C",
  });
  assert.deepEqual(childEnvironment({ LANG: "C" }, "darwin", env), { LANG: "C" });
});

test("compiler file names use forward slashes whatever the host separator", () => {
  assert.equal(
    mapForwardSlashes("C:\\layermap\\project-map-native\\lib.d.ts"),
    "C:/layermap/project-map-native/lib.d.ts",
  );
  assert.equal(mapForwardSlashes("/layermap/src/a.ts"), "/layermap/src/a.ts");
});

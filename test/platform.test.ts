import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  childEnvironment,
  cmdInvocation,
  commandInvocation,
  executableName,
  findExecutable,
} from "../src/platform";
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
  const git = path.join(directory, executableName("git"));
  await writeFile(git, "");
  await chmod(git, 0o755);
  const elsewhere = path.join(directory, "missing");
  assert.equal(findExecutable("git", { PATH: [elsewhere, directory].join(path.delimiter) }), git);
  assert.equal(findExecutable("git", { PATH: elsewhere }), undefined);
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

test("a Windows .cmd shim runs through cmd.exe with its arguments quoted for it", () => {
  const invocation = cmdInvocation(
    "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
    ["mcp", "add", "--", "C:\\Program Files\\nodejs\\node.exe", 'a "quoted" word'],
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.equal(invocation.file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  // cross-spawn's quoting: each argument in quotes, inner quotes escaped, cmd.exe's special
  // characters (spaces and quotes included) caret-escaped twice for npm's shim.
  assert.equal(
    invocation.args[3],
    '"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd ^^^"mcp^^^" ^^^"add^^^" ^^^"--^^^" ^^^"C:\\Program^^^ Files\\nodejs\\node.exe^^^" ^^^"a^^^ \\^^^"quoted\\^^^"^^^ word^^^""',
  );
  assert.deepEqual(commandInvocation("git", ["status"], {}, "linux"), {
    file: "git",
    args: ["status"],
  });
});

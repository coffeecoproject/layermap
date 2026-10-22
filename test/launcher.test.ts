import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { generatedFiles } from "../scripts/plugins";
import { cacheDirectory } from "../src/agent/environment";
import { sandbox } from "./support";

const run = promisify(execFile);

// A registry serving layermap packages whose command records where and how it ran. It lets npm
// keep its list of versions for five minutes, as the npm registry does, so only asking again finds
// a version published since.
async function registry(directory: string) {
  const tarballs = new Map<string, Buffer>();
  let holding: { released: Promise<void>; reached: () => void } | undefined;
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    if (url === "/layermap") {
      const { port } = server.address() as AddressInfo;
      const versions = Object.fromEntries(
        [...tarballs].map(([version, tarball]) => [
          version,
          {
            name: "layermap",
            version,
            bin: { layermap: "cli.mjs" },
            dist: {
              tarball: `http://127.0.0.1:${port}/layermap/-/layermap-${version}.tgz`,
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            },
          },
        ]),
      );
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "public, max-age=300");
      response.end(JSON.stringify({ name: "layermap", versions }));
      return;
    }
    const tarball = tarballs.get(/layermap-(.+)\.tgz$/u.exec(url)?.[1] ?? "");
    response.statusCode = tarball ? 200 : 404;
    if (tarball && holding) {
      const { released, reached } = holding;
      response.write(tarball.subarray(0, 64));
      reached();
      released.then(() => response.end(tarball.subarray(64)));
      return;
    }
    response.end(tarball ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
    // Sends the start of each package and holds the rest back until released.
    hold: () => {
      let release = () => {};
      let reached = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      const sending = new Promise<void>((resolve) => (reached = resolve));
      holding = { released, reached };
      return { sending, release };
    },
    publish: async (version: string) => {
      const source = path.join(directory, `layermap-${version}`, "package");
      await mkdir(source, { recursive: true });
      await writeFile(
        path.join(source, "package.json"),
        JSON.stringify({ name: "layermap", version, type: "module", bin: { layermap: "cli.mjs" } }),
      );
      await writeFile(
        path.join(source, "cli.mjs"),
        `import { writeFileSync } from "node:fs";
writeFileSync(process.env.MARKER, JSON.stringify({ version: ${JSON.stringify(version)}, cwd: process.cwd(), argv: process.argv.slice(1) }));
`,
      );
      const tarball = path.join(directory, `layermap-${version}.tgz`);
      await run("tar", ["-czf", tarball, "-C", path.dirname(source), "package"]);
      tarballs.set(version, await readFile(tarball));
    },
  };
}

test("the launcher installs its version into the cache once, then starts it there in the project", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  const cache = path.join(directory, "cache");
  const project = path.join(directory, "project");
  await mkdir(project);
  // The user's npm settings apply; the project's own take no part, though npm ranks them higher:
  // this one would send npm nowhere.
  const userconfig = path.join(directory, "npmrc");
  await writeFile(userconfig, `registry=${served.url}\n`);
  await writeFile(path.join(project, ".npmrc"), "registry=http://127.0.0.1:9/\n");
  const env = {
    ...process.env,
    LAYERMAP_CACHE: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_userconfig: userconfig,
  };
  const start = async (version: string, marker: string, more: Record<string, string> = {}) => {
    const server = path.join(directory, `server-${version}.mjs`);
    await writeFile(server, generatedFiles(version)["plugins/claude/server.mjs"] ?? "");
    const child = spawn(process.execPath, [server], {
      cwd: project,
      env: { ...env, ...more, MARKER: path.join(directory, marker) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0, stderr);
    assert.equal(stdout, "", "standard output stays the server's, for MCP");
    return JSON.parse(await readFile(path.join(directory, marker), "utf8"));
  };

  await served.publish("1.0.0");
  const first = await start("1.0.0", "first.json");
  const installed = path.join(cache, "versions", "1.0.0", "node_modules", "layermap");
  assert.deepEqual(first, {
    version: "1.0.0",
    cwd: project,
    argv: [path.join(installed, "cli.mjs"), "mcp"],
  });
  assert.ok(existsSync(path.join(cache, "versions", "1.0.0", "last-used")));

  // A version published after npm listed the versions, as each LayerMap update is to its plugins.
  await served.publish("1.0.1");
  assert.equal((await start("1.0.1", "update.json")).version, "1.0.1");

  // Installed, a version starts without npm, so without the registry, a network or npm's cache.
  await served.close();
  const offline = await start("1.0.0", "offline.json", {
    npm_config_cache: path.join(directory, "empty-npm"),
  });
  assert.equal(offline.version, "1.0.0");
  assert.deepEqual((await readdir(path.join(cache, "versions"))).sort(), ["1.0.0", "1.0.1"]);
});

test("two launchers starting a new version at once both start it, from one install", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  await served.publish("2.0.0");
  const cache = path.join(directory, "cache");
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("2.0.0")["plugins/claude/server.mjs"] ?? "");
  const env = {
    ...process.env,
    LAYERMAP_CACHE: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
  };
  const statuses = await Promise.all(
    ["a", "b"].map(
      (name) =>
        new Promise((resolve) =>
          spawn(process.execPath, [server], {
            cwd: directory,
            env: { ...env, MARKER: path.join(directory, `${name}.json`) },
            stdio: "ignore",
          }).on("close", resolve),
        ),
    ),
  );
  assert.deepEqual(statuses, [0, 0]);
  assert.deepEqual(await readdir(path.join(cache, "versions")), ["2.0.0"]);
});

// Another launcher starts what it finds there, so a version is in its place only once complete.
test("a version being installed is not in the cache until npm has installed all of it", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  await served.publish("2.1.0");
  const cache = path.join(directory, "cache");
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("2.1.0")["plugins/claude/server.mjs"] ?? "");
  const { sending, release } = served.hold();
  const child = spawn(process.execPath, [server], {
    cwd: directory,
    env: {
      ...process.env,
      LAYERMAP_CACHE: cache,
      npm_config_cache: path.join(directory, "npm"),
      npm_config_registry: served.url,
      MARKER: path.join(directory, "marker.json"),
    },
    stdio: "ignore",
  });
  const status = new Promise((resolve) => child.on("close", resolve));
  await sending;
  assert.equal(existsSync(path.join(cache, "versions", "2.1.0")), false);
  release();
  assert.equal(await status, 0);
  assert.ok(
    existsSync(path.join(cache, "versions", "2.1.0", "node_modules", "layermap", "cli.mjs")),
  );
});

test("a launcher that cannot install its version says why and exits", async () => {
  const directory = await sandbox();
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("3.0.0")["plugins/claude/server.mjs"] ?? "");
  const child = spawn(process.execPath, [server], {
    cwd: directory,
    env: {
      ...process.env,
      LAYERMAP_CACHE: path.join(directory, "cache"),
      npm_config_cache: path.join(directory, "npm"),
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_fetch_retries: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /could not start LayerMap 3\.0\.0: npm exited with/u);
  assert.deepEqual(await readdir(path.join(directory, "cache", "versions")), []);
});

// The launcher cannot import LayerMap before it is installed, so it finds the cache by itself.
test("the launcher finds its versions in the cache LayerMap uses", async () => {
  const home = await sandbox();
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "local") };
  // cacheDirectory finds the home directory from the process's own variables.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const cache = cacheDirectory(env);
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  const installed = path.join(cache, "versions", "4.0.0", "node_modules", "layermap");
  await mkdir(installed, { recursive: true });
  await writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({
      name: "layermap",
      version: "4.0.0",
      type: "module",
      bin: { layermap: "cli.mjs" },
    }),
  );
  await writeFile(path.join(installed, "cli.mjs"), "process.exit(7);\n");
  const server = path.join(home, "server.mjs");
  await writeFile(server, generatedFiles("4.0.0")["plugins/claude/server.mjs"] ?? "");
  const variables = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["LAYERMAP_CACHE", "XDG_CACHE_HOME"].includes(name),
    ),
  );
  const status = await new Promise((resolve) =>
    spawn(process.execPath, [server], {
      env: { ...variables, ...env, npm_config_registry: "http://127.0.0.1:9/" },
      stdio: "ignore",
    }).on("close", resolve),
  );
  assert.equal(status, 7);
});

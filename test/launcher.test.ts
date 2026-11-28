import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { generatedFiles } from "../scripts/plugins";
import { installDirectory } from "../src/agent/environment";
import { sandbox } from "./support";

const run = promisify(execFile);

// A layermap package that records each start and message. Its command line exits; its server
// answers each request with its version, asks the agent for its roots once told the session is
// initialized, holds requests named wait until cancelled or retired, and answers those it holds
// when retired, then ends. `before` runs first, to make a version that cannot start.
const layermap = (version: string, before = "") => `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
${before}
const version = ${JSON.stringify(version)};
const record = (entry) =>
  appendFileSync(process.env.MARKER, JSON.stringify({ version, cwd: process.cwd(), ...entry }) + "\\n");
record({ argv: process.argv.slice(1) });
if (process.argv[2] === "mcp") {
  const held = [];
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
  const answer = (message) => send({ id: message.id, result: { version, method: message.method } });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    record({ method: message.method ?? null, id: message.id ?? null });
    if (message.method === "notifications/initialized") send({ id: "ask", method: "roots/list" });
    if (message.method === "notifications/cancelled") {
      const index = held.findIndex((request) => request.id === message.params.requestId);
      if (index >= 0) held.splice(index, 1);
    }
    if (message.method === "notifications/layermap/retire") {
      held.splice(0).forEach(answer);
      return lines.close();
    }
    if (message.id === undefined || message.method === undefined) return;
    if (message.method === "wait") return void held.push(message);
    answer(message);
  });
}
`;

// A registry serving layermap packages, by default ones that record how they ran. It lets npm
// keep its list of versions for five minutes, as the npm registry does, so only asking again finds
// a version published since.
async function registry(directory: string) {
  const tarballs = new Map<string, Buffer>();
  let holding: { released: Promise<void>; reached: () => void } | undefined;
  let tagged: string | undefined;
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
      const latest = tagged ?? [...tarballs.keys()].at(-1);
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "public, max-age=300");
      response.end(
        JSON.stringify({ name: "layermap", "dist-tags": latest ? { latest } : {}, versions }),
      );
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
    // Makes the version npm's latest, as `npm dist-tag add` does.
    tag: (version: string) => {
      tagged = version;
    },
    publish: async (version: string, cli = layermap(version)) => {
      const source = path.join(directory, `layermap-${version}`, "package");
      await mkdir(source, { recursive: true });
      await writeFile(
        path.join(source, "package.json"),
        JSON.stringify({ name: "layermap", version, type: "module", bin: { layermap: "cli.mjs" } }),
      );
      await writeFile(path.join(source, "cli.mjs"), cli);
      const tarball = path.join(directory, `layermap-${version}.tgz`);
      await run("tar", ["-czf", tarball, "-C", path.dirname(source), "package"]);
      tarballs.set(version, await readFile(tarball));
    },
  };
}

// The launcher the Claude Code plugin starts its server with, written into the directory.
async function serverScript(directory: string) {
  const server = path.join(directory, "server.mjs");
  await writeFile(server, generatedFiles("0.0.0")["plugins/claude/server.mjs"] ?? "");
  return server;
}

// The plugin's command line, written into the directory.
function generatedCommand(directory: string) {
  const file = path.join(directory, "cli.mjs");
  writeFileSync(file, generatedFiles("0.0.0")["plugins/claude/cli.mjs"] ?? "");
  return file;
}

// The entries a package recorded in the marker.
const recorded = (marker: string): Record<string, unknown>[] =>
  existsSync(marker)
    ? readFileSync(marker, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const current = (cache: string) =>
  readFile(path.join(cache, "versions", "current"), "utf8").then(
    (text) => text.trim(),
    () => undefined,
  );
async function until(done: () => Promise<boolean> | boolean, what: string) {
  for (let tries = 0; !(await done()); tries++) {
    assert.ok(tries < 600, what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Runs a launcher to its end with nothing on its standard input, as a server whose agent left.
async function finish(script: string, cwd: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, stdout, stderr };
}

test("the launcher installs the latest version, names it the machine's once it starts, and starts it in the project", async (t) => {
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
  const marker = path.join(directory, "marker.jsonl");
  const env = {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_userconfig: userconfig,
    MARKER: marker,
  };
  const server = await serverScript(directory);

  await served.publish("1.0.0");
  const first = await finish(server, project, env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "", "standard output stays the server's, for MCP");
  assert.equal(await current(cache), "1.0.0");
  const installed = path.join(cache, "versions", "1.0.0", "node_modules", "layermap");
  const starts = recorded(marker).filter((entry) => entry.argv);
  // Started once to see it answer, outside any project, then for the session in the project.
  assert.deepEqual(
    starts.map(({ cwd, argv }) => ({ cwd, argv })),
    [
      { cwd: path.join(cache, "versions"), argv: [path.join(installed, "cli.mjs"), "mcp"] },
      { cwd: project, argv: [path.join(installed, "cli.mjs"), "mcp"] },
    ],
  );
  assert.ok(existsSync(path.join(cache, "versions", "1.0.0", "last-used")));

  // The machine's version starts without npm, so without the registry, a network or npm's cache,
  // whatever npm has published since.
  await served.publish("1.0.1");
  await served.close();
  await writeFile(marker, "");
  const offline = await finish(server, project, {
    ...env,
    npm_config_cache: path.join(directory, "empty-npm"),
  });
  assert.equal(offline.status, 0, offline.stderr);
  assert.deepEqual(
    recorded(marker).map(({ version }) => version),
    ["1.0.0"],
  );
  assert.deepEqual((await readdir(path.join(cache, "versions"))).sort(), [
    "1.0.0",
    "current",
    "latest-checked",
  ]);
});

test("the command line with no version it can run installs the latest, and a hook does nothing", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  const cache = path.join(directory, "cache");
  // A version older than any this launcher starts, as one from before it.
  const old = path.join(cache, "versions", "0.1.0", "node_modules", "layermap");
  await mkdir(old, { recursive: true });
  await writeFile(
    path.join(old, "package.json"),
    JSON.stringify({ name: "layermap", version: "0.1.0", bin: { layermap: "cli.mjs" } }),
  );
  await served.publish("2.0.0");
  const marker = path.join(directory, "marker.jsonl");
  const env = {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
    MARKER: marker,
  };
  const command = generatedCommand(directory);

  // A hook has seconds to finish in: it asks npm nothing, and runs nothing.
  const hook = await finish(command, directory, env, ["hook", "claude"]);
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, "", ""]);
  assert.equal(existsSync(path.join(cache, "versions", "latest-checked")), false);
  assert.deepEqual(recorded(marker), []);

  const ran = await finish(command, directory, env, ["--version"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(await current(cache), "2.0.0");
  assert.deepEqual(recorded(marker).at(-1)?.argv, [
    path.join(cache, "versions", "2.0.0", "node_modules", "layermap", "cli.mjs"),
    "--version",
  ]);
  // Then the hooks run it too.
  await finish(command, directory, env, ["hook", "claude"]);
  assert.deepEqual(recorded(marker).at(-1)?.argv, [
    path.join(cache, "versions", "2.0.0", "node_modules", "layermap", "cli.mjs"),
    "hook",
    "claude",
  ]);
});

test("two launchers starting with nothing installed both start the latest, from one install", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  await served.publish("2.0.0");
  const cache = path.join(directory, "cache");
  const server = await serverScript(directory);
  const env = {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
    MARKER: path.join(directory, "marker.jsonl"),
  };
  const statuses = await Promise.all(
    ["a", "b"].map(async () => (await finish(server, directory, env)).status),
  );
  assert.deepEqual(statuses, [0, 0]);
  assert.deepEqual((await readdir(path.join(cache, "versions"))).sort(), [
    "2.0.0",
    "current",
    "latest-checked",
  ]);
});

// Another launcher starts what it finds there, so a version is in its place only once complete.
test("a version being installed is not in the cache until npm has installed all of it", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  await served.publish("2.1.0");
  const cache = path.join(directory, "cache");
  const server = await serverScript(directory);
  const { sending, release } = served.hold();
  const finished = finish(server, directory, {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
    MARKER: path.join(directory, "marker.jsonl"),
  });
  await sending;
  assert.equal(existsSync(path.join(cache, "versions", "2.1.0")), false);
  release();
  assert.equal((await finished).status, 0);
  assert.ok(
    existsSync(path.join(cache, "versions", "2.1.0", "node_modules", "layermap", "cli.mjs")),
  );
});

test("a launcher that cannot install a version says why and exits", async () => {
  const directory = await sandbox();
  const server = await serverScript(directory);
  const { status, stdout, stderr } = await finish(server, directory, {
    ...process.env,
    LAYERMAP_HOME: path.join(directory, "cache"),
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_fetch_retries: "0",
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /could not start LayerMap: npm exited with/u);
  assert.deepEqual(await readdir(path.join(directory, "cache", "versions")), ["latest-checked"]);
});

// An agent's session with the plugin's server: requests by id, answered in any order. It answers
// the server's own requests with no roots. It works in the directory of the server's launcher.
const sessions = new Set<ReturnType<typeof spawn>>();
after(() => {
  for (const child of sessions) child.kill();
});
function session(server: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [server], {
    cwd: path.dirname(server),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  sessions.add(child);
  const waiting = new Map<number, (result: { version: string; method: string }) => void>();
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method !== undefined) return void send({ id: message.id, result: { roots: [] } });
    waiting.get(message.id)?.(message.result);
  });
  let next = 0;
  return {
    send,
    stderr: () => stderr,
    request(method: string, params: Record<string, unknown> = {}) {
      const id = ++next;
      const answered = new Promise<{ version: string; method: string }>((resolve) =>
        waiting.set(id, resolve),
      );
      send({ id, method, params });
      return Object.assign(answered, { id });
    },
    end: () => {
      child.stdin.end();
      return new Promise((resolve) => child.on("close", resolve));
    },
  };
}

// The messages each version's server read in the directory.
const read = (marker: string, version: string, cwd: string) =>
  recorded(marker)
    .filter((entry) => entry.version === version && entry.cwd === cwd && !entry.argv)
    .map(({ method, id }) => (method ?? `answer ${id}`) as string);

test("a session moves to the machine's version at its next request, whatever the old server is still doing", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  const cache = path.join(directory, "cache");
  const marker = path.join(directory, "messages.jsonl");
  const env = {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
    MARKER: marker,
  };
  await served.publish("5.0.0");
  const server = await serverScript(directory);
  const agent = session(server, env);
  assert.equal((await agent.request("initialize", { client: "agent" })).version, "5.0.0");
  agent.send({ method: "notifications/initialized" });
  assert.equal((await agent.request("tools/list")).version, "5.0.0");

  // A request the agent cancelled, which the server leaves unanswered, and one it holds.
  const cancelled = agent.request("wait");
  agent.send({ method: "notifications/cancelled", params: { requestId: cancelled.id } });
  const held = agent.request("wait");
  // A later session's launcher, an hour on, finds the newer version npm has and makes it the
  // machine's.
  await served.publish("5.0.1");
  await utimes(path.join(cache, "versions", "latest-checked"), 0, 0);
  const updater = session(server, { ...env, MARKER: path.join(directory, "updater.jsonl") });
  assert.equal((await updater.request("initialize")).version, "5.0.0");
  await until(async () => (await current(cache)) === "5.0.1", "the launcher updates the machine");

  assert.equal((await agent.request("tools/call", { name: "x" })).version, "5.0.1");
  // The old server answers what it held once retired, and ends.
  assert.equal((await held).version, "5.0.0");
  assert.equal((await updater.request("tools/list")).version, "5.0.1");
  assert.equal(await agent.end(), 0, agent.stderr());
  assert.equal(await updater.end(), 0);

  // Each server's request for roots, with the same id, reaches it answered; the agent answers it
  // while its own requests go on.
  const messages = (version: string) => read(marker, version, directory);
  for (const version of ["5.0.0", "5.0.1"])
    assert.ok(messages(version).includes("answer ask"), version);
  const passed = (version: string) => messages(version).filter((method) => method !== "answer ask");
  assert.deepEqual(passed("5.0.0"), [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "wait",
    "notifications/cancelled",
    "wait",
    "notifications/layermap/retire",
  ]);
  // The new server is introduced with the agent's own initialize, whose answer the agent never sees.
  assert.deepEqual(passed("5.0.1"), ["initialize", "notifications/initialized", "tools/call"]);
});

test("a version that does not start never becomes the machine's, and a session stays where it is", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  const cache = path.join(directory, "cache");
  const marker = path.join(directory, "messages.jsonl");
  const env = {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
    MARKER: marker,
  };
  await served.publish("1.0.0");
  const server = await serverScript(directory);
  const agent = session(server, env);
  assert.equal((await agent.request("initialize")).version, "1.0.0");

  // npm's latest exits as it starts: the update installs it, sees it fail, and names it not.
  await served.publish(
    "1.0.1",
    layermap("1.0.1", 'if (process.argv[2] === "mcp") process.exit(9);'),
  );
  await utimes(path.join(cache, "versions", "latest-checked"), 0, 0);
  const later = session(server, env);
  assert.equal((await later.request("initialize")).version, "1.0.0");
  await until(() => /could not update LayerMap/u.test(later.stderr()), "the update ends");
  assert.match(later.stderr(), /could not update LayerMap: layermap 1\.0\.1 did not start/u);
  assert.equal(await current(cache), "1.0.0");
  assert.equal(await later.end(), 0);

  // One named the machine's that then does not start in a session leaves the session on its own.
  await writeFile(path.join(cache, "versions", "current"), "1.0.1\n");
  assert.equal((await agent.request("tools/list")).version, "1.0.0");
  assert.equal((await agent.request("tools/list")).version, "1.0.0");
  assert.match(agent.stderr(), /LayerMap 1\.0\.1 did not start; this session stays on 1\.0\.0/u);
  assert.equal(await agent.end(), 0);
});

test("moving npm's latest back moves the machine back", async (t) => {
  const directory = await sandbox();
  const served = await registry(directory);
  t.after(served.close);
  const cache = path.join(directory, "cache");
  const env = {
    ...process.env,
    LAYERMAP_HOME: cache,
    npm_config_cache: path.join(directory, "npm"),
    npm_config_registry: served.url,
    MARKER: path.join(directory, "marker.jsonl"),
  };
  await served.publish("3.0.0");
  await served.publish("3.0.1");
  const server = await serverScript(directory);
  assert.equal((await finish(server, directory, env)).status, 0);
  assert.equal(await current(cache), "3.0.1");
  served.tag("3.0.0");
  await utimes(path.join(cache, "versions", "latest-checked"), 0, 0);
  const back = session(server, env);
  assert.equal((await back.request("initialize")).version, "3.0.1");
  await until(async () => (await current(cache)) === "3.0.0", "the machine moves back");
  assert.equal((await back.request("tools/list")).version, "3.0.0");
  assert.equal(await back.end(), 0);
});

// The launcher cannot import LayerMap before it is installed, so it finds the directory by itself.
// The directory maps are kept in is another matter: LAYERMAP_CACHE does not move the versions.
test("the launcher finds its versions in the directory LayerMap is installed in, wherever maps are kept", async () => {
  const home = await sandbox();
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "local") };
  // installDirectory finds the home directory from the process's own variables.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const cache = installDirectory(env);
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
  await writeFile(path.join(cache, "versions", "current"), "4.0.0\n");
  const server = await serverScript(home);
  const variables = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["LAYERMAP_HOME", "LAYERMAP_CACHE", "XDG_CACHE_HOME"].includes(name),
    ),
  );
  for (const kept of [{}, { LAYERMAP_CACHE: path.join(home, "maps") }]) {
    const { status } = await finish(server, home, {
      ...variables,
      ...env,
      ...kept,
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_fetch_retries: "0",
    });
    assert.equal(status, 7);
  }
  assert.equal(existsSync(path.join(home, "maps")), false);
});

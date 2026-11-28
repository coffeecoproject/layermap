// Generated from scripts/launcher.mjs.
// Starts LayerMap for an agent: its MCP server, or, given other arguments, its command line with
// them (the Claude Code plugin's layermap command and hooks, and the ~/.local/bin command). A machine
// runs one LayerMap, the version named in versions/current of its cache: every agent's plugin, the
// hooks and the command line start that one, so no two versions share the maps there, and a plugin
// names no version of its own.
//
// Only an update writes versions/current: it asks npm for the latest version, installs it beside
// the others, and names it once it has started and answered as a server, so a version that cannot
// run never becomes the machine's, and moving npm's latest back moves the machine back with it. A
// server's launcher updates once an hour; the command line updates only when there is no version to
// run, and a hook never does: it does nothing until a server or the command line has installed one.
//
// The server runs as a child of this process, which passes the agent's messages through. When
// versions/current names another version, this starts that one before passing on the agent's next
// request, introduces the session to it as the agent did to the old one, and sends the agent's
// requests to it from then on; the old one answers the calls it has and ends. One that cannot start
// leaves the session where it is. The agent starts this in the project, which stays the working
// directory the server maps; npm runs where it installs, so the project's own npm settings and
// packages play no part in it.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const ARGUMENTS = process.argv.slice(2);
// The oldest version this launcher starts: the first with the `layermap hook` command the plugin's
// hooks run, and that ends when the launcher retires it. npm must have it before a plugin with this
// launcher is released: a plugin that comes first finds no version it can start.
const MINIMUM = "0.1.57";
const CHECK_EVERY_MS = 60 * 60 * 1000;
// How long a server has to answer its introduction before this takes it for one that cannot run.
const START_WAIT_MS = 30_000;
const RETIRE = "notifications/layermap/retire";

// The same directory as installDirectory in src/agent/environment.ts: the user's cache, unless
// LAYERMAP_HOME names another. LAYERMAP_CACHE, which names where maps are kept, does not move it.
const env = process.env;
const directory = env.LAYERMAP_HOME
  ? path.resolve(env.LAYERMAP_HOME)
  : process.platform === "darwin"
    ? path.join(homedir(), "Library", "Caches", "layermap")
    : process.platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "layermap", "Cache")
      : path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "layermap");
const versions = path.join(directory, "versions");
// Its time is when a launcher last asked npm for the latest version.
const checked = path.join(versions, "latest-checked");
const chosen = path.join(versions, "current");
const installed = (version) => path.join(versions, version, "node_modules", "layermap");
const manifest = (version) => path.join(installed(version), "package.json");
const entry = (version) =>
  path.join(installed(version), JSON.parse(readFileSync(manifest(version), "utf8")).bin.layermap);
const log = (line) => process.stderr.write(`layermap: ${line}\n`);
const write = (stream, line) => stream.write(`${line}\n`);
// The first lines of an error, as one: npm's whole account is long.
const brief = (error) =>
  String(error?.message ?? error)
    .split("\n")
    .slice(0, 2)
    .join(": ");

const VERSION = /^\d+\.\d+\.\d+$/u;
const numbers = (version) => version.split(".").map(Number);
const compare = (left, right) => {
  const [a, b] = [numbers(left), numbers(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};
const runnable = (version) => version !== undefined && compare(version, MINIMUM) >= 0;
// The machine's version, when it is installed.
const current = () => {
  const version = existsSync(chosen) ? readFileSync(chosen, "utf8").trim() : "";
  return VERSION.test(version) && existsSync(manifest(version)) ? version : undefined;
};
// LayerMap removes a version other than the current one once nothing has used it for a week.
const touch = (version) => {
  const file = path.join(versions, version, "last-used");
  writeFileSync(file, "");
  const now = new Date();
  utimesSync(file, now, now);
};

// The npm of the Node running this, else the one on PATH.
const npm = () => {
  const directory = path.dirname(process.execPath);
  for (const cli of [
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ])
    if (existsSync(cli)) return [process.execPath, [cli]];
  if (process.platform === "win32") throw new Error(`no npm beside ${process.execPath}`);
  return ["npm", []];
};
// --prefer-online has npm ask the registry, whose list of versions a cached one may lack.
const runNpm = (args, cwd) => {
  const [command, prefix] = npm();
  const flags = ["--prefer-online", "--no-update-notifier", "--loglevel=error"];
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args, ...flags], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let output = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      output += data;
    });
    child.stderr.on("data", (data) => (output += data));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`npm exited with ${code}\n${output.trim()}`)),
    );
  });
};

// npm installs into a directory of its own, renamed into place once complete, so no server starts
// from half an install, and two installing at once both end up with the one that was renamed first.
async function install(version) {
  const staging = mkdtempSync(path.join(versions, `.${version}-`));
  log(`installing layermap@${version} with npm`);
  const args = ["install", `layermap@${version}`, "--prefix", staging, "--omit=dev"];
  await runNpm([...args, "--no-audit", "--no-fund"], staging).catch((error) => {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  });
  try {
    renameSync(staging, path.join(versions, version));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(manifest(version))) throw error;
  }
}

// A version's server, started with the arguments in the directory: its messages to this come to
// child.receive, a line at a time, its own log goes where this one's does unless kept.
const launch = (version, args, cwd, stderr = "inherit") => {
  const child = spawn(process.execPath, [entry(version), ...args], {
    cwd,
    stdio: ["pipe", "pipe", stderr],
    windowsHide: true,
  });
  child.version = version;
  child.receive = () => {};
  // A server that has ended takes no more lines; what this writes it then is dropped.
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) =>
    child.receive(line),
  );
  return child;
};

// Sends the server an initialize request and waits for its answer: false when it ends first, or
// takes longer than START_WAIT_MS. Its other messages meanwhile go to `other`.
const INTRODUCTION = "layermap-launcher-initialize";
const introduce = (child, initialize, other = () => {}) =>
  new Promise((resolve) => {
    const done = (answered) => {
      clearTimeout(timer);
      child.receive = other;
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), START_WAIT_MS);
    child.once("close", () => done(false));
    child.receive = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {}
      if (message?.id === INTRODUCTION && message.method === undefined)
        return done(message.result !== undefined);
      other(line);
    };
    write(child.stdin, JSON.stringify({ ...initialize, id: INTRODUCTION }));
  });

// Whether the version starts and answers as a server, outside any project.
async function starts(version) {
  const child = launch(version, ["mcp"], versions, "pipe");
  let output = "";
  child.stderr.on("data", (data) => (output += data));
  const answered = await introduce(child, {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "layermap-launcher", version: MINIMUM },
    },
  });
  child.stdin.end();
  setTimeout(() => child.kill(), 5_000).unref();
  if (!answered)
    throw new Error(
      `layermap ${version} did not start as a server${output.trim() ? `\n${output.trim()}` : ""}`,
    );
}

// Asks npm for the latest version and makes it the machine's: installed, started once, named.
async function update() {
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  writeFileSync(checked, "");
  const latest = JSON.parse(
    await runNpm(["view", "layermap@latest", "version", "--json"], versions),
  );
  if (typeof latest !== "string" || !VERSION.test(latest))
    throw new Error(`npm names no version of layermap: ${JSON.stringify(latest)}`);
  if (latest === current()) return;
  if (!runnable(latest))
    throw new Error(`npm's latest layermap is ${latest}; this launcher starts ${MINIMUM} or later`);
  if (!existsSync(manifest(latest))) await install(latest);
  await starts(latest);
  writeFileSync(`${chosen}.${process.pid}`, `${latest}\n`);
  renameSync(`${chosen}.${process.pid}`, chosen);
}

// The machine's version, updating first when it has none this can run, unless told not to.
async function machineVersion(updating) {
  if (!runnable(current())) {
    if (!updating) return undefined;
    await update();
  }
  const version = current();
  if (!runnable(version)) throw new Error(`no layermap ${MINIMUM} or later is installed`);
  return version;
}

// The command line, in this process. A hook is optional: with no version installed it does nothing,
// and leaves installing to a server or the command line, as it has seconds to finish in.
async function command() {
  const version = await machineVersion(ARGUMENTS[0] !== "hook");
  if (!version) return;
  touch(version);
  process.argv = [process.argv[0], entry(version), ...ARGUMENTS];
  await import(pathToFileURL(entry(version)).href);
}

// A message's id as a key, whatever JSON it is.
const key = (id) => JSON.stringify(id);
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};
const isRequest = (message) => message?.id !== undefined && message.method !== undefined;
const isResponse = (message) => message?.id !== undefined && message.method === undefined;

// The server, as children that this passes the agent's messages to and theirs back from.
async function serve() {
  let server;
  let initialize;
  const servers = new Set();
  // The server each of the agent's requests went to, for its cancellation; each server's requests
  // to the agent, by the id this gives them, as two servers may use the same one.
  const owners = new Map();
  const asked = new Map();
  let asks = 0;
  // Versions that could not be introduced in this session, which it does not try again.
  const failed = new Set();

  const fromServer = (child) => (line) => {
    const message = parse(line);
    if (isRequest(message)) {
      const id = `layermap-launcher-${++asks}`;
      asked.set(id, { child, id: message.id });
      return write(process.stdout, JSON.stringify({ ...message, id }));
    }
    if (isResponse(message)) owners.delete(key(message.id));
    write(process.stdout, line);
  };
  const start = (version) => {
    touch(version);
    const child = launch(version, ARGUMENTS, process.cwd());
    servers.add(child);
    child.on("close", (code, signal) => {
      servers.delete(child);
      for (const [id, owner] of owners) if (owner === child) owners.delete(id);
      for (const [id, ask] of asked) if (ask.child === child) asked.delete(id);
      // The session ends with its server; one it has moved from goes quietly.
      if (child === server) process.exit(code ?? (signal ? 1 : 0));
    });
    return child;
  };

  // Moves the session to the machine's version when that has changed.
  const follow = async () => {
    const next = current();
    if (!runnable(next) || next === server.version || failed.has(next)) return;
    const child = start(next);
    if (!(await introduce(child, initialize, fromServer(child)))) {
      failed.add(next);
      child.kill();
      return log(`LayerMap ${next} did not start; this session stays on ${server.version}`);
    }
    child.receive = fromServer(child);
    write(child.stdin, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const old = server;
    server = child;
    write(old.stdin, JSON.stringify({ jsonrpc: "2.0", method: RETIRE }));
  };

  const fromAgent = async (line) => {
    const message = parse(line);
    if (isRequest(message)) {
      if (message.method === "initialize") initialize = message;
      else if (initialize) await follow();
      owners.set(key(message.id), server);
      return write(server.stdin, line);
    }
    if (isResponse(message)) {
      const ask = asked.get(message.id);
      if (!ask) return write(server.stdin, line);
      asked.delete(message.id);
      return write(ask.child.stdin, JSON.stringify({ ...message, id: ask.id }));
    }
    const owner =
      message?.method === "notifications/cancelled" && owners.get(key(message.params?.requestId));
    write((owner || server).stdin, line);
  };

  server = start(await machineVersion(true));
  server.receive = fromServer(server);
  let updating = false;
  const tick = () => {
    // A marker that cannot be written, in a cache someone emptied say, leaves the session running.
    try {
      touch(server.version);
    } catch {}
    const last = existsSync(checked) ? statSync(checked).mtimeMs : 0;
    if (updating || Date.now() - last < CHECK_EVERY_MS) return;
    updating = true;
    update()
      // A line, as it may fail each hour on a machine offline.
      .catch((error) => log(`could not update LayerMap: ${brief(error)}`))
      .finally(() => (updating = false));
  };
  tick();
  setInterval(tick, 10 * 60 * 1000).unref();

  // Messages are passed on in the order they come, each once the one before it is.
  let passing = Promise.resolve();
  const agent = createInterface({ input: process.stdin, crlfDelay: Infinity });
  agent.on("line", (line) => {
    passing = passing
      .then(() => fromAgent(line))
      .catch((error) => {
        log(`could not pass a message to LayerMap: ${brief(error)}`);
        process.exit(1);
      });
  });
  agent.on("close", () => {
    passing.then(() => {
      for (const child of servers) child.stdin.end();
    });
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      for (const child of servers) child.kill(signal);
      process.exit(1);
    });
}

try {
  await (ARGUMENTS[0] === "mcp" ? serve() : command());
} catch (error) {
  log(`could not start LayerMap: ${brief(error)}`);
  process.exit(1);
}

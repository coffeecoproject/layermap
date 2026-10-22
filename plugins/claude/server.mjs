// Generated from scripts/launcher.mjs.
// Starts one LayerMap version's MCP server in this process. The version is installed once into
// LayerMap's cache, from where every later start runs without npm or a network. The agent starts
// this in the project, which stays the working directory the server maps; npm runs in the cache,
// so the project's own npm settings and packages play no part in what gets installed.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.27";

// The same directory as cacheDirectory in src/agent/environment.ts.
const env = process.env;
const cache = env.LAYERMAP_CACHE
  ? path.resolve(env.LAYERMAP_CACHE)
  : process.platform === "darwin"
    ? path.join(homedir(), "Library", "Caches", "layermap")
    : process.platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "layermap", "Cache")
      : path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "layermap");
const versions = path.join(cache, "versions");
const home = path.join(versions, VERSION);
const installed = path.join(home, "node_modules", "layermap");
const manifest = path.join(installed, "package.json");

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

// npm installs into a directory of its own, renamed into place once complete, so no server starts
// from half an install, and two starting at once both end up with the one that was renamed first.
// --prefer-online has npm ask the registry for the versions it has, which a cached list may lack.
async function install() {
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(versions, `.${VERSION}-`));
  process.stderr.write(`layermap: installing layermap@${VERSION} with npm\n`);
  const [command, prefix] = npm();
  const args = [
    ...prefix,
    "install",
    `layermap@${VERSION}`,
    "--prefix",
    staging,
    "--prefer-online",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--loglevel=error",
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: staging,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm exited with ${code}\n${output.trim()}`)),
    );
  }).catch((error) => {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  });
  try {
    renameSync(staging, home);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(manifest)) throw error;
  }
}

try {
  if (!existsSync(manifest)) await install();
  // LayerMap removes a version from its cache once nothing has started it for a week.
  writeFileSync(path.join(home, "last-used"), "");
  const entry = path.join(installed, JSON.parse(readFileSync(manifest, "utf8")).bin.layermap);
  process.argv = [process.argv[0], entry, "mcp"];
  await import(pathToFileURL(entry).href);
} catch (error) {
  process.stderr.write(
    `layermap: could not start LayerMap ${VERSION}: ${error?.message ?? error}\n`,
  );
  process.exit(1);
}

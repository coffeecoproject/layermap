import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { digestValue } from "./digest";

// A map's code comes from the revision, but the compiler resolves its types against the packages
// the project has installed. They are never mapped: only their types reach the analysis, so a map
// also depends on what is installed, which the digest below stands for. A package manager records
// the whole tree, its dependencies' dependencies too, in these files.
const INSTALL_RECORDS = [
  ".pnpm/lock.yaml",
  ".package-lock.json",
  ".yarn-state.yml",
  ".yarn-integrity",
];
// Without such a record, the lockfile beside the packages is what tells of their dependencies.
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

export const mapInNodeModules = (relative: string) => relative.split("/").includes("node_modules");

/** The coverage gap of a package the code needs that is not installed. */
export const MAP_DEPENDENCY_NOT_INSTALLED = "DEPENDENCY_NOT_INSTALLED";

/** The npm package an import specifier names, undefined for anything else (a path, node:fs, @/x). */
export function mapPackageOf(specifier: string): string | undefined {
  if (isBuiltin(specifier)) return undefined;
  return /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*(?=\/|$)/iu.exec(specifier)?.[0];
}

/** The package a compiler diagnostic says it could not find, undefined for other diagnostics. */
export function mapMissingPackage(code: number, text: string): string | undefined {
  // Cannot find module 'x', its variant asking for another module resolution, and a `types` entry.
  if (code !== 2307 && code !== 2792 && code !== 2688) return undefined;
  const named = /'([^']+)'/u.exec(text)?.[1];
  return named ? mapPackageOf(named) : undefined;
}

/**
 * Where a path relative to the project's real root really is, undefined when nothing is there or a
 * link takes it out of the project: a package linked from elsewhere (npm link, a store shared
 * between projects) counts as not installed.
 */
export function mapInstalledPath(realRoot: string, relative: string): string | undefined {
  try {
    const real = realpathSync.native(path.join(realRoot, relative));
    return real.startsWith(`${realRoot}${path.sep}`) ? real : undefined;
  } catch {
    return undefined;
  }
}

const contentDigest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const versionOf = (realRoot: string, relative: string) => {
  const manifest = mapInstalledPath(realRoot, `${relative}/package.json`);
  if (!manifest) return "not in the project";
  try {
    return String(JSON.parse(readFileSync(manifest, "utf8")).version);
  } catch {
    return "unreadable";
  }
};

function installedAt(realRoot: string, directory: string, real: string): unknown {
  const records = INSTALL_RECORDS.flatMap((name) => {
    const file = mapInstalledPath(realRoot, path.posix.join(directory, name));
    return file ? [[name, contentDigest(file)]] : [];
  });
  if (records.length) return records;
  const packages = readdirSync(real).flatMap((name) => {
    if (name.startsWith(".")) return [];
    if (!name.startsWith("@")) return [name];
    const scope = mapInstalledPath(realRoot, path.posix.join(directory, name));
    return scope ? readdirSync(scope).map((inner) => `${name}/${inner}`) : [];
  });
  const beside = path.join(realRoot, path.posix.dirname(directory));
  return {
    packages: packages.sort().map((name) => [name, versionOf(realRoot, `${directory}/${name}`)]),
    lockfiles: LOCKFILES.flatMap((name) => {
      const file = path.join(beside, name);
      return existsSync(file) ? [[name, contentDigest(file)]] : [];
    }),
  };
}

/**
 * What the project has installed where its files could resolve packages: in the directories above
 * each of them.
 */
export function mapInstalledDigest(root: string, paths: readonly string[]): string {
  const realRoot = realpathSync.native(root);
  const directories = new Set(["."]);
  for (const file of paths) {
    let at = path.posix.dirname(file);
    while (at !== "." && !directories.has(at)) {
      directories.add(at);
      at = path.posix.dirname(at);
    }
  }
  const installed: [string, unknown][] = [];
  for (const directory of [...directories].sort()) {
    const modules = path.posix.join(directory, "node_modules");
    const real = mapInstalledPath(realRoot, modules);
    if (real) installed.push([modules, installedAt(realRoot, modules, real)]);
  }
  return digestValue(installed);
}

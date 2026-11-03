import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FileSystem } from "typescript/unstable/fs";
import { mapInNodeModules, mapInstalledPath } from "./project-map-installed";
import type { MapWorkerInput } from "./project-map-types";

export const MAP_WORKSPACE = "/layermap/";
export const mapVirtualPath = (relative: string) => `${MAP_WORKSPACE}${relative}`;
export const mapRelativePath = (absolute: string) =>
  absolute.startsWith(MAP_WORKSPACE) ? absolute.slice(MAP_WORKSPACE.length) : undefined;
// The compiler names files with forward slashes on every platform, so do the keys here: the
// library files' host paths are Windows paths on Windows.
export const mapForwardSlashes = (file: string) => file.replaceAll("\\", "/");

export class MapVirtualFiles {
  readonly required = new Set<string>();
  readonly readInputs = new Set<string>();
  readonly configurations = new Set<string>();
  private readonly files = new Map<string, string>();
  private readonly inventory = new Map<string, string>();
  private readonly directories = new Map<
    string,
    { files: Set<string>; directories: Set<string> }
  >();
  private readonly aliases = new Map<string, string>();
  private readonly hostPaths = new Map<string, string | undefined>();

  constructor(readonly input: MapWorkerInput) {
    for (const [relative, text] of Object.entries(input.files))
      this.files.set(mapVirtualPath(relative), text);
    for (const relative of input.inventory) this.inventory.set(mapVirtualPath(relative), relative);
    const libraryDirectory = path.dirname(input.compilerPath);
    for (const name of readdirSync(libraryDirectory)) {
      if (!/^lib(?:\.[a-z0-9_-]+)*\.d\.ts$/u.test(name)) continue;
      const text = readFileSync(path.join(libraryDirectory, name), "utf8");
      this.files.set(mapForwardSlashes(path.join(libraryDirectory, name)), text);
    }
    for (const file of new Set([...this.files.keys(), ...this.inventory.keys()]))
      this.addPath(file);
  }

  set(relative: string, text: string): void {
    this.files.set(mapVirtualPath(relative), text);
    this.addPath(mapVirtualPath(relative));
  }

  alias(relative: string, target: string): void {
    this.aliases.set(mapVirtualPath(relative), mapVirtualPath(target));
    this.addPath(mapVirtualPath(`${relative}/package.json`));
  }

  private canonical(file: string): string {
    file = mapForwardSlashes(file);
    for (const [alias, target] of this.aliases)
      if (file === alias || file.startsWith(`${alias}/`)) return target + file.slice(alias.length);
    return file;
  }

  private addPath(file: string): void {
    const ensure = (directory: string) => {
      let entry = this.directories.get(directory);
      if (!entry) {
        entry = { files: new Set<string>(), directories: new Set<string>() };
        this.directories.set(directory, entry);
      }
      return entry;
    };
    let child = file;
    for (;;) {
      const split = child.lastIndexOf("/");
      const parent = child.slice(0, split) || "/";
      const name = child.slice(split + 1);
      if (child === file) ensure(parent).files.add(name);
      else ensure(parent).directories.add(name);
      if (parent === "/") break;
      child = parent;
    }
  }

  private get realRoot(): string | undefined {
    const value =
      this.input.dependencies === undefined
        ? undefined
        : realpathSync.native(this.input.dependencies);
    Object.defineProperty(this, "realRoot", { value });
    return value;
  }

  // Where an installed package's file or directory really is. A link out of the project is a miss.
  private installed(file: string): string | undefined {
    const relative = mapRelativePath(file);
    const root = this.realRoot;
    if (relative === undefined || root === undefined || !mapInNodeModules(relative))
      return undefined;
    if (!this.hostPaths.has(relative))
      this.hostPaths.set(relative, mapInstalledPath(root, relative));
    return this.hostPaths.get(relative);
  }

  // Every miss is explicit. The compiler falls back to the host filesystem for the packages the
  // project has installed and for nothing else, and reads only what it needs to resolve types.
  readonly fs: FileSystem = {
    readFile: (file) => {
      file = this.canonical(file);
      const relative = this.inventory.get(file);
      if (this.files.has(file)) {
        if (relative !== undefined) this.readInputs.add(relative);
        return this.files.get(file) ?? null;
      }
      if (relative !== undefined) {
        this.required.add(relative);
        return "";
      }
      const host = this.installed(file);
      return host && statSync(host, { throwIfNoEntry: false })?.isFile()
        ? readFileSync(host, "utf8")
        : null;
    },
    fileExists: (file) => {
      file = this.canonical(file);
      if (this.files.has(file) || this.inventory.has(file)) return true;
      const host = this.installed(file);
      return host !== undefined && statSync(host, { throwIfNoEntry: false })?.isFile() === true;
    },
    directoryExists: (directory) => {
      directory = this.canonical(directory);
      if (this.directories.has(directory)) return true;
      const host = this.installed(directory);
      return (
        host !== undefined && statSync(host, { throwIfNoEntry: false })?.isDirectory() === true
      );
    },
    realpath: (file) => {
      file = this.canonical(file);
      const host = this.installed(file);
      const root = this.realRoot;
      if (!host || root === undefined) return file;
      // A package manager links packages from a store under node_modules, whose siblings are the
      // package's own dependencies. A link to elsewhere in the project stays where it was named.
      const real = mapForwardSlashes(path.relative(root, host));
      return mapInNodeModules(real) ? mapVirtualPath(real) : file;
    },
    getAccessibleEntries: (directory) => {
      directory = this.canonical(directory);
      const entry = this.directories.get(directory);
      const files = new Set(entry?.files);
      const directories = new Set(entry?.directories);
      const host = this.installed(directory);
      const stat = host ? statSync(host, { throwIfNoEntry: false }) : undefined;
      if (host && stat?.isDirectory())
        for (const name of readdirSync(host)) {
          const inner = this.installed(`${directory}/${name}`);
          const kind = inner ? statSync(inner, { throwIfNoEntry: false }) : undefined;
          if (kind?.isDirectory()) directories.add(name);
          else if (kind?.isFile()) files.add(name);
        }
      return { files: [...files], directories: [...directories] };
    },
  };
}

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FileSystem } from "typescript/unstable/fs";
import type { MapWorkerInput } from "./project-map-types";

export const MAP_WORKSPACE = "/layermap/";
export const mapVirtualPath = (relative: string) => `${MAP_WORKSPACE}${relative}`;
export const mapRelativePath = (absolute: string) =>
  absolute.startsWith(MAP_WORKSPACE) ? absolute.slice(MAP_WORKSPACE.length) : undefined;

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

  constructor(readonly input: MapWorkerInput) {
    for (const [relative, text] of Object.entries(input.files))
      this.files.set(mapVirtualPath(relative), text);
    for (const relative of input.inventory) this.inventory.set(mapVirtualPath(relative), relative);
    const libraryDirectory = path.dirname(input.compilerPath);
    for (const name of readdirSync(libraryDirectory)) {
      if (!/^lib(?:\.[a-z0-9_-]+)*\.d\.ts$/u.test(name)) continue;
      const text = readFileSync(path.join(libraryDirectory, name), "utf8");
      this.files.set(path.join(libraryDirectory, name), text);
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

  // Every miss is explicit. The compiler cannot fall back to the host filesystem.
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
      return null;
    },
    fileExists: (file) => {
      file = this.canonical(file);
      return this.files.has(file) || this.inventory.has(file);
    },
    directoryExists: (directory) => this.directories.has(this.canonical(directory)),
    realpath: (file) => this.canonical(file),
    getAccessibleEntries: (directory) => {
      const entry = this.directories.get(this.canonical(directory));
      return { files: [...(entry?.files ?? [])], directories: [...(entry?.directories ?? [])] };
    },
  };
}

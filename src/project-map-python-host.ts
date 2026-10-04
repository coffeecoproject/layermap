import * as nodeFs from "node:fs";
import {
  type ExecutionEnvironment,
  type ImportedModuleDescriptor,
  ImportResolver,
} from "pyright-internal/analyzer/importResolver";
import { Program } from "pyright-internal/analyzer/program";
import { ConfigOptions } from "pyright-internal/common/configOptions";
import { NullConsole } from "pyright-internal/common/console";
import { NoAccessHost } from "pyright-internal/common/host";
import { PythonVersion } from "pyright-internal/common/pythonVersion";
import { createServiceProvider } from "pyright-internal/common/serviceProviderExtensions";
import { Uri } from "pyright-internal/common/uri/uri";

// Pyright sees the admitted sources under /project and the bundled typeshed under /typeshed;
// nothing else exists for it. Sources come from the request, never from disk.
const PROJECT = "/project";
const TYPESHED = "/typeshed";
const detector = { isCaseSensitive: () => true };

const missing = (path: string): never => {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};
const readOnly = (): never => {
  throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
};
const entryStat = (file: boolean, size: number) =>
  ({
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
    size,
    mtimeMs: 0,
    mtime: new Date(0),
  }) as unknown as nodeFs.Stats;

class SourceFileSystem {
  private readonly directories = new Map<string, Map<string, boolean>>();

  constructor(
    private readonly files: ReadonlyMap<string, string>,
    private readonly typeshed: string,
  ) {
    const add = (directory: string, name: string, file: boolean) => {
      const entries = this.directories.get(directory) ?? new Map<string, boolean>();
      entries.set(name, file);
      this.directories.set(directory, entries);
    };
    for (const path of [...files.keys(), `${TYPESHED}/`]) {
      const parts = path.split("/").slice(1);
      for (let index = 0; index < parts.length; index++) {
        const name = parts[index];
        if (!name) continue;
        add(`/${parts.slice(0, index).join("/")}`, name, index === parts.length - 1);
      }
    }
  }

  // A path inside the mounted typeshed, as it lies on disk.
  private disk(path: string) {
    return path === TYPESHED || path.startsWith(`${TYPESHED}/`)
      ? this.typeshed + path.slice(TYPESHED.length)
      : undefined;
  }

  existsSync(uri: Uri) {
    const path = uri.getFilePath();
    const disk = this.disk(path);
    return disk ? nodeFs.existsSync(disk) : this.files.has(path) || this.directories.has(path);
  }
  chdir() {}
  readdirEntriesSync(uri: Uri) {
    const path = uri.getFilePath();
    const disk = this.disk(path);
    if (disk) return nodeFs.readdirSync(disk, { withFileTypes: true });
    return [...(this.directories.get(path) ?? missing(path))].map(([name, file]) => ({
      name,
      isFile: () => file,
      isDirectory: () => !file,
      isSymbolicLink: () => false,
    }));
  }
  readdirSync(uri: Uri) {
    return this.readdirEntriesSync(uri).map((entry) => entry.name);
  }
  readFileSync(uri: Uri, encoding?: BufferEncoding | null) {
    const path = uri.getFilePath();
    const disk = this.disk(path);
    const text = disk ? nodeFs.readFileSync(disk, "utf8") : (this.files.get(path) ?? missing(path));
    return encoding ? text : Buffer.from(text);
  }
  statSync(uri: Uri) {
    const path = uri.getFilePath();
    const disk = this.disk(path);
    if (disk) return nodeFs.statSync(disk);
    const text = this.files.get(path);
    if (text !== undefined) return entryStat(true, text.length);
    return this.directories.has(path) ? entryStat(false, 0) : missing(path);
  }
  realpathSync(uri: Uri) {
    return uri;
  }
  getModulePath() {
    return Uri.file(TYPESHED, detector);
  }
  realCasePath(uri: Uri) {
    return uri;
  }
  async readFile(uri: Uri) {
    return this.readFileSync(uri);
  }
  async readFileText(uri: Uri) {
    return this.readFileSync(uri, "utf8");
  }
  isMappedUri() {
    return false;
  }
  getOriginalUri(uri: Uri) {
    return uri;
  }
  getMappedUri(uri: Uri) {
    return uri;
  }
  isInZip() {
    return false;
  }
  mkdirSync = readOnly;
  writeFileSync = readOnly;
  unlinkSync = readOnly;
  rmdirSync = readOnly;
  createReadStream = readOnly;
  createWriteStream = readOnly;
  copyFileSync = readOnly;
  createFileSystemWatcher() {
    return { close() {} };
  }
  mapDirectory() {
    return { dispose() {} };
  }
}

/**
 * Python 3 has no implicit relative imports: a package directory (one holding __init__) is never
 * where an absolute import starts. When no import root resolves a name, Pyright tries each
 * directory above the importing file; with no packages installed, that would read `import stripe`
 * as a project package or module named stripe that sits beside some ancestor package.
 */
class SourceImportResolver extends ImportResolver {
  protected override resolveAbsoluteImport(
    sourceFileUri: Uri | undefined,
    rootPath: Uri,
    execEnv: ExecutionEnvironment,
    moduleDescriptor: ImportedModuleDescriptor,
    ...options: unknown[]
  ) {
    const configured =
      rootPath.equals(execEnv.root) || execEnv.extraPaths.some((path) => path.equals(rootPath));
    if (
      moduleDescriptor.leadingDots === 0 &&
      !configured &&
      ["__init__.py", "__init__.pyi"].some((name) =>
        this.fileExistsCached(rootPath.combinePaths(name)),
      )
    )
      return undefined;
    return super.resolveAbsoluteImport(
      sourceFileUri,
      rootPath,
      execEnv,
      moduleDescriptor,
      ...options,
    );
  }

  // Python searches the program's own import roots before its standard library, so a project
  // module named like a library one (queue, email, secrets) is the one imported, as Pyright's
  // checker does not assume. Modules built into the interpreter come first all the same.
  protected override _resolveBestAbsoluteImport(
    sourceFileUri: Uri,
    execEnv: ExecutionEnvironment,
    moduleDescriptor: ImportedModuleDescriptor,
    allowPyi: boolean,
  ) {
    const first = moduleDescriptor.nameParts[0];
    if (moduleDescriptor.leadingDots === 0 && first !== undefined && !BUILT_IN.has(first)) {
      const name = moduleDescriptor.nameParts.join(".");
      for (const root of [execEnv.root, ...execEnv.extraPaths]) {
        if (!root) continue;
        // Pyright's own lookup of a root: native modules allowed, stub packages used, no py.typed.
        const local = this.resolveAbsoluteImport(
          sourceFileUri,
          root,
          execEnv,
          moduleDescriptor,
          name,
          undefined,
          undefined,
          true,
          true,
          allowPyi,
          false,
        );
        if (local?.isImportFound && !local.isNamespacePackage) return local;
      }
    }
    return super._resolveBestAbsoluteImport(sourceFileUri, execEnv, moduleDescriptor, allowPyi);
  }
}

// Modules compiled into CPython (sys.builtin_module_names on Linux), which no file shadows.
const BUILT_IN = new Set([
  "_abc",
  "_ast",
  "_codecs",
  "_collections",
  "_functools",
  "_imp",
  "_io",
  "_locale",
  "_operator",
  "_signal",
  "_sre",
  "_stat",
  "_string",
  "_symtable",
  "_thread",
  "_tokenize",
  "_tracemalloc",
  "_typing",
  "_warnings",
  "_weakref",
  "atexit",
  "builtins",
  "errno",
  "faulthandler",
  "gc",
  "itertools",
  "marshal",
  "posix",
  "pwd",
  "sys",
  "time",
  "xxsubtype",
]);

export type PythonProgramInput = Readonly<{
  // Admitted sources by project-relative path.
  files: Readonly<Record<string, string>>;
  // Directory of the bundled typeshed (its stdlib/ holds the standard library stubs).
  typeshed: string;
  // Project-relative directory the context imports from ("" for the project root).
  root: string;
  pythonVersion: Readonly<{ major: number; minor: number }>;
}>;

export type PythonProgram = Readonly<{
  program: Program;
  // Tracked source files in path order.
  paths: readonly string[];
  uriOf(path: string): Uri;
  // The project-relative path of a tracked source, or undefined for anything else.
  pathOf(uri: Uri): string | undefined;
  dispose(): void;
}>;

/** A Pyright program over the admitted sources, the standard library stubs and nothing else. */
export function openPythonProgram(input: PythonProgramInput): PythonProgram {
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(input.files)) files.set(`${PROJECT}/${path}`, text);
  const fileSystem = new SourceFileSystem(files, input.typeshed);
  const services = createServiceProvider(fileSystem, new NullConsole(), detector);
  const root = input.root ? `${PROJECT}/${input.root}` : PROJECT;
  const config = new ConfigOptions(Uri.file(root, detector));
  config.defaultPythonVersion = PythonVersion.create(
    input.pythonVersion.major,
    input.pythonVersion.minor,
  );
  config.defaultPythonPlatform = "Linux";
  config.typeshedPath = Uri.file(TYPESHED, detector);
  // A src/ layout imports its packages from src.
  const source = `${input.root ? `${input.root}/` : ""}src/`;
  if (Object.keys(input.files).some((path) => path.startsWith(source)))
    config.defaultExtraPaths = [Uri.file(`${PROJECT}/${source.slice(0, -1)}`, detector)];
  const program = new Program(
    new SourceImportResolver(services, config, new NoAccessHost()),
    config,
    services,
    undefined,
    true,
  );
  const paths = Object.keys(input.files)
    .filter((path) => /\.pyi?$/u.test(path))
    .sort();
  const uris = new Map(paths.map((path) => [path, Uri.file(`${PROJECT}/${path}`, detector)]));
  program.setTrackedFiles([...uris.values()]);
  const tracked = new Map([...uris].map(([path, uri]) => [uri.key, path]));
  return {
    program,
    paths,
    uriOf: (path) => uris.get(path) ?? missing(path),
    pathOf: (uri) => tracked.get(uri.key),
    dispose() {
      program.dispose();
      services.dispose();
    },
  };
}

/** Whether a declaration lies in the bundled standard library stubs. */
export const pythonStandardLibrary = (uri: Uri) => uri.getFilePath().startsWith(`${TYPESHED}/`);

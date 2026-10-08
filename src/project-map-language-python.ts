import type { ZodType } from "zod";
import { ProjectEvidenceError } from "./core";
import { digestValue } from "./digest";
import { validateMapAnalysis } from "./project-map-analysis-validation";
import {
  MapFactsSchema,
  MapReferenceFactsSchema,
  mapFactsAnalysis,
  mapReferencesPage,
} from "./project-map-facts";
import type {
  MapAnalyzerObserver,
  MapLanguage,
  MapLanguageAnalyzer,
  MapLanguageSession,
} from "./project-map-language";
import {
  installedPythonMapResources,
  type MapParserResources,
  runMapOperation,
} from "./project-map-process";
import { PYTHON_STANDARD_LIBRARY } from "./project-map-python-stdlib";
import type { MapReferencePage, MapReferenceRequest } from "./project-map-reference-types";
import { type MapWorkerInput, mapTestPath } from "./project-map-types";

// Configuration that roots a Python context, most specific to Pyright first.
const CONFIGURATION = ["pyrightconfig.json", "pyproject.toml", "setup.cfg"];
const pythonConfig = /(?:^|\/)(?:pyrightconfig\.json|pyproject\.toml|setup\.cfg)$/u;
const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
// Projects that do not state a version are read as this one.
const DEFAULT_PYTHON = { major: 3, minor: 13 };

export const PYTHON_MAP_LANGUAGE: MapLanguage = Object.freeze({
  id: "pyright-1.1.414-map-v11",
  claims: (path: string) => /\.pyi?$/u.test(path),
  reads: (path: string) => pythonConfig.test(path),
  // An absolute import names the standard library or a distribution's top-level package.
  importName: (specifier: string) => {
    const top = specifier.split(".", 1)[0] ?? specifier;
    return PYTHON_STANDARD_LIBRARY.has(top) ? "Python standard library" : top;
  },
  create: () => new PythonMapAnalyzer(),
});

// What every Python map states about its own reach.
const PYTHON_GAPS = [
  "THIRD_PARTY_PACKAGES_NOT_LOADED",
  "STANDARD_LIBRARY_FROM_BUNDLED_STUBS",
  "UNTYPED_VALUES_LEAVE_CALLS_UNRESOLVED",
  "DYNAMIC_AND_FRAMEWORK_LINKS_REQUIRE_SOURCE_INVESTIGATION",
  "UNMODELED_LANGUAGE_CONSTRUCTS_REQUIRE_SOURCE_INVESTIGATION",
  "DETAILED_REFERENCES_AVAILABLE_ON_DEMAND",
];

type PythonInput = Omit<MapWorkerInput, "compilerPath">;

// The lowest Python version a project declares: pyrightconfig pythonVersion, then the lower bound
// of requires-python (pyproject.toml) or python_requires (setup.cfg).
function pythonVersion(files: Readonly<Record<string, string>>, configPath?: string) {
  const text = configPath ? (files[configPath] ?? "") : "";
  const declared = configPath?.endsWith("pyrightconfig.json")
    ? /"pythonVersion"\s*:\s*"3\.(\d+)/u.exec(text)
    : /^\s*(?:requires-python|python_requires)\s*=\s*["']?[^"'\n]*?(?:>=|~=|==)\s*3\.(\d+)/mu.exec(
        text,
      );
  const minor = declared ? Number(declared[1]) : Number.NaN;
  return Number.isSafeInteger(minor) ? { major: 3, minor } : DEFAULT_PYTHON;
}

/**
 * Python through Pyright, run in process by the Python map worker: its parser, binder and type
 * evaluator, with the standard library stubs it bundles and no third-party packages. One map
 * context per directory holding Python configuration; files outside any share an inferred one.
 */
export class PythonMapAnalyzer implements MapLanguageAnalyzer {
  readonly id = PYTHON_MAP_LANGUAGE.id;
  readonly claims = PYTHON_MAP_LANGUAGE.claims;
  readonly reads = PYTHON_MAP_LANGUAGE.reads;
  readonly importName = PYTHON_MAP_LANGUAGE.importName;

  constructor(private readonly resources: MapParserResources = installedPythonMapResources()) {}

  private async operation<T>(
    input: PythonInput & { operation: string; [key: string]: unknown },
    schema: ZodType<T>,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<T> {
    const start = performance.now();
    const event = {
      operation: input.operation,
      contextRef: input.contextRef,
      inputFiles: Object.keys(input.files).length,
    };
    observe?.({ ...event, phase: "STARTED" });
    try {
      return await runMapOperation(this.resources, input, schema, signal);
    } finally {
      observe?.({ ...event, phase: "FINISHED", elapsedMs: performance.now() - start });
    }
  }

  // The worker's request for a context: where it imports from and the Python it is read as.
  private request(input: PythonInput) {
    return {
      root: input.configPath ? directoryOf(input.configPath).replace(/\/$/u, "") : "",
      pythonVersion: pythonVersion(input.files, input.configPath),
      tests: Object.keys(input.files).filter((path) => this.claims(path) && mapTestPath(path)),
    };
  }

  async analyze(session: MapLanguageSession, signal: AbortSignal): Promise<void> {
    // The configuration file that roots each configured directory.
    const roots = new Map<string, string>();
    for (const path of session.readable
      .map((entry) => entry.path)
      .filter((path) => pythonConfig.test(path))) {
      const directory = directoryOf(path);
      const current = roots.get(directory);
      const rank = (file: string) => CONFIGURATION.indexOf(file.slice(directory.length));
      if (current === undefined || rank(path) < rank(current)) roots.set(directory, path);
    }
    // Each file belongs to the nearest configured directory.
    const rootOf = (path: string) => {
      let best: string | undefined;
      for (const directory of roots.keys())
        if (path.startsWith(directory) && (best === undefined || directory.length > best.length))
          best = directory;
      return best === undefined ? "" : (roots.get(best) as string);
    };
    const groups = new Map<string, string[]>();
    for (const entry of session.readable) {
      if (!this.claims(entry.path)) continue;
      const key = rootOf(entry.path);
      const into = groups.get(key);
      if (into) into.push(entry.path);
      else groups.set(key, [entry.path]);
    }
    for (const configPath of [...groups.keys()].sort()) {
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      const files: Record<string, string> = Object.create(null);
      for (const path of [...(groups.get(configPath) ?? []), ...(configPath ? [configPath] : [])]) {
        const text = session.texts[path];
        if (text === undefined)
          throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
        files[path] = text;
      }
      const input: PythonInput = {
        contextRef: digestValue({
          analyzer: this.id,
          configPath: configPath || null,
        }),
        ...(configPath ? { configPath } : {}),
        files,
        inventory: Object.keys(files).sort(),
        syntaxOnly: false,
      };
      const request = this.request(input);
      const reused = session.reuse(
        input.contextRef,
        { configPath: configPath || null, ...request },
        Object.keys(files),
      );
      if (reused) {
        session.accept(reused);
        continue;
      }
      const facts = await this.operation(
        { ...input, ...request, operation: "BUILD" },
        MapFactsSchema,
        signal,
        session.observe,
      );
      const analysis = mapFactsAnalysis(facts, input, {
        language: "python",
        offsets: "UTF16",
        ...(configPath ? { configPath } : {}),
        optionsDigest: digestValue({ pythonVersion: request.pythonVersion, platform: "linux" }),
        gaps: [
          ...(configPath ? [] : [{ code: "NO_PYTHON_CONFIGURATION" }]),
          ...PYTHON_GAPS.map((code) => ({ code })),
        ],
        typeIssues: "PYTHON_TYPE_CHECK_ISSUES",
        contract:
          "Declares a Python Protocol. This does not establish runtime enforcement or business authority.",
      });
      validateMapAnalysis(analysis, input);
      session.accept(analysis);
    }
  }

  async references(
    input: PythonInput,
    reference: MapReferenceRequest,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<MapReferencePage> {
    if (input.files[reference.targetPath] === undefined)
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", false);
    const files: Record<string, string> = Object.create(null);
    for (const [path, value] of Object.entries(input.files))
      if (this.claims(path) || pythonConfig.test(path)) files[path] = value;
    const facts = await this.operation(
      {
        ...input,
        files,
        ...this.request({ ...input, files }),
        operation: "REFERENCES",
        target: { path: reference.targetPath, offset: reference.symbolStart },
      },
      MapReferenceFactsSchema,
      signal,
      observe,
    );
    return mapReferencesPage(facts, files, reference, "UTF16");
  }
}

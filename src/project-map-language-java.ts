import { existsSync } from "node:fs";
import { type ZodType, z } from "zod";
import { ProjectEvidenceError } from "./core";
import { digestValue } from "./digest";
import { validateMapAnalysis } from "./project-map-analysis-validation";
import {
  type MapFacts,
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
  discoverJavaRuntime,
  installedJavaMapResources,
  type JavaMapResources,
  runMapOperation,
} from "./project-map-process";
import type { MapReferencePage, MapReferenceRequest } from "./project-map-reference-types";
import { type MapAnalysis, type MapWorkerInput, mapTestPath } from "./project-map-types";

// Build files, the ones that root a whole multi-module build first.
const BUILD_FILES = [
  "settings.gradle.kts",
  "settings.gradle",
  "build.gradle.kts",
  "build.gradle",
  "pom.xml",
];
const buildFile = /(?:^|\/)(?:pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/u;
const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
// Projects that do not state a Java version are read as this one.
const DEFAULT_RELEASE = 21;
// Packages of the Java platform (the JDK's own modules).
const platformPackage =
  /^(?:java|jdk|sun|com\.sun|javax\.(?:annotation\.processing|crypto|imageio|lang\.model|management|naming|net|print|script|security|sound|sql|swing|tools|transaction\.xa|xml))(?:\.|$)/u;

export const JAVA_MAP_LANGUAGE: MapLanguage = Object.freeze({
  id: "javac-lombok-1.18.48-map-v7",
  claims: (path: string) => path.endsWith(".java"),
  reads: (path: string) => buildFile.test(path),
  // A package of the Java platform, or a library named by its first two package segments.
  importName: (specifier: string) =>
    platformPackage.test(specifier)
      ? "Java standard library"
      : specifier.split(".").slice(0, 2).join("."),
  create: () => new JavaMapAnalyzer(),
});

// What every Java map states about its own reach.
const JAVA_GAPS = [
  "EXTERNAL_DEPENDENCIES_NOT_LOADED",
  "ANNOTATION_PROCESSORS_OTHER_THAN_LOMBOK_NOT_RUN",
  "GENERATED_SOURCES_NOT_PRESENT",
  "DYNAMIC_AND_FRAMEWORK_LINKS_REQUIRE_SOURCE_INVESTIGATION",
  "UNMODELED_LANGUAGE_CONSTRUCTS_REQUIRE_SOURCE_INVESTIGATION",
  "DETAILED_REFERENCES_AVAILABLE_ON_DEMAND",
];

type JavaInput = Omit<MapWorkerInput, "compilerPath">;

// What a build keeps for the next build of its context: what it depended on besides file texts,
// and the analyzer's own record of the types and files.
const JavaStateSchema = z
  .object({ basis: z.string(), java: z.record(z.string(), z.unknown()) })
  .strict();

const javaMapAnalysis = (
  facts: MapFacts,
  input: JavaInput,
  release: number,
  runtimeVersion: string | undefined,
  gaps: readonly string[],
): MapAnalysis =>
  mapFactsAnalysis(facts, input, {
    language: "java",
    offsets: "UTF16",
    ...(input.configPath ? { configPath: input.configPath } : {}),
    optionsDigest: digestValue({ release, runtime: runtimeVersion ?? null }),
    gaps: [
      ...(input.configPath ? [] : [{ code: "NO_JAVA_BUILD" }]),
      ...[...gaps, ...JAVA_GAPS].map((code) => ({ code })),
    ],
    typeIssues: "JAVA_TYPE_CHECK_ISSUES",
    contract:
      "Declares a Java interface. This does not establish runtime enforcement or business authority.",
  });

/** The Java version a build declares: a toolchain, source/target compatibility or release. */
export function javaRelease(texts: readonly string[], runtimeVersion?: string): number {
  const patterns = [
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/u,
    /\boptions\.release(?:\.set\(\s*|\s*=\s*)(\d+)/u,
    /\b(?:source|target)Compatibility\s*=\s*(?:JavaVersion\.VERSION_(?:1_)?(\d+)|['"]?(?:1\.)?(\d+))/u,
    /<maven\.compiler\.(?:release|source|target)>\s*(?:1\.)?(\d+)\s*</u,
    /<release>\s*(\d+)\s*<\/release>/u,
    /<java\.version>\s*(?:1\.)?(\d+)\s*</u,
  ];
  let declared: number | undefined;
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      const value = match ? Number(match[1] ?? match[2]) : Number.NaN;
      if (Number.isSafeInteger(value)) {
        declared = value;
        break;
      }
    }
    if (declared !== undefined) break;
  }
  // javac compiles for releases 8 up to its own version.
  const runtime = Number(runtimeVersion?.split(".", 1)[0]);
  const highest = Number.isSafeInteger(runtime) ? runtime : DEFAULT_RELEASE;
  return Math.min(Math.max(declared ?? DEFAULT_RELEASE, 8), highest);
}

/**
 * Java through javac on a Java runtime of 21 or later: its parser and attribution, with Lombok as
 * the annotation processor and no dependencies on the class path. A Gradle settings file or a
 * Maven pom listing modules makes the whole build one map context, so calls between modules link;
 * other files belong to their nearest build file, or share an inferred context.
 */
export class JavaMapAnalyzer implements MapLanguageAnalyzer {
  readonly id = JAVA_MAP_LANGUAGE.id;
  readonly claims = JAVA_MAP_LANGUAGE.claims;
  readonly reads = JAVA_MAP_LANGUAGE.reads;
  readonly importName = JAVA_MAP_LANGUAGE.importName;

  constructor(private resources: JavaMapResources = installedJavaMapResources()) {}

  // The runtime found at startup may be gone since (an upgraded JDK replaces its directory).
  private refreshRuntime() {
    const { runtimePath } = this.resources;
    if (runtimePath && !existsSync(runtimePath)) {
      const { runtimePath: _gone, runtimeVersion: _version, ...rest } = this.resources;
      this.resources = { ...rest, ...discoverJavaRuntime() };
    }
  }

  private async operation<T>(
    input: JavaInput & { operation: string; [key: string]: unknown },
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
      return await runMapOperation(
        this.resources,
        { ...input, runtimePath: this.resources.runtimePath },
        schema,
        signal,
      );
    } finally {
      observe?.({ ...event, phase: "FINISHED", elapsedMs: performance.now() - start });
    }
  }

  // The worker's request for a context: the Java sources, the release and which are tests.
  private request(input: JavaInput, buildTexts: readonly string[]) {
    const files: Record<string, string> = Object.create(null);
    for (const [path, text] of Object.entries(input.files))
      if (this.claims(path)) files[path] = text;
    return {
      files,
      release: javaRelease(buildTexts, this.resources.runtimeVersion),
      tests: Object.keys(files).filter((path) => mapTestPath(path)),
    };
  }

  // The build files of a context's root directory, which declare its Java version.
  private static buildTexts(texts: Readonly<Record<string, string>>, configPath?: string) {
    const directory = configPath ? directoryOf(configPath) : "";
    return BUILD_FILES.map((name) => texts[`${directory}${name}`]).filter(
      (text): text is string => text !== undefined,
    );
  }

  async analyze(session: MapLanguageSession, signal: AbortSignal): Promise<void> {
    this.refreshRuntime();
    const builds = session.readable
      .map((entry) => entry.path)
      .filter((path) => buildFile.test(path));
    // Every build file is configuration input, whether or not it roots a context.
    for (const path of builds) session.configuration(path);
    const rank = (path: string) => BUILD_FILES.indexOf(nameOf(path));
    // Directories whose build files root a whole build, and every directory with a build file.
    const roots = new Map<string, string>();
    const modules = new Map<string, string>();
    for (const path of builds) {
      const directory = directoryOf(path);
      const current = modules.get(directory);
      if (current === undefined || rank(path) < rank(current)) modules.set(directory, path);
      const text = session.texts[path] ?? "";
      if (
        /settings\.gradle(?:\.kts)?$/u.test(path) ||
        (path.endsWith("pom.xml") && /<modules>/u.test(text))
      ) {
        const root = roots.get(directory);
        if (root === undefined || rank(path) < rank(root)) roots.set(directory, path);
      }
    }
    // A file belongs to the outermost root containing it, else to its nearest module's build file.
    const configOf = (path: string) => {
      let outer: string | undefined;
      for (const directory of roots.keys())
        if (path.startsWith(directory) && (outer === undefined || directory.length < outer.length))
          outer = directory;
      if (outer !== undefined) return roots.get(outer) as string;
      let nearest: string | undefined;
      for (const directory of modules.keys())
        if (
          path.startsWith(directory) &&
          (nearest === undefined || directory.length > nearest.length)
        )
          nearest = directory;
      return nearest === undefined ? "" : (modules.get(nearest) as string);
    };
    // A module's build output (build/, target/) holds generated copies, not sources.
    const output = (path: string) =>
      [...modules.keys()].some(
        (directory) =>
          path.startsWith(`${directory}build/`) || path.startsWith(`${directory}target/`),
      );
    const groups = new Map<string, string[]>();
    for (const entry of session.readable) {
      if (!this.claims(entry.path) || output(entry.path)) continue;
      const key = configOf(entry.path);
      const into = groups.get(key);
      if (into) into.push(entry.path);
      else groups.set(key, [entry.path]);
    }
    const digests = new Map(session.entries.map((entry) => [entry.path, entry.contentDigest]));
    for (const configPath of [...groups.keys()].sort()) {
      if (signal.aborted) throw new ProjectEvidenceError("PROJECT_READ_CANCELLED", true);
      const files: Record<string, string> = Object.create(null);
      // The root's build files come along: they declare the Java version.
      const rootBuilds = configPath
        ? BUILD_FILES.map((name) => `${directoryOf(configPath)}${name}`).filter((path) =>
            builds.includes(path),
          )
        : [];
      for (const path of [...(groups.get(configPath) ?? []), ...rootBuilds]) {
        const text = session.texts[path];
        if (text === undefined)
          throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
        files[path] = text;
      }
      const input: JavaInput = {
        contextRef: digestValue({
          analyzer: this.id,
          configPath: configPath || null,
        }),
        ...(configPath ? { configPath } : {}),
        files,
        inventory: Object.keys(files).sort(),
        syntaxOnly: false,
      };
      const request = this.request(input, JavaMapAnalyzer.buildTexts(files, configPath));
      const runtime = this.resources.runtimePath ? (this.resources.runtimeVersion ?? null) : false;
      // Lombok reads its configuration files only from disk, which the analyzer never touches.
      const directory = directoryOf(configPath);
      const lombokConfig = session.entries.some(
        (entry) => entry.path.startsWith(directory) && nameOf(entry.path) === "lombok.config",
      );
      const reused = session.reuse(
        input.contextRef,
        {
          configPath: configPath || null,
          release: request.release,
          tests: request.tests,
          runtime,
          built: existsSync(this.resources.compilerPath),
          lombokConfig,
        },
        Object.keys(files),
      );
      if (reused) {
        session.accept(reused);
        continue;
      }
      // A test file's role follows from its path, so only these decide whether the previous
      // build's record of the context still holds.
      const basis = digestValue({
        configPath: configPath || null,
        release: request.release,
        runtime,
      });
      const previous = session.previous(input.contextRef);
      const prior = JavaStateSchema.safeParse(previous?.state).data;
      const incremental =
        previous && prior?.basis === basis
          ? {
              changed: Object.keys(request.files).filter(
                (path) => digests.get(path) !== previous.digests.get(path),
              ),
              state: prior.java,
            }
          : undefined;
      // Without a Java runtime the context is mapped without facts, and says why.
      const facts: MapFacts = this.resources.runtimePath
        ? await this.operation(
            { ...input, ...request, operation: "BUILD", ...(incremental ? { incremental } : {}) },
            MapFactsSchema,
            signal,
            session.observe,
          )
        : { files: [], objects: [], relations: [], notes: [], typeErrors: 0 };
      const analysis = javaMapAnalysis(
        facts,
        input,
        request.release,
        this.resources.runtimeVersion,
        [
          ...(this.resources.runtimePath
            ? []
            : [
                existsSync(this.resources.compilerPath)
                  ? "JAVA_RUNTIME_UNAVAILABLE"
                  : "JAVA_ANALYZER_NOT_BUILT",
              ]),
          ...(lombokConfig ? ["LOMBOK_CONFIG_NOT_APPLIED"] : []),
        ],
      );
      validateMapAnalysis(analysis, input);
      const state = facts.state && { basis, java: facts.state };
      if (!facts.focus) {
        session.accept(analysis, { state });
        continue;
      }
      // An incremental build: the facts of the files it did not analyze are the previous map's.
      const focus = new Set(facts.focus);
      // Every changed file must be among those analyzed again.
      if (
        !incremental ||
        facts.focus.some((path) => !Object.hasOwn(request.files, path)) ||
        incremental.changed.some((path) => !focus.has(path))
      )
        throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
      analysis.objects = analysis.objects.filter((object) => focus.has(object.anchor.path));
      analysis.relations = analysis.relations.filter((relation) => focus.has(relation.anchor.path));
      analysis.notes = analysis.notes.filter((note) => focus.has(note.anchor.path));
      session.accept(analysis, {
        state,
        linked: analysis.parsedFiles.filter((path) => !focus.has(path)),
      });
    }
  }

  async references(
    input: JavaInput,
    reference: MapReferenceRequest,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<MapReferencePage> {
    this.refreshRuntime();
    if (input.files[reference.targetPath] === undefined || !this.resources.runtimePath)
      throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", false);
    const request = this.request(input, JavaMapAnalyzer.buildTexts(input.files, input.configPath));
    const facts = await this.operation(
      {
        ...input,
        ...request,
        operation: "REFERENCES",
        target: { path: reference.targetPath, offset: reference.symbolStart },
      },
      MapReferenceFactsSchema,
      signal,
      observe,
    );
    return mapReferencesPage(facts, request.files, reference, "UTF16");
  }
}

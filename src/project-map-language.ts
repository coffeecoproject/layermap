import type { ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { GO_MAP_LANGUAGE } from "./project-map-language-go";
import { JAVA_MAP_LANGUAGE } from "./project-map-language-java";
import { PYTHON_MAP_LANGUAGE } from "./project-map-language-python";
import { TYPESCRIPT_MAP_LANGUAGE } from "./project-map-language-typescript";
import type { MapReferencePage, MapReferenceRequest } from "./project-map-reference-types";
import type { MapParserTiming } from "./project-map-timing";
import type { MapAnalysis, MapWorkerInput } from "./project-map-types";

export type MapAnalyzerEvent = Readonly<{
  operation: string;
  phase: "STARTED" | "FINISHED" | "STAGED" | "MEASURED";
  contextRef: string;
  inputFiles: number;
  elapsedMs?: number;
  objects?: number;
  relations?: number;
  timing?: MapParserTiming;
}>;
export type MapAnalyzerObserver = (event: MapAnalyzerEvent) => void;

/** One language's share of an analysis run. Accepted units are staged for the whole map. */
export type MapLanguageSession = Readonly<{
  /** Every admitted entry of the revision, analyzed or not. */
  entries: readonly ProjectEvidenceRevisionFileEntryV1[];
  /** The text entries this language claims or reads, in admission order. */
  readable: readonly ProjectEvidenceRevisionFileEntryV1[];
  texts: Readonly<Record<string, string>>;
  read(entry: ProjectEvidenceRevisionFileEntryV1): Promise<string>;
  /**
   * Stages a context's analysis. `state` is what the language keeps for the next build of the
   * context; `linked` lists files whose facts the analysis left out because the previous map's
   * stand: the new map lists that map's stored units for them.
   */
  accept(
    analysis: MapAnalysis,
    options?: Readonly<{ state?: unknown; linked?: readonly string[] }>,
  ): void;
  /**
   * The previous map's record of a context, for an analysis of only what changed: the state the
   * language kept for it and the content digests of the files that map was built from.
   */
  previous(
    contextRef: string,
  ): Readonly<{ state: unknown; digests: ReadonlyMap<string, string> }> | undefined;
  /**
   * Before a context is analyzed: the previous map's analysis of it when the request (everything
   * the analysis reads besides file texts) and the texts of the given files are the same, and so
   * are the texts of every file it and the contexts sharing its files read. The caller accepts
   * the returned analysis instead of analyzing; otherwise it analyzes and accepts the result.
   */
  reuse(contextRef: string, request: unknown, files: readonly string[]): MapAnalysis | undefined;
  /** Marks a readable file as configuration input rather than an unanalyzed file. */
  configuration(path: string): void;
  observe?: MapAnalyzerObserver;
}>;

export type MapLanguageClaim = Readonly<{
  /** Analyzer identity; changing what the analyzer produces changes the id. */
  id: string;
  /** Code files this language analyzes. */
  claims(path: string): boolean;
  /** Further files the language reads as configuration when it runs. */
  reads(path: string): boolean;
  /** The package an unresolved import specifier names, for dependency listings. */
  importName?(specifier: string): string;
  /** What an import of this file imports, when that is more than the file (such as a package). */
  importTarget?(path: string): string;
}>;

export interface MapLanguageAnalyzer extends MapLanguageClaim {
  analyze(session: MapLanguageSession, signal: AbortSignal): Promise<void>;
  references?(
    input: Omit<MapWorkerInput, "compilerPath">,
    reference: MapReferenceRequest,
    signal: AbortSignal,
    observe?: MapAnalyzerObserver,
  ): Promise<MapReferencePage>;
}

export type MapLanguage = MapLanguageClaim & Readonly<{ create(): MapLanguageAnalyzer }>;

/** The languages the product analyzes. */
export const MAP_LANGUAGES: readonly MapLanguage[] = Object.freeze([
  TYPESCRIPT_MAP_LANGUAGE,
  GO_MAP_LANGUAGE,
  PYTHON_MAP_LANGUAGE,
  JAVA_MAP_LANGUAGE,
]);

export const mapAnalyzerSuite = (languages: readonly Pick<MapLanguageClaim, "id">[]) =>
  languages
    .map((language) => language.id)
    .sort()
    .join("+");

/** Identity of the registered analyzer suite, recorded with every map version. */
export const PROJECT_MAP_ANALYZER = mapAnalyzerSuite(MAP_LANGUAGES);

export const mapCodePath = (path: string) =>
  MAP_LANGUAGES.some((language) => language.claims(path));

const languageOf = (path: string) => MAP_LANGUAGES.find((language) => language.claims(path));

/** The id of the language that claims a path, if any. */
export const mapLanguageOf = (path: string) => languageOf(path)?.id;

// Package names as npm uses them: a scope and name, or the first path segment.
const npmPackage = (specifier: string) => {
  if (specifier.startsWith("node:")) return "node:*";
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

/** The external package an import names, by the conventions of the importing file's language. */
export const mapExternalImport = (sourcePath: string, specifier: string) =>
  languageOf(sourcePath)?.importName?.(specifier) ?? npmPackage(specifier);

/** How an import that resolved to a file is shown: the file, or its package. */
export const mapImportTarget = (path: string) => languageOf(path)?.importTarget?.(path) ?? path;

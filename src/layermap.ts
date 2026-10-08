import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { CodeIndex } from "./code-index";
import {
  CODE_INDEX_CONTEXT_RESULTS_MIGRATION,
  CODE_INDEX_SCHEMA,
  CODE_INDEX_SHARED_NAVIGATION_MIGRATION,
  CODE_INDEX_UNITS_MIGRATION,
  CodeIndexStore,
} from "./code-index-store";
import type { CodeIndexSource, CodeIndexVersion } from "./code-index-types";
import { ProjectEvidenceError } from "./core";
import { ProjectMapAnalyzer } from "./project-map-analyzer";
import {
  mapChangeImpact,
  mapChangesText,
  readMapChanges,
  resolveMapBase,
} from "./project-map-changes";
import { GoMapAnalyzer } from "./project-map-language-go";
import { JavaMapAnalyzer } from "./project-map-language-java";
import { PythonMapAnalyzer } from "./project-map-language-python";
import { TypeScriptMapAnalyzer } from "./project-map-language-typescript";
import { mapReferenceNavigation } from "./project-map-navigation";
import type { JavaMapResources, MapParserResources } from "./project-map-process";
import type { MapQueryOutputBudget } from "./project-map-query-page";
import type { MapReferenceInput } from "./project-map-reference-types";
import type { MapSearchViewPage } from "./project-map-search-view";
import type { MapSearchInput } from "./project-map-types";
import type { MapViewInput, MapViewPage } from "./project-map-view";
import { DEFAULT_INITIAL_EVIDENCE_SCOPE } from "./source-scope";

/** Built analyzer workers and compilers, as the package build writes them. */
export type LayerMapAnalyzers = Readonly<{
  typescript: MapParserResources;
  go: MapParserResources;
  python: MapParserResources;
  java: JavaMapResources;
}>;

// 1: the map schema. 2: free pages are returned to the file system after old versions go.
const SCHEMA_VERSION = 2;
/** Versions kept per project: the current one and recent ones a rebuild can replay from. */
const KEEP_VERSIONS = 3;

/**
 * Opens a map database owned by LayerMap alone, with the SQLite LayerMap ships (Node's own may lack
 * FTS5). A new file gets the whole schema at once; the same statements, applied one by one, are the
 * migrations of a host that embeds the store.
 */
export function openMapDatabase(file: string): DatabaseSyncInstance {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 30000;");
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new ProjectEvidenceError("LAYERMAP_DATABASE_NEWER", false);
    // Only an empty file takes a vacuum mode without being rewritten, before WAL writes its header.
    if (version === 0) database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    database.exec("PRAGMA journal_mode = WAL;");
    if (version === 0) {
      // The units migration rebuilds tables that others reference; keys are checked after.
      database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
      try {
        for (const sql of [
          CODE_INDEX_SCHEMA,
          CODE_INDEX_UNITS_MIGRATION,
          CODE_INDEX_CONTEXT_RESULTS_MIGRATION,
          CODE_INDEX_SHARED_NAVIGATION_MIGRATION,
        ])
          database.exec(sql);
        if (database.prepare("PRAGMA foreign_key_check").get())
          throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } else if (version === 1) {
      database.exec(
        `PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA user_version = ${SCHEMA_VERSION};`,
      );
    }
    database.exec("PRAGMA foreign_keys = ON;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Where a project's map lives: one database per canonical project directory. */
export const mapDatabasePath = (cacheDirectory: string, canonicalProject: string) =>
  path.join(
    cacheDirectory,
    "projects",
    createHash("sha256").update(canonicalProject).digest("hex").slice(0, 24),
    "map.sqlite",
  );

export type LayerMapOptions = Readonly<{
  project: string;
  cacheDirectory: string;
  analyzers: LayerMapAnalyzers;
  /** Largest view or result page, in bytes of its JSON form. */
  maxOutputBytes?: number;
}>;

/**
 * The map of one project directory. Every query first captures the directory as it is now; an
 * unchanged directory reuses its map, and a changed one replays the contexts whose inputs did not
 * change and analyzes the rest.
 */
export class LayerMap {
  private refreshing: Promise<string> | undefined;

  private constructor(
    readonly project: string,
    private readonly source: CodeIndexSource,
    private readonly store: CodeIndexStore,
    private readonly index: CodeIndex,
    private readonly budget: MapQueryOutputBudget,
  ) {}

  static async open(options: LayerMapOptions): Promise<LayerMap> {
    const project = await realpath(options.project);
    const stat = await lstat(project, { bigint: true });
    if (!stat.isDirectory()) throw new ProjectEvidenceError("PROJECT_PATH_INVALID", false);
    const source: CodeIndexSource = {
      kind: "WORKTREE",
      projectRef: `layermap:${createHash("sha256").update(project).digest("hex").slice(0, 24)}`,
      directory: { canonicalPath: project, device: String(stat.dev), inode: String(stat.ino) },
    };
    // LayerMap's SQLite implements node:sqlite's API; the two declare a few members the store does
    // not use (expandedSQL, serialize) differently.
    const store = new CodeIndexStore(
      openMapDatabase(
        mapDatabasePath(options.cacheDirectory, project),
      ) as unknown as CodeIndexStore["database"],
    );
    const { typescript, go, python, java } = options.analyzers;
    const index = new CodeIndex(
      store,
      undefined,
      new ProjectMapAnalyzer([
        new TypeScriptMapAnalyzer(typescript),
        new GoMapAnalyzer(go),
        new PythonMapAnalyzer(python),
        new JavaMapAnalyzer(java),
      ]),
    );
    return new LayerMap(project, source, store, index, {
      maxBytes: options.maxOutputBytes ?? 96 * 1024,
      envelopeBytes: 0,
    });
  }

  /** The map version of the directory as it is now, built or updated if needed. */
  refresh(signal: AbortSignal): Promise<string> {
    return this.serialized(async () => {
      const version = await this.index.prepare(this.source, signal, {
        initialScope: DEFAULT_INITIAL_EVIDENCE_SCOPE,
      });
      this.prune(version);
      return version.version;
    });
  }

  /** The map version of a commit of the directory; files it shares with other versions are reused. */
  private versionAt(commit: string, signal: AbortSignal): Promise<string> {
    return this.serialized(async () => {
      const version = await this.index.prepare({ ...this.source, kind: "COMMIT", commit }, signal, {
        initialScope: DEFAULT_INITIAL_EVIDENCE_SCOPE,
      });
      return version.version;
    });
  }

  // One capture at a time; a query waiting behind one captures again, since files may change.
  private serialized(capture: () => Promise<string>): Promise<string> {
    const next = (this.refreshing ?? Promise.resolve("")).catch(() => "").then(capture);
    this.refreshing = next;
    return next;
  }

  /** Drops versions beyond the most recent few; their files, facts and unshared units go too. */
  private prune(version: CodeIndexVersion) {
    const count = Number(
      this.store.database.prepare("SELECT count(*) AS count FROM project_code_versions").get()
        ?.count,
    );
    if (count <= KEEP_VERSIONS) return;
    this.store.collectGarbage([
      version.version,
      ...this.store.mapParentCandidates(version, KEEP_VERSIONS - 1),
    ]);
    this.store.database.exec("PRAGMA incremental_vacuum;");
  }

  async explore(
    input: Omit<MapViewInput, "version" | "allowedPathPrefixes" | "outputBudget">,
    signal: AbortSignal,
  ): Promise<MapViewPage> {
    const version = await this.refresh(signal);
    return this.index.query.viewMap(
      { ...input, version, allowedPathPrefixes: ["."], outputBudget: this.budget },
      signal,
    );
  }

  async search(
    input: Omit<MapSearchInput, "version" | "allowedPathPrefixes" | "outputBudget">,
    signal: AbortSignal,
  ): Promise<MapSearchViewPage> {
    const version = await this.refresh(signal);
    return this.index.query.searchMapView(
      { ...input, version, allowedPathPrefixes: ["."], outputBudget: this.budget },
      signal,
    );
  }

  async references(
    input: Omit<MapReferenceInput, "version" | "source" | "allowedPathPrefixes" | "outputBudget">,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof mapReferenceNavigation>> {
    const version = await this.refresh(signal);
    return mapReferenceNavigation(
      await this.index.findReferences(
        {
          ...input,
          version,
          source: this.source,
          allowedPathPrefixes: ["."],
          outputBudget: this.budget,
        },
        signal,
      ),
    );
  }

  /**
   * What the working tree's changes against a commit (HEAD by default) affect: the changed and
   * removed declarations, the entry points and tests their callers reach, and what the map cannot
   * see. The base commit's map is built only when the diff removes or changes lines there.
   */
  async checkChanges(input: { base?: string }, signal: AbortSignal): Promise<{ text: string }> {
    const changes = await readMapChanges(this.project, input.base ?? "HEAD", signal);
    const working = await this.refresh(signal);
    // The base map tells what the diff removed, and which existing tests it changed.
    const base = changes.files.some(
      (file) =>
        file.basePath !== undefined && (file.baseLines.length || file.baseText !== undefined),
    )
      ? await this.versionAt(changes.commit, signal)
      : undefined;
    return {
      text: mapChangesText(
        changes,
        mapChangeImpact(this.store, working, base, changes, this.project),
      ),
    };
  }

  /**
   * Builds the map of a base commit (HEAD by default) ahead of a change check, so the check after an
   * edit does not wait for it. A clean working tree's base shares every file with its map.
   */
  async prepareBase(signal: AbortSignal, base = "HEAD"): Promise<void> {
    await this.versionAt(await resolveMapBase(this.project, base, signal), signal);
  }

  async close(): Promise<void> {
    await this.index.quiesce();
    this.index.close();
    this.store.database.close();
  }
}

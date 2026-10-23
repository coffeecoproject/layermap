import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
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
import { digestValue } from "./digest";
import { ProjectMapAnalyzer } from "./project-map-analyzer";
import { checkMapChanges, resolveMapBase } from "./project-map-changes";
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
import { DEFAULT_INITIAL_EVIDENCE_SCOPE, SOURCE_POLICY } from "./source-scope";

/** Built analyzer workers and compilers, as the package build writes them. */
export type LayerMapAnalyzers = Readonly<{
  typescript: MapParserResources;
  go: MapParserResources;
  python: MapParserResources;
  java: JavaMapResources;
}>;

// 1: the map schema. 2: free pages are returned to the file system after old versions go. 3: the
// versions each process is reading, and the version each commit was captured as.
const SCHEMA_VERSION = 3;
/** Versions kept per project: the current one and recent ones a rebuild can replay from. */
const KEEP_VERSIONS = 3;
/** Versions of commits kept as well: the bases the next change checks compare with. */
const KEEP_COMMIT_VERSIONS = 2;
/**
 * How long a process's hold on a version lasts unless renewed: a process renews its holds while it
 * reads them and releases them after, so only one that stopped meanwhile leaves them to expire.
 */
const HOLD_EXPIRY_MS = 10 * 60 * 1000;
/** How long a map waits for another process that holds it. */
const BUSY_TIMEOUT = "PRAGMA busy_timeout = 30000;";
/** The write-ahead log a map leaves after a capture before it is emptied. */
const JOURNAL_LIMIT = 32 * 1024 * 1024;
/** Captures of a directory whose files keep changing while they are read, before giving up. */
const CAPTURE_ATTEMPTS = 3;
// What a capture meets when files change while it reads or analyzes them, or when another
// process's cleanup removed the version it found before it held it.
const CAPTURE_AGAIN = new Set([
  "PROJECT_FILE_CHANGED",
  "PROJECT_FILE_UNIVERSE_CHANGED",
  "PROJECT_MAP_SOURCE_CHANGED",
  "PROJECT_READ_SOURCE_CHANGED",
  "PROJECT_EVIDENCE_REVISION_NOT_FOUND",
]);

// LayerMap's own records beside the store's: the versions each process is reading, which no
// process's cleanup removes, and the version a commit was captured as, which stays its version
// while the capture policy and analyzers stay the same, with when it was last compared with.
const LAYERMAP_TABLES = `
CREATE TABLE layermap_version_holds (
  version_ref TEXT NOT NULL REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  held_at INTEGER NOT NULL,
  PRIMARY KEY (version_ref, holder)
);
CREATE TABLE layermap_commit_versions (
  capture_key TEXT PRIMARY KEY,
  version_ref TEXT NOT NULL REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  used_at INTEGER NOT NULL
);
CREATE INDEX layermap_commit_version ON layermap_commit_versions(version_ref);
`;

const schemaVersion = (database: DatabaseSyncInstance) =>
  Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);

/**
 * Opens a map database owned by LayerMap alone, with the SQLite LayerMap ships (Node's own may lack
 * FTS5). A new file gets the whole schema at once; the same statements, applied one by one, are the
 * migrations of a host that embeds the store. Processes may open a new map at once: the schema is
 * read again under the write lock, and only the first to take it applies what is missing.
 */
export function openMapDatabase(file: string): DatabaseSyncInstance {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  try {
    database.exec(BUSY_TIMEOUT);
    const version = schemaVersion(database);
    if (version > SCHEMA_VERSION) throw new ProjectEvidenceError("LAYERMAP_DATABASE_NEWER", false);
    // Only an empty file takes a vacuum mode without being rewritten, before WAL writes its header.
    if (version === 0) database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    else if (version === 1) database.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
    database.exec("PRAGMA journal_mode = WAL;");
    if (version < SCHEMA_VERSION) {
      // The units migration rebuilds tables that others reference; keys are checked after.
      database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
      try {
        const current = schemaVersion(database);
        if (current === 0)
          for (const sql of [
            CODE_INDEX_SCHEMA,
            CODE_INDEX_UNITS_MIGRATION,
            CODE_INDEX_CONTEXT_RESULTS_MIGRATION,
            CODE_INDEX_SHARED_NAVIGATION_MIGRATION,
          ])
            database.exec(sql);
        if (current < 3) database.exec(LAYERMAP_TABLES);
        if (database.prepare("PRAGMA foreign_key_check").get())
          throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
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
  // The versions this process's operations are reading, with how many hold each, and the timer
  // that renews their holds while any does.
  private readonly held = new Map<string, number>();
  private readonly holder = randomUUID();
  private renewal: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    readonly project: string,
    private readonly source: CodeIndexSource,
    private readonly store: CodeIndexStore,
    private readonly index: CodeIndex,
    private readonly analyzer: string,
    private readonly budget: MapQueryOutputBudget,
    private readonly journal: string,
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
    const file = mapDatabasePath(options.cacheDirectory, project);
    const store = new CodeIndexStore(
      openMapDatabase(file) as unknown as CodeIndexStore["database"],
    );
    const { typescript, go, python, java } = options.analyzers;
    const analyzer = new ProjectMapAnalyzer([
      new TypeScriptMapAnalyzer(typescript),
      new GoMapAnalyzer(go),
      new PythonMapAnalyzer(python),
      new JavaMapAnalyzer(java),
    ]);
    return new LayerMap(
      project,
      source,
      store,
      new CodeIndex(store, undefined, analyzer),
      analyzer.id,
      { maxBytes: options.maxOutputBytes ?? 96 * 1024, envelopeBytes: 0 },
      `${file}-wal`,
    );
  }

  /** The map version of the directory as it is now, built or updated if needed. */
  refresh(signal: AbortSignal): Promise<string> {
    return this.using((hold) => this.current(signal, hold));
  }

  private current(signal: AbortSignal, hold: Hold): Promise<string> {
    return this.serialized(async () => {
      const version = await this.prepare(this.source, signal, hold);
      this.prune(version);
      this.tidyJournal();
      return version.version;
    });
  }

  /**
   * The map version of a commit of the directory: the one it was captured as before, or a new
   * capture, whose files shared with other versions are reused.
   */
  private versionAt(commit: string, signal: AbortSignal, hold: Hold): Promise<string> {
    return this.serialized(async () => {
      const key = digestValue({
        projectRef: this.source.projectRef,
        commit,
        scope: DEFAULT_INITIAL_EVIDENCE_SCOPE,
        analyzer: this.analyzer,
        policy: SOURCE_POLICY,
      });
      const known = this.store.database
        .prepare("SELECT version_ref FROM layermap_commit_versions WHERE capture_key = ?")
        .get(key)?.version_ref;
      const version =
        typeof known === "string" && hold(known)
          ? known
          : (await this.prepare({ ...this.source, kind: "COMMIT", commit }, signal, hold)).version;
      await this.index.ensureIndex(version, signal);
      this.store.database
        .prepare("INSERT OR REPLACE INTO layermap_commit_versions VALUES (?, ?, ?)")
        .run(key, version, Date.now());
      return version;
    });
  }

  // A file that changes while it is captured or analyzed makes the capture describe no state of
  // the directory; the directory is captured again.
  private async prepare(
    source: CodeIndexSource,
    signal: AbortSignal,
    hold: Hold,
  ): Promise<CodeIndexVersion> {
    for (let attempt = 1; ; attempt++) {
      try {
        const version = await this.index.captureVersion(source, signal, {
          initialScope: DEFAULT_INITIAL_EVIDENCE_SCOPE,
        });
        // Held before its index is built, which another process's cleanup does not wait for.
        if (!hold(version.version))
          throw new ProjectEvidenceError("PROJECT_EVIDENCE_REVISION_NOT_FOUND", true);
        await this.index.ensureIndex(version.version, signal);
        return version;
      } catch (error) {
        if (
          attempt === CAPTURE_ATTEMPTS ||
          signal.aborted ||
          !(error instanceof ProjectEvidenceError && CAPTURE_AGAIN.has(error.code))
        )
          throw error;
      }
    }
  }

  // One capture at a time; a query waiting behind one captures again, since files may change.
  private serialized(capture: () => Promise<string>): Promise<string> {
    const next = (this.refreshing ?? Promise.resolve("")).catch(() => "").then(capture);
    this.refreshing = next;
    return next;
  }

  // An operation holds the versions it reads until it ends, so that no process's cleanup removes
  // one while it reads it.
  private async using<T>(operation: (hold: Hold) => Promise<T>): Promise<T> {
    const taken: string[] = [];
    const hold: Hold = (version) => {
      if (!this.held.has(version) && !this.renew([version])) return false;
      taken.push(version);
      this.held.set(version, (this.held.get(version) ?? 0) + 1);
      this.renewal ??= setInterval(() => {
        try {
          this.renew([...this.held.keys()]);
        } catch {
          // Busy: the next renewal comes well before the holds expire.
        }
      }, HOLD_EXPIRY_MS / 5).unref();
      return true;
    };
    try {
      return await operation(hold);
    } finally {
      const released: string[] = [];
      for (const version of taken) {
        const count = (this.held.get(version) ?? 1) - 1;
        if (count > 0) this.held.set(version, count);
        else if (this.held.delete(version)) released.push(version);
      }
      if (this.held.size === 0) {
        clearInterval(this.renewal);
        this.renewal = undefined;
      }
      // Closing released them all.
      if (!this.closed)
        this.store.database
          .prepare(`DELETE FROM layermap_version_holds
          WHERE holder = ? AND version_ref IN (SELECT value FROM json_each(?))`)
          .run(this.holder, JSON.stringify(released));
    }
  }

  // Holds versions as of now; false when one is gone, as another process's cleanup removed it.
  private renew(versions: readonly string[]): boolean {
    const database = this.store.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const exists = database.prepare("SELECT 1 FROM project_code_versions WHERE version_ref = ?");
      const holds = database.prepare(`INSERT INTO layermap_version_holds VALUES (?, ?, ?)
        ON CONFLICT DO UPDATE SET held_at = excluded.held_at`);
      const now = Date.now();
      let all = true;
      for (const version of versions) {
        if (exists.get(version)) holds.run(version, this.holder, now);
        else all = false;
      }
      database.exec("COMMIT");
      return all;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Drops versions beyond the most recent few and the last bases compared with, unless a process
   * holds one; their files, facts and unshared units go too. What to keep is read in the
   * transaction that deletes, so a version another process holds is either kept or found gone by it.
   */
  private prune(version: CodeIndexVersion) {
    const database = this.store.database;
    const count = Number(
      database.prepare("SELECT count(*) AS count FROM project_code_versions").get()?.count,
    );
    if (count <= KEEP_VERSIONS) return;
    const refs = (rows: readonly Record<string, unknown>[]) =>
      rows.map((row) => String(row.version_ref));
    const removed = this.store.collectGarbage(() => [
      version.version,
      ...this.store.mapParentCandidates(version, KEEP_VERSIONS - 1),
      ...refs(
        database
          .prepare("SELECT version_ref FROM layermap_commit_versions ORDER BY used_at DESC LIMIT ?")
          .all(KEEP_COMMIT_VERSIONS),
      ),
      ...refs(
        database
          .prepare("SELECT version_ref FROM layermap_version_holds WHERE held_at > ?")
          .all(Date.now() - HOLD_EXPIRY_MS),
      ),
    ]);
    if (removed) database.exec("PRAGMA incremental_vacuum;");
  }

  // SQLite leaves the write-ahead log at the size of the largest capture written through it, often
  // hundreds of megabytes after a build. Once that capture is in the database the log is emptied,
  // unless another process is reading or writing the map, in which case a later capture empties it.
  private tidyJournal() {
    if ((statSync(this.journal, { throwIfNoEntry: false })?.size ?? 0) <= JOURNAL_LIMIT) return;
    const database = this.store.database;
    // Without waiting: while another process holds the map, the checkpoint reports it busy.
    database.exec("PRAGMA busy_timeout = 0;");
    try {
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      database.exec(BUSY_TIMEOUT);
    }
  }

  explore(
    input: Omit<MapViewInput, "version" | "allowedPathPrefixes" | "outputBudget">,
    signal: AbortSignal,
  ): Promise<MapViewPage> {
    return this.using(async (hold) =>
      this.index.query.viewMap(
        {
          ...input,
          version: await this.current(signal, hold),
          allowedPathPrefixes: ["."],
          outputBudget: this.budget,
        },
        signal,
      ),
    );
  }

  search(
    input: Omit<MapSearchInput, "version" | "allowedPathPrefixes" | "outputBudget">,
    signal: AbortSignal,
  ): Promise<MapSearchViewPage> {
    return this.using(async (hold) =>
      this.index.query.searchMapView(
        {
          ...input,
          version: await this.current(signal, hold),
          allowedPathPrefixes: ["."],
          outputBudget: this.budget,
        },
        signal,
      ),
    );
  }

  references(
    input: Omit<MapReferenceInput, "version" | "source" | "allowedPathPrefixes" | "outputBudget">,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof mapReferenceNavigation>> {
    return this.using(async (hold) =>
      mapReferenceNavigation(
        await this.index.findReferences(
          {
            ...input,
            version: await this.current(signal, hold),
            source: this.source,
            allowedPathPrefixes: ["."],
            outputBudget: this.budget,
          },
          signal,
        ),
      ),
    );
  }

  /**
   * What the working tree's changes against a commit (HEAD by default) affect: the changed and
   * removed declarations, the entry points and tests their callers reach, and what the map cannot
   * see; with test files, by path from the repository root, also the changed code they do not run.
   * The base commit's map is built only when the diff removes or changes lines there.
   */
  checkChanges(
    input: { base?: string; tests?: readonly string[] },
    signal: AbortSignal,
  ): Promise<{ text: string }> {
    return this.using(async (hold) =>
      checkMapChanges(
        {
          index: this.index,
          project: this.project,
          working: await this.current(signal, hold),
          base: input.base ?? "HEAD",
          baseVersion: (commit, baseSignal) => this.versionAt(commit, baseSignal, hold),
          ...(input.tests ? { tests: input.tests } : {}),
        },
        signal,
      ),
    );
  }

  /**
   * Builds the map of a base commit (HEAD by default) ahead of a change check, so the check after an
   * edit does not wait for it. A clean working tree's base shares every file with its map.
   */
  prepareBase(signal: AbortSignal, base = "HEAD"): Promise<void> {
    return this.using(async (hold) => {
      await this.versionAt(await resolveMapBase(this.project, base, signal), signal, hold);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.renewal);
    await this.index.quiesce();
    this.index.close();
    this.store.database
      .prepare("DELETE FROM layermap_version_holds WHERE holder = ?")
      .run(this.holder);
    this.closed = true;
    this.store.database.close();
  }
}

/** Holds a version for the operation reading it; false when the version is gone. */
type Hold = (version: string) => boolean;

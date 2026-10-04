import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CodeIndexVersion } from "./code-index-types";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { canonicalJson, digestValue } from "./digest";
import {
  type MapAnalysis,
  MapAnalysisSchema,
  type MapBuildCoverage,
  type MapContext,
  MapContextSchema,
} from "./project-map-types";

export const CODE_INDEX_SCHEMA = `
CREATE TABLE project_code_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL);
CREATE TABLE project_code_versions (
  version_ref TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  text_file_count INTEGER NOT NULL CHECK (text_file_count >= 0),
  captured_bytes INTEGER NOT NULL CHECK (captured_bytes >= 0),
  analyzer TEXT NOT NULL,
  analysis_digest TEXT NOT NULL
);
CREATE TABLE project_code_files (
  version_ref TEXT NOT NULL REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  path TEXT NOT NULL,
  entry_state TEXT NOT NULL CHECK (entry_state IN (
    'TEXT', 'TYPE_RESTRICTED', 'TOO_LARGE', 'NON_TEXT', 'NOT_READABLE', 'SYMLINK', 'UNSUPPORTED_ENTRY'
  )),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_digest TEXT,
  PRIMARY KEY (version_ref, path),
  CHECK (entry_state <> 'TEXT' OR content_digest IS NOT NULL)
);
CREATE TABLE project_code_index_state (
  version_ref TEXT PRIMARY KEY REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  completed_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE project_map_navigation_fts USING fts5(
  version_ref UNINDEXED, path UNINDEXED, content, tokenize = 'trigram'
);
CREATE INDEX project_code_files_state ON project_code_files(version_ref, entry_state, path);
CREATE INDEX project_code_files_content ON project_code_files(content_digest);
CREATE TABLE project_map_contexts (
  version_ref TEXT NOT NULL REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  context_ref TEXT NOT NULL, context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  PRIMARY KEY (version_ref, context_ref)
);
CREATE TABLE project_map_objects (
  version_ref TEXT NOT NULL, entity_ref TEXT NOT NULL, context_ref TEXT NOT NULL,
  path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  object_json TEXT NOT NULL CHECK (json_valid(object_json)),
  PRIMARY KEY (version_ref, entity_ref),
  FOREIGN KEY (version_ref, path) REFERENCES project_code_files(version_ref, path) ON DELETE CASCADE,
  FOREIGN KEY (version_ref, context_ref) REFERENCES project_map_contexts(version_ref, context_ref) ON DELETE CASCADE
);
CREATE TABLE project_map_relations (
  version_ref TEXT NOT NULL, relation_ref TEXT NOT NULL, from_ref TEXT NOT NULL,
  to_ref TEXT, path TEXT NOT NULL, relation_json TEXT NOT NULL CHECK (json_valid(relation_json)),
  PRIMARY KEY (version_ref, relation_ref),
  FOREIGN KEY (version_ref, from_ref) REFERENCES project_map_objects(version_ref, entity_ref) ON DELETE CASCADE,
  FOREIGN KEY (version_ref, to_ref) REFERENCES project_map_objects(version_ref, entity_ref) ON DELETE CASCADE
);
CREATE TABLE project_map_notes (
  version_ref TEXT NOT NULL, entity_ref TEXT NOT NULL, note_json TEXT NOT NULL CHECK (json_valid(note_json)),
  FOREIGN KEY (version_ref, entity_ref) REFERENCES project_map_objects(version_ref, entity_ref) ON DELETE CASCADE
);
CREATE TABLE project_map_coverage (
  version_ref TEXT PRIMARY KEY REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json))
);
CREATE INDEX project_map_object_path ON project_map_objects(version_ref, path);
CREATE INDEX project_map_object_name ON project_map_objects(version_ref, name);
CREATE INDEX project_map_note_entity ON project_map_notes(version_ref, entity_ref);
CREATE INDEX project_map_relation_from ON project_map_relations(version_ref, from_ref);
CREATE INDEX project_map_relation_to ON project_map_relations(version_ref, to_ref);
`;

/**
 * Map facts are stored once per file as content-addressed units that every version holding the
 * same facts for that file shares; a version lists its unit per path. The version-scoped names
 * remain as views, so readers query a version as before. Existing facts become one unit per
 * version and path.
 */
export const CODE_INDEX_UNITS_MIGRATION = `
CREATE TABLE project_map_units (unit_ref TEXT PRIMARY KEY, path TEXT NOT NULL);
CREATE TABLE project_map_version_units (
  version_ref TEXT NOT NULL REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  path TEXT NOT NULL,
  unit_ref TEXT NOT NULL REFERENCES project_map_units(unit_ref),
  PRIMARY KEY (version_ref, path)
);
CREATE INDEX project_map_version_unit ON project_map_version_units(unit_ref);
CREATE TABLE project_map_unit_objects (
  unit_ref TEXT NOT NULL REFERENCES project_map_units(unit_ref) ON DELETE CASCADE,
  entity_ref TEXT NOT NULL, context_ref TEXT NOT NULL,
  path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  object_json TEXT NOT NULL CHECK (json_valid(object_json)),
  PRIMARY KEY (unit_ref, entity_ref)
);
CREATE INDEX project_map_unit_object_entity ON project_map_unit_objects(entity_ref);
CREATE INDEX project_map_unit_object_name ON project_map_unit_objects(name);
CREATE TABLE project_map_unit_relations (
  unit_ref TEXT NOT NULL REFERENCES project_map_units(unit_ref) ON DELETE CASCADE,
  relation_ref TEXT NOT NULL, from_ref TEXT NOT NULL, to_ref TEXT, path TEXT NOT NULL,
  relation_json TEXT NOT NULL CHECK (json_valid(relation_json)),
  PRIMARY KEY (unit_ref, relation_ref)
);
CREATE INDEX project_map_unit_relation_from ON project_map_unit_relations(from_ref);
CREATE INDEX project_map_unit_relation_to ON project_map_unit_relations(to_ref);
CREATE TABLE project_map_unit_notes (
  unit_ref TEXT NOT NULL REFERENCES project_map_units(unit_ref) ON DELETE CASCADE,
  entity_ref TEXT NOT NULL, path TEXT NOT NULL,
  note_json TEXT NOT NULL CHECK (json_valid(note_json))
);
CREATE INDEX project_map_unit_note_entity ON project_map_unit_notes(entity_ref);
CREATE TEMP VIEW project_map_legacy_units AS
  SELECT version_ref, path FROM project_map_objects
  UNION SELECT version_ref, path FROM project_map_relations;
INSERT INTO project_map_units SELECT version_ref || char(31) || path, path FROM project_map_legacy_units;
INSERT INTO project_map_version_units
  SELECT version_ref, path, version_ref || char(31) || path FROM project_map_legacy_units;
DROP VIEW project_map_legacy_units;
INSERT INTO project_map_unit_objects
  SELECT version_ref || char(31) || path, entity_ref, context_ref, path, name, kind, object_json
  FROM project_map_objects;
INSERT INTO project_map_unit_relations
  SELECT version_ref || char(31) || path, relation_ref, from_ref, to_ref, path, relation_json
  FROM project_map_relations;
INSERT INTO project_map_unit_notes
  SELECT object.version_ref || char(31) || object.path, note.entity_ref, object.path, note.note_json
  FROM project_map_notes note JOIN project_map_objects object
    ON object.version_ref = note.version_ref AND object.entity_ref = note.entity_ref;
DROP TABLE project_map_notes;
DROP TABLE project_map_relations;
DROP TABLE project_map_objects;
CREATE VIEW project_map_objects AS
  SELECT version.version_ref, object.entity_ref, object.context_ref, object.path, object.name,
    object.kind, object.object_json
  FROM project_map_version_units version JOIN project_map_unit_objects object
    ON object.unit_ref = version.unit_ref AND object.path = version.path;
CREATE VIEW project_map_relations AS
  SELECT version.version_ref, relation.relation_ref, relation.from_ref, relation.to_ref,
    relation.path, relation.relation_json
  FROM project_map_version_units version JOIN project_map_unit_relations relation
    ON relation.unit_ref = version.unit_ref AND relation.path = version.path;
CREATE VIEW project_map_notes AS
  SELECT version.version_ref, note.entity_ref, note.note_json
  FROM project_map_version_units version JOIN project_map_unit_notes note
    ON note.unit_ref = version.unit_ref AND note.path = version.path;
-- Planner statistics for the views' joins, by shape rather than count: a version lists thousands
-- of units, a unit holds tens of facts and a fact key matches a handful. Without them SQLite reads
-- every unit of a version to find one key; a full ANALYZE of a large map takes seconds.
ANALYZE project_map_units;
DELETE FROM sqlite_stat1 WHERE tbl IN ('project_map_units', 'project_map_version_units',
  'project_map_unit_objects', 'project_map_unit_relations', 'project_map_unit_notes');
INSERT INTO sqlite_stat1 VALUES
  ('project_map_units', 'sqlite_autoindex_project_map_units_1', '50000 1'),
  ('project_map_version_units', 'sqlite_autoindex_project_map_version_units_1', '100000 2000 1'),
  ('project_map_version_units', 'project_map_version_unit', '100000 2'),
  ('project_map_unit_objects', 'sqlite_autoindex_project_map_unit_objects_1', '1000000 20 1'),
  ('project_map_unit_objects', 'project_map_unit_object_entity', '1000000 1'),
  ('project_map_unit_objects', 'project_map_unit_object_name', '1000000 16'),
  ('project_map_unit_relations', 'sqlite_autoindex_project_map_unit_relations_1', '5000000 80 1'),
  ('project_map_unit_relations', 'project_map_unit_relation_from', '5000000 8'),
  ('project_map_unit_relations', 'project_map_unit_relation_to', '5000000 6'),
  ('project_map_unit_notes', 'project_map_unit_note_entity', '200000 2');
ANALYZE sqlite_schema;
`;

/**
 * What each analysis context of a version reported besides its facts (gaps, parsed files), and a
 * digest of the request that produced it, so a later version whose request and inputs are the
 * same replays the context instead of analyzing it again.
 */
export const CODE_INDEX_CONTEXT_RESULTS_MIGRATION = `
CREATE TABLE project_map_context_results (
  version_ref TEXT NOT NULL REFERENCES project_code_versions(version_ref) ON DELETE CASCADE,
  context_ref TEXT NOT NULL,
  request_digest TEXT,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY (version_ref, context_ref)
);
`;

/**
 * The navigation text index holds one document per file path and unit (a path without facts has
 * the empty unit), shared by every version that lists the file with those facts: a new version
 * indexes only the files whose facts changed. Indexes built per version are discarded and
 * rebuilt on demand.
 */
export const CODE_INDEX_SHARED_NAVIGATION_MIGRATION = `
DROP TABLE project_map_navigation_fts;
DELETE FROM project_code_index_state;
CREATE TABLE project_map_navigation_documents (
  document_ref INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  unit_ref TEXT NOT NULL,
  UNIQUE (path, unit_ref)
);
CREATE VIRTUAL TABLE project_map_navigation_fts USING fts5(content, tokenize = 'trigram');
CREATE VIEW project_map_navigation AS
  SELECT file.version_ref, file.path, document.document_ref
  FROM project_code_files file
  LEFT JOIN project_map_version_units unit
    ON unit.version_ref = file.version_ref AND unit.path = file.path
  JOIN project_map_navigation_documents document
    ON document.path = file.path AND document.unit_ref = coalesce(unit.unit_ref, '')
  WHERE file.entry_state = 'TEXT';
`;

/**
 * A file whose previous units a build links also has facts the build staged, or links to an
 * object the build no longer has, or the linked units do not fit the analysis, so a unit would
 * be wrong: the build is repeated without a parent.
 */
export class MapReplayConflict extends Error {}

/** A context of a stored version, as a later build may reuse it. */
export type MapStoredContext = Readonly<{
  context: MapContext;
  requestDigest?: string;
}>;

/**
 * What a later build may reuse of an analyzed context: the digest of its request, the state its
 * language kept, and the files the context has facts in, whose units a build replaying it lists.
 */
export type MapContextRecord = Readonly<{
  requestDigest?: string;
  state?: unknown;
  paths?: readonly string[];
}>;

type Row = Record<string, unknown>;
/** A navigation document: a file's path, the unit of its facts ("" for none) and its text. */
export type CodeIndexEntry = Readonly<{ path: string; unit: string; content: string }>;
const corrupt = (): never => {
  throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
};

export class CodeIndexStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`CREATE TEMP TABLE IF NOT EXISTS project_map_staging (
      build_ref TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER PRIMARY KEY,
      value_json TEXT NOT NULL CHECK (json_valid(value_json))
    );
    CREATE INDEX IF NOT EXISTS temp.project_map_staging_build ON project_map_staging(build_ref, kind, position);`);
    database
      .prepare("INSERT OR IGNORE INTO project_code_meta VALUES ('cursor-secret', ?)")
      .run(randomBytes(32).toString("base64url"));
  }

  cursorSecret(): Buffer {
    const row = this.database
      .prepare("SELECT meta_value FROM project_code_meta WHERE meta_key = 'cursor-secret'")
      .get();
    if (typeof row?.meta_value !== "string") return corrupt();
    return Buffer.from(row.meta_value, "base64url");
  }

  createMapStage(): string {
    return randomUUID();
  }

  appendMapStage(buildRef: string, analysis: MapAnalysis, record: MapContextRecord = {}): void {
    if (analysis.requiredFiles.length)
      throw new ProjectEvidenceError("PROJECT_MAP_CONTEXT_INCOMPLETE", false);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare(
        "INSERT INTO project_map_staging (build_ref, kind, value_json) VALUES (?, ?, ?)",
      );
      for (const kind of ["contexts", "objects", "relations", "notes"] as const) {
        for (const value of analysis[kind]) insert.run(buildRef, kind, canonicalJson(value));
      }
      for (const context of analysis.contexts)
        insert.run(
          buildRef,
          "results",
          canonicalJson({
            ref: context.ref,
            ...(record.requestDigest ? { requestDigest: record.requestDigest } : {}),
            gaps: analysis.gaps,
            parsedFiles: analysis.parsedFiles,
            ...(record.state !== undefined ? { state: record.state } : {}),
            ...(record.paths ? { paths: record.paths } : {}),
          }),
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  discardMapStage(buildRef: string): void {
    this.database.prepare("DELETE FROM project_map_staging WHERE build_ref = ?").run(buildRef);
  }

  publish(
    version: CodeIndexVersion,
    entries: readonly ProjectEvidenceRevisionFileEntryV1[],
    buildRef: string,
    coverage: MapBuildCoverage,
    // Files whose units the version lists as that version stored them: the files of replayed
    // contexts, and those a context analyzed in part left out.
    linked?: Readonly<{ version: string; paths: ReadonlySet<string> }>,
  ): CodeIndexVersion {
    if (
      version.version !==
        digestValue({
          projectRef: version.projectRef,
          pathPrefixes: version.pathPrefixes,
          entries,
          analyzer: version.analyzer,
        }) ||
      entries.length !== version.fileCount ||
      entries.filter((entry) => entry.state === "TEXT").length !== version.readableTextFileCount ||
      entries
        .filter((entry) => entry.state === "TEXT")
        .reduce((sum, entry) => sum + entry.byteLength, 0) !== version.capturedBytes
    )
      return corrupt();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // What is stored, independent of the order the analysis staged it in: each file's unit,
      // the contexts and the coverage.
      const paths = new Set(entries.map((entry) => entry.path));
      const staged = this.stageUnits(buildRef, paths, linked);
      const reused = linked
        ? this.database
            .prepare(`SELECT path, unit_ref FROM project_map_version_units
              WHERE version_ref = ? AND path IN (SELECT value FROM json_each(?))`)
            .all(linked.version, JSON.stringify([...linked.paths]))
            .map((row) => ({ path: String(row.path), unit: String(row.unit_ref) }))
        : [];
      // A linked file's facts are its stored unit's only; an analyzed context adds none to it.
      if (
        reused.length !== (linked?.paths.size ?? 0) ||
        reused.some(({ path }) => !paths.has(path)) ||
        staged.some(({ path }) => linked?.paths.has(path))
      )
        throw new MapReplayConflict();
      const units = [...staged, ...reused].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
      const analysisDigest = digestValue({
        coverage,
        contexts: this.database
          .prepare(
            "SELECT value_json FROM project_map_staging WHERE build_ref = ? AND kind = 'contexts'",
          )
          .all(buildRef)
          .map((row) => String(row.value_json))
          .sort(),
        units,
      });
      this.database
        .prepare("INSERT OR IGNORE INTO project_code_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          version.version,
          version.projectRef,
          canonicalJson(version.pathPrefixes),
          version.fileCount,
          version.readableTextFileCount,
          version.capturedBytes,
          version.analyzer,
          analysisDigest,
        );
      const insert = this.database.prepare(
        "INSERT OR IGNORE INTO project_code_files VALUES (?, ?, ?, ?, ?)",
      );
      for (const entry of entries)
        insert.run(
          version.version,
          entry.path,
          entry.state,
          entry.byteLength,
          entry.contentDigest ?? null,
        );
      if (
        digestValue(this.getVersion(version.version)) !== digestValue(version) ||
        digestValue(this.listEntries(version.version)) !== digestValue(entries)
      )
        return corrupt();
      const previous = this.database
        .prepare("SELECT coverage_json FROM project_map_coverage WHERE version_ref = ?")
        .get(version.version);
      if (previous) {
        const row = this.database
          .prepare("SELECT analysis_digest FROM project_code_versions WHERE version_ref = ?")
          .get(version.version);
        if (row?.analysis_digest !== analysisDigest) return corrupt();
      } else {
        this.database
          .prepare(`INSERT INTO project_map_contexts
          SELECT ?, json_extract(value_json, '$.ref'), value_json FROM project_map_staging
          WHERE build_ref = ? AND kind = 'contexts' ORDER BY position`)
          .run(version.version, buildRef);
        this.database
          .prepare(`INSERT INTO project_map_context_results
          SELECT ?, json_extract(value_json, '$.ref'), json_extract(value_json, '$.requestDigest'),
            value_json FROM project_map_staging
          WHERE build_ref = ? AND kind = 'results' ORDER BY position`)
          .run(version.version, buildRef);
        this.commitUnits(version.version, staged);
        const member = this.database.prepare(
          "INSERT INTO project_map_version_units VALUES (?, ?, ?)",
        );
        for (const { path, unit } of reused) member.run(version.version, path, unit);
        this.database
          .prepare("INSERT INTO project_map_coverage VALUES (?, ?)")
          .run(version.version, canonicalJson(coverage));
      }
      this.database.exec("COMMIT");
      return Object.freeze({ ...version, pathPrefixes: Object.freeze([...version.pathPrefixes]) });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec(`DROP TABLE IF EXISTS temp.project_map_publish_objects;
        DROP TABLE IF EXISTS temp.project_map_publish_relations;
        DROP TABLE IF EXISTS temp.project_map_publish_notes;`);
    }
  }

  /**
   * Stores a version's facts as one unit per file, keyed by the unit's content: a file whose facts
   * another version already holds shares that unit. An object analyzed in several contexts keeps
   * its first copy unless a later copy belongs to its primary context. Relations may also name
   * objects of the linked files, whose units the version lists as they are.
   */
  private stageUnits(
    buildRef: string,
    paths: ReadonlySet<string>,
    linked?: Readonly<{ version: string; paths: ReadonlySet<string> }>,
  ): { path: string; unit: string }[] {
    const database = this.database;
    database.exec(`CREATE TEMP TABLE project_map_publish_objects (
      entity_ref TEXT PRIMARY KEY, context_ref TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, object_json TEXT NOT NULL);
    CREATE TEMP TABLE project_map_publish_relations (
      relation_ref TEXT PRIMARY KEY, from_ref TEXT NOT NULL, to_ref TEXT, path TEXT NOT NULL,
      relation_json TEXT NOT NULL);
    CREATE TEMP TABLE project_map_publish_notes (
      entity_ref TEXT NOT NULL, path TEXT NOT NULL, note_json TEXT NOT NULL);`);
    database
      .prepare(`INSERT INTO project_map_publish_objects
          SELECT json_extract(value_json, '$.id'), json_extract(value_json, '$.contextRef'),
            json_extract(value_json, '$.anchor.path'), json_extract(value_json, '$.name'),
            json_extract(value_json, '$.kind'), value_json FROM project_map_staging
          WHERE build_ref = ? AND kind = 'objects' ORDER BY position
          ON CONFLICT(entity_ref) DO UPDATE SET
            context_ref = excluded.context_ref, object_json = excluded.object_json
          WHERE json_extract(excluded.object_json, '$.contextRole') = 'DEFAULT'
            AND json_extract(project_map_publish_objects.object_json, '$.contextRole') = 'DEPENDENCY'`)
      .run(buildRef);
    database
      .prepare(`INSERT OR IGNORE INTO project_map_publish_relations
          SELECT json_extract(value_json, '$.id'), json_extract(value_json, '$.from'),
            json_extract(value_json, '$.to'), json_extract(value_json, '$.anchor.path'), value_json
          FROM project_map_staging WHERE build_ref = ? AND kind = 'relations' ORDER BY position`)
      .run(buildRef);
    const notes = database
      .prepare(`INSERT INTO project_map_publish_notes
          SELECT object.entity_ref, object.path, staged.value_json FROM project_map_staging staged
          JOIN project_map_publish_objects object
            ON object.entity_ref = json_extract(staged.value_json, '$.entityRef')
          WHERE staged.build_ref = ? AND staged.kind = 'notes' ORDER BY staged.position`)
      .run(buildRef).changes;
    const linkedPaths = JSON.stringify([...(linked?.paths ?? [])]);
    // What the version-scoped tables' keys guaranteed: objects lie in the version's files,
    // relations join objects, notes belong to objects.
    if (
      database
        .prepare("SELECT DISTINCT path FROM project_map_publish_objects")
        .all()
        .some((row) => !paths.has(String(row.path))) ||
      notes !==
        Number(
          database
            .prepare(
              "SELECT count(*) AS count FROM project_map_staging WHERE build_ref = ? AND kind = 'notes'",
            )
            .get(buildRef)?.count,
        ) ||
      database
        .prepare(`SELECT 1 FROM project_map_publish_relations relation WHERE
            relation.from_ref NOT IN (SELECT entity_ref FROM project_map_publish_objects)
            OR (relation.to_ref NOT IN (SELECT entity_ref FROM project_map_publish_objects)
              AND NOT EXISTS (SELECT 1 FROM project_map_objects object
                WHERE object.version_ref = ? AND object.entity_ref = relation.to_ref
                  AND object.path IN (SELECT value FROM json_each(?))))
          LIMIT 1`)
        .get(linked?.version ?? "", linkedPaths)
    ) {
      // Without a parent the analysis itself is inconsistent; with one, linking made it so.
      if (linked) throw new MapReplayConflict();
      corrupt();
    }
    // A linked file's relation to an object of the parent's other files that this analysis no
    // longer has means the file needed analyzing again: the version is built without a parent.
    if (linked) {
      const unlinked = database
        .prepare("SELECT path FROM project_map_version_units WHERE version_ref = ?")
        .all(linked.version)
        .map((row) => String(row.path))
        .filter((path) => !linked.paths.has(path));
      if (
        database
          .prepare(`SELECT 1 FROM project_map_objects gone
            WHERE gone.version_ref = ? AND gone.path IN (SELECT value FROM json_each(?))
              AND gone.entity_ref NOT IN (SELECT entity_ref FROM project_map_publish_objects)
              AND EXISTS (SELECT 1 FROM project_map_relations relation
                WHERE relation.version_ref = ? AND relation.to_ref = gone.entity_ref
                  AND relation.path IN (SELECT value FROM json_each(?)))
            LIMIT 1`)
          .get(linked.version, JSON.stringify(unlinked), linked.version, linkedPaths)
      )
        throw new MapReplayConflict();
    }
    database.exec(`CREATE INDEX temp.project_map_publish_object_path ON project_map_publish_objects(path);
        CREATE INDEX temp.project_map_publish_relation_path ON project_map_publish_relations(path);
        CREATE INDEX temp.project_map_publish_note_path ON project_map_publish_notes(path);`);
    const objects = database.prepare(
      "SELECT entity_ref, object_json FROM project_map_publish_objects WHERE path = ? ORDER BY entity_ref",
    );
    const relations = database.prepare(
      "SELECT relation_ref, relation_json FROM project_map_publish_relations WHERE path = ? ORDER BY relation_ref",
    );
    const pathNotes = database.prepare(
      "SELECT entity_ref, note_json FROM project_map_publish_notes WHERE path = ? ORDER BY entity_ref, note_json",
    );
    const units: { path: string; unit: string }[] = [];
    for (const row of database
      .prepare(`SELECT path FROM project_map_publish_objects
          UNION SELECT path FROM project_map_publish_relations ORDER BY path`)
      .all()) {
      const path = String(row.path);
      const hash = createHash("sha256").update(path).update("\0");
      for (const [mark, statement] of [
        ["object", objects],
        ["relation", relations],
        ["note", pathNotes],
      ] as const)
        for (const fact of statement.all(path))
          for (const value of Object.values(fact))
            hash.update(mark).update("\0").update(String(value)).update("\0");
      units.push({ path, unit: hash.digest("hex") });
    }
    return units;
  }

  /** Stores the staged units a version lists, each once whichever versions share it. */
  private commitUnits(version: string, units: readonly { path: string; unit: string }[]): void {
    const database = this.database;
    const insertUnit = database.prepare("INSERT OR IGNORE INTO project_map_units VALUES (?, ?)");
    const unitObjects = database.prepare(
      "INSERT INTO project_map_unit_objects SELECT ?, * FROM project_map_publish_objects WHERE path = ?",
    );
    const unitRelations = database.prepare(
      "INSERT INTO project_map_unit_relations SELECT ?, * FROM project_map_publish_relations WHERE path = ?",
    );
    const unitNotes = database.prepare(
      "INSERT INTO project_map_unit_notes SELECT ?, * FROM project_map_publish_notes WHERE path = ?",
    );
    const member = database.prepare("INSERT INTO project_map_version_units VALUES (?, ?, ?)");
    for (const { path, unit } of units) {
      if (insertUnit.run(unit, path).changes) {
        unitObjects.run(unit, path);
        unitRelations.run(unit, path);
        unitNotes.run(unit, path);
      }
      member.run(version, path, unit);
    }
  }

  /** Earlier versions of a project's scope built by the same analyzer, most recent first. */
  mapParentCandidates(version: CodeIndexVersion, limit: number): readonly string[] {
    return this.database
      .prepare(`SELECT version.version_ref FROM project_code_versions version
        JOIN project_code_index_state state ON state.version_ref = version.version_ref
        WHERE version.project_ref = ? AND version.analyzer = ? AND version.scope_json = ?
          AND version.version_ref <> ?
        ORDER BY state.completed_at DESC LIMIT ?`)
      .all(
        version.projectRef,
        version.analyzer,
        canonicalJson(version.pathPrefixes),
        version.version,
        limit,
      )
      .map((row) => String(row.version_ref));
  }

  /** A version's analysis contexts with the request digest each was built from, if recorded. */
  mapContexts(version: string): ReadonlyMap<string, MapStoredContext> {
    const contexts = new Map<string, MapStoredContext>();
    for (const row of this.database
      .prepare(`SELECT context.context_ref, context.context_json, result.request_digest
        FROM project_map_contexts context LEFT JOIN project_map_context_results result
          ON result.version_ref = context.version_ref AND result.context_ref = context.context_ref
        WHERE context.version_ref = ?`)
      .all(version))
      contexts.set(String(row.context_ref), {
        context: MapContextSchema.parse(JSON.parse(String(row.context_json))),
        ...(typeof row.request_digest === "string" ? { requestDigest: row.request_digest } : {}),
      });
    return contexts;
  }

  /**
   * One context of a stored version without its facts: its record, gaps and parsed files, the
   * state its language kept and the files it has facts in. A later version that replays the
   * context lists the stored units of those files.
   */
  mapContextShell(
    version: string,
    contextRef: string,
  ): Readonly<{ analysis: MapAnalysis; state?: unknown; paths?: readonly string[] }> {
    const context = this.database
      .prepare(
        "SELECT context_json FROM project_map_contexts WHERE version_ref = ? AND context_ref = ?",
      )
      .get(version, contextRef);
    const result = this.database
      .prepare(
        "SELECT result_json FROM project_map_context_results WHERE version_ref = ? AND context_ref = ?",
      )
      .get(version, contextRef);
    if (!context || !result) return corrupt();
    const { gaps, parsedFiles, state, paths } = JSON.parse(String(result.result_json)) as Record<
      string,
      unknown
    >;
    const analysis = MapAnalysisSchema.parse({
      contexts: [JSON.parse(String(context.context_json))],
      objects: [],
      relations: [],
      notes: [],
      gaps,
      parsedFiles,
      requiredFiles: [],
    });
    return {
      analysis,
      ...(state !== undefined ? { state } : {}),
      ...(paths !== undefined ? { paths: z.array(z.string()).parse(paths) } : {}),
    };
  }

  /** The state a context's language kept in a stored version, if any. */
  mapContextState(version: string, contextRef: string): unknown {
    const row = this.database
      .prepare(`SELECT json_extract(result_json, '$.state') AS state FROM project_map_context_results
        WHERE version_ref = ? AND context_ref = ? AND json_type(result_json, '$.state') = 'object'`)
      .get(version, contextRef);
    return row ? JSON.parse(String(row.state)) : undefined;
  }

  getVersion(version: string): CodeIndexVersion | undefined {
    const row = this.database
      .prepare("SELECT * FROM project_code_versions WHERE version_ref = ?")
      .get(version);
    if (!row) return undefined;
    const prefixes = JSON.parse(String(row.scope_json)) as unknown;
    if (
      !Array.isArray(prefixes) ||
      !prefixes.every((value) => typeof value === "string") ||
      ![row.file_count, row.text_file_count, row.captured_bytes].every(
        (value) => Number.isSafeInteger(value) && Number(value) >= 0,
      )
    )
      return corrupt();
    return Object.freeze({
      version: String(row.version_ref),
      projectRef: String(row.project_ref),
      pathPrefixes: Object.freeze(prefixes),
      fileCount: Number(row.file_count),
      readableTextFileCount: Number(row.text_file_count),
      capturedBytes: Number(row.captured_bytes),
      analyzer: String(row.analyzer),
    });
  }

  requireVersion(version: string): CodeIndexVersion {
    const result = this.getVersion(version);
    if (!result) throw new ProjectEvidenceError("PROJECT_EVIDENCE_REVISION_NOT_FOUND", false);
    return result;
  }

  listEntries(version: string): readonly ProjectEvidenceRevisionFileEntryV1[] {
    return this.database
      .prepare("SELECT * FROM project_code_files WHERE version_ref = ? ORDER BY path")
      .all(version)
      .map((row) => this.entry(row));
  }

  getEntry(version: string, relative: string): ProjectEvidenceRevisionFileEntryV1 | undefined {
    const row = this.database
      .prepare("SELECT * FROM project_code_files WHERE version_ref = ? AND path = ?")
      .get(version, relative);
    return row ? this.entry(row) : undefined;
  }

  configurationEntries(
    version: string,
    relative: string,
  ): readonly ProjectEvidenceRevisionFileEntryV1[] {
    // CROSS JOIN keeps SQLite from scanning every version file before expanding configuration paths.
    return this.database
      .prepare(`WITH selected AS MATERIALIZED (
        SELECT DISTINCT context_ref FROM project_map_objects WHERE version_ref = ? AND path = ?
      )
      SELECT DISTINCT file.* FROM selected
      JOIN project_map_contexts context ON context.version_ref = ? AND context.context_ref = selected.context_ref
      JOIN json_each(json_extract(context.context_json, '$.configurationFiles')) configuration
      CROSS JOIN project_code_files file ON file.version_ref = context.version_ref AND file.path = configuration.value
      ORDER BY file.path`)
      .all(version, relative, version)
      .map((row) => this.entry(row));
  }

  beginDerivedIndexRebuild(version: string): CodeIndexVersion {
    const result = this.requireVersion(version);
    this.discardDerivedIndex(version);
    return result;
  }

  /** The next files of a version, in path order, whose navigation documents do not exist yet. */
  listDerivedIndexEntries(
    version: string,
    afterPath: string,
    limit: number,
  ): readonly CodeIndexEntry[] {
    if (!Number.isInteger(limit) || limit < 1)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_INPUT_INVALID", false);
    return this.database
      .prepare(`SELECT entry.path, coalesce(unit.unit_ref, '') AS unit, coalesce((
        SELECT group_concat(name, ' ') FROM project_map_objects object
        WHERE object.version_ref = entry.version_ref AND object.path = entry.path
      ), '') || ' ' || coalesce((
        SELECT group_concat(json_extract(note.note_json, '$.text'), ' ')
        FROM project_map_objects object CROSS JOIN project_map_notes note
          ON object.version_ref = note.version_ref AND object.entity_ref = note.entity_ref
        WHERE object.version_ref = entry.version_ref AND object.path = entry.path
      ), '') AS names
      FROM project_code_files entry
      LEFT JOIN project_map_version_units unit
        ON unit.version_ref = entry.version_ref AND unit.path = entry.path
      WHERE entry.version_ref = ? AND entry.entry_state = 'TEXT' AND entry.path > ?
        AND NOT EXISTS (SELECT 1 FROM project_map_navigation_documents document
          WHERE document.path = entry.path AND document.unit_ref = coalesce(unit.unit_ref, ''))
      ORDER BY entry.path LIMIT ?`)
      .all(version, afterPath, limit)
      .map((row) => ({
        path: String(row.path),
        unit: String(row.unit),
        content: `${String(row.path)} ${String(row.names)}`,
      }));
  }

  /** Stores navigation documents of a version's files; one another version stored is kept. */
  appendDerivedIndexEntries(version: string, entries: readonly CodeIndexEntry[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const unit = this.database.prepare(`SELECT coalesce(unit.unit_ref, '') AS unit
        FROM project_code_files file LEFT JOIN project_map_version_units unit
          ON unit.version_ref = file.version_ref AND unit.path = file.path
        WHERE file.version_ref = ? AND file.path = ? AND file.entry_state = 'TEXT'`);
      const document = this.database.prepare(`INSERT INTO project_map_navigation_documents
        (path, unit_ref) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING document_ref`);
      const insert = this.database.prepare(
        "INSERT INTO project_map_navigation_fts (rowid, content) VALUES (?, ?)",
      );
      for (const entry of entries) {
        if (unit.get(version, entry.path)?.unit !== entry.unit)
          throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_INPUT_INVALID", false);
        const created = document.get(entry.path, entry.unit);
        if (created) insert.run(Number(created.document_ref), entry.content);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeDerivedIndex(version: string, completedAt: string): void {
    const progress = this.getIndexProgress(version);
    if (progress.indexedFiles !== progress.totalFiles)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_INDEX_INCOMPLETE", false);
    this.database
      .prepare("INSERT OR REPLACE INTO project_code_index_state VALUES (?, ?)")
      .run(version, completedAt);
  }

  /**
   * Marks a version's index incomplete. Its documents stay: each is the text of one file's unit,
   * so a rebuild reuses them, and garbage collection drops those no version lists.
   */
  discardDerivedIndex(version: string): void {
    this.database
      .prepare("DELETE FROM project_code_index_state WHERE version_ref = ?")
      .run(version);
  }

  getIndexProgress(version: string) {
    const snapshot = this.requireVersion(version);
    const indexedFiles = Number(
      this.database
        .prepare("SELECT count(*) AS count FROM project_map_navigation WHERE version_ref = ?")
        .get(version)?.count,
    );
    const complete = !!this.database
      .prepare("SELECT 1 FROM project_code_index_state WHERE version_ref = ?")
      .get(version);
    return {
      indexedFiles,
      totalFiles: snapshot.readableTextFileCount,
      complete: complete && indexedFiles === snapshot.readableTextFileCount,
    };
  }

  collectGarbage(referencedVersions: readonly string[]): void {
    const retained = new Set(referencedVersions);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.database
        .prepare("SELECT version_ref FROM project_code_versions")
        .all()) {
        const version = String(row.version_ref);
        if (retained.has(version)) continue;
        this.database
          .prepare("DELETE FROM project_code_versions WHERE version_ref = ?")
          .run(version);
      }
      // Units and navigation documents no retained version lists anymore go with their facts.
      this.database.exec(`DELETE FROM project_map_units WHERE NOT EXISTS (
        SELECT 1 FROM project_map_version_units version WHERE version.unit_ref = project_map_units.unit_ref)`);
      const orphans = JSON.stringify(
        this.database
          .prepare(`SELECT document_ref FROM project_map_navigation_documents
            WHERE document_ref NOT IN (SELECT document_ref FROM project_map_navigation)`)
          .all()
          .map((row) => Number(row.document_ref)),
      );
      this.database
        .prepare(
          "DELETE FROM project_map_navigation_fts WHERE rowid IN (SELECT value FROM json_each(?))",
        )
        .run(orphans);
      this.database
        .prepare(`DELETE FROM project_map_navigation_documents
          WHERE document_ref IN (SELECT value FROM json_each(?))`)
        .run(orphans);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private entry(row: Row): ProjectEvidenceRevisionFileEntryV1 {
    const state = String(row.entry_state) as ProjectEvidenceRevisionFileEntryV1["state"];
    if (
      ![
        "TEXT",
        "TYPE_RESTRICTED",
        "TOO_LARGE",
        "NON_TEXT",
        "NOT_READABLE",
        "SYMLINK",
        "UNSUPPORTED_ENTRY",
      ].includes(state) ||
      (state === "TEXT" && typeof row.content_digest !== "string")
    )
      return corrupt();
    return Object.freeze({
      path: String(row.path),
      state,
      byteLength: Number(row.byte_length),
      ...(typeof row.content_digest === "string" ? { contentDigest: row.content_digest } : {}),
    });
  }
}

import type { CodeIndexStore } from "./code-index-store";
import { ProjectEvidenceError } from "./core";
import {
  type MapObject,
  MapObjectSchema,
  type MapRelation,
  MapRelationSchema,
} from "./project-map-types";

const corrupt = (): never => {
  throw new ProjectEvidenceError("PROJECT_EVIDENCE_STORE_CORRUPT", false);
};
const MODULE_KINDS = new Set<MapObject["kind"]>(["FILE", "PACKAGE", "CONFIG"]);
const MEMBER_CONTAINERS = new Set<MapObject["kind"]>(["CLASS", "INTERFACE", "TYPE", "ENUM"]);

export const mapIsModule = (object: Pick<MapObject, "kind">) => MODULE_KINDS.has(object.kind);

export const MAP_KIND_LETTERS: Readonly<Record<MapObject["kind"], string>> = Object.freeze({
  FILE: "file",
  PACKAGE: "package",
  CONFIG: "config",
  FUNCTION: "f",
  CLASS: "c",
  INTERFACE: "i",
  TYPE: "t",
  METHOD: "m",
  PROPERTY: "p",
  VARIABLE: "v",
  ENUM: "e",
});

type Lines = Readonly<{ anchor: Readonly<{ startLine: number; endLine: number }> }>;
export const mapLineRange = ({ anchor }: Lines) =>
  anchor.startLine === anchor.endLine
    ? `${anchor.startLine}`
    : `${anchor.startLine}-${anchor.endLine}`;

export const mapDeclarationLabel = (object: Lines & Pick<MapObject, "kind">) =>
  `${MAP_KIND_LETTERS[object.kind]}${mapLineRange(object)}`;

/**
 * Reader-facing declarations over the occurrence index. A declaration is addressable when it
 * is module-level or a member of a class, type or module-level object literal; closures,
 * locals and computed members belong to their nearest addressable container.
 */
export class MapViewGraph {
  private readonly objects = new Map<string, MapObject>();
  private readonly parents = new Map<string, string | null>();
  private readonly owners = new Map<string, string>();
  private readonly addressable = new Map<string, boolean>();
  private readonly implementations = new Map<string, boolean>();
  private readonly statements;

  constructor(
    store: CodeIndexStore,
    private readonly version: string,
  ) {
    const database = store.database;
    this.statements = {
      object: database.prepare(
        "SELECT object_json FROM project_map_objects WHERE version_ref = ? AND entity_ref = ?",
      ),
      path: database.prepare(
        "SELECT object_json FROM project_map_objects WHERE version_ref = ? AND path = ?",
      ),
      parent: database.prepare(`SELECT from_ref FROM project_map_relations
        WHERE version_ref = ? AND to_ref = ? AND json_extract(relation_json, '$.kind') = 'CONTAINS'`),
      children: database.prepare(`SELECT to_ref FROM project_map_relations
        WHERE version_ref = ? AND from_ref = ? AND json_extract(relation_json, '$.kind') = 'CONTAINS'`),
      from: database.prepare(`SELECT relation_json FROM project_map_relations
        WHERE version_ref = ? AND from_ref IN (SELECT value FROM json_each(?))`),
      to: database.prepare(`SELECT relation_json FROM project_map_relations
        WHERE version_ref = ? AND to_ref IN (SELECT value FROM json_each(?))`),
      implemented: database.prepare(`SELECT 1 FROM project_map_relations
        WHERE version_ref = ? AND to_ref = ? AND json_extract(relation_json, '$.kind') = 'OVERRIDES'
        LIMIT 1`),
    };
  }

  object(ref: string): MapObject {
    let object = this.objects.get(ref);
    if (!object) {
      const row = this.statements.object.get(this.version, ref);
      if (!row) return corrupt();
      object = MapObjectSchema.parse(JSON.parse(String(row.object_json)));
      this.objects.set(ref, object);
    }
    return object;
  }

  objectsAt(path: string): MapObject[] {
    return this.statements.path.all(this.version, path).map((row) => {
      const object = MapObjectSchema.parse(JSON.parse(String(row.object_json)));
      this.objects.set(object.id, object);
      return object;
    });
  }

  parent(ref: string): string | undefined {
    let parent = this.parents.get(ref);
    if (parent === undefined) {
      const rows = this.statements.parent.all(this.version, ref);
      if (rows.length > 1) return corrupt();
      parent = rows[0] ? String(rows[0].from_ref) : null;
      this.parents.set(ref, parent);
    }
    return parent ?? undefined;
  }

  children(ref: string): string[] {
    return this.statements.children.all(this.version, ref).map((row) => String(row.to_ref));
  }

  isAddressable(object: MapObject): boolean {
    const known = this.addressable.get(object.id);
    if (known !== undefined) return known;
    let result: boolean;
    if (mapIsModule(object)) result = true;
    else if (object.name.startsWith("<")) result = false;
    else {
      const parentRef = this.parent(object.id);
      const parent = parentRef === undefined ? undefined : this.object(parentRef);
      if (!parent || mapIsModule(parent)) result = true;
      else if (object.kind !== "METHOD" && object.kind !== "PROPERTY") result = false;
      else if (MEMBER_CONTAINERS.has(parent.kind)) result = this.isAddressable(parent);
      else if (parent.kind !== "VARIABLE") result = false;
      else {
        const container = this.parent(parent.id);
        result = container !== undefined && mapIsModule(this.object(container));
      }
    }
    this.addressable.set(object.id, result);
    return result;
  }

  /** Whether any member implements or overrides the declaration, so calls to it dispatch on. */
  implemented(ref: string): boolean {
    let known = this.implementations.get(ref);
    if (known === undefined) {
      known = this.statements.implemented.get(this.version, ref) !== undefined;
      this.implementations.set(ref, known);
    }
    return known;
  }

  /** The nearest addressable declaration containing, or equal to, the object. */
  owner(ref: string): string {
    const pending: string[] = [];
    let current: string | undefined = ref;
    let owner: string | undefined;
    while (current !== undefined) {
      owner = this.owners.get(current);
      if (owner) break;
      pending.push(current);
      if (this.isAddressable(this.object(current))) {
        owner = current;
        break;
      }
      current = this.parent(current);
    }
    owner ??= ref;
    for (const value of pending) this.owners.set(value, owner);
    return owner;
  }

  qualifiedName(ref: string): string {
    const object = this.object(ref);
    if (mapIsModule(object)) return object.name;
    const names = [object.name];
    for (let parent = this.parent(ref); parent !== undefined; parent = this.parent(parent)) {
      const container = this.object(parent);
      if (mapIsModule(container)) break;
      if (this.isAddressable(container)) names.unshift(container.name);
    }
    return names.join(".");
  }

  /** The declaration, the closures and locals it owns, and its addressable members. */
  scope(ref: string): Readonly<{ refs: readonly string[]; members: readonly MapObject[] }> {
    const refs = [ref];
    const members: MapObject[] = [];
    const pending = [ref];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      for (const child of this.children(current)) {
        const object = this.object(child);
        if (this.isAddressable(object)) members.push(object);
        else {
          refs.push(child);
          pending.push(child);
        }
      }
    }
    // Members declared in the declaration's file come first; members declared elsewhere (Go
    // methods can be) follow file by file.
    const home = this.object(ref).anchor.path;
    const file = (object: MapObject) => (object.anchor.path === home ? "" : object.anchor.path);
    members.sort(
      (left, right) =>
        (file(left) < file(right) ? -1 : file(left) > file(right) ? 1 : 0) ||
        left.anchor.start - right.anchor.start,
    );
    return { refs, members };
  }

  relationsFrom(refs: readonly string[]): MapRelation[] {
    return this.relations(this.statements.from, refs);
  }

  relationsTo(refs: readonly string[]): MapRelation[] {
    return this.relations(this.statements.to, refs);
  }

  private relations(
    statement: ReturnType<CodeIndexStore["database"]["prepare"]>,
    refs: readonly string[],
  ): MapRelation[] {
    const relations: MapRelation[] = [];
    for (let start = 0; start < refs.length; start += 256) {
      const batch = JSON.stringify(refs.slice(start, start + 256));
      for (const row of statement.all(this.version, batch))
        relations.push(MapRelationSchema.parse(JSON.parse(String(row.relation_json))));
    }
    // In source order, so lists such as a declaration's decorators read as written; storage
    // order is not meaningful (versions share per-file units).
    return relations.sort(
      (left, right) =>
        (left.anchor.path < right.anchor.path
          ? -1
          : left.anchor.path > right.anchor.path
            ? 1
            : 0) ||
        left.anchor.start - right.anchor.start ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  }
}

/**
 * Declarations in a file selected by name (or Container.member) and an optional line. A start
 * line selects exactly; any other line selects the innermost declaration containing it.
 */
export function mapSelectDeclarations(
  graph: MapViewGraph,
  path: string,
  name?: string,
  line?: number,
): MapObject[] {
  const objects = graph.objectsAt(path).filter((object) => !mapIsModule(object));
  const matching =
    name === undefined
      ? objects
      : objects.filter(
          (object) =>
            object.name === name || (name.includes(".") && graph.qualifiedName(object.id) === name),
        );
  // Locals are selectable by exact name, but never shadow an addressable declaration.
  const addressable = matching.filter((object) => graph.isAddressable(object));
  const named = addressable.length || name === undefined ? addressable : matching;
  named.sort((left, right) => left.anchor.start - right.anchor.start);
  if (line === undefined) return named;
  // A name with its exact start line is unambiguous, so it may select a local as well.
  const starting = (name === undefined ? named : matching).filter(
    (object) => object.anchor.startLine === line,
  );
  if (name !== undefined && starting.length) return starting;
  const containing = named
    .filter((object) => object.anchor.startLine <= line && line <= object.anchor.endLine)
    .sort((left, right) => right.anchor.start - left.anchor.start)
    .slice(0, 1);
  // The name selects; a line that fits none of its declarations only failed to narrow it.
  return containing.length || name === undefined ? containing : named;
}

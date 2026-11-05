import { normalizeProjectEvidencePath, ProjectEvidenceError } from "./core";

export type MapQuerySelection<Kind extends string> = Readonly<{
  path: string;
  kinds: readonly Kind[];
}>;

// A result filter is not a read grant; declarations and compiler inputs retain their own checks.
export const mapQuerySelection = <Kind extends string>(
  input: { path?: string; kinds?: readonly Kind[] },
  knownKinds: readonly Kind[],
): MapQuerySelection<Kind> => {
  const path = normalizeProjectEvidencePath(input.path ?? ".", true) || ".";
  const kinds = input.kinds ?? knownKinds;
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    kinds.length > knownKinds.length ||
    kinds.some((kind) => !knownKinds.includes(kind))
  )
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  return { path, kinds: [...new Set(kinds)].sort() };
};

export const mapQueryPathMatches = (path: string, prefix: string) =>
  prefix === "." || path === prefix || path.startsWith(`${prefix}/`);

// A relation r's target object t in r's version, NULL when the version holds none. SQLite materializes
// a joined view on the right of a LEFT JOIN, here project_map_objects with every version's objects,
// so this joins its tables instead.
export const MAP_RELATION_TARGET_JOIN = `LEFT JOIN project_map_unit_objects t ON t.entity_ref = r.to_ref
      AND EXISTS (SELECT 1 FROM project_map_version_units target
        WHERE target.version_ref = r.version_ref AND target.unit_ref = t.unit_ref AND target.path = t.path)`;

export const mapQueryPathSql = (column: string) =>
  `(? = '.' OR ${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/')`;

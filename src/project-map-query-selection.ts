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

export const mapQueryPathSql = (column: string) =>
  `(? = '.' OR ${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/')`;

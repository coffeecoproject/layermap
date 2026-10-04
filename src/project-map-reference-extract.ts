import {
  getTokenAtPosition,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/async";
import { mapQueryPathMatches } from "./project-map-query-selection";
import type { MapReferencePage, MapReferenceRequest } from "./project-map-reference-types";
import { MapSourcePositions } from "./project-map-source-positions";
import type { MapWorkerInput } from "./project-map-types";
import { mapRelativePath, mapVirtualPath } from "./project-map-virtual-files";
import { isMapWrite } from "./project-map-write";

function referenceKind(node: Node): MapReferencePage["references"][number]["kind"] {
  let expression = node;
  if (isPropertyAccessExpression(node.parent) && node.parent.name === node)
    expression = node.parent;
  if (isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
    expression = node.parent;
  const parent = expression.parent;
  if ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === expression)
    return "CALL";
  if (isMapWrite(expression)) return "WRITE";
  if (
    [
      SyntaxKind.ImportSpecifier,
      SyntaxKind.ExportSpecifier,
      SyntaxKind.ImportClause,
      SyntaxKind.NamespaceImport,
    ].includes(node.parent.kind)
  )
    return "IMPORT_EXPORT";
  if ((node.parent as Node & { name?: Node }).name === node && expression === node)
    return "DECLARATION";
  return isPropertyAccessExpression(expression) || isElementAccessExpression(expression)
    ? "READ"
    : "REFERENCE";
}

export async function extractMapReferences(
  project: Project,
  input: MapWorkerInput,
  query: MapReferenceRequest,
): Promise<MapReferencePage> {
  const file = await project.program.getSourceFile(mapVirtualPath(query.targetPath));
  if (!file) throw new Error("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE");
  const token = getTokenAtPosition(file, query.symbolStart);
  if (
    !isIdentifier(token) &&
    !isPrivateIdentifier(token) &&
    token.kind !== SyntaxKind.StringLiteral
  )
    throw new Error("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE");
  const groups = await project.checker.getReferencedSymbolsForNode(token, query.symbolStart);
  if (!groups.length) throw new Error("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE");
  const positions = new MapSourcePositions(input.files);
  const references = new Map<string, MapReferencePage["references"][number]>();
  for (const group of groups) {
    for (const handle of group.references) {
      if (mapRelativePath(handle.path) === undefined) continue;
      const node = await handle.resolve(project);
      if (!node) throw new Error("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE");
      const relative = mapRelativePath(node.getSourceFile().fileName);
      if (!relative || !Object.hasOwn(input.files, relative)) continue;
      if (!mapQueryPathMatches(relative, query.path ?? ".")) continue;
      const kind = referenceKind(node);
      if (query.kinds && !query.kinds.includes(kind)) continue;
      const anchor = positions.anchor(node, node.getSourceFile());
      references.set(`${relative}:${anchor.start}:${anchor.end}`, {
        anchor,
        kind,
      });
    }
  }
  const ordered = [...references.values()].sort(
    (left, right) =>
      Buffer.compare(Buffer.from(left.anchor.path), Buffer.from(right.anchor.path)) ||
      left.anchor.start - right.anchor.start ||
      left.anchor.end - right.anchor.end,
  );
  if (query.offset > ordered.length) throw new Error("PROJECT_MAP_REFERENCE_CURSOR_INVALID");
  const selected = ordered.slice(query.offset, query.offset + query.maxResults);
  const next = query.offset + selected.length;
  return {
    references: selected,
    ...(next < ordered.length ? { nextOffset: next } : {}),
    requiredFiles: [],
  };
}

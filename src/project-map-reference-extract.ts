import {
  getTokenAtPosition,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isIndexedAccessTypeNode,
  isLiteralTypeNode,
  isNewExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/async";
import { mapQueryPathMatches } from "./project-map-query-selection";
import type {
  MapReferenceBatch,
  MapReferencePage,
  MapReferenceRequest,
} from "./project-map-reference-types";
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

/**
 * Where a type's index names the symbol at the given token, as T["total"] does. The compiler's
 * search skips a file that does not name what it looks for, and a string in a type's index is no
 * name to it, so it finds these only in a file that also says .total.
 */
async function indexedAccesses(
  project: Project,
  input: MapWorkerInput,
  token: Node,
): Promise<readonly Node[]> {
  const target = await project.checker.getSymbolAtLocation(token);
  if (!target) return [];
  const name = (token as Node & { text: string }).text;
  const index = new RegExp(
    `\\[\\s*(["'\`])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\1`,
    "gu",
  );
  const literals: Node[] = [];
  for (const [path, text] of Object.entries(input.files)) {
    const matches = [...text.matchAll(index)];
    const file = matches.length && (await project.program.getSourceFile(mapVirtualPath(path)));
    if (!file) continue;
    for (const match of matches) {
      const literal = getTokenAtPosition(file, match.index + match[0].length - name.length - 2);
      const type = literal.parent;
      if (isLiteralTypeNode(type) && isIndexedAccessTypeNode(type.parent)) literals.push(literal);
    }
  }
  if (!literals.length) return [];
  // An index on a generic or a union names one symbol standing for the same member of each type.
  const declarations = new Set(target.declarations.map((node) => `${node.path}:${node.index}`));
  const symbols = await project.checker.getSymbolAtLocation(literals);
  return literals.filter((_, at) =>
    symbols[at]?.declarations.some((node) => declarations.has(`${node.path}:${node.index}`)),
  );
}

async function extractPage(
  project: Project,
  input: MapWorkerInput,
  positions: MapSourcePositions,
  query: MapReferenceRequest,
): Promise<MapReferencePage | null> {
  const file = await project.program.getSourceFile(mapVirtualPath(query.targetPath));
  if (!file) return null;
  const token = getTokenAtPosition(file, query.symbolStart);
  if (
    !isIdentifier(token) &&
    !isPrivateIdentifier(token) &&
    token.kind !== SyntaxKind.StringLiteral
  )
    return null;
  const groups = await project.checker.getReferencedSymbolsForNode(token, query.symbolStart);
  if (!groups.length) return null;
  const references = new Map<string, MapReferencePage["references"][number]>();
  const add = (node: Node) => {
    const relative = mapRelativePath(node.getSourceFile().fileName);
    if (!relative || !Object.hasOwn(input.files, relative)) return;
    if (!mapQueryPathMatches(relative, query.path ?? ".")) return;
    const kind = referenceKind(node);
    if (query.kinds && !query.kinds.includes(kind)) return;
    const anchor = positions.anchor(node, node.getSourceFile());
    references.set(`${relative}:${anchor.start}:${anchor.end}`, {
      anchor,
      kind,
    });
  };
  for (const group of groups) {
    for (const handle of group.references) {
      if (mapRelativePath(handle.path) === undefined) continue;
      const node = await handle.resolve(project);
      if (!node) return null;
      add(node);
    }
  }
  for (const node of await indexedAccesses(project, input, token)) add(node);
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
  };
}

/** Every request's page from one compile; past the deadline, a compile's first is still read. */
export async function extractMapReferences(
  project: Project,
  input: MapWorkerInput,
  requests: readonly MapReferenceRequest[],
  until = Number.POSITIVE_INFINITY,
): Promise<MapReferenceBatch> {
  const positions = new MapSourcePositions(input.files);
  const pages: MapReferenceBatch["pages"] = [];
  for (const query of requests) {
    if (pages.length && Date.now() > until) break;
    pages.push(await extractPage(project, input, positions, query));
  }
  return { pages, requiredFiles: [] };
}

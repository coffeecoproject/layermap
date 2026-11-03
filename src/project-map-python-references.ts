import { type Declaration, DeclarationType } from "pyright-internal/analyzer/declaration";
import { ParseTreeWalker } from "pyright-internal/analyzer/parseTreeWalker";
import type { TypeEvaluator } from "pyright-internal/analyzer/typeEvaluatorTypes";
import {
  type AssignmentNode,
  type AugmentedAssignmentNode,
  type CallNode,
  type ClassNode,
  type DelNode,
  type FunctionNode,
  type MemberAccessNode,
  type NameNode,
  type ParameterNode,
  type ParseNode,
  ParseNodeType,
  type TypeAnnotationNode,
} from "pyright-internal/parser/parseNodes";
import type { PythonProgram } from "./project-map-python-host";

type ReferenceKind = "DECLARATION" | "CALL" | "READ" | "WRITE" | "IMPORT_EXPORT" | "REFERENCE";
type PythonReferencePage = {
  references: { path: string; start: number; end: number; kind: ReferenceKind }[];
};
export type PythonReferenceFacts = { pages: (PythonReferencePage | null)[] };

class Names extends ParseTreeWalker {
  readonly found: NameNode[] = [];
  constructor(private readonly names?: ReadonlySet<string>) {
    super();
  }
  override visitName(node: NameNode) {
    if (!this.names || this.names.has(node.d.value)) this.found.push(node);
    return false;
  }
}

// Where a declaration's name sits; declarations of one symbol share nothing else comparable.
function declarationKey(declaration: Declaration) {
  const node = declaration.node;
  const name =
    declaration.type === DeclarationType.Function || declaration.type === DeclarationType.Class
      ? (node as FunctionNode | ClassNode).d.name
      : declaration.type === DeclarationType.Param
        ? (node as ParameterNode).d.name
        : node;
  return name ? `${declaration.uri.key}:${name.start}` : undefined;
}

function resolved(evaluator: TypeEvaluator, name: NameNode) {
  return (evaluator.getDeclInfoForNameNode(name)?.decls ?? []).map((declaration) =>
    declaration.type === DeclarationType.Alias
      ? (evaluator.resolveAliasDeclaration(declaration, true) ?? declaration)
      : declaration,
  );
}

function isTarget(expression: ParseNode) {
  const parent = expression.parent;
  if (!parent) return false;
  if (parent.nodeType === ParseNodeType.TypeAnnotation)
    return (
      (parent as TypeAnnotationNode).d.valueExpr === expression &&
      (parent.parent?.nodeType !== ParseNodeType.Assignment ||
        (parent.parent as AssignmentNode).d.leftExpr === parent)
    );
  if (parent.nodeType === ParseNodeType.Assignment)
    return (parent as AssignmentNode).d.leftExpr === expression;
  if (parent.nodeType === ParseNodeType.AugmentedAssignment)
    return (parent as AugmentedAssignmentNode).d.leftExpr === expression;
  if (parent.nodeType === ParseNodeType.Del)
    return (parent as DelNode).d.targets.includes(expression);
  if (parent.nodeType === ParseNodeType.Tuple || parent.nodeType === ParseNodeType.List)
    return isTarget(parent);
  return false;
}

function kindOf(name: NameNode, declarations: readonly Declaration[]): ReferenceKind {
  const parent = name.parent;
  switch (parent?.nodeType) {
    case ParseNodeType.Function:
    case ParseNodeType.Class:
      if ((parent as FunctionNode | ClassNode).d.name === name) return "DECLARATION";
      break;
    case ParseNodeType.Parameter:
      return "DECLARATION";
    case ParseNodeType.ImportAs:
    case ParseNodeType.ImportFromAs:
    case ParseNodeType.ModuleName:
      return "IMPORT_EXPORT";
  }
  const expression =
    parent?.nodeType === ParseNodeType.MemberAccess &&
    (parent as MemberAccessNode).d.member === name
      ? parent
      : name;
  const call = expression.parent;
  if (call?.nodeType === ParseNodeType.Call && (call as CallNode).d.leftExpr === expression)
    return "CALL";
  if (isTarget(expression))
    return declarations.some((declaration) => declaration.node === name) ? "DECLARATION" : "WRITE";
  return declarations.some(
    (declaration) =>
      declaration.type === DeclarationType.Function || declaration.type === DeclarationType.Class,
  )
    ? "REFERENCE"
    : "READ";
}

/**
 * Every use in the program of the declarations whose names start at the target offsets, in one walk
 * of its names. A target that names no declaration has a null page.
 */
export function findPythonReferences(
  source: PythonProgram,
  targets: readonly Readonly<{ path: string; offset: number }>[],
): PythonReferenceFacts {
  const evaluator = source.program.evaluator;
  if (!evaluator) throw new Error("PROJECT_MAP_ANALYSIS_FAILED");
  const named = new Map<string, Map<number, NameNode>>();
  const namesIn = (path: string) => {
    const known = named.get(path);
    if (known) return known;
    const all = new Names();
    const parsed = source.program.getParseResults(source.uriOf(path));
    if (parsed) all.walk(parsed.parserOutput.parseTree);
    const found = new Map(all.found.map((node) => [node.start, node]));
    named.set(path, found);
    return found;
  };
  // The pages wanted of each name, by the declarations each is a page of.
  const wanted = new Map<string, { keys: ReadonlySet<string>; page: PythonReferencePage }[]>();
  const pages = targets.map((target) => {
    const at = namesIn(target.path).get(target.offset);
    if (!at) return null;
    const keys = new Set(
      resolved(evaluator, at)
        .map(declarationKey)
        .filter((key) => key !== undefined),
    );
    const page: PythonReferencePage = { references: [] };
    wanted.set(at.d.value, [...(wanted.get(at.d.value) ?? []), { keys, page }]);
    return page;
  });
  for (const path of source.paths) {
    const uri = source.uriOf(path);
    const tree = source.program.getParseResults(uri)?.parserOutput.parseTree;
    if (!tree) continue;
    source.program.getBoundSourceFile(uri);
    const names = new Names(new Set(wanted.keys()));
    names.walk(tree);
    for (const name of names.found) {
      const found = resolved(evaluator, name);
      const declared = found.map((declaration) => declarationKey(declaration) ?? "");
      for (const { keys, page } of wanted.get(name.d.value) ?? [])
        if (declared.some((key) => keys.has(key)))
          page.references.push({
            path,
            start: name.start,
            end: name.start + name.length,
            kind: kindOf(name, found),
          });
    }
  }
  return { pages };
}

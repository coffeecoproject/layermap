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
export type PythonReferenceFacts = {
  references: { path: string; start: number; end: number; kind: ReferenceKind }[];
};

class Names extends ParseTreeWalker {
  readonly found: NameNode[] = [];
  constructor(private readonly name?: string) {
    super();
  }
  override visitName(node: NameNode) {
    if (this.name === undefined || node.d.value === this.name) this.found.push(node);
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

/** Every use in the program of the declaration whose name starts at the target offset. */
export function findPythonReferences(
  source: PythonProgram,
  target: Readonly<{ path: string; offset: number }>,
): PythonReferenceFacts {
  const evaluator = source.program.evaluator;
  if (!evaluator) throw new Error("PROJECT_MAP_ANALYSIS_FAILED");
  const parsed = source.program.getParseResults(source.uriOf(target.path));
  if (!parsed) throw new Error("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE");
  const all = new Names();
  all.walk(parsed.parserOutput.parseTree);
  const at = all.found.find((node) => node.start === target.offset);
  if (!at) throw new Error("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE");
  const declarations = resolved(evaluator, at);
  const keys = new Set(declarations.map(declarationKey).filter((key) => key !== undefined));
  const references: PythonReferenceFacts["references"] = [];
  for (const path of source.paths) {
    const uri = source.uriOf(path);
    const tree = source.program.getParseResults(uri)?.parserOutput.parseTree;
    if (!tree) continue;
    source.program.getBoundSourceFile(uri);
    const names = new Names(at.d.value);
    names.walk(tree);
    for (const name of names.found) {
      const found = resolved(evaluator, name);
      if (!found.some((declaration) => keys.has(declarationKey(declaration) ?? ""))) continue;
      references.push({
        path,
        start: name.start,
        end: name.start + name.length,
        kind: kindOf(name, found),
      });
    }
  }
  return { references };
}

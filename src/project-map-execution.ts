import { type Node, SyntaxKind } from "typescript/unstable/ast";
import { mapDeclarationKind, mapDeclarationName, mapNodeLabel } from "./project-map-declarations";
import type { MapObject } from "./project-map-types";

type ExecutableNode = Node & {
  body?: Node;
  initializer?: Node;
  parameters?: readonly Node[];
  expression?: Node;
};

const callableKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);
const expressionWrappers = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
]);

export const mapIsCallable = (node: Node): boolean => callableKinds.has(node.kind);

export function mapUnwrapExpression(node: Node): Node {
  let current = node;
  while (expressionWrappers.has(current.kind) && (current as ExecutableNode).expression)
    current = (current as ExecutableNode).expression as Node;
  return current;
}

// A binding and its directly assigned function have one navigation identity. Nested
// functions in a conditional or call argument remain separate executable scopes.
export function mapCallableCarrier(node: Node): Node | undefined {
  if (![SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression].includes(node.kind))
    return undefined;
  let expression = node;
  while (expression.parent && expressionWrappers.has(expression.parent.kind))
    expression = expression.parent;
  const parent = expression.parent as ExecutableNode | undefined;
  if (parent?.kind === SyntaxKind.ExportAssignment && parent.expression === expression)
    return parent;
  if (
    parent?.initializer === expression &&
    [
      SyntaxKind.VariableDeclaration,
      SyntaxKind.PropertyDeclaration,
      SyntaxKind.PropertyAssignment,
      SyntaxKind.Parameter,
      SyntaxKind.BindingElement,
    ].includes(parent.kind) &&
    mapDeclarationName(parent)
  )
    return parent;
  return undefined;
}

type ValueParent = Node & {
  expression?: Node;
  initializer?: Node;
  condition?: Node;
  body?: Node;
  left?: Node;
  operatorToken?: Node;
};
const choosingOperators = new Set([SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken]);
const assigningOperators = new Set([
  ...choosingOperators,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const valueContext = (node: Node) => {
  let expression = node;
  while (expression.parent && expressionWrappers.has(expression.parent.kind))
    expression = expression.parent;
  return { expression, parent: expression.parent as ValueParent | undefined };
};

// A name used here without being called is stored, passed, returned or selected as a value;
// whatever receives it usually invokes it later.
export function mapValueUse(node: Node): boolean {
  const { expression, parent } = valueContext(node);
  switch (parent?.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
      return parent.expression !== expression;
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertyAssignment:
      return parent.initializer === expression;
    case SyntaxKind.ConditionalExpression:
      return parent.condition !== expression;
    case SyntaxKind.BinaryExpression: {
      const operator = parent.operatorToken?.kind;
      if (operator === undefined) return false;
      return parent.left === expression
        ? choosingOperators.has(operator)
        : assigningOperators.has(operator);
    }
    case SyntaxKind.ArrowFunction:
      return parent.body === expression;
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.JsxExpression:
      return true;
    default:
      return false;
  }
}

// An object member that stores the value keeps its own identity, so calls through it link too.
export function mapValueProperty(node: Node): Node | undefined {
  const { expression, parent } = valueContext(node);
  return parent?.kind === SyntaxKind.PropertyAssignment && parent.initializer === expression
    ? parent
    : undefined;
}

export function mapExecutionKind(node: Node): MapObject["execution"] {
  if (node.kind === SyntaxKind.SourceFile) return "MODULE";
  if (node.kind === SyntaxKind.Constructor) return "CONSTRUCTOR";
  if (node.kind === SyntaxKind.ClassStaticBlockDeclaration) return "INITIALIZER";
  if (mapIsCallable(node)) {
    if ([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression].includes(node.kind))
      return "CLOSURE";
    // A signature without a body (abstract, an overload, declared) runs nothing itself.
    return (node as ExecutableNode).body ? "FUNCTION" : undefined;
  }
  const initializer =
    node.kind === SyntaxKind.ExportAssignment
      ? (node as ExecutableNode).expression
      : (node as ExecutableNode).initializer;
  if (initializer) {
    const value = mapUnwrapExpression(initializer);
    if (mapCallableCarrier(value) === node) return "CLOSURE";
    if (node.kind === SyntaxKind.PropertyDeclaration) return "INITIALIZER";
  }
  return undefined;
}

export function mapExecutionDeclaration(
  node: Node,
): { kind: MapObject["kind"]; name: string } | undefined {
  if (mapIsCallable(node)) {
    if (mapCallableCarrier(node)) return undefined;
    const name = mapDeclarationName(node);
    return {
      kind:
        node.kind === SyntaxKind.Constructor ? "METHOD" : (mapDeclarationKind(node) ?? "FUNCTION"),
      name: name
        ? mapNodeLabel(name)
        : node.kind === SyntaxKind.Constructor
          ? "constructor"
          : node.kind === SyntaxKind.FunctionDeclaration
            ? "default"
            : mapDeclarationKind(node) === "METHOD"
              ? "<computed method>"
              : "<anonymous function>",
    };
  }
  if (node.kind === SyntaxKind.ClassStaticBlockDeclaration)
    return { kind: "METHOD", name: "<static initializer>" };
  if (node.kind === SyntaxKind.PropertyDeclaration && !mapDeclarationName(node))
    return { kind: "PROPERTY", name: "<computed property>" };
  if (mapExecutionKind(node) === "CLOSURE") {
    if (node.kind === SyntaxKind.ExportAssignment) return { kind: "FUNCTION", name: "default" };
    const name = mapDeclarationName(node);
    const kind = mapDeclarationKind(node, true);
    if (name && kind) return { kind, name: mapNodeLabel(name) };
  }
  return undefined;
}

export function mapChildExecutionOwner(
  node: Node,
  child: Node,
  scope: MapObject,
  enclosing: MapObject,
  declarationExecution: MapObject,
): MapObject {
  const executable = node as ExecutableNode;
  if (mapIsCallable(node)) {
    // Computed names and decorators run where a declaration is evaluated; only
    // parameters and the body belong to the callable's execution scope.
    return child === executable.body || executable.parameters?.includes(child) ? scope : enclosing;
  }
  if (node.kind === SyntaxKind.Parameter && child.kind === SyntaxKind.Decorator)
    return declarationExecution;
  if (
    (node.kind === SyntaxKind.PropertyDeclaration &&
      scope.execution === "INITIALIZER" &&
      child === executable.initializer) ||
    (node.kind === SyntaxKind.ClassStaticBlockDeclaration && child === executable.body)
  )
    return scope;
  return enclosing;
}

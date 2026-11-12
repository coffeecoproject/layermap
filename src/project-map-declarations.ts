import {
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isParenthesizedExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { MapObject } from "./project-map-types";

export function mapDeclarationKind(node: Node, linked = false): MapObject["kind"] | undefined {
  if (isFunctionDeclaration(node)) return "FUNCTION";
  if (isClassDeclaration(node)) return "CLASS";
  if (isInterfaceDeclaration(node)) return "INTERFACE";
  if (isTypeAliasDeclaration(node)) return "TYPE";
  if (
    isMethodDeclaration(node) ||
    [SyntaxKind.MethodSignature, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor].includes(node.kind)
  )
    return "METHOD";
  if (isPropertyDeclaration(node) || node.kind === SyntaxKind.PropertySignature) return "PROPERTY";
  if (
    node.kind === SyntaxKind.PropertyAssignment &&
    [SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression].includes(
      (node as Node & { initializer: Node }).initializer.kind,
    )
  )
    return "METHOD";
  if (isVariableDeclaration(node)) return mapRequireBinding(node) ? undefined : "VARIABLE";
  if (isEnumDeclaration(node)) return "ENUM";
  if (!linked) return undefined;
  if ([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment].includes(node.kind))
    return "PROPERTY";
  if (node.kind === SyntaxKind.BindingElement) {
    let at = node.parent;
    while (at && !isVariableDeclaration(at)) at = at.parent;
    return at && mapRequireBinding(at) ? undefined : "VARIABLE";
  }
  if (node.kind === SyntaxKind.Parameter) {
    const property = (node as Node & { modifiers?: readonly Node[] }).modifiers?.some((modifier) =>
      [
        SyntaxKind.PublicKeyword,
        SyntaxKind.PrivateKeyword,
        SyntaxKind.ProtectedKeyword,
        SyntaxKind.ReadonlyKeyword,
      ].includes(modifier.kind),
    );
    return property ? "PROPERTY" : "VARIABLE";
  }
  return undefined;
}

export const mapDeclarationName = (node: Node): Node | undefined => {
  const name = (node as Node & { name?: Node }).name;
  return name && (isIdentifier(name) || isPrivateIdentifier(name) || isStringLiteral(name))
    ? name
    : isFunctionValue(node)
      ? mapExportedAs(node)
      : undefined;
};

const isFunctionValue = (node: Node) =>
  node.kind === SyntaxKind.ArrowFunction || node.kind === SyntaxKind.FunctionExpression;
/**
 * Whether a variable binds what a CommonJS require gives, as const fs = require("node:fs") or
 * const { join } = require("node:path").posix do: an import, not a declaration of the file.
 */
export function mapRequireBinding(node: Node): boolean {
  if (!isVariableDeclaration(node) || !node.initializer) return false;
  let value = unwrap(node.initializer);
  while (isPropertyAccessExpression(value)) value = unwrap(value.expression);
  return (
    isCallExpression(value) &&
    isIdentifier(value.expression) &&
    value.expression.text === "require" &&
    value.arguments.length === 1 &&
    isStringLiteral(value.arguments[0] as Node)
  );
}

const unwrap = (node: Node): Node =>
  isParenthesizedExpression(node) || isAsExpression(node) ? unwrap(node.expression) : node;
const isExports = (node: Node) =>
  (isIdentifier(node) && node.text === "exports") ||
  (isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports");

// The assignment a CommonJS module exports a value by, `exports.getUser = value` or
// `module.exports.getUser = value`, from the assignment or its left side.
function exportAssignment(node: Node) {
  const assignment =
    isPropertyAccessExpression(node) && node.parent && isBinaryExpression(node.parent)
      ? node.parent
      : node;
  return isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === SyntaxKind.EqualsToken &&
    isPropertyAccessExpression(assignment.left) &&
    isExports(assignment.left.expression)
    ? { assignment, name: assignment.left.name }
    : undefined;
}

/**
 * The name a CommonJS module exports a function under, for a function it assigns to exports as
 * `exports.getUser = (req, res) => ...`, or passes to the wrapper whose result it assigns:
 * `exports.getUser = catchAsync(async (req, res) => ...)`.
 */
export function mapExportedAs(node: Node): Node | undefined {
  let value = node;
  while (value.parent && (isParenthesizedExpression(value.parent) || isAsExpression(value.parent)))
    value = value.parent;
  const call = value.parent;
  if (
    call &&
    isCallExpression(call) &&
    call.arguments.find((argument) => isFunctionValue(unwrap(argument))) === value
  )
    value = call;
  while (value.parent && (isParenthesizedExpression(value.parent) || isAsExpression(value.parent)))
    value = value.parent;
  const exported = value.parent && exportAssignment(value.parent);
  return exported && exported.assignment.right === value ? exported.name : undefined;
}

/**
 * The function a CommonJS export declares, from the declaration the compiler gives for it (the
 * assignment or its left side), and whether a wrapper's call returns it rather than the
 * function itself being assigned.
 */
export function mapExportedFunction(node: Node): { node: Node; wrapped: boolean } | undefined {
  const exported = exportAssignment(node);
  if (!exported) return undefined;
  const value = unwrap(exported.assignment.right);
  if (isFunctionValue(value)) return { node: value, wrapped: false };
  if (!isCallExpression(value)) return undefined;
  const argument = value.arguments.find((item) => isFunctionValue(unwrap(item)));
  return argument ? { node: unwrap(argument), wrapped: true } : undefined;
}

export function mapNodeLabel(node: Node): string {
  if (isIdentifier(node) || isPrivateIdentifier(node) || isStringLiteral(node)) return node.text;
  if (isPropertyAccessExpression(node))
    return `${mapNodeLabel(node.expression)}.${mapNodeLabel(node.name)}`;
  // A computed key names its receiver; the key itself is only known at runtime.
  if (isElementAccessExpression(node)) return `${mapNodeLabel(node.expression)}[…]`;
  if (node.kind === SyntaxKind.ThisKeyword) return "this";
  if (node.kind === SyntaxKind.SuperKeyword) return "super";
  return `<${SyntaxKind[node.kind]}>`;
}

import {
  isClassDeclaration,
  isElementAccessExpression,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
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
  if (isVariableDeclaration(node)) return "VARIABLE";
  if (isEnumDeclaration(node)) return "ENUM";
  if (!linked) return undefined;
  if ([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment].includes(node.kind))
    return "PROPERTY";
  if (node.kind === SyntaxKind.BindingElement) return "VARIABLE";
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
    : undefined;
};

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

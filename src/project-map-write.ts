import { isBinaryExpression, type Node, SyntaxKind } from "typescript/unstable/ast";

export function isMapWrite(node: Node): boolean {
  const parent = node.parent;
  if (isBinaryExpression(parent))
    return (
      parent.left === node &&
      parent.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= SyntaxKind.LastAssignment
    );
  if (
    parent.kind !== SyntaxKind.PrefixUnaryExpression &&
    parent.kind !== SyntaxKind.PostfixUnaryExpression
  )
    return false;
  const operator = (parent as Node & { operator: SyntaxKind }).operator;
  return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
}

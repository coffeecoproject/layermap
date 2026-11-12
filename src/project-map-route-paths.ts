import {
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  NodeFlags,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { type Project, SymbolFlags } from "typescript/unstable/async";
import { constDeclaration, httpMethod } from "./project-map-routes";

// Paths that code builds from constants rather than spells out: a route registered as
// app.get(`${root}/items`, list), or a test requesting it as inject({ url: `${ITEMS}/${id}` }) with
// ITEMS imported from another module. Their text is worked out from the const declarations the
// names refer to, in this file or, through the compiler, in another.

/** A part of a requested path no constant gives, as a parameter does: `${id}`. */
export const MAP_PATH_PARAMETER = "{}";
const MAX = 256;
// Callees whose first argument is a path: routers registering routes, clients requesting them.
const ROUTER = new Set(["route", "all"]);
const CLIENT = new Set(["request", "fetch", "inject", "visit", "goto"]);
// Object properties holding a path a request is sent to.
const REQUEST_PROPERTY = new Set(["url", "path", "uri", "endpoint"]);

const unwrap = (node: Node): Node =>
  isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
const literal = (node: Node) =>
  isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
const computed = (node: Node) => {
  const inner = unwrap(node);
  return (
    isIdentifier(inner) ||
    isTemplateExpression(inner) ||
    (isBinaryExpression(inner) && inner.operatorToken.kind === SyntaxKind.PlusToken)
  );
};
const calleeName = (call: Node & { expression: Node }) =>
  isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : isIdentifier(call.expression)
      ? call.expression.text
      : undefined;

/** The paths of one file that its code computes: route registrations, and in tests, requests. */
export type MapFilePaths = Readonly<{
  /** Registration path arguments, by node: what the route is registered under. */
  registered: ReadonlyMap<Node, string>;
  /** Paths tests request, by the expression giving them; unknown parts are MAP_PATH_PARAMETER. */
  requested: ReadonlyMap<Node, string>;
}>;

export class MapPathFolder {
  private readonly symbols = new Map<number, Promise<string | undefined>>();
  // Constants being worked out: one met again while its value is worked out refers to itself,
  // through imports, and has none.
  private readonly folding = new Set<number>();
  constructor(private readonly project: Project | undefined) {}

  /** The computed registration paths of a file and, for a test file, the paths it requests. */
  async file(file: SourceFile, test: boolean): Promise<MapFilePaths> {
    const registered = new Map<Node, string>();
    const requested = new Map<Node, string>();
    const registrations: Node[] = [];
    const requests: Node[] = [];
    const visit = (node: Node) => {
      if (isCallExpression(node)) {
        const name = calleeName(node);
        const first = node.arguments[0];
        if (first && name) {
          if (
            !test &&
            isPropertyAccessExpression(node.expression) &&
            (httpMethod(name) || ROUTER.has(name)) &&
            // A handler follows the path, or a method of the route the call sets up adds one:
            // router.route(PATH).get(list). One argument alone is a lookup, as map.get(key) is.
            (node.arguments.length > 1 || name === "route") &&
            computed(first)
          )
            registrations.push(first);
          if (test && (httpMethod(name) || CLIENT.has(name))) requests.push(first);
        }
      } else if (
        test &&
        isPropertyAssignment(node) &&
        isObjectLiteralExpression(node.parent) &&
        (isIdentifier(node.name) || isStringLiteral(node.name)) &&
        REQUEST_PROPERTY.has(node.name.text)
      )
        requests.push(node.initializer);
      node.forEachChild((child) => {
        visit(child);
      });
    };
    visit(file);
    // Whether a value is a route path is for registeredRoute to judge, as for a literal.
    for (const node of registrations) {
      const value = await this.fold(node, false, 0);
      if (value !== undefined) registered.set(node, value);
    }
    for (const node of requests) {
      const value = await this.fold(node, true, 0);
      const path = value && requestPath(value);
      if (path) requested.set(node, path);
    }
    return { registered, requested };
  }

  /**
   * The string an expression gives: literals, template strings and + joined from them and from
   * const declarations. Loosely, a part nothing gives is a parameter; otherwise there is none.
   */
  async fold(node: Node, loose: boolean, depth: number): Promise<string | undefined> {
    if (depth > 8) return undefined;
    node = unwrap(node);
    const text = literal(node);
    if (text !== undefined) return text.length <= MAX ? text : undefined;
    const part = async (child: Node) =>
      (await this.fold(child, false, depth + 1)) ?? (loose ? MAP_PATH_PARAMETER : undefined);
    let joined: string | undefined;
    if (isTemplateExpression(node)) {
      joined = node.head.text;
      for (const span of node.templateSpans) {
        const value = await part(span.expression);
        if (value === undefined) return undefined;
        joined += value + span.literal.text;
      }
    } else if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
      const left = await part(node.left);
      const right = left === undefined ? undefined : await part(node.right);
      if (left === undefined || right === undefined) return undefined;
      joined = left + right;
    } else if (isIdentifier(node)) return this.constant(node, depth);
    return joined !== undefined && joined.length <= MAX ? joined : undefined;
  }

  // The value of the const declaration a name refers to: one in scope in its file, else the one
  // the compiler resolves it to, through imports.
  private async constant(
    name: Node & { text: string },
    depth: number,
  ): Promise<string | undefined> {
    const local = constDeclaration(name);
    if (local) return this.fold(local, false, depth + 1);
    if (!this.project) return undefined;
    let symbol = await this.project.checker.getSymbolAtLocation(name);
    if (!symbol) return undefined;
    if (symbol.flags & SymbolFlags.Alias)
      symbol = await this.project.checker.getAliasedSymbol(symbol);
    const id = symbol.id;
    if (this.folding.has(id)) return undefined;
    const known = this.symbols.get(id);
    if (known) return known;
    const handle = symbol.declarations.length === 1 ? symbol.declarations[0] : undefined;
    const project = this.project;
    const value = (async () => {
      this.folding.add(id);
      try {
        const declaration = handle && (await handle.resolve(project));
        if (
          !declaration ||
          !isVariableDeclaration(declaration) ||
          !declaration.initializer ||
          !(declaration.parent.flags & NodeFlags.Const)
        )
          return undefined;
        return await this.fold(declaration.initializer, false, depth + 1);
      } finally {
        this.folding.delete(id);
      }
    })();
    this.symbols.set(id, value);
    return value;
  }
}

// The path of a requested URL: after a scheme and host, or a base the test computes, as in
// `${baseUrl}/orders`, without a query or fragment. One that is all parameters says nothing of
// which route it requests.
function requestPath(value: string): string | undefined {
  const path = /^(?:https?:\/\/[^/\s]+|(?:\{\})+)?(\/[^\s?#]*)/u.exec(value)?.[1];
  if (!path || path.startsWith("//")) return undefined;
  return path
    .split("/")
    .some((segment) => segment.length >= 2 && !segment.includes(MAP_PATH_PARAMETER))
    ? path
    : undefined;
}

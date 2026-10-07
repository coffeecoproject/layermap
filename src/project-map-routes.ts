import {
  type CallExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  NodeFlags,
  SyntaxKind,
} from "typescript/unstable/ast";

// Routes in TypeScript and JavaScript, found by the same syntactic rules as in Go: an argument
// after a call's path literal is registered under that path, as router.get("/users", list) and
// app.post("/users", auth, async (req, res) => { … }) register handlers.

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]);
// A path, optionally after a method, as route patterns are written: "/v1/users", "GET /v1/users";
// a sentence that starts with a slash, as a test's name can, is not one.
const PATH = /^(?:[A-Z]+ +)?\/\S*$/u;

const text = (node: Node | undefined) =>
  node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const pathText = (node: Node | undefined) => {
  const value = text(node);
  return value !== undefined && value.length <= 256 && PATH.test(value) ? value : undefined;
};
const isFunction = (node: Node) =>
  node.kind === SyntaxKind.ArrowFunction || node.kind === SyntaxKind.FunctionExpression;
// Named declarations end a registration's reach: code in them runs when they are called.
const isDeclaration = (node: Node) =>
  node.kind === SyntaxKind.FunctionDeclaration ||
  node.kind === SyntaxKind.MethodDeclaration ||
  node.kind === SyntaxKind.ClassDeclaration ||
  node.kind === SyntaxKind.SourceFile;

/** A path joined to the prefix it is registered under, with one slash between them. */
export function joinRoute(prefix: string, path: string): string {
  const joined = !prefix
    ? path
    : !path
      ? prefix
      : `${prefix.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
  return joined.startsWith("/") || joined.startsWith("$") ? joined : `/${joined}`;
}

/** The HTTP method a name is spelled as (get, GET, Get), if any. */
export const httpMethod = (name: string) =>
  HTTP_METHODS.has(name.toUpperCase()) ? name.toUpperCase() : undefined;

/**
 * The route a call or value use is registered under: it is, or is inside a function that is, an
 * argument after a registration's path. A call passed directly counts only where the
 * registration is named for an HTTP method (router.get("/users", auth("admin"), list)), since a
 * path and a computed value otherwise say little: fetch("/api/users", options()). Functions in
 * an options object are callbacks of a request, not handlers: useAction("/start", { onSuccess }).
 */
export function registeredRoute(node: Node, kind: "CALLS" | "REFERENCES"): string | undefined {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (isCallExpression(parent) && parent.arguments.includes(child as never)) {
      const registration = routeOf(parent, parent.arguments.indexOf(child as never));
      const direct = child === node && (kind === "REFERENCES" || registration?.method);
      if (registration && (isFunction(child) || direct)) return registration.label;
    }
    if (isDeclaration(parent)) return undefined;
  }
  return undefined;
}

type Registration = { label: string; method?: string };

// What a call registers the argument at index under, if that argument follows its path.
function routeOf(call: CallExpression, index: number): Registration | undefined {
  const callee = call.expression;
  const name = isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  let path: string | undefined;
  let receiver: Node | undefined = isPropertyAccessExpression(callee)
    ? callee.expression
    : undefined;
  const at = call.arguments.findIndex((argument) => pathText(argument) !== undefined);
  if (at >= 0) {
    if (index <= at) return undefined;
    path = pathText(call.arguments[at]);
  } else if (
    name &&
    httpMethod(name) &&
    receiver &&
    isCallExpression(receiver) &&
    isPropertyAccessExpression(receiver.expression) &&
    receiver.arguments.length === 1
  ) {
    // A handler attached by method to a route the router method before it set up:
    // router.route("/users").get(list), but not fetch("/users").then(read).
    path = pathText(receiver.arguments[0]);
    receiver = receiver.expression.expression;
  }
  if (path === undefined) return undefined;
  let method: string | undefined;
  const space = path.indexOf(" ");
  if (space > 0) [method, path] = [path.slice(0, space), path.slice(space).trimStart()];
  method ??= name ? httpMethod(name) : undefined;
  // "/" alone is a key as often as a route (keys.on("/", openSearch)): only a registration named
  // for an HTTP method makes it one.
  if (path === "/" && !method) return undefined;
  const full = joinRoute(receiver ? routerPrefix(receiver, 0) : "", path);
  const label = method ? `${method} ${full}` : full;
  return label.length <= 256 ? { label, ...(method ? { method } : {}) } : { label: path };
}

// The path a router expression adds to routes registered on it: the path literals of the method
// calls that made it, as new Hono().basePath("/api") does, followed through const declarations.
function routerPrefix(expression: Node, depth: number): string {
  if (depth > 8) return "";
  if (isCallExpression(expression)) {
    const callee = expression.expression;
    if (!isPropertyAccessExpression(callee)) return "";
    const base = routerPrefix(callee.expression, depth + 1);
    const path = expression.arguments.length === 1 ? pathText(expression.arguments[0]) : undefined;
    return path === undefined || path.includes(" ") ? base : joinRoute(base, path);
  }
  if (isIdentifier(expression)) {
    const declaration = constDeclaration(expression);
    return declaration ? routerPrefix(declaration, depth + 1) : "";
  }
  return "";
}

// The initializer of the const declaration in the same file that a name refers to, by scope.
function constDeclaration(name: Node & { text: string }): Node | undefined {
  for (let scope = name.parent; scope; scope = scope.parent) {
    const statements = (scope as Node & { statements?: readonly Node[] }).statements;
    for (const statement of statements ?? []) {
      if (statement.kind !== SyntaxKind.VariableStatement) continue;
      const list = (
        statement as Node & { declarationList: Node & { declarations: readonly Node[] } }
      ).declarationList;
      if (!(list.flags & NodeFlags.Const)) continue;
      for (const declaration of list.declarations) {
        const { name: bound, initializer } = declaration as Node & {
          name: Node;
          initializer?: Node;
        };
        if (isIdentifier(bound) && bound.text === name.text && initializer) return initializer;
      }
    }
  }
  return undefined;
}

/**
 * The route a member's decorator maps, as NestJS's @Get(":id") does inside @Controller("users"):
 * the HTTP method the decorator is named for, then the class decorator's path joined with its own.
 */
export function decoratorRoute(
  decorator: Node & { expression: Node },
  argument: string | undefined,
): string | undefined {
  const call = isCallExpression(decorator.expression) ? decorator.expression : undefined;
  const callee = call ? call.expression : decorator.expression;
  const name = isIdentifier(callee)
    ? callee.text
    : isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  // Only a decorator spelled as the method itself: @Get or @GET, not @Getter.
  const method =
    name && (name === name.toUpperCase() || /^[A-Z][a-z]+$/u.test(name))
      ? httpMethod(name)
      : undefined;
  if (!method) return undefined;
  const member = decorator.parent;
  const owner = member?.parent;
  let prefix = "";
  if (owner?.kind === SyntaxKind.ClassDeclaration || owner?.kind === SyntaxKind.ClassExpression)
    for (const modifier of (owner as Node & { modifiers?: readonly Node[] }).modifiers ?? []) {
      if (modifier.kind !== SyntaxKind.Decorator) continue;
      const expression = (modifier as Node & { expression: Node }).expression;
      const value = isCallExpression(expression) ? text(expression.arguments[0]) : undefined;
      if (value !== undefined && value.length <= 256) {
        prefix = value;
        break;
      }
    }
  const path = argument ?? (call && text(call.arguments[0])) ?? "";
  const route = `${method} ${joinRoute(prefix, path)}`;
  return route.length <= 256 ? route : undefined;
}

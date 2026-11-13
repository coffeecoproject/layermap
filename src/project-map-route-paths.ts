import {
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isModuleBlock,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  NodeFlags,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "typescript/unstable/ast";
import {
  type Symbol as CompilerSymbol,
  type Project,
  SymbolFlags,
  type Type,
  TypeFlags,
} from "typescript/unstable/async";
import { mapInNodeModules } from "./project-map-installed";
import { constDeclaration, httpMethod } from "./project-map-routes";
import { mapTestPath } from "./project-map-types";
import { mapRelativePath } from "./project-map-virtual-files";

// Paths that code builds from constants rather than spells out: a route registered as
// app.get(`${root}/items`, list), or a test requesting it as inject({ url: `${ITEMS}/${id}` }) with
// ITEMS imported from another module. Their text is worked out from the const declarations the
// names refer to, in this file or, through the compiler, in another.

/** A part of a requested path no constant gives, as a parameter does: `${id}`. */
export const MAP_PATH_PARAMETER = "{}";
const MAX = 256;
// Callees whose first argument is a path: routers registering routes, clients requesting them.
const ROUTER = new Set(["route", "all"]);
// Calls sending a request to the path they are given: fetch(url), app.inject(url),
// app.request(path), page.goto(url), cy.visit(url). Without a method named, they send a GET.
const CLIENT = new Set(["request", "fetch", "inject", "visit", "goto"]);
// Object properties holding a path a request is sent to; all but path name nothing else.
const REQUEST_PROPERTY = new Set(["url", "path", "uri", "endpoint"]);
const URL_PROPERTY = new Set(["url", "uri", "endpoint"]);
// Words of a name for what sends requests, as a receiver whose get, post and the like send them is
// named: request(app).get(path), client.post(path), this.httpClient.put(path); not map.get(key),
// wrapper.get(selector) or db.prepare(sql).get(id).
const CLIENT_WORDS = new Set([
  "request",
  "agent",
  "client",
  "api",
  "http",
  "https",
  "server",
  "app",
  "axios",
  "fetch",
  "supertest",
]);
// The types of a value that may be a URL: strings, URL and Request objects, and what the
// compiler cannot tell; and of one that names its own method, a Request object.
const URL_TYPES = new Set(["URL", "Request"]);
const REQUEST_TYPES = new Set(["Request"]);

const unwrap = (node: Node): Node =>
  isParenthesizedExpression(node) ||
  isAsExpression(node) ||
  isSatisfiesExpression(node) ||
  isAwaitExpression(node)
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
const nameWords = (name: string) =>
  name
    .split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[^A-Za-z0-9]+/u)
    .map((word) => word.toLowerCase());
// Whether what a method is called on sends requests by its name: a client's, or the call or new
// expression making one, as request(app) and request.agent(app) do.
const client = (receiver: Node) => {
  const inner = unwrap(receiver);
  const name =
    isCallExpression(inner) || isNewExpression(inner)
      ? calleeName(inner)
      : isPropertyAccessExpression(inner)
        ? inner.name.text
        : isIdentifier(inner)
          ? inner.text
          : undefined;
  return name !== undefined && nameWords(name).some((word) => CLIENT_WORDS.has(word));
};
// Whether a call's result has a method named for HTTP called on it, as request(app) does in
// request(app).get(path): unless the call is sent a path, as cy.visit(path).get(selector) is, it
// makes a client.
const makesClient = (call: Node) => {
  const access = call.parent;
  return (
    isPropertyAccessExpression(access) &&
    access.expression === call &&
    httpMethod(access.name.text) !== undefined &&
    isCallExpression(access.parent) &&
    access.parent.expression === access
  );
};
// The value of an object literal's property, by its name.
const property = (object: ObjectLiteralExpression, name: string) => {
  for (const member of object.properties)
    if (
      (isPropertyAssignment(member) || isShorthandPropertyAssignment(member)) &&
      (isIdentifier(member.name) || isStringLiteral(member.name)) &&
      member.name.text === name
    )
      return isPropertyAssignment(member) ? member.initializer : member.name;
  return undefined;
};

/** The paths of one file that its code computes: route registrations, and in tests, requests. */
export type MapFilePaths = Readonly<{
  /** Registration path arguments, by node: what the route is registered under. */
  registered: ReadonlyMap<Node, string>;
  /**
   * The requests tests send, by the expression giving the path, written as a route is: the
   * method, if known, then the path, as "POST /api/items". Unknown parts of the path are
   * MAP_PATH_PARAMETER, and a request whose path is not worked out at all, as path(id) gives it,
   * has that alone: "GET {}", or "{}".
   */
  requested: ReadonlyMap<Node, string>;
}>;

// A request a test may send: the expression giving its path, and its method as the call names it,
// the expression its options give it by, or a GET when it has no options and is not sent a Request
// object, which names its own. It surely is a request, so that a path not worked out is still one,
// when sent by a client call, to an object's url, or through what sends requests (`receiver`). A
// client call whose result is used as a client (`makes`), as request(app) is in request(app).get(path)
// and in const api = request(app) where api.get(path) is called, is sent no path but what it
// requests through. A call named for HTTP (`call`) whose receiver says nothing surely sends a request
// when it gives what is awaited, as a response is.
type Request = {
  node: Node;
  method?: string | Node;
  get?: boolean;
  sure: boolean;
  call?: Node;
  receiver?: Node;
  makes?: true | VariableDeclaration;
};

export class MapPathFolder {
  private readonly symbols = new Map<number, Promise<string | undefined>>();
  // Constants being worked out: one met again while its value is worked out refers to itself,
  // through imports, and has none.
  private readonly folding = new Set<number>();
  constructor(private readonly project: Project | undefined) {}

  /** The computed registration paths of a file and, for a test file, the requests it sends. */
  async file(file: SourceFile, test: boolean): Promise<MapFilePaths> {
    const registered = new Map<Node, string>();
    const requested = new Map<Node, string>();
    const registrations: Node[] = [];
    const requests: Request[] = [];
    // The names that methods named for HTTP are called on: api of api.get(path).
    const receivers: Identifier[] = [];
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
          if (test) this.request(node, name, first, requests, receivers);
        }
      } else if (
        test &&
        (isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) &&
        isObjectLiteralExpression(node.parent) &&
        (isIdentifier(node.name) || isStringLiteral(node.name)) &&
        REQUEST_PROPERTY.has(node.name.text)
      )
        requests.push({
          node: isPropertyAssignment(node) ? node.initializer : node.name,
          sure: URL_PROPERTY.has(node.name.text) && isCallExpression(node.parent.parent),
          ...this.methodOf(node.parent),
        });
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
    const values = new Map<Request, string | undefined>();
    for (const request of requests) values.set(request, await this.fold(request.node, true, 0));
    const path = (request: Request) => {
      const value = values.get(request);
      return value && requestPath(value);
    };
    // A client call whose result is used as a client and that is sent no path makes the client.
    const makers = new Set<Request>();
    const clients: VariableDeclaration[] = [];
    for (const request of requests) {
      const { makes } = request;
      if (!makes || path(request)) continue;
      if (makes === true) makers.add(request);
      else if (receivers.some((receiver) => binds(makes, receiver))) {
        makers.add(request);
        clients.push(makes);
      }
    }
    const sent = requests.filter((request) => !makers.has(request));
    // A request without options whose path is not worked out may be sent a Request object.
    const unsure = sent.filter((request) => request.get && !path(request));
    const objects = new Map(
      (
        await this.mayBe(
          unsure.map(({ node }) => node),
          false,
          REQUEST_TYPES,
        )
      ).map((may, at) => [unsure[at] as Request, may]),
    );
    const unknown: { node: Node; method: string | undefined; sure: boolean; call?: Node }[] = [];
    for (const request of sent) {
      const method =
        typeof request.method === "object"
          ? httpMethod((await this.fold(request.method, false, 0)) ?? "")
          : (request.method ?? (request.get && !objects.get(request) ? "GET" : undefined));
      const { receiver } = request;
      const sure =
        request.sure ||
        (receiver !== undefined &&
          (client(receiver) ||
            (isIdentifier(receiver) && clients.some((binding) => binds(binding, receiver)))));
      const value = values.get(request);
      const found = path(request);
      const text = (path: string) => (method ? `${method} ${path}` : path);
      if (found) requested.set(request.node, text(found));
      // A string that is no path is not a request; one the map cannot work out may be any.
      else if (value === undefined || value.includes(MAP_PATH_PARAMETER))
        unknown.push({ node: request.node, method, sure, call: request.call });
    }
    // A call of a function the project's tests implement, as a test helper's get(path) is, sends
    // what the function does: that is read in the function, and stands for the tests calling it.
    const called = unknown.filter((request) => request.call);
    const helpers = await this.helpers(called.map(({ call }) => call as Node));
    const own = new Set(called.filter((_, at) => helpers[at]));
    const open = unknown.filter((request) => !own.has(request));
    const untold = open.filter((request) => !request.sure && request.call);
    for (const [at, awaited] of (
      await this.awaited(untold.map(({ call }) => call as Node))
    ).entries())
      (untold[at] as { sure: boolean }).sure = awaited;
    const sending = open.filter((request) => request.sure);
    const urls = await this.mayBe(
      sending.map(({ node }) => node),
      true,
      URL_TYPES,
    );
    for (const [at, { node, method }] of sending.entries())
      if (urls[at])
        requested.set(node, method ? `${method} ${MAP_PATH_PARAMETER}` : MAP_PATH_PARAMETER);
    return { registered, requested };
  }

  // The request a call of a test sends, if any: client.get(path), request(app).post(path),
  // fetch(url, { method: "PUT" }), or a test's own get(path). One whose path is an object's is
  // the object's url.
  private request(
    call: Node & { expression: Node; arguments: readonly Node[] },
    name: string,
    first: Node,
    requests: Request[],
    receivers: Identifier[],
  ) {
    if (isObjectLiteralExpression(unwrap(first))) return;
    const method = httpMethod(name);
    if (method) {
      // What it is called on says whether it surely sends a request.
      const receiver = isPropertyAccessExpression(call.expression)
        ? unwrap(call.expression.expression)
        : undefined;
      if (receiver && isIdentifier(receiver)) receivers.push(receiver);
      requests.push({ node: first, method, sure: false, call, ...(receiver ? { receiver } : {}) });
      return;
    }
    if (!CLIENT.has(name)) return;
    const options = call.arguments[1];
    const object = options && unwrap(options);
    const binding = call.parent;
    requests.push({
      node: first,
      sure: true,
      // Options name the method, unless spread from elsewhere; without a method they send a GET.
      ...(options === undefined
        ? { get: true }
        : object && isObjectLiteralExpression(object)
          ? (this.methodOf(object) ??
            (object.properties.some(isSpreadAssignment) ? {} : { method: "GET" }))
          : {}),
      ...(makesClient(call)
        ? { makes: true as const }
        : !options &&
            isVariableDeclaration(binding) &&
            binding.initializer === (call as Node) &&
            isIdentifier(binding.name)
          ? { makes: binding }
          : {}),
    });
  }

  // The method property of a request's options, { method: "POST", url }, worked out when the
  // request's path is.
  private methodOf(options: ObjectLiteralExpression): { method: Node } | undefined {
    const value = property(options, "method");
    return value ? { method: value } : undefined;
  }

  // What each call calls, as the compiler resolves its name: undefined for a call of an untyped
  // value, as request(server).get(path) is where request is any.
  private callees(calls: readonly Node[]): Promise<(CompilerSymbol | undefined)[]> {
    const project = this.project;
    return Promise.all(
      calls.map(async (call) => {
        const callee = unwrap((call as Node & { expression: Node }).expression);
        const name = isPropertyAccessExpression(callee)
          ? callee.name
          : isIdentifier(callee)
            ? callee
            : undefined;
        const symbol = project && name && (await project.checker.getSymbolAtLocation(name));
        if (!project || !symbol) return undefined;
        return symbol.flags & SymbolFlags.Alias
          ? await project.checker.getAliasedSymbol(symbol)
          : symbol;
      }),
    );
  }

  // Whether each call is of a function the project's tests implement, every declaration of it a
  // function with a body in a test file, or a property naming one: { ...harness, post }. Without
  // the compiler, none is known to be.
  private async helpers(calls: readonly Node[]): Promise<boolean[]> {
    const helper = async (symbol: CompilerSymbol | undefined, depth: number): Promise<boolean> => {
      const project = this.project;
      if (!project || !symbol?.declarations.length || depth > 4) return false;
      for (const handle of symbol.declarations) {
        const path = mapRelativePath(handle.path);
        if (
          path === undefined ||
          mapInNodeModules(path) ||
          /\.d\.[cm]?ts$/u.test(path) ||
          !mapTestPath(path)
        )
          return false;
        const node = await handle.resolve(project);
        if (
          node && isShorthandPropertyAssignment(node)
            ? !(await helper(
                await project.checker.getShorthandAssignmentValueSymbol(node),
                depth + 1,
              ))
            : !implemented(node)
        )
          return false;
      }
      return true;
    };
    return Promise.all((await this.callees(calls)).map((symbol) => helper(symbol, 0)));
  }

  // Whether each call gives what is awaited: by its type, a promise or another thenable; or, for
  // a call of an untyped value, anything untyped. A declared function's any is not, as
  // Reflect.get(target, key) gives, nor is one declared unknown, as a statement's row is.
  // Without the compiler, none is known to.
  private async awaited(calls: readonly Node[]): Promise<boolean[]> {
    const project = this.project;
    if (!project || !calls.length) return calls.map(() => false);
    const [types, callees] = await Promise.all([
      project.checker.getTypeAtLocation(calls),
      this.callees(calls),
    ]);
    return Promise.all(
      types.map(
        async (type, at) =>
          (callees[at] === undefined && (!type || (type.flags & TypeFlags.Any) !== 0)) ||
          (type !== undefined &&
            (await project.checker.getPropertyOfType(type, "then")) !== undefined),
      ),
    );
  }

  // Whether each expression may give a value of these types, by its type: a string where strings
  // count, an object of a type named so, or one the compiler cannot tell; not a number, as
  // request(text.indexOf(name)) gives, or an app, as request(app) does. Without the compiler,
  // each may.
  private async mayBe(
    nodes: readonly Node[],
    strings: boolean,
    names: ReadonlySet<string>,
  ): Promise<boolean[]> {
    if (!this.project || !nodes.length) return nodes.map(() => true);
    const types = await this.project.checker.getTypeAtLocation(nodes);
    return Promise.all(types.map((type) => mayBe(type, strings, names)));
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
        // The value kept is the constant's own, whatever depth it is first met at: the depth
        // bounds an expression's nesting, and folding marks the constants met through imports.
        return await this.fold(declaration.initializer, false, 0);
      } finally {
        this.folding.delete(id);
      }
    })();
    this.symbols.set(id, value);
    return value;
  }
}

// Whether a declaration is a function with a body: one declared so, or a property or binding a
// function expression initializes.
function implemented(node: Node | undefined): boolean {
  if (!node) return false;
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isArrowFunction(node) ||
    isFunctionExpression(node)
  )
    return node.body !== undefined;
  if (isPropertyAssignment(node) || isVariableDeclaration(node) || isPropertyDeclaration(node)) {
    const value = node.initializer && unwrap(node.initializer);
    return (
      value !== undefined &&
      (isArrowFunction(value) || isFunctionExpression(value)) &&
      implemented(value)
    );
  }
  return false;
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

async function mayBe(
  type: Type | undefined,
  strings: boolean,
  names: ReadonlySet<string>,
  depth = 0,
): Promise<boolean> {
  if (!type || type.isErrorType() || type.isTypeParameter() || depth > 4) return true;
  if (type.flags & TypeFlags.AnyOrUnknown) return true;
  if (type.flags & TypeFlags.StringLike) return strings;
  if (type.isUnionType() || type.isIntersectionType()) {
    for (const member of (await type.getTypes()) ?? [])
      if (await mayBe(member, strings, names, depth + 1)) return true;
    return false;
  }
  const symbol = await type.getSymbol();
  return symbol !== undefined && names.has(symbol.name);
}

// Whether a name, bound by this declaration, is the one this identifier refers to: the same name
// in the block declaring it.
function binds(declaration: VariableDeclaration, identifier: Identifier): boolean {
  if (!isIdentifier(declaration.name) || declaration.name.text !== identifier.text) return false;
  let scope: Node | undefined = declaration.parent;
  while (scope && !isBlock(scope) && !isSourceFile(scope) && !isModuleBlock(scope))
    scope = scope.parent;
  return scope !== undefined && identifier.pos >= scope.pos && identifier.end <= scope.end;
}

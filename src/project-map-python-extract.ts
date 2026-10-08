import { getImportInfo } from "pyright-internal/analyzer/analyzerNodeInfo";
import { type Declaration, DeclarationType } from "pyright-internal/analyzer/declaration";
import { ImportType } from "pyright-internal/analyzer/importResult";
import { ParseTreeWalker } from "pyright-internal/analyzer/parseTreeWalker";
import type { TypeEvaluator } from "pyright-internal/analyzer/typeEvaluatorTypes";
import { ClassType, isClass, isClassInstance } from "pyright-internal/analyzer/types";
import {
  doForEachSubtype,
  lookUpClassMember,
  MemberAccessFlags,
} from "pyright-internal/analyzer/typeUtils";
import { DiagnosticCategory } from "pyright-internal/common/diagnostic";
import type { Uri } from "pyright-internal/common/uri/uri";
import {
  type ArgumentNode,
  type AssignmentNode,
  type AugmentedAssignmentNode,
  type CallNode,
  type ClassNode,
  type DecoratorNode,
  type DelNode,
  type FunctionNode,
  type GlobalNode,
  type ImportFromNode,
  type ImportNode,
  type IndexNode,
  type LambdaNode,
  type ListNode,
  type MemberAccessNode,
  type ModuleNameNode,
  type ModuleNode,
  type NameNode,
  type ParameterNode,
  type ParseNode,
  ParseNodeType,
  type StatementListNode,
  type StringListNode,
  type StringNode,
  type TupleNode,
  type TypeAliasNode,
  type TypeAnnotationNode,
  type WithNode,
} from "pyright-internal/parser/parseNodes";
import { type PythonProgram, pythonStandardLibrary } from "./project-map-python-host";

// Facts in the shape of MapFactsSchema (project-map-facts.ts), with UTF-16 offsets.
type Kind =
  | "FILE"
  | "FUNCTION"
  | "CLASS"
  | "INTERFACE"
  | "TYPE"
  | "METHOD"
  | "PROPERTY"
  | "VARIABLE"
  | "ENUM";
type Execution = "MODULE" | "FUNCTION" | "CLOSURE" | "CONSTRUCTOR" | "INITIALIZER";
type Reason = "COMPILER_LIBRARY" | "DECLARATION_NOT_AVAILABLE" | "SYMBOL_NOT_RESOLVED";
export type PythonObjectFact = {
  id: number;
  kind: Kind;
  name: string;
  path: string;
  start: number;
  end: number;
  nameStart: number;
  parent?: number;
  exported: boolean;
  execution?: Execution;
};
export type PythonRelationFact = {
  kind:
    | "CALLS"
    | "REFERENCES"
    | "WRITES"
    | "IMPORTS"
    | "TEST_IMPORTS"
    | "EXTENDS"
    | "IMPLEMENTS"
    | "OVERRIDES"
    | "DECORATED_BY";
  from: number;
  to?: number;
  path: string;
  start: number;
  end: number;
  target: string;
  basis: "TYPE_RESOLVED" | "SYNTAX_DECLARED" | "UNRESOLVED";
  reason?: Reason;
  argument?: string;
  route?: string;
};
export type PythonFacts = {
  files: { path: string; object?: number; excluded?: "SYNTAX_ERROR" }[];
  objects: PythonObjectFact[];
  relations: PythonRelationFact[];
  notes: {
    object: number;
    kind: "SOURCE_DOCUMENTATION";
    path: string;
    start: number;
    end: number;
  }[];
  typeErrors: number;
};

// A module's public names (no leading underscore) are what it exports; members are not exported.
const isPublic = (name: string) => !name.startsWith("_");
const end = (node: ParseNode) => node.start + node.length;

// The source text of a callee or target, abbreviated as the map labels it.
function label(node: ParseNode): string {
  switch (node.nodeType) {
    case ParseNodeType.Name:
      return (node as NameNode).d.value;
    case ParseNodeType.MemberAccess: {
      const access = node as MemberAccessNode;
      return `${label(access.d.leftExpr)}.${access.d.member.d.value}`;
    }
    case ParseNodeType.Call:
      return `${label((node as CallNode).d.leftExpr)}()`;
    case ParseNodeType.Index:
      return `${label((node as IndexNode).d.leftExpr)}[…]`;
    default:
      return "…";
  }
}

// A string literal (not an f-string) of 1-256 characters, as decorators and registrations pass
// route paths.
function literal(node: ParseNode | undefined): string | undefined {
  if (node?.nodeType !== ParseNodeType.StringList) return undefined;
  const parts = (node as StringListNode).d.strings;
  if (!parts.every((part) => part.nodeType === ParseNodeType.String)) return undefined;
  const value = parts.map((part) => (part as StringNode).d.value).join("");
  return value.length > 0 && value.length <= 256 ? value : undefined;
}

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]);

// A route path: a string literal, including the empty path a route at its router's prefix uses.
function routeText(node: ParseNode | undefined): string | undefined {
  if (node?.nodeType !== ParseNodeType.StringList) return undefined;
  const parts = (node as StringListNode).d.strings;
  if (!parts.every((part) => part.nodeType === ParseNodeType.String)) return undefined;
  const value = parts.map((part) => (part as StringNode).d.value).join("");
  return value.length <= 256 ? value : undefined;
}

// A path joined to the prefix it is registered under, with one slash between them.
function joinRoute(prefix: string, path: string): string {
  const joined = !prefix
    ? path
    : !path
      ? prefix
      : `${prefix.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
  return joined.startsWith("/") || joined.startsWith("$") ? joined : `/${joined}`;
}

// A docstring: the first statement of a body when it is a lone string literal.
function docstring(statements: ParseNode[]): ParseNode | undefined {
  const first = statements[0];
  if (first?.nodeType !== ParseNodeType.StatementList) return undefined;
  const inner = (first as StatementListNode).d.statements;
  return inner.length === 1 && inner[0]?.nodeType === ParseNodeType.StringList
    ? inner[0]
    : undefined;
}

type Resolution = { to?: number; basis: PythonRelationFact["basis"]; reason?: Reason };

class Extraction {
  readonly facts: PythonFacts = { files: [], objects: [], relations: [], notes: [], typeErrors: 0 };
  // Objects by the start of their declaring name, per file.
  private readonly byName = new Map<string, number>();
  // Members (methods, attributes) of each class object, by name.
  private readonly members = new Map<number, Map<string, number>>();
  // Module-level variables of each file, by name.
  private readonly globals = new Map<string, Map<string, number>>();
  private readonly classes = new Map<number, ClassNode>();
  // Lambdas assigned to one variable or attribute take that object's identity.
  private readonly carriers = new Map<LambdaNode, number>();
  // Names of project functions, methods and classes: only such names can be a callable used as a
  // value.
  readonly callableNames = new Set<string>();
  // Names of module-level variables: only such names can be a read of module state.
  readonly stateNames = new Set<string>();

  constructor(
    readonly source: PythonProgram,
    readonly evaluator: TypeEvaluator,
    private readonly tests: ReadonlySet<string>,
  ) {}

  add(fact: Omit<PythonObjectFact, "id">): number {
    const id = this.facts.objects.length + 1;
    this.facts.objects.push({ ...fact, id });
    if (fact.nameStart >= 0) this.byName.set(`${fact.path}:${fact.nameStart}`, id);
    return id;
  }
  object(id: number) {
    return this.facts.objects[id - 1] as PythonObjectFact;
  }
  member(owner: number, name: string) {
    return this.members.get(owner)?.get(name);
  }
  classMembersOf(owner: number): ReadonlyMap<string, number> {
    return this.members.get(owner) ?? new Map();
  }
  private readonly fileObjects = new Map<string, number>();
  setFileObject(path: string, id: number) {
    this.fileObjects.set(path, id);
  }
  fileObject(path: string | undefined) {
    return path === undefined ? undefined : this.fileObjects.get(path);
  }
  setMember(owner: number, name: string, id: number) {
    const members = this.members.get(owner) ?? new Map<string, number>();
    if (!members.has(name)) members.set(name, id);
    this.members.set(owner, members);
  }
  global(path: string, name: string) {
    return this.globals.get(path)?.get(name);
  }
  setGlobal(path: string, name: string, id: number) {
    const names = this.globals.get(path) ?? new Map<string, number>();
    if (!names.has(name)) names.set(name, id);
    this.globals.set(path, names);
  }
  declared(path: string, nameStart: number) {
    return this.byName.get(`${path}:${nameStart}`);
  }
  setClass(id: number, node: ClassNode) {
    this.classes.set(id, node);
  }
  classNodes() {
    return this.classes;
  }
  carrier(node: LambdaNode) {
    return this.carriers.get(node);
  }
  setCarrier(node: LambdaNode, id: number) {
    this.carriers.set(node, id);
  }
  relation(fact: PythonRelationFact) {
    this.facts.relations.push(fact);
  }
  note(object: number, path: string, node: ParseNode) {
    this.facts.notes.push({
      object,
      kind: "SOURCE_DOCUMENTATION",
      path,
      start: node.start,
      end: end(node),
    });
  }
  isTest(path: string) {
    return this.tests.has(path);
  }

  // Declarations a name refers to, with imports followed to what they import. An import that
  // resolves nowhere stays an alias declaration.
  declarations(name: NameNode): Declaration[] {
    const found = this.evaluator.getDeclInfoForNameNode(name)?.decls ?? [];
    return found.map((declaration) =>
      declaration.type === DeclarationType.Alias
        ? (this.evaluator.resolveAliasDeclaration(declaration, true) ?? declaration)
        : declaration,
    );
  }

  // The object a project declaration declares, materializing a parameter when it is called.
  objectOf(declaration: Declaration): number | undefined {
    const path = this.source.pathOf(declaration.uri);
    if (path === undefined) return undefined;
    const node = declaration.node;
    switch (declaration.type) {
      case DeclarationType.Function:
      case DeclarationType.Class:
        return this.declared(path, (node as FunctionNode | ClassNode).d.name.start);
      case DeclarationType.TypeAlias:
        return this.declared(path, (node as TypeAliasNode).d.name.start);
      case DeclarationType.Variable: {
        if (node.nodeType !== ParseNodeType.Name) return undefined;
        const name = node as NameNode;
        const direct = this.declared(path, name.start);
        if (direct !== undefined) return direct;
        const owner = this.ownerClass(name);
        if (owner !== undefined) return this.member(owner, name.d.value);
        return this.enclosingScope(name) === undefined
          ? this.global(path, name.d.value)
          : undefined;
      }
      case DeclarationType.Param: {
        const parameter = node as {
          d: { name: NameNode | undefined };
          parent: ParseNode | undefined;
        };
        const name = parameter.d.name;
        const scope = parameter.parent;
        if (!name || scope?.nodeType !== ParseNodeType.Function) return undefined;
        const existing = this.declared(path, name.start);
        if (existing !== undefined) return existing;
        const owner = this.declared(path, (scope as FunctionNode).d.name.start);
        return this.add({
          kind: "VARIABLE",
          name: name.d.value,
          path,
          start: name.start,
          end: end(name),
          nameStart: name.start,
          ...(owner !== undefined ? { parent: owner } : {}),
          exported: false,
        });
      }
      default:
        return undefined;
    }
  }

  // The project object a class's instances reach under a member name, along its method
  // resolution order.
  projectMember(classType: ClassType, name: string, flags = MemberAccessFlags.Default) {
    const found = lookUpClassMember(classType, name, flags);
    for (const declaration of found?.symbol.getDeclarations() ?? []) {
      const id = this.objectOf(declaration);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  // The class object an attribute name belongs to: declared in its body, or assigned through the
  // first parameter of one of its methods (self.x).
  ownerClass(name: NameNode): number | undefined {
    const path = this.pathOfNode(name);
    const parent = name.parent;
    if (
      parent?.nodeType === ParseNodeType.MemberAccess &&
      (parent as MemberAccessNode).d.member === name
    ) {
      const method = this.enclosingScope(name);
      if (method?.nodeType !== ParseNodeType.Function || isStatic(method as FunctionNode))
        return undefined;
      const receiver = (method as FunctionNode).d.params[0]?.d.name?.d.value;
      const left = (parent as MemberAccessNode).d.leftExpr;
      if (
        !receiver ||
        left.nodeType !== ParseNodeType.Name ||
        (left as NameNode).d.value !== receiver
      )
        return undefined;
      const owner = this.enclosingScope(method);
      return owner?.nodeType === ParseNodeType.Class && path !== undefined
        ? this.declared(path, (owner as ClassNode).d.name.start)
        : undefined;
    }
    const scope = this.enclosingScope(name);
    return scope?.nodeType === ParseNodeType.Class && path !== undefined
      ? this.declared(path, (scope as ClassNode).d.name.start)
      : undefined;
  }

  // The innermost class, function or lambda around a node (undefined at module level).
  enclosingScope(node: ParseNode): ParseNode | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (
        current.nodeType === ParseNodeType.Class ||
        current.nodeType === ParseNodeType.Function ||
        current.nodeType === ParseNodeType.Lambda
      ) {
        // A class or function's own name, decorators and bases sit outside its body.
        const scope = current as ClassNode | FunctionNode;
        if (current.nodeType !== ParseNodeType.Lambda && !within(node, scope.d.suite)) continue;
        return current;
      }
    }
    return undefined;
  }

  private readonly nodePaths = new Map<number, string>();
  setModule(module: ParseNode, path: string) {
    this.nodePaths.set(module.id, path);
  }
  pathOfNode(node: ParseNode): string | undefined {
    let current: ParseNode | undefined = node;
    while (current?.parent) current = current.parent;
    return current ? this.nodePaths.get(current.id) : undefined;
  }

  // Where a callee or base expression leads: every project object it may reach (each member of a
  // union type), or why it stays unresolved.
  targets(expression: ParseNode): { targets: number[]; reason?: Reason } {
    const name =
      expression.nodeType === ParseNodeType.Name
        ? (expression as NameNode)
        : expression.nodeType === ParseNodeType.MemberAccess
          ? (expression as MemberAccessNode).d.member
          : undefined;
    // A subscript or a call's result is a runtime value, whatever holds it.
    if (!name) return { targets: [], reason: "SYMBOL_NOT_RESOLVED" };
    const declarations = this.declarations(name);
    // A parameter holding a class (cls in a class method, a type[X] argument) calls the class.
    if (
      name === expression &&
      declarations.length &&
      declarations.every((declaration) => declaration.type === DeclarationType.Param)
    ) {
      const classes = this.classesOf(expression);
      if (classes.length) return { targets: classes };
    }
    // Definitions of one function name in one scope: overload signatures resolve to the
    // implementation, a property's setter and deleter to its getter; definitions in different
    // branches (if/else, try/except) each stay. Members of different classes stay apart.
    const groups = new Map<string, Declaration[]>();
    for (const declaration of declarations) {
      if (this.source.pathOf(declaration.uri) === undefined) continue;
      const scope = this.enclosingScope(declaration.node)?.id ?? 0;
      const key =
        declaration.type === DeclarationType.Function
          ? (declaration.node as FunctionNode).d.name.d.value
          : `#${declaration.node.id}`;
      const group = `${declaration.uri.key}:${scope}:${key}`;
      const into = groups.get(group);
      if (into) into.push(declaration);
      else groups.set(group, [declaration]);
    }
    const chosen: Declaration[] = [];
    for (const group of groups.values()) {
      const definitions = group.filter(
        (declaration) =>
          declaration.type !== DeclarationType.Function ||
          !(declaration.node as FunctionNode).d.decorators.some(signatureOnly),
      );
      chosen.push(...(definitions.length ? definitions : group.slice(-1)));
    }
    const targets = [
      ...new Set(
        chosen.map((declaration) => this.objectOf(declaration)).filter((id) => id !== undefined),
      ),
    ];
    if (targets.length) return { targets };
    if (declarations.some((declaration) => pythonStandardLibrary(declaration.uri)))
      return { targets, reason: "COMPILER_LIBRARY" };
    return { targets, reason: this.origin(expression) };
  }

  // The project classes an expression's value is (not instances of them).
  private classesOf(expression: ParseNode) {
    const type = this.evaluator.getType(expression);
    const classes = new Set<number>();
    if (type)
      doForEachSubtype(this.evaluator.makeTopLevelTypeVarsConcrete(type), (subtype) => {
        if (!isClass(subtype)) return;
        const declaration = (subtype as ClassType).shared.declaration;
        if (isClassInstance(subtype) || !declaration) return;
        const id = this.objectOf(declaration);
        if (id !== undefined) classes.add(id);
      });
    return [...classes];
  }

  // The one object a decorator or base class names, or why it stays unresolved.
  resolve(expression: ParseNode): Resolution {
    const { targets, reason } = this.targets(expression);
    const to = targets[0];
    return to !== undefined ? { to, basis: "TYPE_RESOLVED" } : { basis: "UNRESOLVED", reason };
  }

  // Why a callee (or a written receiver) stays unresolved. A static path from an import
  // (module.function, module.Class.method) reaches into that module: an unloaded package's, or
  // the standard library's even where this platform or version omits the member. Anything else is
  // a value whose type is not known, whatever produced it (a package's call or field, an untyped
  // parameter), as TypeScript reports an untyped value.
  origin(expression: ParseNode): Reason {
    let current = expression;
    while (current.nodeType === ParseNodeType.MemberAccess) {
      if (this.declarations((current as MemberAccessNode).d.member).length)
        return "SYMBOL_NOT_RESOLVED";
      current = (current as MemberAccessNode).d.leftExpr;
    }
    if (current.nodeType !== ParseNodeType.Name) return "SYMBOL_NOT_RESOLVED";
    const modules = this.declarations(current as NameNode).filter(
      (declaration) => declaration.type === DeclarationType.Alias,
    );
    if (modules.some((module) => pythonStandardLibrary(module.uri))) return "COMPILER_LIBRARY";
    if (modules.some((module) => this.source.pathOf(module.uri) === undefined))
      return "DECLARATION_NOT_AVAILABLE";
    return "SYMBOL_NOT_RESOLVED";
  }
}

// A decorator after which a definition is a signature (an overload) or a property's setter or
// deleter rather than a function of its own.
const signatureOnly = (decorator: DecoratorNode) => {
  const expression = decorator.d.expr;
  if (expression.nodeType === ParseNodeType.Name)
    return (expression as NameNode).d.value === "overload";
  if (expression.nodeType !== ParseNodeType.MemberAccess) return false;
  const member = (expression as MemberAccessNode).d.member.d.value;
  return member === "overload" || member === "setter" || member === "deleter";
};

// A static method's first parameter is an ordinary argument, not the instance.
const isStatic = (node: FunctionNode) =>
  node.d.decorators.some(
    (decorator) =>
      decorator.d.expr.nodeType === ParseNodeType.Name &&
      (decorator.d.expr as NameNode).d.value === "staticmethod",
  );

function within(node: ParseNode, container: ParseNode) {
  return node.start >= container.start && end(node) <= end(container);
}

// Pass 1: the objects each file declares.
class Declarer extends ParseTreeWalker {
  private readonly scopes: { node: ParseNode; id: number }[] = [];

  constructor(
    private readonly x: Extraction,
    private readonly path: string,
    file: number,
    module: ParseNode,
  ) {
    super();
    this.scopes.push({ node: module, id: file });
  }

  private get scope() {
    return this.scopes[this.scopes.length - 1] as { node: ParseNode; id: number };
  }

  override visitClass(node: ClassNode) {
    const outer = this.scope;
    const classType = this.x.evaluator.getTypeOfClass(node)?.classType;
    const kind: Kind = classType
      ? ClassType.isProtocolClass(classType)
        ? "INTERFACE"
        : ClassType.isEnumClass(classType)
          ? "ENUM"
          : "CLASS"
      : "CLASS";
    const name = node.d.name.d.value;
    const id = this.x.add({
      kind,
      name,
      path: this.path,
      start: node.start,
      end: end(node),
      nameStart: node.d.name.start,
      parent: outer.id,
      exported: isPublic(name) && outer.node.nodeType === ParseNodeType.Module,
    });
    this.x.setClass(id, node);
    this.x.callableNames.add(name);
    if (outer.node.nodeType === ParseNodeType.Class) this.x.setMember(outer.id, name, id);
    if (outer.node.nodeType === ParseNodeType.Module) this.x.setGlobal(this.path, name, id);
    const doc = docstring(node.d.suite.d.statements);
    if (doc) this.x.note(id, this.path, doc);
    this.scopes.push({ node, id });
    this.walk(node.d.suite);
    this.scopes.pop();
    return false;
  }

  override visitFunction(node: FunctionNode) {
    const outer = this.scope;
    const name = node.d.name.d.value;
    const method = outer.node.nodeType === ParseNodeType.Class;
    const nested = outer.node.nodeType === ParseNodeType.Function;
    const id = this.x.add({
      kind: method ? "METHOD" : "FUNCTION",
      name,
      path: this.path,
      start: node.start,
      end: end(node),
      nameStart: node.d.name.start,
      parent: outer.id,
      exported: isPublic(name) && outer.node.nodeType === ParseNodeType.Module,
      execution: nested ? "CLOSURE" : method && name === "__init__" ? "CONSTRUCTOR" : "FUNCTION",
    });
    this.x.callableNames.add(name);
    if (method) this.x.setMember(outer.id, name, id);
    if (outer.node.nodeType === ParseNodeType.Module) this.x.setGlobal(this.path, name, id);
    const doc = docstring(node.d.suite.d.statements);
    if (doc) this.x.note(id, this.path, doc);
    this.scopes.push({ node, id });
    this.walk(node.d.suite);
    this.scopes.pop();
    return false;
  }

  override visitLambda() {
    return false;
  }

  override visitTypeAlias(node: TypeAliasNode) {
    if (this.scope.node.nodeType !== ParseNodeType.Module) return false;
    const name = node.d.name.d.value;
    const id = this.x.add({
      kind: "TYPE",
      name,
      path: this.path,
      start: node.start,
      end: end(node),
      nameStart: node.d.name.start,
      parent: this.scope.id,
      exported: isPublic(name),
    });
    this.x.setGlobal(this.path, name, id);
    return false;
  }

  override visitAssignment(node: AssignmentNode) {
    // A chained assignment (a = b = v) nests one node per target, all spanning the statement, the
    // first target's innermost with the value. The others span their own names: identities follow
    // spans, and the value belongs to the first.
    if (node.d.rightExpr.nodeType === ParseNodeType.Assignment)
      this.target(node.d.leftExpr, node.d.leftExpr);
    else this.target(node.d.leftExpr, node, node.d.rightExpr);
    return true;
  }

  override visitTypeAnnotation(node: TypeAnnotationNode) {
    // x: int (without a value) declares too; an annotated assignment arrives here from its target.
    if (node.parent?.nodeType !== ParseNodeType.Assignment) this.target(node.d.valueExpr, node);
    return false;
  }

  // Module variables, class attributes and self.x attributes, each at its first assignment.
  private target(expression: ParseNode, statement: ParseNode, value?: ParseNode) {
    const target =
      expression.nodeType === ParseNodeType.TypeAnnotation
        ? (expression as TypeAnnotationNode).d.valueExpr
        : expression;
    if (target.nodeType === ParseNodeType.Tuple || target.nodeType === ParseNodeType.List) {
      // Each target of an unpacking assignment spans its own name: identities follow spans.
      for (const item of (target as TupleNode | ListNode).d.items) this.target(item, item);
      return;
    }
    const scope = this.scope;
    const closure = value?.nodeType === ParseNodeType.Lambda ? (value as LambdaNode) : undefined;
    const execution = closure ? { execution: "CLOSURE" as const } : {};
    if (target.nodeType === ParseNodeType.Name) {
      const name = target as NameNode;
      if (scope.node.nodeType === ParseNodeType.Module) {
        if (this.x.global(this.path, name.d.value) !== undefined) return;
        const id = this.x.add({
          kind: "VARIABLE",
          name: name.d.value,
          path: this.path,
          start: statement.start,
          end: end(statement),
          nameStart: name.start,
          parent: scope.id,
          exported: isPublic(name.d.value),
          ...execution,
        });
        this.x.setGlobal(this.path, name.d.value, id);
        this.x.stateNames.add(name.d.value);
        if (closure) this.x.setCarrier(closure, id);
      } else if (scope.node.nodeType === ParseNodeType.Class) {
        if (this.x.member(scope.id, name.d.value) !== undefined) return;
        // A class attribute's value runs as its initializer (Django and dataclass fields).
        const id = this.x.add({
          kind: "PROPERTY",
          name: name.d.value,
          path: this.path,
          start: statement.start,
          end: end(statement),
          nameStart: name.start,
          parent: scope.id,
          exported: false,
          ...(closure ? execution : value ? { execution: "INITIALIZER" as const } : {}),
        });
        this.x.setMember(scope.id, name.d.value, id);
        if (closure) this.x.setCarrier(closure, id);
      } else if (closure) {
        // A lambda assigned to a local becomes a callable local of its function.
        const id = this.x.add({
          kind: "VARIABLE",
          name: name.d.value,
          path: this.path,
          start: statement.start,
          end: end(statement),
          nameStart: name.start,
          parent: scope.id,
          exported: false,
          execution: "CLOSURE",
        });
        this.x.setCarrier(closure, id);
      }
      return;
    }
    if (
      target.nodeType === ParseNodeType.MemberAccess &&
      scope.node.nodeType === ParseNodeType.Function
    ) {
      const member = (target as MemberAccessNode).d.member;
      const owner = this.x.ownerClass(member);
      if (owner === undefined || this.x.member(owner, member.d.value) !== undefined) return;
      const id = this.x.add({
        kind: "PROPERTY",
        name: member.d.value,
        path: this.path,
        start: statement.start,
        end: end(statement),
        nameStart: member.start,
        parent: owner,
        exported: false,
        ...execution,
      });
      this.x.setMember(owner, member.d.value, id);
      if (closure) this.x.setCarrier(closure, id);
    }
  }
}

// Pass 2: what each declaration does and refers to.
// Whether an expression is (part of) a type annotation: of a variable, a parameter or a return.
function inAnnotation(node: ParseNode): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent)
    switch (parent.nodeType) {
      case ParseNodeType.TypeAnnotation:
        if ((parent as TypeAnnotationNode).d.annotation === child) return true;
        break;
      case ParseNodeType.Parameter: {
        const parameter = parent as ParameterNode;
        return parameter.d.annotation === child || parameter.d.annotationComment === child;
      }
      case ParseNodeType.Function:
        return (parent as FunctionNode).d.returnAnnotation === child;
      case ParseNodeType.StatementList:
      case ParseNodeType.Suite:
      case ParseNodeType.Lambda:
        return false;
    }
  return false;
}

class Relater extends ParseTreeWalker {
  // Executing object and innermost declared object for the current node.
  private readonly executing: number[];
  private readonly declared: number[];
  private readonly scopes: ParseNode[] = [];
  private readonly callees = new Set<number>();
  // Names a function declares global.
  private readonly globalNames: Set<string>[] = [new Set()];

  constructor(
    private readonly x: Extraction,
    private readonly path: string,
    file: number,
    module: ParseNode,
  ) {
    super();
    this.executing = [file];
    this.declared = [file];
    this.scopes.push(module);
  }

  private top(stack: number[]) {
    return stack[stack.length - 1] as number;
  }
  private push(executing: number, declared: number, scope: ParseNode) {
    this.executing.push(executing);
    this.declared.push(declared);
    this.scopes.push(scope);
    this.globalNames.push(new Set());
  }
  private pop() {
    this.executing.pop();
    this.declared.pop();
    this.scopes.pop();
    this.globalNames.pop();
  }
  private relation(fact: Omit<PythonRelationFact, "path">) {
    this.x.relation({ ...fact, path: this.path });
  }

  // Module-level names assigned once to a router made with a path prefix, as
  // APIRouter(prefix="/v1") or Blueprint("admin", __name__, url_prefix="/admin") are.
  private routers?: Map<string, string>;
  private routerPrefix(name: string): string {
    if (!this.routers) {
      const prefixes = new Map<string, string>();
      const assigned = new Map<string, number>();
      for (const statement of (this.scopes[0] as ModuleNode).d.statements) {
        if (statement.nodeType !== ParseNodeType.StatementList) continue;
        for (const inner of (statement as StatementListNode).d.statements) {
          if (inner.nodeType !== ParseNodeType.Assignment) continue;
          const { leftExpr, rightExpr } = (inner as AssignmentNode).d;
          const target =
            leftExpr.nodeType === ParseNodeType.TypeAnnotation
              ? (leftExpr as TypeAnnotationNode).d.valueExpr
              : leftExpr;
          if (target.nodeType !== ParseNodeType.Name) continue;
          const name = (target as NameNode).d.value;
          assigned.set(name, (assigned.get(name) ?? 0) + 1);
          if (rightExpr.nodeType !== ParseNodeType.Call) continue;
          for (const argument of (rightExpr as CallNode).d.args) {
            const keyword = argument.d.name?.d.value;
            const prefix = routeText(argument.d.valueExpr);
            if ((keyword === "prefix" || keyword === "url_prefix") && prefix !== undefined)
              prefixes.set(name, prefix);
          }
        }
      }
      for (const [name, count] of assigned) if (count > 1) prefixes.delete(name);
      this.routers = prefixes;
    }
    return this.routers.get(name) ?? "";
  }

  // The route a decorator registers its function under, when it says more than the decorator's
  // argument: router.put("/{id}") or app.route("/items", methods=["GET", "POST"]) on a router
  // whose prefix this module sets.
  private route(call: CallNode, argument: string | undefined): string | undefined {
    const callee = call.d.leftExpr;
    if (callee.nodeType !== ParseNodeType.MemberAccess) return undefined;
    const member = (callee as MemberAccessNode).d.member.d.value;
    const methods = HTTP_METHODS.has(member.toUpperCase()) ? [member.toUpperCase()] : [];
    let path: string | undefined;
    for (const item of call.d.args) {
      const keyword = item.d.name?.d.value;
      if (keyword === undefined) path ??= routeText(item.d.valueExpr);
      else if (keyword === "path" || keyword === "rule") path ??= routeText(item.d.valueExpr);
      else if (
        keyword === "methods" &&
        (item.d.valueExpr.nodeType === ParseNodeType.List ||
          item.d.valueExpr.nodeType === ParseNodeType.Tuple)
      )
        for (const method of (item.d.valueExpr as ListNode | TupleNode).d.items) {
          const text = routeText(method)?.toUpperCase();
          if (text && HTTP_METHODS.has(text)) methods.push(text);
        }
    }
    if (path === undefined || (!methods.length && member !== "route" && member !== "api_route"))
      return undefined;
    const receiver = (callee as MemberAccessNode).d.leftExpr;
    const prefix =
      receiver.nodeType === ParseNodeType.Name
        ? this.routerPrefix((receiver as NameNode).d.value)
        : "";
    const route = `${methods.length ? `${methods.join("|")} ` : ""}${joinRoute(prefix, path)}`;
    return route.length <= 256 && route !== argument ? route : undefined;
  }

  private decorate(owner: number, decorators: DecoratorNode[], executing: number) {
    for (const decorator of decorators) {
      const expression = decorator.d.expr;
      const call =
        expression.nodeType === ParseNodeType.Call ? (expression as CallNode) : undefined;
      const target = call ? call.d.leftExpr : expression;
      const first = call?.d.args.find((argument) => !argument.d.name);
      const argument = literal(first?.d.valueExpr);
      const route = call && this.route(call, argument);
      this.relation({
        kind: "DECORATED_BY",
        from: owner,
        start: decorator.start,
        end: end(decorator),
        target: label(target),
        ...this.x.resolve(target),
        ...(argument ? { argument } : {}),
        ...(route ? { route } : {}),
      });
      // What the decorator's arguments pass belongs to the declaration it decorates; they run
      // where the declaration is defined (a function's range includes its decorators).
      this.push(executing, owner, this.scopes[this.scopes.length - 1] as ParseNode);
      if (call) for (const item of call.d.args) this.walk(item.d.valueExpr);
      this.walkReceiver(target);
      this.pop();
    }
  }

  // The receiver of a decorator or callee (a.b in a.b.c) is itself evaluated.
  private walkReceiver(target: ParseNode) {
    if (target.nodeType === ParseNodeType.MemberAccess)
      this.walk((target as MemberAccessNode).d.leftExpr);
  }

  override visitClass(node: ClassNode) {
    const id = this.x.declared(this.path, node.d.name.start);
    if (id === undefined) return false;
    const outer = this.top(this.executing);
    this.decorate(id, node.d.decorators, outer);
    for (const base of node.d.arguments) {
      if (base.d.name) continue;
      const expression =
        base.d.valueExpr.nodeType === ParseNodeType.Index
          ? (base.d.valueExpr as IndexNode).d.leftExpr
          : base.d.valueExpr;
      const resolution = this.x.resolve(expression);
      const protocol =
        resolution.to !== undefined && this.x.object(resolution.to).kind === "INTERFACE";
      this.relation({
        kind: protocol ? "IMPLEMENTS" : "EXTENDS",
        from: id,
        start: base.start,
        end: end(base),
        target: label(expression),
        ...resolution,
      });
    }
    // A class body runs where the class is defined; its attributes' values run as initializers.
    this.push(outer, id, node);
    this.walk(node.d.suite);
    this.pop();
    return false;
  }

  override visitFunction(node: FunctionNode) {
    const id = this.x.declared(this.path, node.d.name.start);
    if (id === undefined) return false;
    this.decorate(id, node.d.decorators, id);
    // Defaults run where the function is defined, but what they call or pass (such as
    // Depends(get_db)) belongs to the function, as its decorators do. Annotations are types.
    this.push(id, id, this.scopes[this.scopes.length - 1] as ParseNode);
    for (const parameter of node.d.params)
      if (parameter.d.defaultValue) this.walk(parameter.d.defaultValue);
    this.pop();
    this.push(id, id, node);
    this.walk(node.d.suite);
    this.pop();
    return false;
  }

  override visitLambda(node: LambdaNode) {
    const id = this.closure(node);
    for (const parameter of node.d.params)
      if (parameter.d.defaultValue) this.walk(parameter.d.defaultValue);
    this.push(id, id, node);
    this.walk(node.d.expr);
    this.pop();
    return false;
  }

  private closure(node: LambdaNode) {
    const carried = this.x.carrier(node);
    if (carried !== undefined) return carried;
    const id = this.x.add({
      kind: "FUNCTION",
      name: "<lambda>",
      path: this.path,
      start: node.start,
      end: end(node),
      nameStart: -1,
      parent: this.top(this.declared),
      exported: false,
      execution: "CLOSURE",
    });
    this.x.setCarrier(node, id);
    return id;
  }

  override visitCall(node: CallNode) {
    const callee = node.d.leftExpr;
    this.callees.add(callee.id);
    const fact = {
      kind: "CALLS" as const,
      from: this.top(this.executing),
      start: node.start,
      end: end(node),
    };
    if (callee.nodeType === ParseNodeType.Lambda) {
      this.relation({
        ...fact,
        to: this.closure(callee as LambdaNode),
        basis: "SYNTAX_DECLARED",
        target: "<lambda>",
      });
    } else {
      const { targets, reason } = this.x.targets(callee);
      if (!targets.length)
        this.relation({ ...fact, target: label(callee), basis: "UNRESOLVED", reason });
      for (const to of targets)
        this.relation({ ...fact, to, target: label(callee), basis: "TYPE_RESOLVED" });
    }
    return true;
  }

  // A with statement calls its context manager's __enter__ and __exit__ (async: __aenter__ and
  // __aexit__) where it runs: each project method the manager's class reaches is called there.
  // Python looks these up on the class, not on the instance; self is its class's instance.
  override visitWith(node: WithNode) {
    const methods = node.d.isAsync ? ["__aenter__", "__aexit__"] : ["__enter__", "__exit__"];
    for (const item of node.d.withItems) {
      const type = this.x.evaluator.getType(item.d.expr);
      if (!type) continue;
      const targets = new Set<number>();
      doForEachSubtype(this.x.evaluator.makeTopLevelTypeVarsConcrete(type), (subtype) => {
        if (!isClassInstance(subtype)) return;
        for (const name of methods) {
          const to = this.x.projectMember(subtype, name, MemberAccessFlags.SkipInstanceMembers);
          if (to !== undefined) targets.add(to);
        }
      });
      for (const to of targets)
        this.relation({
          kind: "CALLS",
          from: this.top(this.executing),
          start: item.d.expr.start,
          end: end(item.d.expr),
          to,
          target: `${label(item.d.expr)}.${this.x.object(to).name}`,
          basis: "TYPE_RESOLVED",
        });
    }
    return true;
  }

  override visitMemberAccess(node: MemberAccessNode) {
    if (!this.callees.has(node.id)) this.valueUse(node.d.member, node);
    this.walk(node.d.leftExpr);
    return false;
  }

  override visitName(node: NameNode) {
    const parent = node.parent;
    if (this.callees.has(node.id) || !parent) return false;
    switch (parent.nodeType) {
      case ParseNodeType.Argument:
        // A keyword's name, or a base class: neither is a value the code passes around.
        if ((parent as ArgumentNode).d.name === node) return false;
        if (parent.parent?.nodeType === ParseNodeType.Class) return false;
        break;
      case ParseNodeType.Function:
      case ParseNodeType.Class:
      case ParseNodeType.Parameter:
      case ParseNodeType.TypeAlias:
      case ParseNodeType.Global:
      case ParseNodeType.Nonlocal:
      case ParseNodeType.ImportAs:
      case ParseNodeType.ImportFromAs:
      case ParseNodeType.ModuleName:
        return false;
    }
    this.valueUse(node, node);
    return false;
  }

  // A project function, method or class used as a value (passed, stored or returned, as
  // functools.partial(Client, ...) passes a class), or a module-level variable read: a change to
  // either changes what the user does. A class named in a type annotation is not a use.
  private valueUse(name: NameNode, expression: ParseNode) {
    const callable = this.x.callableNames.has(name.d.value);
    const state = this.x.stateNames.has(name.d.value);
    if (!callable && !state) return;
    for (const declaration of this.x.declarations(name)) {
      const read = state && declaration.type === DeclarationType.Variable;
      const value =
        callable &&
        (declaration.type === DeclarationType.Function ||
          (declaration.type === DeclarationType.Class && !inAnnotation(expression)));
      if (!read && !value) continue;
      const to = this.x.objectOf(declaration);
      if (to === undefined) continue;
      // Only module state: a local or an attribute read is not a use of a mapped declaration.
      if (read && this.x.global(this.x.object(to).path, name.d.value) !== to) continue;
      this.relation({
        kind: "REFERENCES",
        from: this.top(this.declared),
        to,
        start: expression.start,
        end: end(expression),
        target: label(expression),
        basis: "TYPE_RESOLVED",
      });
      return;
    }
  }

  override visitGlobal(node: GlobalNode) {
    for (const target of node.d.targets)
      this.globalNames[this.globalNames.length - 1]?.add(target.d.value);
    return false;
  }

  override visitAssignment(node: AssignmentNode) {
    this.assign(node.d.leftExpr, node.d.rightExpr);
    return false;
  }

  override visitAugmentedAssignment(node: AugmentedAssignmentNode) {
    this.write(node.d.leftExpr);
    this.walkTargetParts(node.d.leftExpr);
    this.walk(node.d.rightExpr);
    return false;
  }

  override visitDel(node: DelNode) {
    for (const target of node.d.targets) {
      this.write(target);
      this.walkTargetParts(target);
    }
    return false;
  }

  override visitTypeAnnotation(node: TypeAnnotationNode) {
    // The annotation is a type; only the annotated target is walked by its assignment.
    this.walkTargetParts(node.d.valueExpr);
    return false;
  }

  private assign(target: ParseNode, value: ParseNode) {
    const unwrapped =
      target.nodeType === ParseNodeType.TypeAnnotation
        ? (target as TypeAnnotationNode).d.valueExpr
        : target;
    this.write(unwrapped);
    this.walkTargetParts(unwrapped);
    // In a chained assignment the value belongs to the first target, which the nested node holds.
    if (value.nodeType === ParseNodeType.Assignment) {
      this.walk(value);
      return;
    }
    // A module variable or class attribute's value belongs to it; a class attribute's declaring
    // assignment also runs as its initializer.
    const owner = this.owner(unwrapped);
    if (owner === undefined) {
      this.walk(value);
      return;
    }
    const object = this.x.object(owner);
    const initializer =
      object.execution === "INITIALIZER" &&
      object.path === this.path &&
      object.start <= value.start &&
      end(value) <= object.end;
    if (initializer) this.executing.push(owner);
    this.declared.push(owner);
    this.walk(value);
    this.declared.pop();
    if (initializer) this.executing.pop();
  }

  private owner(target: ParseNode) {
    const scope = this.scopes[this.scopes.length - 1];
    if (target.nodeType !== ParseNodeType.Name || !scope) return undefined;
    const name = (target as NameNode).d.value;
    if (scope.nodeType === ParseNodeType.Module) return this.x.global(this.path, name);
    if (scope.nodeType === ParseNodeType.Class) return this.x.member(this.top(this.declared), name);
    return undefined;
  }

  // Sub-expressions of a write target are evaluated: the receiver of a.b, the index of a[i].
  private walkTargetParts(target: ParseNode) {
    switch (target.nodeType) {
      case ParseNodeType.MemberAccess:
        this.walk((target as MemberAccessNode).d.leftExpr);
        break;
      case ParseNodeType.Index: {
        const index = target as IndexNode;
        this.walk(index.d.leftExpr);
        for (const item of index.d.items) this.walk(item.d.valueExpr);
        break;
      }
      case ParseNodeType.Tuple:
      case ParseNodeType.List:
        for (const item of (target as TupleNode | ListNode).d.items) this.walkTargetParts(item);
        break;
    }
  }

  // Writes to shared state: attributes, and module variables a function declares global.
  private write(target: ParseNode) {
    let base = target;
    while (base.nodeType === ParseNodeType.Index) base = (base as IndexNode).d.leftExpr;
    if (base.nodeType === ParseNodeType.Tuple || base.nodeType === ParseNodeType.List) {
      for (const item of (base as TupleNode | ListNode).d.items) this.write(item);
      return;
    }
    const fact = {
      kind: "WRITES" as const,
      from: this.top(this.executing),
      start: target.start,
      end: end(target),
      target: label(target),
    };
    if (base.nodeType === ParseNodeType.MemberAccess) {
      const member = (base as MemberAccessNode).d.member;
      const declared = this.x
        .declarations(member)
        .map((declaration) => this.x.objectOf(declaration))
        .find((id) => id !== undefined);
      const owner = declared === undefined ? this.x.ownerClass(member) : undefined;
      const syntactic = owner === undefined ? undefined : this.x.member(owner, member.d.value);
      if (declared !== undefined) this.relation({ ...fact, to: declared, basis: "TYPE_RESOLVED" });
      else if (syntactic !== undefined)
        this.relation({ ...fact, to: syntactic, basis: "SYNTAX_DECLARED" });
      else
        this.relation({
          ...fact,
          basis: "UNRESOLVED",
          reason: this.x.origin((base as MemberAccessNode).d.leftExpr),
        });
      return;
    }
    if (base.nodeType !== ParseNodeType.Name) return;
    const name = (base as NameNode).d.value;
    const scope = this.scopes[this.scopes.length - 1];
    const global = this.x.global(this.path, name);
    // Module-level assignments declare; functions write globals they declare global.
    if (
      scope?.nodeType === ParseNodeType.Function &&
      this.globalNames[this.globalNames.length - 1]?.has(name) &&
      global !== undefined
    )
      this.relation({ ...fact, to: global, basis: "TYPE_RESOLVED" });
  }

  override visitImport(node: ImportNode) {
    for (const item of node.d.list) this.imports(item.d.module, item);
    return false;
  }

  override visitImportFrom(node: ImportFromNode) {
    this.imports(node.d.module, node, node);
    return false;
  }

  private imports(module: ModuleNameNode, site: ParseNode, from?: ImportFromNode) {
    const specifier = `${".".repeat(module.d.leadingDots)}${module.d.nameParts.map((part) => part.d.value).join(".")}`;
    const kind = this.x.isTest(this.path) ? ("TEST_IMPORTS" as const) : ("IMPORTS" as const);
    const fact = { kind, from: this.top(this.executing), start: site.start, end: end(site) };
    const result = getImportInfo(module, this.x.source.program.analyzerNodeInfoReader);
    const resolved = result?.isImportFound ? result.resolvedUris.at(-1) : undefined;
    const path = resolved && !resolved.isEmpty() ? this.x.source.pathOf(resolved) : undefined;
    const fileObject = this.x.fileObject(path);
    // from package import module: each imported submodule is a module import too.
    const submodules = from
      ? from.d.imports.flatMap((item) => {
          const implicit = result?.filteredImplicitImports?.get(item.d.name.d.value);
          const object = this.x.fileObject(
            implicit ? this.x.source.pathOf(implicit.uri) : undefined,
          );
          return object === undefined ? [] : [{ object, name: item.d.name.d.value }];
        })
      : [];
    // A local namespace package (a directory without __init__.py) has no module file to link.
    const namespace = result?.isImportFound === true && result.importType === ImportType.Local;
    if (fileObject !== undefined)
      this.relation({ ...fact, to: fileObject, target: specifier, basis: "TYPE_RESOLVED" });
    else if (!submodules.length && !namespace)
      this.relation({
        ...fact,
        target: specifier,
        basis: "UNRESOLVED",
        reason:
          result?.isImportFound &&
          (result.importType === ImportType.BuiltIn || result.isStdlibTypeshedFile)
            ? "COMPILER_LIBRARY"
            : module.d.leadingDots > 0
              ? "SYMBOL_NOT_RESOLVED"
              : "DECLARATION_NOT_AVAILABLE",
      });
    for (const submodule of submodules)
      this.relation({
        ...fact,
        to: submodule.object,
        target: `${specifier}${specifier.endsWith(".") ? "" : "."}${submodule.name}`,
        basis: "TYPE_RESOLVED",
      });
  }
}

// Members that implement or override a base or protocol member, and protocols classes satisfy
// structurally.
function implementations(x: Extraction) {
  const types = new Map<number, ClassType>();
  for (const [id, node] of x.classNodes()) {
    const classType = x.evaluator.getTypeOfClass(node)?.classType;
    if (classType) types.set(id, classType);
  }
  const overrides = new Set<string>();
  const override = (member: number, base: number) => {
    const key = `${member}:${base}`;
    if (member === base || overrides.has(key)) return;
    overrides.add(key);
    const object = x.object(member);
    x.relation({
      kind: "OVERRIDES",
      from: member,
      to: base,
      path: object.path,
      start: object.nameStart,
      end: object.nameStart + object.name.length,
      target: x.object(base).name,
      basis: "TYPE_RESOLVED",
    });
  };
  for (const [id, classType] of types) {
    for (const [name, member] of x.classMembersOf(id)) {
      if (x.object(member).kind !== "METHOD") continue;
      const base = x.projectMember(classType, name, MemberAccessFlags.SkipOriginalClass);
      if (base !== undefined) override(member, base);
    }
  }
  const protocols = [...types].filter(
    ([id, classType]) =>
      x.object(id).kind === "INTERFACE" && classType.shared.typeParams.length === 0,
  );
  const explicit = new Set(
    x.facts.relations
      .filter((relation) => relation.kind === "IMPLEMENTS" && relation.to !== undefined)
      .map((relation) => `${relation.from}:${relation.to}`),
  );
  for (const [id, classType] of types) {
    // A class with a base of unknown type (from an unloaded package) is assignable to anything.
    if (x.object(id).kind === "INTERFACE" || ClassType.derivesFromAnyOrUnknown(classType)) continue;
    const instance = ClassType.cloneAsInstance(classType);
    for (const [protocol, protocolType] of protocols) {
      if (explicit.has(`${id}:${protocol}`)) continue;
      if (!x.evaluator.assignType(ClassType.cloneAsInstance(protocolType), instance)) continue;
      const object = x.object(id);
      x.relation({
        kind: "IMPLEMENTS",
        from: id,
        to: protocol,
        path: object.path,
        start: object.nameStart,
        end: object.nameStart + object.name.length,
        target: x.object(protocol).name,
        basis: "TYPE_RESOLVED",
      });
      for (const [name, contract] of x.classMembersOf(protocol)) {
        if (x.object(contract).kind !== "METHOD") continue;
        const member = x.projectMember(classType, name);
        if (member !== undefined) override(member, contract);
      }
    }
  }
}

/** Map facts for every tracked source of the program. */
export function extractPython(source: PythonProgram, tests: ReadonlySet<string>): PythonFacts {
  const evaluator = source.program.evaluator;
  if (!evaluator) throw new Error("PROJECT_MAP_ANALYSIS_FAILED");
  const x = new Extraction(source, evaluator, tests);
  const modules: { path: string; file: number; tree: ParseNode }[] = [];
  for (const path of source.paths) {
    const uri: Uri = source.uriOf(path);
    const parsed = source.program.getParseResults(uri);
    source.program.getBoundSourceFile(uri);
    if (!parsed) {
      x.facts.files.push({ path, excluded: "SYNTAX_ERROR" });
      continue;
    }
    const tree = parsed.parserOutput.parseTree;
    x.setModule(tree, path);
    const file = x.add({
      kind: "FILE",
      name: path,
      path,
      start: 0,
      end: parsed.text.length,
      nameStart: -1,
      exported: false,
      execution: "MODULE",
    });
    x.setFileObject(path, file);
    const doc = docstring(tree.d.statements);
    if (doc) x.note(file, path, doc);
    new Declarer(x, path, file, tree).walk(tree);
    // Pyright recovers from syntax errors, often without error nodes; its parse diagnostics tell.
    const syntaxError = source.program
      .getSourceFile(uri)
      ?.getParseDiagnostics()
      .some((diagnostic) => diagnostic.category === DiagnosticCategory.Error);
    x.facts.files.push({
      path,
      object: file,
      ...(syntaxError ? { excluded: "SYNTAX_ERROR" as const } : {}),
    });
    modules.push({ path, file, tree });
  }
  for (const { path, file, tree } of modules) new Relater(x, path, file, tree).walk(tree);
  implementations(x);
  return x.facts;
}

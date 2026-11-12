import {
  isCallExpression,
  isIdentifier,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  type Symbol as CompilerSymbol,
  type Project,
  SignatureKind,
  SymbolFlags,
} from "typescript/unstable/async";
import { mapExportedFunction } from "./project-map-declarations";
import { mapCallableCarrier, mapUnwrapExpression } from "./project-map-execution";
import type { MapObject, MapRelation, MapWorkerInput } from "./project-map-types";
import { mapRelativePath } from "./project-map-virtual-files";

// Whether a function or method declaration is a signature without a body; undefined for others.
const signature = (node: Node) =>
  node.kind === SyntaxKind.FunctionDeclaration || node.kind === SyntaxKind.MethodDeclaration
    ? !(node as Node & { body?: Node }).body
    : undefined;

// A call taking a function, as a wrapper does: catchAsync(async (req, res) => ...).
const wraps = (value: Node) => {
  const call = mapUnwrapExpression(value);
  return (
    isCallExpression(call) &&
    call.arguments.some((argument) =>
      [SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression].includes(
        mapUnwrapExpression(argument).kind,
      ),
    )
  );
};

// Declarations whose members a call can dispatch through: interfaces, type literals and classes.
const memberContainers = new Set([
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeLiteral,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
]);

type Resolution = {
  objects: MapObject[];
  unresolvedReason?: MapRelation["unresolvedReason"];
};

export class MapTargetResolver {
  private readonly cache = new Map<number, Resolution>();
  private readonly mappedCache = new Map<number, MapObject[]>();
  // Whether what a value's symbol holds can be called, by its type.
  private readonly callableTypes = new Map<number, Promise<boolean>>();
  constructor(
    private readonly project: Project,
    private readonly input: MapWorkerInput,
    private readonly mapDeclaration: (node: Node) => MapObject | undefined,
  ) {}

  async resolve(symbol: CompilerSymbol | undefined): Promise<Resolution> {
    if (this.input.syntaxOnly) return { objects: [], unresolvedReason: "SYNTAX_ONLY" };
    if (!symbol) return { objects: [], unresolvedReason: "SYMBOL_NOT_RESOLVED" };
    const cached = this.cache.get(symbol.id);
    if (cached) return cached;
    const original = symbol.id;
    if (symbol.flags & SymbolFlags.Alias)
      symbol = await this.project.checker.getAliasedSymbol(symbol);
    const objects: MapObject[] = [];
    const reasons = new Set<MapRelation["unresolvedReason"]>();
    const nodes = new Map<(typeof symbol.declarations)[number], Node | undefined>();
    for (const handle of symbol.declarations)
      if (mapRelativePath(handle.path) !== undefined)
        nodes.set(handle, await handle.resolve(this.project));
    // Overload signatures resolve to the implementation that follows them.
    const implemented = [...nodes.values()].some((node) => node && signature(node) === false);
    for (const handle of symbol.declarations) {
      const relative = mapRelativePath(handle.path);
      if (relative !== undefined) {
        const node = nodes.get(handle);
        if (implemented && node && signature(node)) continue;
        // Handles use compiler-canonical paths; source identity retains the admitted spelling.
        const source = node && mapRelativePath(node.getSourceFile().fileName);
        if (!source || !Object.hasOwn(this.input.files, source)) {
          reasons.add(node ? "OUTSIDE_SOURCE_CONTEXT" : "DECLARATION_NOT_AVAILABLE");
          continue;
        }
        // A CommonJS export, exports.getUser = fn, declares the function it assigns.
        const object = node && this.mapDeclaration(mapExportedFunction(node)?.node ?? node);
        if (object) objects.push(object);
        else reasons.add("SOURCE_DECLARATION_UNMAPPED");
      } else if (
        (await this.project.program.getSourceFileMetadata(handle.path))?.isDefaultLibrary
      ) {
        reasons.add("COMPILER_LIBRARY");
      } else {
        reasons.add("OUTSIDE_SOURCE_CONTEXT");
      }
    }
    const result: Resolution = {
      objects: [...new Map(objects.map((object) => [object.id, object])).values()],
      ...(!objects.length
        ? {
            unresolvedReason: reasons.has("SOURCE_DECLARATION_UNMAPPED")
              ? "SOURCE_DECLARATION_UNMAPPED"
              : reasons.has("OUTSIDE_SOURCE_CONTEXT")
                ? "OUTSIDE_SOURCE_CONTEXT"
                : reasons.has("COMPILER_LIBRARY")
                  ? "COMPILER_LIBRARY"
                  : "DECLARATION_NOT_AVAILABLE",
          }
        : {}),
    };
    this.cache.set(original, result);
    return result;
  }

  // The module-level variables a read resolves to, among those already mapped: a read of anything
  // else (a local, a parameter, a library value) links nothing and materializes nothing.
  async resolveMapped(
    symbol: CompilerSymbol | undefined,
    mapped: (node: Node) => MapObject | undefined,
  ): Promise<MapObject[]> {
    if (this.input.syntaxOnly || !symbol) return [];
    const cached = this.mappedCache.get(symbol.id);
    if (cached) return cached;
    const target =
      symbol.flags & SymbolFlags.Alias
        ? await this.project.checker.getAliasedSymbol(symbol)
        : symbol;
    const objects: MapObject[] = [];
    if (target.flags & SymbolFlags.Variable)
      for (const handle of target.declarations) {
        if (mapRelativePath(handle.path) === undefined) continue;
        const node = await handle.resolve(this.project);
        const object = node && mapped(node);
        if (object) objects.push(object);
      }
    this.mappedCache.set(symbol.id, objects);
    return objects;
  }

  // A value links only a function, a method or a binding initialized with a function expression.
  // Other values stay unlinked, so resolving them never materializes locals.
  async resolveCallable(
    symbol: CompilerSymbol | undefined,
    depth = 0,
  ): Promise<Resolution | undefined> {
    if (this.input.syntaxOnly || !symbol) return undefined;
    const target =
      symbol.flags & SymbolFlags.Alias
        ? await this.project.checker.getAliasedSymbol(symbol)
        : symbol;
    let callable = (target.flags & (SymbolFlags.Function | SymbolFlags.Method)) !== 0;
    if (!callable && target.flags & (SymbolFlags.Variable | SymbolFlags.Property))
      for (const handle of target.declarations) {
        const node = (await handle.resolve(this.project)) as
          | (Node & { initializer?: Node; expression?: Node })
          | undefined;
        // A property naming a function declared apart is that function, as the controllers a
        // CommonJS module exports are: module.exports = { getUser }, { list: listItems }.
        const named =
          node && depth < 4
            ? isShorthandPropertyAssignment(node)
              ? await this.project.checker.getShorthandAssignmentValueSymbol(node)
              : isPropertyAssignment(node) && isIdentifier(mapUnwrapExpression(node.initializer))
                ? await this.project.checker.getSymbolAtLocation(
                    mapUnwrapExpression(node.initializer),
                  )
                : undefined
            : undefined;
        const linked = named && (await this.resolveCallable(named, depth + 1));
        if (linked) return linked;
        // A binding initialized with a function, or a default export of one, or a function a
        // CommonJS module exports: exports.getUser = (req, res) => ...
        const value =
          node?.kind === SyntaxKind.ExportAssignment ? node.expression : node?.initializer;
        const exported = node && mapExportedFunction(node);
        if (
          (value && mapCallableCarrier(mapUnwrapExpression(value)) === node) ||
          (exported && !exported.wrapped)
        )
          callable = true;
        // A function a wrapper returns, as Express handlers are: catchAsync(async (req, res) => ...),
        // memo(() => ...). A call taking a function is a wrapper when what it gives can be called.
        else if (
          (exported?.wrapped || (value && wraps(value))) &&
          (await this.callableType(target))
        )
          callable = true;
      }
    if (!callable) return undefined;
    const resolved = await this.resolve(target);
    return resolved.objects.length ? resolved : undefined;
  }

  private callableType(symbol: CompilerSymbol): Promise<boolean> {
    const known = this.callableTypes.get(symbol.id);
    if (known) return known;
    const result = (async () => {
      const type = await this.project.checker.getTypeOfSymbol(symbol);
      return Boolean(
        type && (await this.project.checker.getSignaturesOfType(type, SignatureKind.Call)).length,
      );
    })();
    this.callableTypes.set(symbol.id, result);
    return result;
  }

  // The source members of interfaces, type literals and classes that a property symbol declares.
  // Members of object literals are values, not contracts, so an inferred shape never links.
  async resolveMembers(symbol: CompilerSymbol | undefined): Promise<MapObject[]> {
    if (this.input.syntaxOnly || !symbol) return [];
    const objects = new Map<string, MapObject>();
    for (const handle of symbol.declarations) {
      if (mapRelativePath(handle.path) === undefined) continue;
      const node = await handle.resolve(this.project);
      const source = node && mapRelativePath(node.getSourceFile().fileName);
      if (!node?.parent || !source || !Object.hasOwn(this.input.files, source)) continue;
      if (!memberContainers.has(node.parent.kind)) continue;
      const object = this.mapDeclaration(node);
      if (object?.kind === "METHOD" || object?.kind === "PROPERTY") objects.set(object.id, object);
    }
    return [...objects.values()];
  }
}

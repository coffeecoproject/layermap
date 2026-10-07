import {
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isElementAccessExpression,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isInterfaceDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { type Project, type Type, TypeFlags, type UnionType } from "typescript/unstable/async";
import { digestValue } from "./digest";
import { mapParsingContext } from "./project-map-context";
import {
  mapNodeLabel as label,
  mapDeclarationKind,
  mapDeclarationName as named,
} from "./project-map-declarations";
import {
  mapCallableCarrier,
  mapChildExecutionOwner,
  mapExecutionDeclaration,
  mapExecutionKind,
  mapIsCallable,
  mapUnwrapExpression,
  mapValueProperty,
  mapValueUse,
} from "./project-map-execution";
import type { MapParserTrace } from "./project-map-failure";
import { MapOutputCollector } from "./project-map-output";
import { MapTargetResolver } from "./project-map-resolution";
import { decoratorRoute, registeredRoute } from "./project-map-routes";
import { mapSourceFiles } from "./project-map-source-files";
import { MapSourcePositions } from "./project-map-source-positions";
import {
  MAP_RELATION_PRIORITY,
  type MapAnalysis,
  type MapAnchor,
  type MapObject,
  type MapRelation,
  type MapWorkerInput,
} from "./project-map-types";
import { mapRelativePath as relativePath } from "./project-map-virtual-files";
import { isMapWrite } from "./project-map-write";

const key = (node: Node) => `${node.getSourceFile().fileName}:${node.pos}:${node.kind}`;
// Nodes that declare something an object can stand for, and the name it would carry.
const declares = (node: Node) =>
  Boolean(mapExecutionDeclaration(node) || (mapDeclarationKind(node, true) && named(node)));
const declarationName = (node: Node) => {
  const execution = mapExecutionDeclaration(node);
  const name = named(node);
  return execution?.name ?? (name ? label(name) : "");
};
type Contract = Node & {
  properties?: readonly Node[];
  members?: readonly Node[];
  heritageClauses?: readonly (Node & { types: readonly Node[] })[];
};
type Member = Node & { modifiers?: readonly Node[] };
type Pending = {
  owner: string;
  node: Node;
  lookup: Node;
  kind: MapRelation["kind"];
  target: string;
  anchor: MapAnchor;
  holder?: Node;
  argument?: string;
  route?: string;
};

export async function extractProjectMap(
  project: Project,
  input: MapWorkerInput,
  trace: MapParserTrace,
): Promise<MapAnalysis> {
  const output: MapAnalysis = {
    contexts: [],
    objects: [],
    relations: [],
    notes: [],
    gaps: [
      ...(!input.configPath ? [{ code: "NO_ADMITTED_TSCONFIG" }] : []),
      { code: "EXTERNAL_DEPENDENCIES_NOT_LOADED" },
      { code: "DYNAMIC_AND_FRAMEWORK_LINKS_REQUIRE_SOURCE_INVESTIGATION" },
      { code: "UNMODELED_LANGUAGE_CONSTRUCTS_REQUIRE_SOURCE_INVESTIGATION" },
      { code: "DETAILED_REFERENCES_AVAILABLE_ON_DEMAND" },
      { code: "INLINE_VALUE_MEMBERS_MAPPED_WHEN_LINKED" },
      { code: "LOCAL_BINDINGS_MAPPED_WHEN_LINKED" },
      { code: "PROJECT_TYPECHECK_NOT_PERFORMED" },
      ...(input.workspace?.issues.map((code) => ({ code })) ?? []),
      ...(input.workspace?.redirects.length
        ? [{ code: "WORKSPACE_BUILD_OUTPUTS_REDIRECTED_TO_ADMITTED_SOURCE" }]
        : []),
    ],
    parsedFiles: [],
    requiredFiles: [],
  };
  const declared = new Map<string, MapObject>();
  const owned = new Set(input.rootFiles ?? Object.keys(input.files));
  const positions = new MapSourcePositions(input.files);
  const anchor = (node: Node, file: SourceFile) => positions.anchor(node, file);
  const declarations: { object: MapObject; name: Node; node: Node; file: SourceFile }[] = [];
  const exportedSymbols = new Map<string, Set<number>>();
  const pending: Pending[] = [];
  // Object literals and heritage declarations whose members may implement contract members.
  const contracts: Contract[] = [];
  // Object members materialized because their value resolved to a function.
  const callableHolders = new Set<string>();
  // Imported bindings and callable declarations: the only names a value use can link.
  const valueNames = new Set<string>();
  // Names of namespace imports (import * as ns): a value use of ns.member may link too.
  const namespaces = new Set<string>();
  const collect = new MapOutputCollector(output);
  // An object is identified by its file, kind, name and place among the declarations around it:
  // the declarations it lies in and the same-named ones before it there. An edit elsewhere leaves
  // it, and every relation that names it, unchanged, and every context that materializes a
  // declaration gives it the same identity.
  // Per scope, each declaration's place among the same-named ones (by name and position).
  const scopes = new Map<string, Map<string, number>>();
  const declaredIn = (scope: Node) => {
    const found = scopes.get(key(scope));
    if (found) return found;
    const ordinals = new Map<string, number>();
    const counts = new Map<string, number>();
    const visit = (node: Node): void => {
      node.forEachChild((child) => {
        if (declares(child)) {
          const name = declarationName(child);
          const count = counts.get(name) ?? 0;
          ordinals.set(`${name}\0${child.pos}`, count);
          counts.set(name, count + 1);
        } else visit(child);
        return undefined;
      });
    };
    visit(scope);
    scopes.set(key(scope), ordinals);
    return ordinals;
  };
  const identities = new Map<string, string>();
  const identity = (node: Node): string => {
    if (node.kind === SyntaxKind.SourceFile) return "";
    const known = identities.get(key(node));
    if (known !== undefined) return known;
    let scope = node.parent;
    while (scope.kind !== SyntaxKind.SourceFile && !declares(scope)) scope = scope.parent;
    const name = declarationName(node);
    const ordinal = declaredIn(scope).get(`${name}\0${node.pos}`);
    if (ordinal === undefined) throw new Error("PROJECT_MAP_PROTOCOL_INVALID");
    const value = digestValue({ scope: identity(scope), name, ordinal });
    identities.set(key(node), value);
    return value;
  };
  const gap = (code: string, path?: string) => {
    output.gaps.push({ code, ...(path ? { path } : {}) });
  };
  const addObject = (
    node: Node,
    file: SourceFile,
    kind: MapObject["kind"],
    name: string,
  ): MapObject => {
    const location = anchor(node, file);
    const object: MapObject = {
      id: digestValue({ path: location.path, kind, identity: identity(node) }),
      contextRef: input.contextRef,
      name,
      kind,
      anchor: location,
      exported:
        node.kind === SyntaxKind.ExportAssignment ||
        Boolean(
          (node as Node & { modifiers?: readonly Node[] }).modifiers?.some(
            (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
          ),
        ),
      ...(mapExecutionKind(node) ? { execution: mapExecutionKind(node) } : {}),
      contextRole: owned.has(location.path) ? "DEFAULT" : "DEPENDENCY",
      ...(named(node) ? { symbolStart: anchor(named(node) as Node, file).start } : {}),
      ...(kind === "FILE"
        ? {
            language: file.fileName.split(".").at(-1) ?? "unknown",
            parsing: input.syntaxOnly ? ("SYNTAX_ONLY" as const) : ("PARSED" as const),
          }
        : {}),
    };
    collect.object(object);
    declared.set(key(node), object);
    return object;
  };

  trace.phase = "SOURCE_FILES";
  for await (const { file, path, syntaxErrors, exports } of mapSourceFiles(project, input, trace)) {
    if (!file) {
      gap("SOURCE_NOT_PARSED", path);
      continue;
    }
    if (syntaxErrors) {
      gap("SYNTAX_ERROR", path);
      continue;
    }
    output.parsedFiles.push(path);
    const fileObject = addObject(file, file, "FILE", path);
    // Dependency declarations are materialized only when linked. Their default context owns traversal.
    if (!owned.has(path)) continue;
    exportedSymbols.set(file.fileName, exports);
    trace.phase = "TRAVERSAL";
    const stack: {
      node: Node;
      owner: MapObject;
      execution: MapObject;
      declarationExecution: MapObject;
    }[] = [
      { node: file, owner: fileObject, execution: fileObject, declarationExecution: fileObject },
    ];
    while (stack.length) {
      const item = stack.pop();
      if (!item) break;
      const { node } = item;
      let owner = item.owner;
      const kind = mapDeclarationKind(node);
      const name = named(node);
      const executionDeclaration = mapExecutionDeclaration(node);
      const carrier = mapCallableCarrier(node);
      const carrierObject = carrier && declared.get(key(carrier));
      if (carrierObject) {
        declared.set(key(node), carrierObject);
        owner = carrierObject;
      } else if ((kind && name) || executionDeclaration) {
        const object = addObject(
          node,
          file,
          executionDeclaration?.kind ?? (kind as MapObject["kind"]),
          executionDeclaration?.name ?? label(name as Node),
        );
        if (owned.has(path))
          collect.relation({
            from: owner.id,
            to: object.id,
            kind: "CONTAINS",
            anchor: object.anchor,
            target: object.name,
            basis: "SYNTAX_DECLARED",
          });
        if (owned.has(path) && name) declarations.push({ object, name, node, file });
        owner = object;
        if (kind === "INTERFACE" && owned.has(path)) {
          const note = {
            entityRef: object.id,
            kind: "CONTRACT_DECLARATION",
            text: "Declares a TypeScript interface. This does not establish runtime enforcement or business authority.",
            anchor: object.anchor,
            truncated: false,
          } as const;
          collect.note(note);
        }
      }
      let reference: Omit<Pending, "owner" | "anchor"> | undefined;
      const moduleSpecifier = isImportDeclaration(node)
        ? node.moduleSpecifier
        : isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
      if (
        moduleSpecifier &&
        (isStringLiteral(moduleSpecifier) || isNoSubstitutionTemplateLiteral(moduleSpecifier))
      ) {
        reference = {
          node,
          lookup: moduleSpecifier,
          kind: /(?:^|[/.])(?:test|spec|tests)(?:[/.]|$)/u.test(path) ? "TEST_IMPORTS" : "IMPORTS",
          target: moduleSpecifier.text,
        };
      } else if (isCallExpression(node) || isNewExpression(node)) {
        const route = registeredRoute(node, "CALLS");
        reference = {
          node,
          lookup: node.expression,
          kind: "CALLS",
          target: label(node.expression),
          ...(route ? { argument: route } : {}),
        };
      } else if (isDecorator(node)) {
        const call = isCallExpression(node.expression) ? node.expression : undefined;
        const expression = call ? call.expression : node.expression;
        // A literal first argument (such as a route) is part of what the declaration declares;
        // parameter decorators stay names only.
        const first = call?.arguments[0];
        const argument =
          node.parent.kind !== SyntaxKind.Parameter &&
          first &&
          (isStringLiteral(first) || isNoSubstitutionTemplateLiteral(first)) &&
          first.text.length > 0 &&
          first.text.length <= 256
            ? first.text
            : undefined;
        const route =
          node.parent.kind !== SyntaxKind.Parameter ? decoratorRoute(node, argument) : undefined;
        reference = {
          node,
          lookup: expression,
          kind: "DECORATED_BY",
          target: label(expression),
          ...(argument ? { argument } : {}),
          ...(route && route !== argument ? { route } : {}),
        };
      } else if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
        const writes = isMapWrite(node);
        if (writes) {
          reference = {
            node,
            lookup: isPropertyAccessExpression(node)
              ? node.name
              : isStringLiteral(node.argumentExpression)
                ? node.argumentExpression
                : node,
            kind: "WRITES",
            target: label(node),
          };
        } else if (isPropertyAccessExpression(node) && mapValueUse(node)) {
          const route = registeredRoute(node, "REFERENCES");
          reference = {
            node,
            lookup: node.name,
            kind: "REFERENCES",
            target: node.name.text,
            holder: mapValueProperty(node),
            ...(route ? { argument: route } : {}),
          };
        }
      } else if (isIdentifier(node) && named(node.parent) !== node) {
        const parent = node.parent;
        if (
          !((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === node)
        ) {
          const writes = isMapWrite(node);
          if (writes) reference = { node, lookup: node, kind: "WRITES", target: label(node) };
          else if (mapValueUse(node)) {
            const route = registeredRoute(node, "REFERENCES");
            reference = {
              node,
              lookup: node,
              kind: "REFERENCES",
              target: node.text,
              holder: mapValueProperty(node),
              ...(route ? { argument: route } : {}),
            };
          }
        }
      } else if (isShorthandPropertyAssignment(node)) {
        reference = {
          node,
          lookup: node.name,
          kind: "REFERENCES",
          target: label(node.name),
          holder: node,
        };
      } else if (isImportSpecifier(node)) {
        valueNames.add(node.name.text);
      } else if (node.kind === SyntaxKind.ImportClause) {
        // A default import's local name (import requireAuth from "./auth").
        const local = (node as Node & { name?: Node }).name;
        if (local && isIdentifier(local)) valueNames.add(local.text);
      } else if (node.kind === SyntaxKind.NamespaceImport) {
        const local = (node as Node & { name: Node }).name;
        if (isIdentifier(local)) namespaces.add(local.text);
      } else if (
        node.kind === SyntaxKind.ExpressionWithTypeArguments &&
        node.parent.kind === SyntaxKind.HeritageClause
      ) {
        const expression = (node as Node & { expression: Node }).expression;
        reference = {
          node,
          lookup: expression,
          kind:
            (node.parent as Node & { token: SyntaxKind }).token === SyntaxKind.ImplementsKeyword
              ? "IMPLEMENTS"
              : "EXTENDS",
          target: label(expression),
        };
      }
      if (
        isObjectLiteralExpression(node) ||
        ((isClassDeclaration(node) ||
          node.kind === SyntaxKind.ClassExpression ||
          isInterfaceDeclaration(node)) &&
          (node as Contract).heritageClauses?.length)
      )
        contracts.push(node);
      if (reference && owned.has(path)) {
        pending.push({
          ...reference,
          owner: ["CALLS", "WRITES"].includes(reference.kind) ? item.execution.id : owner.id,
          anchor: anchor(node, file),
        });
      }
      const children: Node[] = [];
      node.forEachChild((child) => {
        children.push(child);
      });
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child)
          stack.push({
            node: child,
            owner,
            execution: mapChildExecutionOwner(
              node,
              child,
              owner,
              item.execution,
              item.declarationExecution,
            ),
            declarationExecution: mapIsCallable(node) ? item.execution : item.declarationExecution,
          });
      }
    }
  }
  await trace.checkpoint?.("SOURCES");
  for (let start = 0; start < declarations.length; start += 128) {
    const batch = declarations.slice(start, start + 128);
    trace.phase = "DECLARATION_SYMBOLS";
    const symbols = await project.checker.getSymbolAtLocation(batch.map((item) => item.name));
    trace.phase = "DOCUMENTATION";
    for (const [index, item] of batch.entries()) {
      item.object.exported =
        exportedSymbols.get(item.file.fileName)?.has(symbols[index]?.id ?? -1) ?? false;
      for (const documentation of item.node.jsDoc ?? []) {
        const relative = item.object.anchor.path;
        const full = input.files[relative]?.slice(documentation.pos, documentation.end) ?? "";
        if (!full) continue;
        collect.note({
          entityRef: item.object.id,
          kind: "SOURCE_DOCUMENTATION",
          text: full,
          truncated: false,
          anchor: positions.span(relative, documentation.pos, documentation.end),
        });
      }
    }
  }
  await trace.checkpoint?.("DECLARATIONS");
  pending.sort(
    (left, right) => MAP_RELATION_PRIORITY[left.kind] - MAP_RELATION_PRIORITY[right.kind],
  );
  const materialize = (node: Node): MapObject | undefined => {
    const existing = declared.get(key(node));
    if (existing) return existing;
    const carrier = mapCallableCarrier(node);
    if (carrier) {
      const object = materialize(carrier);
      if (object) declared.set(key(node), object);
      return object;
    }
    const name = named(node);
    const kind = mapDeclarationKind(node, true);
    const executionDeclaration = mapExecutionDeclaration(node);
    const file = node.getSourceFile();
    const path = relativePath(file.fileName);
    if ((!executionDeclaration && (!name || !kind)) || !path || !Object.hasOwn(input.files, path))
      return undefined;
    const object = addObject(
      node,
      file,
      executionDeclaration?.kind ?? (kind as MapObject["kind"]),
      executionDeclaration?.name ?? label(name as Node),
    );
    let parent = node.parent;
    while (
      parent &&
      !declared.has(key(parent)) &&
      !(mapDeclarationKind(parent) && named(parent)) &&
      !mapExecutionDeclaration(parent)
    )
      parent = parent.parent;
    const owner = parent ? materialize(parent) : undefined;
    if (owner && owned.has(path))
      collect.relation({
        from: owner.id,
        to: object.id,
        kind: "CONTAINS",
        anchor: object.anchor,
        target: object.name,
        basis: "SYNTAX_DECLARED",
      });
    return object;
  };
  const targets = new MapTargetResolver(project, input, materialize);
  for (const object of declared.values())
    if (object.execution && object.execution !== "MODULE") valueNames.add(object.name);
  const linkable = pending.filter(
    (item) =>
      item.kind !== "REFERENCES" ||
      valueNames.has(item.target) ||
      (isPropertyAccessExpression(item.node) &&
        isIdentifier(item.node.expression) &&
        namespaces.has(item.node.expression.text)),
  );
  for (let start = 0; start < linkable.length; start += 128) {
    const batch = linkable.slice(start, start + 128);
    trace.phase = "RELATION_SYMBOLS";
    const symbols = await project.checker.getSymbolAtLocation(batch.map((item) => item.lookup));
    trace.phase = "RELATION_TARGETS";
    for (const [index, item] of batch.entries()) {
      if (item.kind === "REFERENCES") {
        const symbol = isShorthandPropertyAssignment(item.node)
          ? await project.checker.getShorthandAssignmentValueSymbol(item.node)
          : symbols[index];
        // Values that are not functions, or cannot be resolved, are data flow rather than calls.
        const callable = await targets.resolveCallable(symbol);
        const holder = callable && item.holder ? materialize(item.holder) : undefined;
        if (holder && item.holder) callableHolders.add(key(item.holder));
        for (const destination of callable?.objects ?? [])
          collect.relation({
            from: holder?.id ?? item.owner,
            to: destination.id,
            kind: item.kind,
            anchor: item.anchor,
            target: item.target,
            ...(item.argument ? { argument: item.argument } : {}),
            basis: "TYPE_RESOLVED",
          });
        continue;
      }
      const directCallable = item.kind === "CALLS" ? mapUnwrapExpression(item.lookup) : undefined;
      const directObject =
        directCallable && mapIsCallable(directCallable) ? materialize(directCallable) : undefined;
      const resolved = directObject
        ? { objects: [directObject], unresolvedReason: undefined }
        : await targets.resolve(symbols[index]);
      for (const destination of resolved.objects.length ? resolved.objects : [undefined]) {
        collect.relation({
          from: item.owner,
          ...(destination ? { to: destination.id } : {}),
          kind: item.kind,
          anchor: item.anchor,
          target: item.target,
          ...(item.argument ? { argument: item.argument } : {}),
          ...(item.route ? { route: item.route } : {}),
          basis: directObject ? "SYNTAX_DECLARED" : destination ? "TYPE_RESOLVED" : "UNRESOLVED",
          ...(!destination ? { unresolvedReason: resolved.unresolvedReason } : {}),
        });
      }
      if (item.kind === "WRITES") {
        const note = {
          entityRef: item.owner,
          kind: "STATE_WRITE",
          text: `Contains an assignment to ${item.target}. A write site is not necessarily the owner of the business rule.`,
          anchor: item.anchor,
          truncated: false,
        } as const;
        collect.note(note);
      }
    }
  }
  await trace.checkpoint?.("RELATIONS");
  trace.phase = "IMPLEMENTATIONS";
  // A function member of a typed object literal, or a member of a class or interface with
  // heritage, implements or overrides the same-named member of the contract type, so calls to
  // that member may dispatch here. Accessors, static members and non-function values stay out.
  const implementation = (member: Member): MapObject | undefined => {
    if (member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword))
      return undefined;
    const object = declared.get(key(member));
    if (!object) return undefined;
    switch (member.kind) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.PropertySignature:
        return object;
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
        return object.execution === "CLOSURE" || callableHolders.has(key(member))
          ? object
          : undefined;
      default:
        return undefined;
    }
  };
  const implemented = new Set<string>();
  const implement = async (contract: Contract, type: Type | undefined, members: Member[]) => {
    if (!type) return [];
    // Each constituent of a union is a contract on its own, such as `T | undefined` or the
    // `PromiseLike<T> | T` an async function's return expects.
    const types =
      type.flags & TypeFlags.Union ? ((await (type as UnionType).getTypes()) ?? []) : [type];
    const links: Omit<MapRelation, "id">[] = [];
    for (const member of members) {
      const object = implementation(member);
      const name = named(member);
      if (!object || !name) continue;
      const destinations: MapObject[] = [];
      for (const constituent of types)
        destinations.push(
          ...(await targets.resolveMembers(
            await project.checker.getPropertyOfType(constituent, label(name)),
          )),
        );
      for (const destination of destinations) {
        const link = `${object.id}\u0000${destination.id}`;
        if (destination.id === object.id || implemented.has(link)) continue;
        implemented.add(link);
        links.push({
          from: object.id,
          to: destination.id,
          kind: "OVERRIDES",
          anchor: anchor(name, contract.getSourceFile()),
          target: destination.name,
          basis: "TYPE_RESOLVED",
        });
      }
    }
    return links;
  };
  for (let start = 0; start < contracts.length; start += 32) {
    const batch = contracts.slice(start, start + 32).map(async (contract) => {
      if (contract.properties) {
        const members = contract.properties.filter((member) => implementation(member));
        if (!members.length) return [];
        // Object.freeze returns its argument, so a frozen literal implements what the call's
        // context expects; other calls infer the literal's own shape and link nothing.
        const parent = contract.parent;
        const frozen =
          isCallExpression(parent) &&
          parent.arguments[0] === contract &&
          label(parent.expression) === "Object.freeze";
        const context = await project.checker.getContextualType(
          (frozen ? parent : contract) as Expression,
        );
        return implement(contract, context, members);
      }
      const members = (contract.members ?? []).filter((member) => implementation(member));
      if (!members.length) return [];
      const links: Omit<MapRelation, "id">[] = [];
      for (const clause of contract.heritageClauses ?? [])
        for (const heritage of clause.types)
          links.push(
            ...(await implement(
              contract,
              await project.checker.getTypeAtLocation(heritage),
              members,
            )),
          );
      return links;
    });
    // Publish in source order rather than response arrival order.
    for (const links of await Promise.all(batch)) for (const link of links) collect.relation(link);
  }
  await trace.checkpoint?.("IMPLEMENTATIONS");
  trace.phase = "CONFIG_DIAGNOSTICS";
  for (const diagnostic of await project.program.getConfigFileParsingDiagnostics())
    gap(`TSC_CONFIG_${diagnostic.code}`, input.configPath);
  trace.phase = "PROGRAM_DIAGNOSTICS";
  for (const diagnostic of await project.program.getProgramDiagnostics())
    gap(`TSC_PROGRAM_${diagnostic.code}`, input.configPath);
  trace.phase = "CONTEXT";
  output.contexts.push(mapParsingContext(project, input));
  return output;
}

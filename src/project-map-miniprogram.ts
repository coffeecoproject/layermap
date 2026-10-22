import path from "node:path";
import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { digestValue } from "./digest";
import type { MapAnchor, MapGap, MapObject, MapRelation } from "./project-map-types";

// WeChat mini-programs wire a page or component to its template by name, which no compiler
// follows: pages/home/home.ts registers Page({ open() {} }) or Component({ methods: { open() {} } }),
// and pages/home/home.wxml beside it binds those methods to events (bindtap="open",
// catch:change="pick") and puts as tags the components its .json, or app.json, registers under
// usingComponents. The template calls each method it binds and references the template of each
// component it puts, so a method's callers reach the pages that show it. A component emits events
// by name, this.triggerEvent("close"), which the template that puts it binds (bind:close="onClose"):
// the declaration that emits one calls the handler each template that puts it binds to it.

/** Whether a file is a mini-program template. */
export const mapMiniprogramTemplate = (file: string) => file.endsWith(".wxml");

const templateOf = (script: string) => script.replace(/\.[cm]?[jt]sx?$/u, ".wxml");

/** The template beside a page or component file, when the inventory holds one. */
export const miniprogramTemplateOf = (script: string, inventory: ReadonlySet<string>) =>
  /\.[cm]?[jt]sx?$/u.test(script) && inventory.has(templateOf(script))
    ? templateOf(script)
    : undefined;

type Configuration = Readonly<{
  /** The page's or component's own .json. */
  own?: string;
  /** The app.json of the mini-program it belongs to, the nearest one above it. */
  app?: string;
  /** That app.json's directory, "" for the repository's root. */
  root?: string;
}>;

/** The configuration a page or component template's links read besides it. */
export function miniprogramConfiguration(
  template: string,
  inventory: ReadonlySet<string>,
): Configuration {
  const own = template.replace(/\.wxml$/u, ".json");
  const configuration = inventory.has(own) ? { own } : {};
  for (let directory = path.posix.dirname(template); ; directory = path.posix.dirname(directory)) {
    const root = directory === "." ? "" : directory;
    const app = path.posix.join(root, "app.json");
    if (inventory.has(app)) return { ...configuration, app, root };
    if (!root) return configuration;
  }
}

const propertyName = (member: Node) => {
  const name = (member as Node & { name?: Node }).name;
  return name && (isIdentifier(name) || isStringLiteral(name)) ? name.text : undefined;
};

// The file's Page({...}) or Component({...}) registration, with its options.
function registration(file: SourceFile) {
  for (const statement of file.statements) {
    if (!isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!isCallExpression(call) || !isIdentifier(call.expression)) continue;
    const kind = call.expression.text;
    const options = call.arguments[0];
    if ((kind === "Page" || kind === "Component") && options && isObjectLiteralExpression(options))
      return { kind, options };
  }
  return undefined;
}

/**
 * The methods a page or component file registers, by name: the members of Page's options, or of
 * Component's methods. Undefined when the file registers neither.
 */
export function miniprogramMethods(file: SourceFile): Map<string, Node> | undefined {
  const registered = registration(file);
  if (!registered) return undefined;
  const { kind, options } = registered;
  let members: readonly Node[] = options.properties;
  if (kind === "Component") {
    const methods = options.properties.find((member) => propertyName(member) === "methods");
    const value = methods && isPropertyAssignment(methods) ? methods.initializer : undefined;
    members = value && isObjectLiteralExpression(value) ? value.properties : [];
  }
  const found = new Map<string, Node>();
  for (const member of members) {
    const name = propertyName(member);
    if (name !== undefined && (isMethodDeclaration(member) || isPropertyAssignment(member)))
      found.set(name, member);
  }
  return found;
}

/** A component's this.triggerEvent(name, detail, options) call. */
export type MiniprogramEmit = Readonly<{
  call: CallExpression;
  name: Expression;
  /** Whether the event crosses component boundaries, so a component that puts this one passes it on. */
  composed: boolean;
}>;

// An event crosses component boundaries unless its options say it does not.
const composedEvent = (options: Expression | undefined) => {
  if (!options) return false;
  if (!isObjectLiteralExpression(options)) return true;
  const composed = (options as ObjectLiteralExpression).properties.find(
    (member) => propertyName(member) === "composed",
  );
  if (!composed) return false;
  return !(isPropertyAssignment(composed) && composed.initializer.kind === SyntaxKind.FalseKeyword);
};

/**
 * The calls by which a component file emits its events. Undefined when the file is no component,
 * or when they cannot all be read: a component with behaviors, which emit events of their own, or
 * one calling triggerEvent on another receiver than this, or with a spread argument.
 */
export function miniprogramEmits(file: SourceFile): MiniprogramEmit[] | undefined {
  const registered = registration(file);
  if (
    registered?.kind !== "Component" ||
    registered.options.properties.some((member) => propertyName(member) === "behaviors")
  )
    return undefined;
  const emits: MiniprogramEmit[] = [];
  let readable = true;
  const visit = (node: Node): undefined => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "triggerEvent"
    ) {
      const [name, , options] = node.arguments;
      if (
        node.expression.expression.kind !== SyntaxKind.ThisKeyword ||
        !name ||
        node.arguments.some((argument) => argument.kind === SyntaxKind.SpreadElement)
      )
        readable = false;
      else emits.push({ call: node, name, composed: composedEvent(options) });
    }
    node.forEachChild(visit);
    return undefined;
  };
  visit(file);
  return readable ? emits : undefined;
}

/** The target of a template's binding to an event the component it binds on does not emit. */
export const miniprogramEventTarget = (tag: string, event: string) => `<${tag}> ${event} event`;

/** The tag and event of a binding's target that names an event, undefined for other targets. */
export const miniprogramEventOf = (target: string) => {
  const match = /^<([^>]+)> (\S+) event$/u.exec(target);
  return match?.[1] && match[2] ? { tag: match[1], event: match[2] } : undefined;
};

// Events the framework itself bubbles out of a component, from the elements inside it.
const NATIVE_EVENTS = new Set([
  "touchstart",
  "touchmove",
  "touchcancel",
  "touchend",
  "touchforcechange",
  "tap",
  "longpress",
  "longtap",
  "transitionend",
  "animationstart",
  "animationiteration",
  "animationend",
]);

type Span = Readonly<{ start: number; end: number }>;
type Binding = Span & {
  /** The method a static value names, or undefined for a {{computed}} one. */
  method?: string;
  /** The event it binds: tap for bindtap and bind:tap. */
  event: string;
  /** The index of the tag it is on. */
  tag: number;
};
type Template = Readonly<{
  bindings: readonly Binding[];
  tags: readonly (Span & { name: string })[];
}>;

// bindtap, bind:tap, catchtap, catch:tap, capture-bind:tap, capture-catch:tap, mut-bind:tap.
const BINDING = /^(?:(?:capture-)?(?:bind|catch)|mut-bind):?[a-z][\w-]*$/iu;
const BINDING_PREFIX = /^(?:(?:capture-)?(?:bind|catch)|mut-bind):?/iu;
const METHOD = /^[A-Za-z_$][\w$]*$/u;
const TAG = /<([A-Za-z][\w.:-]*)/uy;
const ATTRIBUTE = /\s*([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/uy;

/** The event bindings and tags of a template, by a scan of its tags rather than a full parse. */
export function parseMiniprogramTemplate(text: string): Template {
  const bindings: Binding[] = [];
  const tags: (Span & { name: string })[] = [];
  const skip = (from: number, end: string) => {
    const at = text.indexOf(end, from);
    return at < 0 ? text.length : at + end.length;
  };
  for (let index = 0; index < text.length; ) {
    const open = text.indexOf("<", index);
    const expression = text.indexOf("{{", index);
    // Text between tags may hold expressions with < in them: {{a < b}}.
    if (expression >= 0 && (open < 0 || expression < open)) {
      index = skip(expression + 2, "}}");
      continue;
    }
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      index = skip(open + 4, "-->");
      continue;
    }
    TAG.lastIndex = open;
    const tag = TAG.exec(text);
    if (!tag?.[1]) {
      index = open + 1;
      continue;
    }
    const name = tag[1];
    tags.push({ name, start: open + 1, end: open + 1 + name.length });
    let at = TAG.lastIndex;
    for (;;) {
      while (at < text.length && /\s/u.test(text[at] as string)) at++;
      if (at >= text.length || text[at] === ">" || text.startsWith("/>", at)) break;
      ATTRIBUTE.lastIndex = at;
      const attribute = ATTRIBUTE.exec(text);
      if (!attribute) {
        at++;
        continue;
      }
      at = ATTRIBUTE.lastIndex;
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      const attributeName = attribute[1] ?? "";
      if (value === undefined || !BINDING.test(attributeName)) continue;
      const end = at - (attribute[4] === undefined ? 1 : 0);
      const start = end - value.length;
      const method = value.trim();
      const binding = {
        event: attributeName.replace(BINDING_PREFIX, ""),
        tag: tags.length - 1,
        start,
        end,
      };
      if (METHOD.test(method)) bindings.push({ ...binding, method });
      else if (method.includes("{{")) bindings.push(binding);
    }
    index = text[at] === ">" ? at + 1 : at + 2;
    // A wxs module's content is script, not markup.
    if (name === "wxs" && text[at] === ">") index = skip(index, "</wxs>");
  }
  return { bindings, tags };
}

const usingComponents = (text: string | undefined): Record<string, string> => {
  if (!text) return {};
  try {
    const using = (JSON.parse(text) as { usingComponents?: unknown }).usingComponents;
    if (!using || typeof using !== "object") return {};
    return Object.fromEntries(
      Object.entries(using).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

// The template a usingComponents path names: from the mini-program's root when it starts with a
// slash, otherwise beside the registering file, then from the root and its npm packages.
function componentTemplate(
  value: string,
  registeredIn: string,
  root: string | undefined,
  inventory: ReadonlySet<string>,
): string | undefined {
  if (/^plugin(?:-private)?:\/\//u.test(value)) return undefined;
  const from = (base: string) => path.posix.normalize(path.posix.join(base || ".", value));
  const bases = value.startsWith("/")
    ? root !== undefined
      ? [from(root)]
      : []
    : [
        from(path.posix.dirname(registeredIn)),
        ...(root !== undefined ? [from(root), from(path.posix.join(root, "miniprogram_npm"))] : []),
      ];
  for (const base of bases)
    for (const candidate of [`${base}.wxml`, `${base}/index.wxml`])
      if (!candidate.startsWith("../") && inventory.has(candidate)) return candidate;
  return undefined;
}

export type MiniprogramLinks = {
  objects: MapObject[];
  relations: Omit<MapRelation, "id">[];
  gaps: MapGap[];
  /** The templates the links were read from, which the context parsed. */
  parsedFiles: string[];
};

/** A file object's id, as the TypeScript analysis identifies a module. */
const fileId = (file: string) => digestValue({ path: file, kind: "FILE", identity: "" });

/** The events a component emits, by name, each with the declarations that emit it and where. */
export type MiniprogramEvents = ReadonlyMap<
  string,
  readonly Readonly<{ emitter: MapObject; anchor: MapAnchor }>[]
>;

/**
 * The links of page and component templates: each template is a module that calls the methods
 * its bindings name and references the templates of the components it puts. A component outside
 * the given scripts is linked through its template as a dependency. A binding on a component's tag
 * is called from where the component emits its event, and names the event as unresolved when the
 * component's events are known and it emits no such event.
 */
export function linkMiniprogramTemplates(
  scripts: readonly Readonly<{
    template: string;
    methods: ReadonlyMap<string, Node>;
    /** A component's events, when they are all known. */
    events?: MiniprogramEvents;
  }>[],
  context: Readonly<{
    contextRef: string;
    inventory: ReadonlySet<string>;
    /** A file's text, read through the analysis so that it counts among the context's inputs. */
    read(file: string): string | undefined;
    span(file: string, start: number, end: number): MapAnchor;
    /** The object of a method's declaration, mapped when a binding links it. */
    materialize(node: Node): MapObject | undefined;
    /**
     * The events components emit across component boundaries, which any component that puts the
     * emitting one may pass on; undefined when the name of one is not known.
     */
    composed?: ReadonlySet<string>;
  }>,
): MiniprogramLinks {
  const links: MiniprogramLinks = { objects: [], relations: [], gaps: [], parsedFiles: [] };
  const modules = new Map<string, MapObject>();
  const module = (template: string, role: MapObject["contextRole"]) => {
    const known = modules.get(template);
    if (known) return known;
    const text = context.read(template);
    if (text === undefined) return undefined;
    const object: MapObject = {
      id: fileId(template),
      contextRef: context.contextRef,
      kind: "FILE",
      name: template,
      anchor: context.span(template, 0, text.length),
      exported: false,
      execution: "MODULE",
      contextRole: role,
      language: "wxml",
      parsing: "PARSED",
    };
    modules.set(template, object);
    links.objects.push(object);
    return object;
  };
  const owned = scripts.flatMap((script) => {
    const object = module(script.template, "DEFAULT");
    return object ? [{ ...script, object }] : [];
  });
  const events = new Map(owned.map((script) => [script.template, script.events]));
  const emitted = new Set<string>();
  for (const { template, methods, object } of owned) {
    links.parsedFiles.push(template);
    const parsed = parseMiniprogramTemplate(context.read(template) ?? "");
    // A page's or component's own registrations take precedence over the app's.
    const registered = new Map<string, string | undefined>();
    if (parsed.tags.length) {
      const { own, app, root } = miniprogramConfiguration(template, context.inventory);
      for (const file of [app, own])
        if (file !== undefined)
          for (const [tag, value] of Object.entries(usingComponents(context.read(file))))
            registered.set(tag, componentTemplate(value, file, root, context.inventory));
    }
    let computed = 0;
    for (const binding of parsed.bindings) {
      const anchor = context.span(template, binding.start, binding.end);
      const method = binding.method === undefined ? undefined : methods.get(binding.method);
      const target = method && context.materialize(method);
      if (binding.method === undefined) computed++;
      else
        links.relations.push({
          from: object.id,
          kind: "CALLS",
          anchor,
          target: binding.method,
          ...(target
            ? { to: target.id, basis: "SYNTAX_DECLARED" as const }
            : { basis: "UNRESOLVED" as const, unresolvedReason: "SYMBOL_NOT_RESOLVED" as const }),
        });
      // On a component's tag, the handler is called from where the component emits the event.
      const tag = parsed.tags[binding.tag]?.name;
      const component = tag === undefined ? undefined : registered.get(tag);
      const known = component === undefined ? undefined : events.get(component);
      if (tag === undefined || !known) continue;
      const emits = known.get(binding.event);
      if (emits) {
        for (const emit of emits) {
          const link = `${emit.emitter.id}\u0000${target?.id}\u0000${emit.anchor.start}`;
          if (!target || emitted.has(link)) continue;
          emitted.add(link);
          links.relations.push({
            from: emit.emitter.id,
            to: target.id,
            kind: "CALLS",
            anchor: emit.anchor,
            target: target.name,
            basis: "SYNTAX_DECLARED",
          });
        }
      } else if (
        !NATIVE_EVENTS.has(binding.event) &&
        context.composed &&
        !context.composed.has(binding.event)
      )
        links.relations.push({
          from: object.id,
          kind: "CALLS",
          anchor,
          target: miniprogramEventTarget(tag, binding.event),
          basis: "UNRESOLVED",
          unresolvedReason: "SYMBOL_NOT_RESOLVED",
        });
    }
    if (computed)
      links.gaps.push({
        code: "MINIPROGRAM_COMPUTED_EVENT_HANDLERS",
        path: template,
        count: computed,
      });
    for (const tag of parsed.tags) {
      if (!registered.has(tag.name)) continue;
      const component = registered.get(tag.name);
      const target = component === undefined ? undefined : module(component, "DEPENDENCY");
      links.relations.push({
        from: object.id,
        kind: "REFERENCES",
        anchor: context.span(template, tag.start, tag.end),
        target: tag.name,
        ...(target
          ? { to: target.id, basis: "SYNTAX_DECLARED" as const }
          : {
              basis: "UNRESOLVED" as const,
              unresolvedReason: "DECLARATION_NOT_AVAILABLE" as const,
            }),
      });
    }
  }
  return links;
}

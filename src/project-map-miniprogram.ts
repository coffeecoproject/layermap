import path from "node:path";
import {
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { digestValue } from "./digest";
import type { MapAnchor, MapGap, MapObject, MapRelation } from "./project-map-types";

// WeChat mini-programs wire a page or component to its template by name, which no compiler
// follows: pages/home/home.ts registers Page({ open() {} }) or Component({ methods: { open() {} } }),
// and pages/home/home.wxml beside it binds those methods to events (bindtap="open",
// catch:change="pick") and puts as tags the components its .json, or app.json, registers under
// usingComponents. The template calls each method it binds and references the template of each
// component it puts, so a method's callers reach the pages that show it.

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

/**
 * The methods a page or component file registers, by name: the members of Page's options, or of
 * Component's methods. Undefined when the file registers neither.
 */
export function miniprogramMethods(file: SourceFile): Map<string, Node> | undefined {
  for (const statement of file.statements) {
    if (!isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!isCallExpression(call) || !isIdentifier(call.expression)) continue;
    const registration = call.expression.text;
    const options = call.arguments[0];
    if ((registration !== "Page" && registration !== "Component") || !options) continue;
    if (!isObjectLiteralExpression(options)) continue;
    let members: readonly Node[] = options.properties;
    if (registration === "Component") {
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
  return undefined;
}

type Span = Readonly<{ start: number; end: number }>;
type Template = Readonly<{
  /** Event bindings: the method a static value names, or undefined for a {{computed}} one. */
  bindings: readonly (Span & { method?: string })[];
  tags: readonly (Span & { name: string })[];
}>;

// bindtap, bind:tap, catchtap, catch:tap, capture-bind:tap, capture-catch:tap, mut-bind:tap.
const BINDING = /^(?:(?:capture-)?(?:bind|catch)|mut-bind):?[a-z][\w-]*$/iu;
const METHOD = /^[A-Za-z_$][\w$]*$/u;
const TAG = /<([A-Za-z][\w.:-]*)/uy;
const ATTRIBUTE = /\s*([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/uy;

/** The event bindings and tags of a template, by a scan of its tags rather than a full parse. */
export function parseMiniprogramTemplate(text: string): Template {
  const bindings: (Span & { method?: string })[] = [];
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
      if (value === undefined || !BINDING.test(attribute[1] ?? "")) continue;
      const end = at - (attribute[4] === undefined ? 1 : 0);
      const start = end - value.length;
      const method = value.trim();
      if (METHOD.test(method)) bindings.push({ method, start, end });
      else if (method.includes("{{")) bindings.push({ start, end });
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

/**
 * The links of page and component templates: each template is a module that calls the methods
 * its bindings name and references the templates of the components it puts. A component outside
 * the given scripts is linked through its template as a dependency.
 */
export function linkMiniprogramTemplates(
  scripts: readonly Readonly<{ template: string; methods: ReadonlyMap<string, Node> }>[],
  context: Readonly<{
    contextRef: string;
    inventory: ReadonlySet<string>;
    /** A file's text, read through the analysis so that it counts among the context's inputs. */
    read(file: string): string | undefined;
    span(file: string, start: number, end: number): MapAnchor;
    /** The object of a method's declaration, mapped when a binding links it. */
    materialize(node: Node): MapObject | undefined;
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
  const owned = scripts.flatMap(({ template, methods }) => {
    const object = module(template, "DEFAULT");
    return object ? [{ template, methods, object }] : [];
  });
  for (const { template, methods, object } of owned) {
    links.parsedFiles.push(template);
    const parsed = parseMiniprogramTemplate(context.read(template) ?? "");
    let computed = 0;
    for (const binding of parsed.bindings) {
      if (binding.method === undefined) {
        computed++;
        continue;
      }
      const method = methods.get(binding.method);
      const target = method && context.materialize(method);
      links.relations.push({
        from: object.id,
        kind: "CALLS",
        anchor: context.span(template, binding.start, binding.end),
        target: binding.method,
        ...(target
          ? { to: target.id, basis: "SYNTAX_DECLARED" as const }
          : { basis: "UNRESOLVED" as const, unresolvedReason: "SYMBOL_NOT_RESOLVED" as const }),
      });
    }
    if (computed)
      links.gaps.push({
        code: "MINIPROGRAM_COMPUTED_EVENT_HANDLERS",
        path: template,
        count: computed,
      });
    if (!parsed.tags.length) continue;
    // A page's or component's own registrations take precedence over the app's.
    const { own, app, root } = miniprogramConfiguration(template, context.inventory);
    const registered = new Map<string, string | undefined>();
    for (const file of [app, own])
      if (file !== undefined)
        for (const [tag, value] of Object.entries(usingComponents(context.read(file))))
          registered.set(tag, componentTemplate(value, file, root, context.inventory));
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

import type { CodeIndexStore } from "./code-index-store";
import { type GitRunner, type GitRunOptions, gitGrep } from "./git-runner";
import { mapTestPath } from "./project-map-types";

// A route and the code that requests it are linked by a path string, which no compiler follows: a
// frontend's fetch("/api/v1/items/" + id), a generated client's url: "/api/v1/items/{id}", a
// template's href. The paths of the routes a change reaches, or removes, are looked up by text in
// the code and templates outside the tests.

/** A route the change reaches or removes, and the places outside the tests that request it. */
export type MapRouteClients = Readonly<{
  route: string;
  removed: boolean;
  clients: readonly string[];
}>;

/** The routes requested outside the tests, and why the search did not finish when it did not. */
export type MapRouteClientSearch = Readonly<{
  routes: readonly MapRouteClients[];
  failed?: string;
  /** How many routes were past the search's limit, and not searched for. */
  unsearched?: number;
}>;

type Segment = Readonly<{ text: string; param: boolean }>;

// Where code and templates request paths: the mapped languages and the template kinds.
const CLIENT_FILES = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "py",
  "java",
  "kt",
  "html",
  "htm",
  "jinja",
  "jinja2",
  "j2",
  "hbs",
  "ejs",
  "tmpl",
  "tpl",
  "gohtml",
  "vue",
  "svelte",
].map((extension) => `*.${extension}`);
// A path parameter as routers and clients write it: {id}, ${id}, :id, <int:id>, %d, [id], *.
const PARAM =
  /^(?:\{[^}]*\}|\$\{[^}]*\}|:\w+\??|<[^>]*>|%[sdvqfx]|\[[^\]]+\]|\*{1,2}|\{\{.*\}\})$/u;
// A prefix a server mounts its routes under and clients write out: /api, /v1, /rest.
const MOUNT = /^(?:api|v\d+(?:\.\d+)?|rest|public|internal|backend)$/iu;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gu;
// A literal that mounts routes under a prefix rather than requesting one: prefix="/items",
// app.use("/api", router), r.Group("/v1").
const MOUNTING =
  /(?:\b(?:prefix|root_path|base_path|basePath|baseURL|baseUrl)\s*[=:]|\b(?:Group|Route|Mount|mount|use|include_router|PathPrefix|StripPrefix)\s*\()\s*$/u;
const LIMIT = Object.freeze({ routes: 40, clients: 5 });
// A route label: its HTTP methods, if named, then its path.
const ROUTE = /^(?:[A-Z]+(?:\|[A-Z]+)* +)?\/\S*$/u;

const segments = (path: string): Segment[] =>
  path
    .split("/")
    .filter(Boolean)
    .map((text) => ({ text, param: PARAM.test(text) || /[{}$<>%]/u.test(text) }));

/**
 * A route's label, or a request's written as one: its HTTP methods, if named, then its path, as
 * "GET|POST /items/{id}", "/items" and "POST {}" are.
 */
export function mapRouteLabel(label: string): { methods?: readonly string[]; path: string } {
  const match = /^([A-Z]+(?:\|[A-Z]+)*) +(\S.*)$/u.exec(label);
  return match ? { methods: (match[1] ?? "").split("|"), path: match[2] ?? "" } : { path: label };
}

/** Whether a text is a route's label: its HTTP methods, if named, then its path. */
export const mapIsRouteLabel = (text: string) => ROUTE.test(text);

/**
 * The route a relation registers: a decorator's whole route, which says more than its argument
 * (a controller's prefix, the method), else the route label a registration call is given.
 */
export function mapRegisteredRoute(
  relation: Readonly<{ route?: string; argument?: string }>,
): string | undefined {
  const route = relation.route ?? relation.argument;
  return route && mapIsRouteLabel(route) ? route : undefined;
}

/**
 * Whether a route serves a request by their methods: one named for none (all, use, route)
 * serves any, a GET serves a HEAD too, and a request whose method is not known may be any.
 */
export function mapRouteServes(route: string, request: string): boolean {
  const served = mapRouteLabel(route).methods;
  const sent = mapRouteLabel(request).methods;
  return (
    !served ||
    !sent ||
    sent.some((method) => served.includes(method) || (method === "HEAD" && served.includes("GET")))
  );
}

/** A route's path segments from its label ("GET|POST /items/{id}"). */
const routeSegments = (label: string) => segments(mapRouteLabel(label).path);

/**
 * The longest stretch of a route's path that code requesting it spells out, parameters left out:
 * "/funds/items" of "GET /funds/items/{id}/read"; a path with no parameter whole, as written.
 */
export function mapRouteLiteral(label: string): string {
  const all = routeSegments(label);
  if (!all.some((segment) => segment.param)) return mapRouteLabel(label).path;
  let longest = "";
  let stretch = "";
  for (const segment of [...all, { text: "", param: true }])
    if (!segment.param) stretch += `/${segment.text}`;
    else {
      if (stretch.length > longest.length) longest = stretch;
      stretch = "";
    }
  return longest;
}

/**
 * The path a string literal requests, if it is one: at its start, after a leading placeholder for
 * a base URL (`${base}/items`), after a scheme and host, in a Thymeleaf @{...} link, or after
 * Spring's redirect: and forward:. A literal that ends in a slash and is joined with what follows
 * ("/items/" + id) gains a parameter.
 */
function requestedPath(literal: string, joined: boolean): Segment[] | undefined {
  const match =
    /^(?:https?:\/\/[^/\s]+|(?:\$\{[^}]*\})+|@\{|redirect:|forward:)?(\/[^\s?#()"'`,;|]*)/u.exec(
      literal,
    ) ?? undefined;
  const path = match?.[1];
  if (!path || path.startsWith("//") || path.length < 3) return undefined;
  const parts = segments(path);
  if (joined && path.endsWith("/")) parts.push({ text: "*", param: true });
  return parts;
}

// A literal segment matches the same text; a route parameter matches any segment; a parameter in
// the request matches only a parameter.
const same = (route: Segment, requested: Segment) =>
  route.param || (!requested.param && route.text === requested.text);

/**
 * How well a requested path matches a route: aligned at their ends, the number of extra leading
 * segments on either side (a mount prefix such as /api/v1, or a router's own), or -1 when it does
 * not match. Extra segments other than a mount prefix need two matching segments.
 */
function fit(route: readonly Segment[], requested: readonly Segment[]): number {
  const shorter = Math.min(route.length, requested.length);
  if (!shorter) return -1;
  const routeTail = route.slice(route.length - shorter);
  const requestedTail = requested.slice(requested.length - shorter);
  if (!routeTail.every((segment, index) => same(segment, requestedTail[index] as Segment)))
    return -1;
  if (!routeTail.some((segment) => !segment.param && segment.text.length >= 3)) return -1;
  const extra = [
    ...route.slice(0, route.length - shorter),
    ...requested.slice(0, requested.length - shorter),
  ];
  return extra.every((segment) => MOUNT.test(segment.text)) || shorter >= 2 ? extra.length : -1;
}

// The routes a request fits most closely: the fewest extra segments, then the most segments named
// literally, so a request for /owners/new is that route's, not /owners/{ownerId}'s.
function closestRoutes(
  known: readonly Readonly<{ route: string; segments: readonly Segment[] }>[],
  requested: readonly Segment[],
): string[] {
  const fits = known
    .map((entry) => ({
      route: entry.route,
      extra: fit(entry.segments, requested),
      literal: entry.segments.filter((segment) => !segment.param).length,
    }))
    .filter((entry) => entry.extra >= 0);
  const fewest = Math.min(...fits.map((entry) => entry.extra));
  const named = Math.max(
    ...fits.filter((entry) => entry.extra === fewest).map((entry) => entry.literal),
  );
  return fits
    .filter((entry) => entry.extra === fewest && entry.literal === named)
    .map((entry) => entry.route);
}

/**
 * The routes among these that a request is closest to, as a test computes it ("POST /items/{}"):
 * of those serving its method, the ones its path fits most closely, its unknown parts parameters.
 */
export function mapRequestedRoutes(routes: Iterable<string>): (request: string) => string[] {
  const known = [...new Set(routes)].map((route) => ({ route, segments: routeSegments(route) }));
  return (request) => {
    const requested = segments(mapRouteLabel(request).path);
    return requested.length
      ? closestRoutes(
          known.filter(({ route }) => mapRouteServes(route, request)),
          requested,
        )
      : [];
  };
}

/**
 * The routes the map found registered, and the lines (path:line) registering them: those lines
 * define routes rather than request them.
 */
export function routeRegistrations(
  store: CodeIndexStore,
  version: string,
): { routes: Set<string>; sites: Set<string> } {
  const routes = new Set<string>();
  const sites = new Set<string>();
  for (const row of store.database
    .prepare(
      "SELECT relation_json FROM project_map_relations WHERE version_ref = ? AND (json_extract(relation_json, '$.route') IS NOT NULL OR json_extract(relation_json, '$.argument') LIKE '%/%')",
    )
    .all(version)) {
    const relation = JSON.parse(String(row.relation_json)) as {
      anchor: { path: string; startLine: number; endLine: number };
      argument?: string;
      route?: string;
    };
    const route = mapRegisteredRoute(relation);
    if (!route) continue;
    routes.add(route);
    for (let line = relation.anchor.startLine; line <= relation.anchor.endLine; line++)
      sites.add(`${relation.anchor.path}:${line}`);
  }
  return { routes, sites };
}

/**
 * The places outside the tests that request each route's path, found with git grep: code and
 * templates, without the lines that register routes. When git grep cannot finish, none are
 * reported and `failed` says why.
 */
export async function routeClients(
  routes: readonly Readonly<{ route: string; removed: boolean }>[],
  registrations: Readonly<{ routes: ReadonlySet<string>; sites: ReadonlySet<string> }>,
  git: GitRunner,
  options: GitRunOptions,
): Promise<MapRouteClientSearch> {
  const searchable = routes
    .map((entry) => ({ ...entry, segments: routeSegments(entry.route) }))
    .filter((entry) =>
      entry.segments.some((segment) => !segment.param && segment.text.length >= 3),
    );
  const wanted = searchable.slice(0, LIMIT.routes);
  const past =
    searchable.length > wanted.length ? { unsearched: searchable.length - wanted.length } : {};
  // A request is the route it fits most closely among those the map knows, the removed ones included.
  const known = [...new Set([...registrations.routes, ...wanted.map((entry) => entry.route)])].map(
    (route) => ({ route, segments: routeSegments(route) }),
  );
  // git grep narrows the files to lines naming one of the routes' literal segments as a path part.
  const needles = new Set<string>();
  for (const entry of wanted)
    for (const segment of entry.segments) if (!segment.param) needles.add(`/${segment.text}`);
  if (!needles.size) return { routes: [] };
  const search = await gitGrep(git, { strings: [...needles], paths: CLIENT_FILES }, options);
  if (search.failed) return { routes: [], failed: search.failed, ...past };
  // Each route's requests, and whether each one's path starts with a mount prefix (/api, /v1).
  const clients = new Map<string, Map<string, boolean>>();
  for (const { path: file, line, text } of search.hits) {
    if (mapTestPath(file) || registrations.sites.has(`${file}:${line}`)) continue;
    for (const literal of text.matchAll(LITERAL)) {
      if (MOUNTING.test(text.slice(0, literal.index))) continue;
      const after = text.slice((literal.index ?? 0) + literal[0].length).trimStart();
      const requested = requestedPath(literal[2] ?? "", after.startsWith("+"));
      if (!requested) continue;
      const closest = new Set(closestRoutes(known, requested));
      const mounted = MOUNT.test(requested[0]?.text ?? "");
      for (const entry of wanted)
        if (closest.has(entry.route))
          clients.set(
            entry.route,
            (clients.get(entry.route) ?? new Map()).set(`${file}:${line}`, mounted),
          );
    }
  }
  // When some requests spell out the mount prefix, the API is requested that way, and paths
  // without it are the frontend's own pages (a link to /items beside fetch("/api/v1/items")).
  const requestedRoutes = wanted
    .map(({ route, removed }) => {
      const found = [...(clients.get(route) ?? [])];
      const mounted = found.some(([, prefixed]) => prefixed);
      return {
        route,
        removed,
        clients: found.filter(([, prefixed]) => prefixed || !mounted).map(([site]) => site),
      };
    })
    .filter((entry) => entry.clients.length);
  return { routes: requestedRoutes, ...past };
}

/** One line per route: its label, whether it was removed, and the first few places requesting it. */
export const routeClientsLine = ({ route, removed, clients }: MapRouteClients) =>
  `${JSON.stringify(route)}${removed ? " (removed or renamed)" : ""} ← ${clients.slice(0, LIMIT.clients).join(", ")}${clients.length > LIMIT.clients ? `, +${clients.length - LIMIT.clients} more` : ""}`;

import type { CodeIndexStore } from "./code-index-store";
import { GitCommandError, type GitRunner, type GitRunOptions } from "./git-runner";
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

/** A route's path segments from its label ("GET|POST /items/{id}"). */
const routeSegments = (label: string) => segments(label.slice(label.indexOf("/")));

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
    const route = relation.route ?? relation.argument;
    if (!route || !ROUTE.test(route)) continue;
    routes.add(route);
    for (let line = relation.anchor.startLine; line <= relation.anchor.endLine; line++)
      sites.add(`${relation.anchor.path}:${line}`);
  }
  return { routes, sites };
}

/**
 * The places outside the tests that request each route's path, found with git grep: code and
 * templates, without the lines that register routes. When git grep cannot finish, none are
 * reported rather than failing the check.
 */
export async function routeClients(
  routes: readonly Readonly<{ route: string; removed: boolean }>[],
  registrations: Readonly<{ routes: ReadonlySet<string>; sites: ReadonlySet<string> }>,
  git: GitRunner,
  options: GitRunOptions,
): Promise<MapRouteClients[]> {
  const wanted = routes
    .map((entry) => ({ ...entry, segments: routeSegments(entry.route) }))
    .filter((entry) => entry.segments.some((segment) => !segment.param && segment.text.length >= 3))
    .slice(0, LIMIT.routes);
  // A request is the route it fits most closely among those the map knows, the removed ones included.
  const known = [...new Set([...registrations.routes, ...wanted.map((entry) => entry.route)])].map(
    (route) => ({ route, segments: routeSegments(route) }),
  );
  // git grep narrows the files to lines naming one of the routes' literal segments as a path part.
  const needles = new Set<string>();
  for (const entry of wanted)
    for (const segment of entry.segments) if (!segment.param) needles.add(`/${segment.text}`);
  if (!needles.size) return [];
  let found: string;
  try {
    found = (
      await git.run(
        [
          "grep",
          "-n",
          "-I",
          "-F",
          "--untracked",
          "--full-name",
          "--no-color",
          ...[...needles].flatMap((needle) => ["-e", needle]),
          "--",
          ...CLIENT_FILES,
        ],
        options,
      )
    ).stdout.toString("utf8");
  } catch (error) {
    // git grep exits with 1 when nothing matches.
    if (error instanceof GitCommandError && !options.signal?.aborted) return [];
    throw error;
  }
  // Each route's requests, and whether each one's path starts with a mount prefix (/api, /v1).
  const clients = new Map<string, Map<string, boolean>>();
  for (const hit of found.split("\n")) {
    const match = /^(.+?):(\d+):(.*)$/u.exec(hit);
    if (!match) continue;
    const [, file = "", line = "", text = ""] = match;
    if (mapTestPath(file) || registrations.sites.has(`${file}:${line}`)) continue;
    for (const literal of text.matchAll(LITERAL)) {
      if (MOUNTING.test(text.slice(0, literal.index))) continue;
      const after = text.slice((literal.index ?? 0) + literal[0].length).trimStart();
      const requested = requestedPath(literal[2] ?? "", after.startsWith("+"));
      if (!requested) continue;
      // The closest fit: fewest extra segments, then the most segments named literally, so a
      // request for /owners/new is that route's, not /owners/{ownerId}'s.
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
      const mounted = MOUNT.test(requested[0]?.text ?? "");
      for (const entry of wanted)
        if (
          fits.some(
            (other) =>
              other.route === entry.route && other.extra === fewest && other.literal === named,
          )
        )
          clients.set(
            entry.route,
            (clients.get(entry.route) ?? new Map()).set(`${file}:${line}`, mounted),
          );
    }
  }
  // When some requests spell out the mount prefix, the API is requested that way, and paths
  // without it are the frontend's own pages (a link to /items beside fetch("/api/v1/items")).
  return wanted
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
}

/** One line per route: its label, whether it was removed, and the first few places requesting it. */
export const routeClientsLine = ({ route, removed, clients }: MapRouteClients) =>
  `${JSON.stringify(route)}${removed ? " (removed or renamed)" : ""} ← ${clients.slice(0, LIMIT.clients).join(", ")}${clients.length > LIMIT.clients ? `, +${clients.length - LIMIT.clients} more` : ""}`;

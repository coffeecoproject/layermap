import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { openMap, project, signal } from "./support";

const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A router in the shapes route libraries use: subrouters made from a path, handlers registered
// with a path, methods chained on or named by the registering method, and routes in closures.
const ROUTER = `package web

import "net/http"

type Router struct{}
type Route struct{}

func (r *Router) PathPrefix(path string) *Route                                   { return &Route{} }
func (r *Router) Path(path string) *Route                                         { return &Route{} }
func (r *Router) HandleFunc(path string, h func(http.ResponseWriter, *http.Request)) *Route { return &Route{} }
func (r *Router) Get(path string, h func(http.ResponseWriter, *http.Request))     {}
func (r *Router) Route(path string, build func(r *Router))                        {}
func (r *Route) Subrouter() *Router                                               { return &Router{} }
func (r *Route) Methods(methods ...string) *Route                                 { return r }
func (r *Route) HandlerFunc(h func(http.ResponseWriter, *http.Request)) *Route    { return r }
func (r *Route) Name(name string) *Route                                          { return r }
`;
const SERVE = `package web

import "net/http"

func list(w http.ResponseWriter, r *http.Request)   {}
func update(w http.ResponseWriter, r *http.Request) {}
func show(w http.ResponseWriter, r *http.Request)   {}
func files(w http.ResponseWriter, r *http.Request)  {}
func health(w http.ResponseWriter, r *http.Request) {}

func Serve(router *Router) {
	sr := router.PathPrefix("/v1").Subrouter()
	sr.HandleFunc("/feeds", list).Methods(http.MethodGet)
	sr.HandleFunc("/feeds/{id}", update).Name("update").Methods(http.MethodPut, "PATCH")
	router.Route("/admin", func(r *Router) {
		r.Get("/users", show)
	})
	router.Path("/static/").HandlerFunc(files)
	router.HandleFunc("/health", health)
}
`;

const callerLine = async (root: string, name: string) => {
  const map = await openMap(root);
  try {
    const view = await map.explore(
      { path: "web/serve.go", name, direction: "INCOMING", depth: 1 },
      signal(),
    );
    return view.text.split("\n").find((line) => line.includes("used as value by")) ?? view.text;
  } finally {
    await map.close();
  }
};

test("Go routes carry the methods and the prefixes their own function sets", {
  skip: !hasGo,
}, async () => {
  const { root } = await project({
    "go.mod": "module example.com/app\n\ngo 1.24\n",
    "web/router.go": ROUTER,
    "web/serve.go": SERVE,
  });
  assert.match(await callerLine(root, "list"), /"GET \/v1\/feeds"$/u);
  assert.match(await callerLine(root, "update"), /"PUT\|PATCH \/v1\/feeds\/\{id\}"$/u);
  assert.match(await callerLine(root, "show"), /"GET \/admin\/users"$/u);
  assert.match(await callerLine(root, "files"), /"\/static\/"$/u);
  // A router passed in brings no prefix this function can see, and no method is named.
  assert.match(await callerLine(root, "health"), /"\/health"$/u);
});

const decoratedLine = async (root: string, path: string, name: string) => {
  const map = await openMap(root);
  try {
    const view = await map.explore({ path, name, direction: "INCOMING", depth: 1 }, signal());
    return view.text.split("\n").find((line) => line.startsWith("DECLARATION")) ?? view.text;
  } finally {
    await map.close();
  }
};

test("TypeScript routes: registrations, inline handlers and decorated controllers", async () => {
  const { root } = await project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, experimentalDecorators: true },
      include: ["src"],
    }),
    "src/service.ts":
      "export function listUsers() { return []; }\nexport function saveUser() { return 1; }\nexport function config() { return {}; }\n",
    "src/routes.ts": `import { listUsers, saveUser, config } from "./service";
declare const router: { get(path: string, ...h: unknown[]): void; post(path: string, ...h: unknown[]): void };
declare function fetchJson(path: string, options: unknown): void;
export function list() { return listUsers(); }
router.get("/users", list);
router.post("/users", async () => { saveUser(); });
fetchJson("/api/config", { body: config() });
declare const api: { route(path: string): { get(h: unknown): void } };
export function items() { return 1; }
api.route("/items").get(items);
fetch("/api/users").then(() => saveUser());
`,
    "src/controller.ts": `declare function Controller(path: string): ClassDecorator;
declare function Get(path?: string): MethodDecorator;
@Controller("users")
export class UsersController {
  @Get(":id")
  find() { return 1; }
}
`,
  });
  const map = await openMap(root);
  try {
    const callers = async (path: string, name: string) =>
      (await map.explore({ path, name, direction: "INCOMING", depth: 1 }, signal())).text;
    assert.match(await callers("src/routes.ts", "list"), /used as value by .*"GET \/users"/u);
    assert.match(await callers("src/service.ts", "saveUser"), /called by .*"POST \/users"/u);
    // A path given to something that is not named for a method leaves direct calls unlabelled.
    assert.doesNotMatch(await callers("src/service.ts", "config"), /"\/api\/config"/u);
    assert.match(await callers("src/routes.ts", "items"), /used as value by .*"GET \/items"/u);
    // A request's callback is not a handler: fetch("/api/users").then(…) registers nothing.
    assert.doesNotMatch(await callers("src/service.ts", "saveUser"), /"\/api\/users"/u);
  } finally {
    await map.close();
  }
  assert.match(
    await decoratedLine(root, "src/controller.ts", "UsersController.find"),
    /@Get\(":id"\) route "GET \/users\/:id"/u,
  );
});

test("Python routes join the router's prefix and name their methods", async () => {
  const { root } = await project({
    "app/orders.py": `from fastapi import APIRouter

router = APIRouter(prefix="/orders")


@router.get("/{order_id}")
def get_order(order_id: int):
    return order_id


@router.route("", methods=["POST", "put"])
def save_order():
    return 1
`,
  });
  assert.match(
    await decoratedLine(root, "app/orders.py", "get_order"),
    /@router\.get\("\/\{order_id\}"\) route "GET \/orders\/\{order_id\}"/u,
  );
  assert.match(
    await decoratedLine(root, "app/orders.py", "save_order"),
    /@router\.route route "POST\|PUT \/orders"/u,
  );
});

test("Java routes join the class mapping and name their methods", {
  skip: !process.env.LAYERMAP_JAVA_HOME && !process.env.JAVA_HOME,
}, async () => {
  const { root } = await project({
    "src/main/java/app/Mapping.java": `package app;
import java.lang.annotation.*;
public final class Mapping {
  @Retention(RetentionPolicy.RUNTIME) public @interface RequestMapping { String[] value() default {}; Method[] method() default {}; }
  @Retention(RetentionPolicy.RUNTIME) public @interface GetMapping { String[] value() default {}; }
  @Retention(RetentionPolicy.RUNTIME) public @interface Path { String value(); }
  @Retention(RetentionPolicy.RUNTIME) public @interface GET {}
  public enum Method { GET, PUT }
}
`,
    "src/main/java/app/Tasks.java": `package app;
import app.Mapping.*;
@RequestMapping(Tasks.BASE)
public class Tasks {
  static final String BASE = "/api/tasks";
  @GetMapping("/{id}") public String find() { return ""; }
  @RequestMapping(value = "/{id}", method = Mapping.Method.PUT) public void save() {}
}
`,
    "src/main/java/app/Items.java": `package app;
import app.Mapping.*;
@Path("items")
public class Items {
  @GET @Path("{id}") public String find() { return ""; }
}
`,
  });
  assert.match(
    await decoratedLine(root, "src/main/java/app/Tasks.java", "Tasks.find"),
    /route "GET \/api\/tasks\/\{id\}"/u,
  );
  assert.match(
    await decoratedLine(root, "src/main/java/app/Tasks.java", "Tasks.save"),
    /route "PUT \/api\/tasks\/\{id\}"/u,
  );
  assert.match(
    await decoratedLine(root, "src/main/java/app/Items.java", "Items.find"),
    /route "GET \/items\/\{id\}"/u,
  );
});

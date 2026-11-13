import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { mapRouteLiteral } from "../src/project-map-clients";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);

// A route and the code requesting it share only a path string: the check names, by text, the code
// and templates outside the tests that request the routes a change reaches or removes.
async function checkAfter(
  files: Record<string, string>,
  changes: Record<string, string>,
): Promise<string> {
  const { root, write } = await project(files);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  const map = await openMap(root);
  try {
    for (const [file, content] of Object.entries(changes)) await write(file, content);
    return (await map.checkChanges({}, signal())).text;
  } finally {
    map.close();
  }
}

const routes = (path: string, body: string) => `declare const router: {
  get(path: string, h: unknown): void;
  put(path: string, h: unknown): void;
};
export function markRead(id: number) {
  return ${body};
}
router.put("${path}", (id: number) => markRead(id));
router.get("/feeds/new", () => 1);
`;
const FILES = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true },
    include: ["server", "web"],
  }),
  "server/routes.ts": routes("/feeds/:id/read", "id"),
  "web/api.ts":
    // A template literal's ${id} placeholder, split so it stays text here.
    "export const markRead = (id: number) => fetch(`/api/feeds/$" +
    "{id}/read`, { method: 'PUT' });\nexport const fresh = () => fetch('/api/feeds/new');\n",
  "web/nav.ts": 'export const links = [{ path: "/feeds" }];\n',
  "web/feeds.test.ts": 'export const url = "/api/feeds/1/read";\n',
  // Shared test fixtures, as Gradle keeps them, are test code too.
  "web/testFixtures/feeds.ts": "export const read = () => fetch('/api/feeds/2/read');\n",
};
const section = (text: string) =>
  text.includes("REQUESTED BY")
    ? text.slice(
        text.indexOf("REQUESTED BY"),
        text.indexOf("\n", text.indexOf("If the change alters")),
      )
    : "";

test("a changed route handler names the code that requests its path, not tests or other routes", async () => {
  const text = await checkAfter(FILES, { "server/routes.ts": routes("/feeds/:id/read", "id + 1") });
  const requested = section(text);
  assert.match(requested, /^ {2}"PUT \/feeds\/:id\/read" ← web\/api\.ts:1$/mu);
  // The test is listed among the related tests; /feeds/new is another route's request.
  assert.doesNotMatch(requested, /feeds\.test\.ts|testFixtures|api\.ts:2|nav\.ts|routes\.ts/u);
});

test("a route whose path a registration with another method keeps is not named as removed", async () => {
  const text = await checkAfter(FILES, {
    "server/routes.ts": routes("/feeds/:id/read", "id").replace("router.put(", "router.get("),
  });
  assert.doesNotMatch(text, /removed or renamed/u);
});

test("a renamed route names the code still requesting its old path", async () => {
  const text = await checkAfter(FILES, { "server/routes.ts": routes("/feeds/:id/seen", "id") });
  assert.match(
    section(text),
    /^ {2}"PUT \/feeds\/:id\/read" \(removed or renamed\) ← web\/api\.ts:1$/mu,
  );
});

test("a route's literal is its longest stretch without parameters, however a router writes them", () => {
  assert.equal(mapRouteLiteral("GET /funds/items/{id}/read"), "/funds/items");
  assert.equal(mapRouteLiteral("/static/**"), "/static");
  assert.equal(mapRouteLiteral("GET /users/[id]/orders/history"), "/orders/history");
  assert.equal(mapRouteLiteral("PUT /feeds/:id/read"), "/feeds");
  // A path with no parameter is whole, as written.
  assert.equal(mapRouteLiteral("GET /static/"), "/static/");
});

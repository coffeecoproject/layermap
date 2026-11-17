import assert from "node:assert/strict";
import { test } from "node:test";
import { mapChangesText } from "../src/project-map-change-text";
import type { MapChangeImpact, MapChanges, MapUnclear } from "../src/project-map-change-types";

const changes: MapChanges = {
  base: "HEAD",
  commit: "0123456789abcdef",
  files: [
    {
      path: "src/app.ts",
      basePath: "src/app.ts",
      status: "MODIFIED",
      lines: [[1, 1]],
      baseLines: [[1, 1]],
      hunks: [{ baseStart: 1, baseCount: 1, start: 1, count: 1 }],
      removed: [],
      binary: false,
    },
  ],
  quoted: [],
  stranded: { names: [] },
};

const impact = (entries: MapChangeImpact["entries"], unclear: MapUnclear[]): MapChangeImpact => ({
  changed: ["src/app.ts: start f1-3"],
  removed: [],
  rewrittenTests: [],
  entries,
  tests: [],
  areas: [],
  unclear,
  incomplete: [],
  unmapped: [],
  removedRoutes: [],
  uncalled: [],
  dependencies: [],
  truncated: false,
});

const topLevel = (path: string): MapUnclear => ({
  text: `top-level code of ${path} changed (imports, constants or registrations)`,
  group: { kind: "TOP_LEVEL", subject: path },
});
const registration = (route: string, site: string): MapUnclear => ({
  text: `the registration of ${JSON.stringify(route)} at ${site} changed; check that the route still reaches the right handler`,
  group: { kind: "REGISTRATION", subject: site, route },
});
const handBy = (text: string) =>
  text
    .slice(text.indexOf("CHECK BY HAND"))
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("  "));

test("notes of a kind to check by hand share a line naming the first eight, in the order they came", () => {
  const files = Array.from({ length: 10 }, (_, at) => `src/f${at}.ts`);
  const text = mapChangesText(
    changes,
    impact([], [topLevel("src/a.ts"), { text: "a note of its own" }, ...files.map(topLevel)]),
  );
  assert.deepEqual(handBy(text), [
    `  top-level code of 11 files changed (imports, constants or registrations): src/a.ts, ${files.slice(0, 7).join(", ")}, +3 more`,
    "  a note of its own",
  ]);
});

test("a changed registration of a listed route is marked on its line, wherever it changed; others share a line to check by hand", () => {
  const text = mapChangesText(
    changes,
    impact(
      [
        { label: "GET /a", route: true, chain: ["a"], site: "src/app.ts:3", certain: true },
        { label: "GET /b", route: true, chain: ["b"], site: "src/app.ts:5", certain: true },
      ],
      [
        registration("GET /a", "src/app.ts:3"),
        registration("GET /b", "src/other.ts:9"),
        registration("GET /c", "src/app.ts:7"),
        registration("GET /d", "src/app.ts:8"),
      ],
    ),
  );
  assert.match(
    text,
    /^ {2}"GET \/a" → a \(registered at src\/app\.ts:3, a line the diff changed\)$/mu,
  );
  assert.match(
    text,
    /^ {2}"GET \/b" → b \(registered at src\/app\.ts:5; its registration at src\/other\.ts:9 changed\)$/mu,
  );
  assert.match(text, /^Where the diff changed a route's registration, check/mu);
  assert.deepEqual(handBy(text), [
    '  2 route registrations changed; check that each route still reaches the right handler: "GET /c" at src/app.ts:7, "GET /d" at src/app.ts:8',
  ]);
});

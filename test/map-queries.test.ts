import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeIndex } from "../src/code-index";
import type { CodeIndexStore } from "../src/code-index-store";
import { ProjectEvidenceError } from "../src/core";
import { canonicalJson } from "../src/digest";
import type { LayerMap } from "../src/layermap";
import { mapExploreTraversal } from "../src/project-map-traversal";
import { MAP_RELATION_PRIORITY, type MapRelation } from "../src/project-map-types";
import { openMap, project, signal } from "./support";

// first calls middle, in another directory, which calls last, which calls itself.
const CHAIN = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  "src/a/first.ts":
    'import { middle } from "../b/middle";\n\nexport function first() {\n  return middle();\n}\n',
  "src/b/middle.ts":
    'import { last } from "../a/last";\n\nexport function middle() {\n  return last(1);\n}\n',
  "src/a/last.ts":
    "export function last(n: number): number {\n  return n > 0 ? last(n - 1) : 0;\n}\n",
};
const ALL_KINDS = Object.keys(MAP_RELATION_PRIORITY).sort() as MapRelation["kind"][];

const storeOf = (map: LayerMap) => (map as unknown as { store: CodeIndexStore }).store;

async function chain(t: { after: (fn: () => void) => void }) {
  const { root } = await project(CHAIN);
  const map = await openMap(root);
  t.after(() => map.close());
  const version = await map.refresh(signal());
  const store = storeOf(map);
  const named = (name: string) =>
    String(
      store.database
        .prepare(
          "SELECT entity_ref FROM project_map_objects WHERE version_ref = ? AND name = ? AND kind = 'FUNCTION'",
        )
        .get(version, name)?.entity_ref,
    );
  const nameOf = (ref: string) =>
    String(
      store.database
        .prepare("SELECT name FROM project_map_objects WHERE entity_ref = ? LIMIT 1")
        .get(ref)?.name,
    );
  const walk = async (
    name: string,
    direction: "INCOMING" | "OUTGOING" | "BOTH",
    depth: number | null,
    scope: readonly string[] = ["."],
  ) => {
    const { relationRefs, frontier } = await mapExploreTraversal(
      store,
      {
        version,
        entityRef: named(name),
        direction,
        depth,
        scope: "RELATED",
        authorizationScope: canonicalJson(scope),
        selection: { path: ".", kinds: ["CALLS"] },
      },
      signal(),
    );
    const edge = (ref: string) => {
      const row = store.database
        .prepare(
          "SELECT from_ref, to_ref FROM project_map_relations WHERE version_ref = ? AND relation_ref = ?",
        )
        .get(version, ref);
      return `${nameOf(String(row?.from_ref))}>${nameOf(String(row?.to_ref))}`;
    };
    return {
      edges: relationRefs.map(edge).sort(),
      refs: relationRefs,
      frontier: frontier.map((node) => nameOf(node.entityRef)),
    };
  };
  return { map, store, version, named, walk };
}

test("a map's queries read one version's objects, however many versions the map keeps", async (t) => {
  const { map, store, version, walk } = await chain(t);
  const { database } = store;
  const prepare = database.prepare.bind(database);
  const read = new Set<string>();
  Object.defineProperty(database, "prepare", {
    configurable: true,
    value: (sql: string) => {
      read.add(sql);
      return prepare(sql);
    },
  });
  await map.explore({ path: "." }, signal());
  await map.explore(
    { path: "src/a/last.ts", name: "last", direction: "INCOMING", depth: 3 },
    signal(),
  );
  await map.search({ query: "middle", path: ".", maxResults: 20 }, signal());
  await walk("last", "BOTH", 2);
  await mapExploreTraversal(
    store,
    {
      version,
      direction: "BOTH",
      depth: null,
      scope: "PROJECT",
      authorizationScope: canonicalJson(["."]),
      selection: { path: ".", kinds: ALL_KINDS },
    },
    signal(),
  );
  Reflect.deleteProperty(database, "prepare");

  const relationReads = [...read].filter((sql) => sql.includes("project_map_relations"));
  assert.ok(relationReads.length >= 3);
  for (const sql of relationReads) {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => String(row.detail));
    assert.deepEqual(
      plan.filter((step) => /MATERIALIZE project_map_|AUTOMATIC/u.test(step)),
      [],
      sql,
    );
  }
});

test("a walk follows relations by direction and stops at its depth", async (t) => {
  const { walk } = await chain(t);
  assert.deepEqual((await walk("last", "INCOMING", null)).edges, [
    "first>middle",
    "last>last",
    "middle>last",
  ]);
  assert.deepEqual((await walk("first", "OUTGOING", null)).edges, [
    "first>middle",
    "last>last",
    "middle>last",
  ]);
  assert.deepEqual((await walk("middle", "BOTH", 1)).edges, ["first>middle", "middle>last"]);

  const one = await walk("first", "OUTGOING", 1);
  assert.deepEqual(one.edges, ["first>middle"]);
  assert.deepEqual(one.frontier, ["middle"]);
  // A declaration calling itself counts once, whichever way it is reached.
  for (const direction of ["INCOMING", "OUTGOING", "BOTH"] as const) {
    const edges = (await walk("last", direction, 1)).edges;
    assert.equal(edges.filter((edge) => edge === "last>last").length, 1);
  }
});

test("a walk does not cross a declaration the reader may not see", async (t) => {
  const { walk } = await chain(t);
  // middle is outside the scope, so first is out of reach of last although both are in it.
  assert.deepEqual((await walk("last", "INCOMING", null, ["src/a"])).edges, ["last>last"]);
  assert.deepEqual((await walk("first", "OUTGOING", null, ["src/a"])).edges, []);
  assert.deepEqual((await walk("last", "INCOMING", null, ["src/a", "src/b"])).edges, [
    "first>middle",
    "last>last",
    "middle>last",
  ]);
});

test("a relation whose target the version lost shows only in an unrestricted read", async (t) => {
  const { store, version, walk } = await chain(t);
  store.database
    .prepare("DELETE FROM project_map_version_units WHERE version_ref = ? AND path = ?")
    .run(version, "src/b/middle.ts");
  const first = String(
    store.database
      .prepare(
        "SELECT entity_ref FROM project_map_objects WHERE version_ref = ? AND name = 'first' AND kind = 'FUNCTION'",
      )
      .get(version)?.entity_ref,
  );
  const reach = async (scope: readonly string[]) =>
    (
      await mapExploreTraversal(
        store,
        {
          version,
          entityRef: first,
          direction: "OUTGOING",
          depth: 1,
          scope: "RELATED",
          authorizationScope: canonicalJson(scope),
          selection: { path: ".", kinds: ["CALLS"] },
        },
        signal(),
      )
    ).relationRefs.length;
  assert.equal(await reach(["."]), 1);
  assert.equal(await reach(["src"]), 0);
  // Nothing else in the version names it, and last no longer has a caller.
  assert.deepEqual((await walk("last", "INCOMING", null)).edges, ["last>last"]);
});

test("a walk's order does not depend on the order SQLite returns rows", async (t) => {
  const { store, walk } = await chain(t);
  const walks = async () => [
    await walk("last", "INCOMING", null),
    await walk("middle", "BOTH", null),
    await walk("first", "OUTGOING", 2),
  ];
  const forward = await walks();
  store.database.exec("PRAGMA reverse_unordered_selects = ON");
  assert.deepEqual(await walks(), forward);
});

test("a version removed part way through a walk fails the read rather than cut it short", async (t) => {
  const { map, store, version, named } = await chain(t);
  const entityRef = named("last");
  const { database } = store;
  const prepare = database.prepare.bind(database);
  let steps = 0;
  Object.defineProperty(database, "prepare", {
    configurable: true,
    value: (sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("r.to_ref IN")) return statement;
      return new Proxy(statement, {
        get: (target, name) =>
          name === "iterate"
            ? (...parameters: never[]) => {
                if (++steps === 2) {
                  Reflect.deleteProperty(database, "prepare");
                  store.collectGarbage(() => []);
                }
                return target.iterate(...parameters);
              }
            : Reflect.get(target, name).bind(target),
      });
    },
  });
  await assert.rejects(
    (map as unknown as { index: CodeIndex }).index.query.exploreMap(
      {
        version,
        entityRef,
        direction: "INCOMING",
        depth: 3,
        allowedPathPrefixes: ["."],
        maxResults: 20,
      },
      signal(),
    ),
    ProjectEvidenceError,
  );
  assert.equal(steps, 2);
});

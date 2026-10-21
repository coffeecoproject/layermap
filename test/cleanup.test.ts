import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { pruneCache } from "../src/agent/environment";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { FILES, openMap, project, sandbox, signal } from "./support";

const DAY = 24 * 60 * 60 * 1000;

test("a project keeps its three most recent map versions as its files change", async (t) => {
  const { root, write } = await project(FILES);
  const cache = path.join(await sandbox(), "cache");
  const map = await openMap(root, cache);
  t.after(() => map.close());
  const versions = new Set<string>();
  for (let edit = 0; edit < 5; edit++) {
    await write(
      "src/target.ts",
      `export function target(value: number): number {\n  return value * ${edit + 2};\n}\n`,
    );
    versions.add(await map.refresh(signal()));
  }
  assert.equal(versions.size, 5);
  const database = new DatabaseSync(mapDatabasePath(cache, map.project), { readOnly: true });
  try {
    const kept = database.prepare("SELECT version_ref FROM project_code_versions").all();
    assert.equal(kept.length, 3);
    assert.equal(Number(database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum), 2);
    // Nothing is left that no kept version lists.
    assert.equal(
      Number(
        database
          .prepare(`SELECT count(*) AS count FROM project_map_units unit WHERE NOT EXISTS (
          SELECT 1 FROM project_map_version_units used WHERE used.unit_ref = unit.unit_ref)`)
          .get()?.count,
      ),
      0,
    );
  } finally {
    database.close();
  }
  const callers = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 2 },
    signal(),
  );
  assert.match(callers.text, /← called by src\/helper\.ts: helper/u);
});

test("a database from before versions were pruned is rewritten to return freed space", async () => {
  const file = path.join(await sandbox(), "map.sqlite");
  openMapDatabase(file).close();
  const old = new DatabaseSync(file);
  old.exec("PRAGMA auto_vacuum = NONE; VACUUM; PRAGMA user_version = 1;");
  old.close();
  const upgraded = openMapDatabase(file);
  try {
    assert.equal(Number(upgraded.prepare("PRAGMA user_version").get()?.user_version), 2);
    assert.equal(Number(upgraded.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum), 2);
  } finally {
    upgraded.close();
  }
});

test("the cache drops maps unused for 30 days and analyzer builds superseded for a day", async () => {
  const cache = path.join(await sandbox(), "cache");
  const now = Date.now();
  const age = async (target: string, days: number) => {
    const when = (now - days * DAY) / 1000;
    await utimes(target, when, when);
  };
  const projects = path.join(cache, "projects");
  for (const [name, days] of [
    ["stale", 31],
    ["recent", 2],
  ] as const) {
    await mkdir(path.join(projects, name), { recursive: true });
    await writeFile(path.join(projects, name, "last-used"), "");
    await age(path.join(projects, name, "last-used"), days);
  }
  const builds = path.join(cache, "analyzers");
  for (const [name, days] of [
    ["superseded", 2],
    ["fresh", 0.5],
    ["interrupted.123", 0.1],
  ] as const) {
    await mkdir(path.join(builds, name), { recursive: true });
    await age(path.join(builds, name), days);
  }
  const current = path.join(await sandbox(), "current");
  await mkdir(current);
  await pruneCache(cache, current, now);
  const exists = async (target: string) => !!(await stat(target).catch(() => undefined));
  assert.equal(await exists(path.join(projects, "stale")), false);
  assert.equal(await exists(path.join(projects, "recent")), true);
  assert.equal(await exists(path.dirname(mapDatabasePath(cache, current))), true);
  assert.equal(await exists(path.join(builds, "superseded")), false);
  assert.equal(await exists(path.join(builds, "fresh")), true);
  assert.equal(await exists(path.join(builds, "interrupted.123")), false);
});

test("a capture empties the write-ahead log that a large write left, while another process holds the map", async (t) => {
  const { root } = await project(FILES);
  const cache = path.join(await sandbox(), "cache");
  const map = await openMap(root, cache);
  t.after(() => map.close());
  await map.refresh(signal());
  // Another connection keeps the log from being removed on close, as another session's server does.
  const file = mapDatabasePath(cache, map.project);
  const other = new DatabaseSync(file);
  t.after(() => other.close());
  // One large transaction, as a build writes, which the log holds whole.
  other.exec("BEGIN; CREATE TABLE written (data BLOB);");
  for (let block = 0; block < 40; block++)
    other.exec("INSERT INTO written VALUES (randomblob(1024 * 1024))");
  other.exec("COMMIT");
  const journal = async () => (await stat(`${file}-wal`)).size;
  assert.ok((await journal()) > 32 * 1024 * 1024);
  await map.refresh(signal());
  assert.equal(await journal(), 0);
});

test("the cache drops versions npx installed beside this one a week after it installed an older one", async () => {
  const npx = path.join(await sandbox(), "_npx");
  const now = Date.now();
  const install = async (
    name: string,
    requested: Record<string, string>,
    version: string,
    days: number,
  ) => {
    const directory = path.join(npx, name);
    await mkdir(path.join(directory, "node_modules", "layermap"), { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ dependencies: requested }),
    );
    await writeFile(
      path.join(directory, "node_modules", "layermap", "package.json"),
      JSON.stringify({ name: "layermap", version }),
    );
    const when = (now - days * DAY) / 1000;
    await utimes(directory, when, when);
    return directory;
  };
  const own = await install("own", { layermap: "^0.1.22" }, "0.1.22", 30);
  const old = await install("old", { layermap: "^0.1.9" }, "0.1.9", 8);
  const recent = await install("recent", { layermap: "^0.1.21" }, "0.1.21", 2);
  const newer = await install("newer", { layermap: "^0.2.0" }, "0.2.0", 30);
  const shared = await install("shared", { layermap: "^0.1.0", other: "1.0.0" }, "0.1.0", 30);
  const cache = path.join(await sandbox(), "cache");
  const current = path.join(await sandbox(), "current");
  await mkdir(current);
  await pruneCache(cache, current, now, path.join(own, "node_modules", "layermap"));
  const exists = async (target: string) => !!(await stat(target).catch(() => undefined));
  assert.equal(await exists(own), true);
  assert.equal(await exists(old), false, "an older version a week after npx installed it");
  assert.equal(await exists(recent), true, "a session started before the update may still run it");
  assert.equal(await exists(newer), true);
  assert.equal(await exists(shared), true, "npx installed it with another package");
});

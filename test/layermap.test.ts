import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMapTools } from "../src/agent/tools";
import { FILES, openMap, project, signal } from "./support";

test("a project directory is mapped on first use and queried by directory, declaration and name", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());

  const overview = await map.explore({ path: "." }, signal());
  assert.match(overview.text, /^PROJECT MAP · DIRECTORY \./u);
  assert.match(overview.text, /src\//u);
  assert.match(overview.text, /tools\//u);

  const callers = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 3 },
    signal(),
  );
  assert.match(callers.text, /← called by src\/helper\.ts: helper/u);
  assert.match(callers.text, /← called by src\/handler\.ts: handler/u);

  const python = await map.explore(
    { path: "tools/report.py", name: "total", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.match(python.text, /← called by tools\/report\.py: report/u);

  const found = await map.search(
    { query: "helper", path: ".", matchMode: "ANY", maxResults: 20, offset: 0 },
    signal(),
  );
  assert.match(found.text, /src\/helper\.ts: .*helper f3-5/u);

  const references = await map.references(
    { symbol: { path: "src/target.ts", name: "target" }, path: ".", maxResults: 20 },
    signal(),
  );
  assert.ok(references.references.some((reference) => reference.anchor.path === "src/helper.ts"));
});

test("a query after an edit sees the edited source, and an unchanged directory keeps its map", async (t) => {
  const { root, write } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());

  const first = await map.refresh(signal());
  assert.equal(await map.refresh(signal()), first);

  await write(
    "src/handler.ts",
    'import { target } from "./target";\n\nexport function handler() {\n  return target(20);\n}\n',
  );
  const callers = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.match(callers.text, /← called by src\/handler\.ts: handler/u);
  assert.notEqual(await map.refresh(signal()), first);
});

test("views name a generic text search unless the host names its own", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  const generic = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING" },
    signal(),
  );
  assert.match(generic.text, /confirm impact with project_find_references or a text search\./u);
  const named = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", textSearch: "grep" },
    signal(),
  );
  assert.match(named.text, /confirm impact with project_find_references or grep\./u);
});

test("views print only what varies; the tool descriptions say how to read them", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());

  const callers = await map.explore(
    { path: "src/target.ts", name: "target", direction: "INCOMING", depth: 2 },
    signal(),
  );
  assert.doesNotMatch(callers.text, /Kinds:|@n marks/u);
  assert.match(callers.text, /^PROJECT MAP · DECLARATION .*\nCalls through dependency injection/u);
  const file = await map.explore({ path: "src/target.ts" }, signal());
  assert.doesNotMatch(file.text, /Kinds:/u);
  const found = await map.search(
    { query: "helper", path: ".", matchMode: "ANY", maxResults: 20, offset: 0 },
    signal(),
  );
  assert.doesNotMatch(found.text, /Ranked by relevance/u);

  // A later page continues a view already read: its title stays, its explanations do not.
  const overview = await map.explore({ path: "." }, signal());
  const [title, explanation] = overview.text.split("\n");
  const later = await map.explore({ path: ".", offset: 1 }, signal());
  assert.equal(later.text.split("\n")[0], title);
  assert.ok(explanation && !later.text.includes(explanation));

  const explore = agentMapTools.find((tool) => tool.name === "project_explore_map");
  const search = agentMapTools.find((tool) => tool.name === "project_search_map");
  assert.match(explore?.description ?? "", /kinds f function, c class.*@n marks where/u);
  assert.match(search?.description ?? "", /kinds f function, c class/u);
});

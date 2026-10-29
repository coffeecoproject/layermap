import assert from "node:assert/strict";
import { test } from "node:test";
import { openMap, project, signal } from "./support";

/** A page renders a component by its tag beside host elements; a test renders the page. */
const FILES = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, jsx: "react-jsx" },
    include: ["src", "test"],
  }),
  "src/panel.tsx":
    "export function Panel(props: { title: string }) {\n  return <section>{props.title}</section>;\n}\n",
  "src/page.tsx":
    'import { Panel } from "./panel";\n\nexport function Page() {\n  return (\n    <main>\n      <Panel title="a">\n        a\n      </Panel>\n      <div />\n    </main>\n  );\n}\n',
  "test/page.test.tsx":
    'import { Page } from "../src/page";\n\nexport function renders() {\n  return <Page />;\n}\n',
};

test("a component rendered as a JSX tag is used as a value by the component that renders it", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());
  const panel = await map.explore(
    { path: "src/panel.tsx", name: "Panel", direction: "INCOMING", depth: 1 },
    signal(),
  );
  assert.match(panel.text, /← used as value by src\/page\.tsx: Page f3-12 @6$/mu);
  // A test that renders the page reaches it.
  const page = await map.explore(
    { path: "src/page.tsx", name: "Page", direction: "INCOMING", depth: 1, includeTests: true },
    signal(),
  );
  assert.match(page.text, /← used as value by test\/page\.test\.tsx: renders f3-5 @4$/mu);
  // Host elements are not names the map resolves or reports, and a closing tag is not a use.
  const file = await map.explore({ path: "src/page.tsx" }, signal());
  for (const text of [page.text, file.text]) assert.doesNotMatch(text, /\b(?:div|section|main)\b/u);
});

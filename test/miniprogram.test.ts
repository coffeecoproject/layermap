import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodeIndex } from "../src/code-index";
import { CodeIndexStore } from "../src/code-index-store";
import { mapDatabasePath, openMapDatabase } from "../src/layermap";
import { ProjectMapAnalyzer } from "../src/project-map-analyzer";
import { TypeScriptMapAnalyzer } from "../src/project-map-language-typescript";
import { parseMiniprogramTemplate } from "../src/project-map-miniprogram";
import { analyzers, openMap, project, sandbox, signal } from "./support";

const run = promisify(execFile);

// A mini-program: a page that shows a component, which a service's call reaches through a method
// the component's template binds to a tap.
const FILES = {
  "miniprogram/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "miniprogram/app.json": JSON.stringify({
    pages: ["pages/home/home"],
    usingComponents: {
      "booking-sheet": "/components/booking-sheet/booking-sheet",
      "status-tag": "/components/missing/missing",
    },
  }),
  "miniprogram/services/booking.ts":
    "export function cancelBooking(id: string) {\n  return id;\n}\n",
  "miniprogram/components/booking-sheet/booking-sheet.json": '{ "component": true }\n',
  "miniprogram/components/booking-sheet/booking-sheet.ts": `import { cancelBooking } from "../../services/booking";
declare function Component(options: unknown): void;
Component({
  properties: { id: String },
  methods: {
    cancel() {
      this.confirm();
    },
    confirm() {
      cancelBooking("1");
    },
  },
});
`,
  "miniprogram/components/booking-sheet/booking-sheet.wxml": `<view class="sheet">
  <!-- <button bindtap="removed">old</button> -->
  <button bindtap="cancel">Cancel</button>
</view>
`,
  // The page's own registration of a tag takes precedence over the app's.
  "miniprogram/pages/home/home.json":
    '{ "usingComponents": { "status-tag": "../../components/status-tag/status-tag" } }\n',
  "miniprogram/components/status-tag/status-tag.ts":
    "declare function Component(options: unknown): void;\nComponent({});\n",
  "miniprogram/components/status-tag/status-tag.wxml": "<text>tag</text>\n",
  "miniprogram/pages/home/home.ts": `declare function Page(options: unknown): void;
Page({
  data: { open: false },
  onSheetClosed() {
    return 1;
  },
  missing: 1,
});
`,
  "miniprogram/pages/home/home.wxml": `<view wx:if="{{a < b}}">
  <booking-sheet id="sheet" bind:closed="onSheetClosed" /><status-tag />
  <button bindtap="{{handler}}">Computed</button>
  <button bindtap="gone">Gone</button>
</view>
`,
  // A template no script beside it registers methods for.
  "miniprogram/pages/legacy/legacy.wxml": "<view>legacy</view>\n",
};

const commit = (root: string) =>
  run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });

test("a template's bindings and tags are found by a scan of its tags", () => {
  const text = `<view bindtap="open" catch:change='pick' data-x="{{a > b}}">{{ x<y }}<comp-a/>
<!-- <comp-b bindtap="gone"/> --><wxs module="m">var s = "<comp-c>";</wxs>
<button capture-bind:tap="{{name}}" mut-bind:tap=hold>`;
  const { bindings, tags } = parseMiniprogramTemplate(text);
  assert.deepEqual(
    bindings.map((binding) => [binding.method, text.slice(binding.start, binding.end)]),
    [
      ["open", "open"],
      ["pick", "pick"],
      [undefined, "{{name}}"],
      ["hold", "hold"],
    ],
  );
  assert.deepEqual(
    tags.map((tag) => tag.name),
    ["view", "comp-a", "wxs", "button"],
  );
});

test("a method a template binds is called from the template, and reached from the pages that show it", async (t) => {
  const { root } = await project(FILES);
  const map = await openMap(root);
  t.after(() => map.close());

  const callers = await map.explore(
    {
      path: "miniprogram/services/booking.ts",
      name: "cancelBooking",
      direction: "INCOMING",
      depth: 6,
    },
    signal(),
  );
  assert.match(
    callers.text,
    /← called by miniprogram\/components\/booking-sheet\/booking-sheet\.wxml: \(template\) @3\n/u,
  );
  assert.match(callers.text, /← shown by miniprogram\/pages\/home\/home\.wxml: \(template\) @2\n/u);
  // A page's handler of the component's event is bound in the page's template.
  const handler = await map.explore(
    { path: "miniprogram/pages/home/home.ts", name: "onSheetClosed", direction: "INCOMING" },
    signal(),
  );
  assert.match(handler.text, /← called by miniprogram\/pages\/home\/home\.wxml: \(template\) @2/u);
  // A binding's method the script does not register, and the computed one, are named.
  const page = await map.explore({ path: "miniprogram/pages/home/home.wxml" }, signal());
  assert.match(page.text, /· 5 lines · MINIPROGRAM_COMPUTED_EVENT_HANDLERS\n/u);
  assert.match(page.text, /→ calls miniprogram\/pages\/home\/home\.ts: onSheetClosed m4-6 @2\n/u);
  assert.match(
    page.text,
    /→ shows miniprogram\/components\/booking-sheet\/booking-sheet\.wxml: \(template\) @2\n/u,
  );
  assert.match(
    page.text,
    /→ shows miniprogram\/components\/status-tag\/status-tag\.wxml: \(template\) @2\n/u,
  );
  assert.match(page.text, /→ unresolved: gone$/u);
});

test("a change to a component reaches the pages that show it, and a template's change is checked", async (t) => {
  const { root, write } = await project(FILES);
  await run("git", ["add", "-A"], { cwd: root });
  await commit(root);
  const map = await openMap(root);
  t.after(() => map.close());

  await write(
    "miniprogram/services/booking.ts",
    "export function cancelBooking(id: string) {\n  return id.trim();\n}\n",
  );
  const service = await map.checkChanges({}, signal());
  assert.match(
    service.text,
    /AFFECTED ENTRY POINTS[^\n]*\n {2}miniprogram\/pages\/home\/home\.wxml → miniprogram\/components\/booking-sheet\/booking-sheet\.wxml → cancel → confirm\n/u,
  );

  await write("miniprogram/services/booking.ts", FILES["miniprogram/services/booking.ts"]);
  await write(
    "miniprogram/components/booking-sheet/booking-sheet.wxml",
    FILES["miniprogram/components/booking-sheet/booking-sheet.wxml"].replace("Cancel", "Stop"),
  );
  const template = await map.checkChanges({}, signal());
  assert.match(
    template.text,
    /CHANGED\n {2}miniprogram\/components\/booking-sheet\/booking-sheet\.wxml \(template\)\n/u,
  );
  assert.match(
    template.text,
    /AFFECTED ENTRY POINTS[^\n]*\n {2}miniprogram\/pages\/home\/home\.wxml → miniprogram\/components\/booking-sheet\/booking-sheet\.wxml\n/u,
  );

  // A template that binds another method leaves the one it bound without callers.
  await write(
    "miniprogram/components/booking-sheet/booking-sheet.wxml",
    FILES["miniprogram/components/booking-sheet/booking-sheet.wxml"].replace(
      'bindtap="cancel"',
      'bindtap="confirm"',
    ),
  );
  const rebound = await map.checkChanges({}, signal());
  assert.match(rebound.text, /LEFT WITHOUT CALLERS[^\n]*\n {2}[^\n]*cancel/u);
  const confirm = await map.explore(
    {
      path: "miniprogram/components/booking-sheet/booking-sheet.ts",
      name: "confirm",
      direction: "INCOMING",
      depth: 1,
    },
    signal(),
  );
  assert.match(
    confirm.text,
    /← called by miniprogram\/components\/booking-sheet\/booking-sheet\.wxml: \(template\) @3/u,
  );

  // A page's own template is the entry its change reaches; a template no script registers
  // methods for is left to check by hand.
  await write(
    "miniprogram/components/booking-sheet/booking-sheet.wxml",
    FILES["miniprogram/components/booking-sheet/booking-sheet.wxml"],
  );
  await write(
    "miniprogram/pages/home/home.wxml",
    FILES["miniprogram/pages/home/home.wxml"].replace("Gone", "Away"),
  );
  await write("miniprogram/pages/legacy/legacy.wxml", "<view>old</view>\n");
  const pages = await map.checkChanges({}, signal());
  assert.match(
    pages.text,
    /AFFECTED ENTRY POINTS[^\n]*\n {2}miniprogram\/pages\/home\/home\.wxml\n(?! )/u,
  );
  assert.match(
    pages.text,
    /miniprogram\/pages\/legacy\/legacy\.wxml changed \(template\): its effects are not mapped/u,
  );
  assert.doesNotMatch(pages.text, /home\.wxml (?:has no callers|changed \(template\))/u);
});

test("the templates and their configuration reach the analysis with the scripts, so it runs once", async (t) => {
  const { root } = await project(FILES);
  const directory = await realpath(root);
  const store = new CodeIndexStore(
    openMapDatabase(
      mapDatabasePath(await sandbox(), directory),
    ) as unknown as CodeIndexStore["database"],
  );
  const builds: string[] = [];
  const index = new CodeIndex(
    store,
    undefined,
    new ProjectMapAnalyzer([new TypeScriptMapAnalyzer((await analyzers()).typescript)], (event) => {
      if (event.operation === "BUILD" && event.phase === "STARTED") builds.push(event.contextRef);
    }),
  );
  t.after(async () => {
    await index.quiesce();
    index.close();
    store.database.close();
  });
  const stat = await lstat(directory, { bigint: true });
  await index.prepare(
    {
      kind: "WORKTREE",
      projectRef: "test:miniprogram",
      directory: { canonicalPath: directory, device: String(stat.dev), inode: String(stat.ino) },
    },
    signal(),
  );
  assert.ok(builds.length > 0);
  assert.deepEqual(builds, [...new Set(builds)], "no context is analyzed again for a missing file");
});

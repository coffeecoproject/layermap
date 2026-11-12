import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { goLocalModules, goModuleGroups } from "../src/project-map-language-go";
import { openMap, project, signal } from "./support";

const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a go.mod's local replacements and a go.work's modules are the directories they name", () => {
  const mod = [
    "module example.com/worker",
    "",
    "replace example.com/api => ../api // the service's own API",
    "replace (",
    '\texample.com/shared v1.2.0 => "../shared/"',
    "\texample.com/forked => github.com/someone/forked v1.0.0",
    "\texample.com/outside => ../../../elsewhere",
    "\texample.com/absolute => /opt/absolute",
    ")",
  ].join("\n");
  assert.deepEqual(goLocalModules("services/worker/go.mod", mod), [
    "services/api",
    "services/shared",
  ]);
  assert.deepEqual(goLocalModules("go.work", "go 1.24\n\nuse (\n\t./a\n\t.\n)\nuse ./b/c\n"), [
    "a",
    ".",
    "b/c",
  ]);
});

test("modules a replace directive or a go.work joins are one group; others stand alone", () => {
  const texts: Record<string, string> = {
    "services/api/go.mod": "module example.com/api\n",
    "services/worker/go.mod": "module example.com/worker\n\nreplace example.com/api => ../api\n",
    "tools/go.mod": "module example.com/tools\n",
    "w/go.work": "use (\n\t./a\n\t./b\n)\n",
    "w/a/go.mod": "module example.com/a\n",
    "w/b/go.mod": "module example.com/b\n",
  };
  const groups = goModuleGroups(Object.keys(texts), (path) => texts[path] ?? "");
  const joined = {
    configPath: "services/api/go.mod",
    modules: ["services/api/go.mod", "services/worker/go.mod"],
  };
  const work = { configPath: "w/go.work", modules: ["w/a/go.mod", "w/b/go.mod"] };
  assert.deepEqual(Object.fromEntries(groups), {
    "services/api/go.mod": joined,
    "services/worker/go.mod": joined,
    "tools/go.mod": { configPath: "tools/go.mod", modules: ["tools/go.mod"] },
    "w/a/go.mod": work,
    "w/b/go.mod": work,
  });
});

const callers = async (root: string, path: string, name: string) => {
  const map = await openMap(root);
  try {
    return (await map.explore({ path, name, direction: "INCOMING", depth: 1 }, signal())).text;
  } finally {
    await map.close();
  }
};

test("calls from a module into another it replaces with local source are mapped", {
  skip: !hasGo,
}, async () => {
  const { root } = await project({
    "services/api/go.mod": "module example.com/api\n\ngo 1.24\n",
    "services/api/orders/run.go": "package orders\n\nfunc Run() int { return 1 }\n",
    "services/worker/go.mod":
      "module example.com/worker\n\ngo 1.24\n\nrequire example.com/api v0.0.0\n\nreplace example.com/api => ../api\n",
    "services/worker/main.go":
      'package main\n\nimport "example.com/api/orders"\n\nfunc main() { orders.Run() }\n',
    // A module that requires the API as a release builds against that release, not this source.
    "tools/go.mod": "module example.com/tools\n\ngo 1.24\n\nrequire example.com/api v1.0.0\n",
    "tools/main.go":
      'package main\n\nimport "example.com/api/orders"\n\nfunc main() { orders.Run() }\n',
    "w/go.work": "go 1.24\n\nuse (\n\t./a\n\t./b\n)\n",
    "w/a/go.mod": "module example.com/a\n\ngo 1.24\n",
    "w/a/lib/lib.go": "package lib\n\nfunc Do() int { return 2 }\n",
    "w/b/go.mod": "module example.com/b\n\ngo 1.24\n",
    "w/b/main.go": 'package main\n\nimport "example.com/a/lib"\n\nfunc main() { lib.Do() }\n',
  });
  const run = await callers(root, "services/api/orders/run.go", "Run");
  assert.match(run, /services\/worker\/main\.go/u);
  assert.doesNotMatch(run, /tools\/main\.go/u);
  assert.match(await callers(root, "w/a/lib/lib.go", "Do"), /w\/b\/main\.go/u);
});

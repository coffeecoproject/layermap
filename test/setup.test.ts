import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  allowAgent,
  allowInClaudeSettings,
  configureCodexServer,
  disallowInClaudeSettings,
  mcpLaunchCommand,
  removeAgent,
  removeInstructionNote,
  setupAgent,
  writeInstructionNote,
} from "../src/agent/setup";
import { AGENT_MAP_NOTE } from "../src/agent/tools";
import { sandbox } from "./support";

test("Claude Code settings gain one allow rule for the map tools and keep everything else", async () => {
  const file = path.join(await sandbox(), ".claude", "settings.json");
  assert.equal(await allowInClaudeSettings(file), true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    permissions: { allow: ["mcp__layermap"] },
  });
  await writeFile(
    file,
    JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] } }),
  );
  assert.equal(await allowInClaudeSettings(file), true);
  assert.equal(await allowInClaudeSettings(file), false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    model: "x",
    permissions: { allow: ["Bash(ls)", "mcp__layermap"], deny: ["Read(.env)"] },
  });
});

test("removing the allow rule leaves no empty permissions behind", async () => {
  const file = path.join(await sandbox(), "settings.json");
  await writeFile(file, JSON.stringify({ model: "x" }));
  await allowInClaudeSettings(file);
  await disallowInClaudeSettings(file);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { model: "x" });
});

test("allow lets the plugin's tools run unprompted, and remove takes that back too", async () => {
  const home = path.join(await sandbox(), "claude");
  const options = {
    agent: "claude" as const,
    scope: "user" as const,
    project: home,
    version: "0.0.0",
    dryRun: false,
    env: { ...process.env, PATH: "", CLAUDE_CONFIG_DIR: home },
    log: () => {},
  };
  assert.equal(await allowAgent(options), true);
  const settings = path.join(home, "settings.json");
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), {
    permissions: { allow: ["mcp__plugin_layermap_layermap"] },
  });
  await removeAgent(options);
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), {});
  assert.equal(await allowAgent({ ...options, agent: "codex" }), true);
});

test("DeepSeek Harness gets LayerMap's server in its home layer, and remove restores the layer", async () => {
  const home = path.join(await sandbox(), "dsh");
  await mkdir(home, { recursive: true });
  const layer = path.join(home, "cordis.patch.yml");
  const stub = "# machine-local preferences\n[]\n";
  await writeFile(layer, stub);
  const options = {
    agent: "dsh" as const,
    scope: "user" as const,
    project: home,
    version: "0.0.0",
    dryRun: false,
    env: { ...process.env, DSH_HOME: home },
    log: () => {},
  };
  assert.equal(await setupAgent(options), true);
  const patch = await readFile(layer, "utf8");
  assert.match(patch, /^# machine-local preferences\n# layermap:begin/u);
  assert.match(
    patch,
    /name: '@deepseek-ai\/dsh-mcp-client'\n {6}config:\n {8}serverName: layermap/u,
  );
  assert.doesNotMatch(patch, /^\[\]$/mu);
  assert.equal(await setupAgent(options), true);
  assert.equal(await readFile(layer, "utf8"), patch);
  assert.match(await readFile(path.join(home, "AGENTS.md"), "utf8"), /layermap:begin/u);
  assert.equal(await removeAgent(options), true);
  assert.equal(await readFile(layer, "utf8"), stub);
  // The note's file was setup's own, so it goes too.
  await assert.rejects(readFile(path.join(home, "AGENTS.md"), "utf8"));
  assert.equal(await setupAgent({ ...options, scope: "project" }), false);
});

test("a missing dsh layer is created and removed whole; a flow-style list is left to the user", async () => {
  const home = path.join(await sandbox(), "dsh");
  const layer = path.join(home, "cordis.patch.yml");
  const options = {
    agent: "dsh" as const,
    scope: "user" as const,
    project: home,
    version: "0.0.0",
    dryRun: false,
    instructions: false,
    env: { ...process.env, DSH_HOME: home },
    log: () => {},
  };
  assert.equal(await setupAgent(options), true);
  assert.match(await readFile(layer, "utf8"), /^# layermap:begin/u);
  await removeAgent(options);
  await assert.rejects(readFile(layer, "utf8"));
  await writeFile(layer, "[{ id: mine, name: other }]\n");
  await assert.rejects(setupAgent(options), /flow-style YAML list/u);
  assert.equal(await readFile(layer, "utf8"), "[{ id: mine, name: other }]\n");
});

test("the Codex server table gains approval and timeout keys once, other lines untouched", async () => {
  const file = path.join(await sandbox(), "config.toml");
  const before = [
    'model = "gpt-5.5"',
    "",
    "[mcp_servers.layermap]",
    'command = "node"',
    'args = ["cli.mjs", "mcp"]',
    "",
    "[mcp_servers.layermap.env]",
    'A = "1"',
    "",
    "[mcp_servers.other]",
    'command = "x"',
  ].join("\n");
  await writeFile(file, before);
  assert.equal(await configureCodexServer(file), true);
  assert.equal(await configureCodexServer(file), false);
  const after = (await readFile(file, "utf8")).split("\n");
  assert.deepEqual(after.slice(2, 7), [
    "[mcp_servers.layermap]",
    'default_tools_approval_mode = "approve"',
    "tool_timeout_sec = 120",
    'command = "node"',
    'args = ["cli.mjs", "mcp"]',
  ]);
  assert.deepEqual(after.slice(7), before.split("\n").slice(5));
  await writeFile(file, 'model = "x"\n');
  await assert.rejects(configureCodexServer(file), /no \[mcp_servers\.layermap\] table/u);
});

test("setup registers the server through each agent's own command and approves its tools", async () => {
  const directory = await sandbox();
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  await mkdir(bin);
  // Stand-ins for the agents' CLIs: they record their arguments; codex also writes its table.
  for (const agent of ["claude", "codex"]) {
    const script = path.join(bin, agent);
    await writeFile(
      script,
      `#!/bin/sh\necho "${agent} $*" >> "${calls}"\nif [ "${agent}" = codex ] && [ "$2" = add ]; then printf '[mcp_servers.layermap]\\ncommand = "node"\\n' >> "$CODEX_HOME/config.toml"; fi\n`,
    );
    await chmod(script, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
    CODEX_HOME: path.join(directory, "codex"),
  };
  await mkdir(env.CODEX_HOME);
  await writeFile(path.join(env.CODEX_HOME, "config.toml"), "");
  const lines: string[] = [];
  const common = {
    project: directory,
    version: "0.0.0",
    dryRun: false,
    env,
    log: (line: string) => lines.push(line),
  };
  assert.equal(await setupAgent({ ...common, agent: "claude", scope: "user" }), true);
  assert.equal(await setupAgent({ ...common, agent: "codex", scope: "user" }), true);

  const recorded = (await readFile(calls, "utf8")).trim().split("\n");
  const launch = mcpLaunchCommand("0.0.0").join(" ");
  assert.deepEqual(recorded, [
    "claude mcp remove layermap --scope user",
    `claude mcp add --scope user layermap -- ${launch}`,
    "codex mcp remove layermap",
    `codex mcp add layermap -- ${launch}`,
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"))
      .permissions.allow,
    ["mcp__layermap"],
  );
  assert.match(
    await readFile(path.join(env.CODEX_HOME, "config.toml"), "utf8"),
    /\[mcp_servers\.layermap\]\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 120\ncommand = "node"/u,
  );
  assert.ok(launch.endsWith(" mcp"));
  assert.ok(!launch.includes(" tsx "), "loaders are passed as absolute URLs");
});

test("the note goes into an instructions file once, is replaced in place, and comes out cleanly", async () => {
  const file = path.join(await sandbox(), "CLAUDE.md");
  await writeInstructionNote(file);
  assert.equal(
    await readFile(file, "utf8"),
    `<!-- layermap:begin -->\n${AGENT_MAP_NOTE}\n<!-- layermap:end -->\n`,
  );
  const own = "# My rules\n\nReply briefly.\n";
  await writeFile(file, own);
  await writeInstructionNote(file);
  await writeInstructionNote(file, "Changed note.");
  assert.equal(
    await readFile(file, "utf8"),
    `${own}\n<!-- layermap:begin -->\nChanged note.\n<!-- layermap:end -->\n`,
  );
  await removeInstructionNote(file);
  assert.equal(await readFile(file, "utf8"), own);
});

test("remove undoes setup: the server, the approval and the note, keeping the user's own lines", async () => {
  const directory = await sandbox();
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), `#!/bin/sh\necho "claude $*" >> "${calls}"\n`);
  await chmod(path.join(bin, "claude"), 0o755);
  const home = path.join(directory, "claude");
  await mkdir(home);
  await writeFile(path.join(home, "CLAUDE.md"), "Mine.\n");
  await writeFile(
    path.join(home, "settings.json"),
    JSON.stringify({ permissions: { allow: ["Read"] } }),
  );
  const options = {
    agent: "claude" as const,
    scope: "user" as const,
    project: directory,
    version: "0.0.0",
    dryRun: false,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: home },
    log: () => {},
  };
  assert.equal(await setupAgent(options), true);
  assert.match(await readFile(path.join(home, "CLAUDE.md"), "utf8"), /layermap:begin/u);
  assert.equal(await removeAgent(options), true);
  assert.equal(await readFile(path.join(home, "CLAUDE.md"), "utf8"), "Mine.\n");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")).permissions.allow,
    ["Read"],
  );
  assert.match(await readFile(calls, "utf8"), /claude mcp remove layermap --scope user\n$/u);
});

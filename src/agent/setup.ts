import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type SetupAgent = "claude" | "codex" | "dsh";
export type SetupOptions = Readonly<{
  agent: SetupAgent;
  /** Claude Code scope: user (every project, the default), project (.mcp.json) or local. */
  scope: "user" | "project" | "local";
  project: string;
  version: string;
  dryRun: boolean;
  /** Add the note naming the map to the agent's instructions file (the default). */
  instructions?: boolean;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}>;

import { commandInvocation } from "../platform";
import { AGENT_MAP_NOTE } from "./tools";

const SERVER = "layermap";
/** Claude Code names a server's tools mcp__<server>__*, and a plugin's server plugin_<plugin>_<server>. */
const SETUP_RULE = `mcp__${SERVER}`;
const PLUGIN_RULE = `mcp__plugin_${SERVER}_${SERVER}`;
const BEGIN = "<!-- layermap:begin -->";
const END = "<!-- layermap:end -->";

/**
 * How an agent starts this LayerMap's MCP server, whether run through npx or from a checkout. On
 * Windows npx is a .cmd script, which an agent that starts servers without a shell cannot run, so
 * cmd.exe runs it.
 */
export const mcpLaunchCommand = (
  version: string,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const script = path.resolve(process.argv[1] ?? "");
  if (script.includes(`${path.sep}_npx${path.sep}`))
    return [
      ...(platform === "win32" ? ["cmd", "/c"] : []),
      "npx",
      "-y",
      `layermap@${version}`,
      "mcp",
    ];
  // Loaders such as --import tsx are resolved here: agents start servers in other directories.
  const execArgv: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index] as string;
    const next = process.execArgv[index + 1];
    if ((argument === "--import" || argument === "--loader") && next && !next.startsWith(".")) {
      execArgv.push(argument, next.startsWith("file:") ? next : import.meta.resolve(next));
      index++;
    } else execArgv.push(argument);
  }
  return [process.execPath, ...execArgv, script, "mcp"];
};

// The agents' own CLIs: on Windows usually npm's .cmd shims, which run only through cmd.exe.
const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; output: string }>((resolve) => {
    const invocation = commandInvocation(command, args, env);
    execFile(
      invocation.file,
      invocation.args,
      {
        env,
        timeout: 60_000,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
    );
  });

/** Adds an allow rule for LayerMap's tools to a Claude Code settings file, keeping the rest. */
export async function allowInClaudeSettings(file: string, rule = SETUP_RULE): Promise<boolean> {
  const settings = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  if (typeof settings !== "object" || settings === null || Array.isArray(settings))
    throw new Error(`${file} is not a settings object.`);
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!Array.isArray(settings.permissions.allow))
    throw new Error(`${file} has permissions.allow that is not a list.`);
  if (settings.permissions.allow.includes(rule)) return false;
  settings.permissions.allow.push(rule);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/**
 * Sets keys in the [mcp_servers.layermap] table of a Codex config, leaving every other line as
 * it is. Codex approves the read-only map tools without asking, and waits for a first build.
 */
export async function configureCodexServer(file: string): Promise<boolean> {
  const lines = (await readFile(file, "utf8")).split("\n");
  const header = lines.findIndex((line) => line.trim() === `[mcp_servers.${SERVER}]`);
  if (header < 0) throw new Error(`${file} has no [mcp_servers.${SERVER}] table.`);
  let end = header + 1;
  while (end < lines.length && !lines[end]?.trim().startsWith("[")) end++;
  const wanted: Record<string, string> = {
    default_tools_approval_mode: '"approve"',
    tool_timeout_sec: "120",
  };
  const present = new Set(
    lines.slice(header + 1, end).map((line) => line.split("=")[0]?.trim() ?? ""),
  );
  const added = Object.entries(wanted)
    .filter(([key]) => !present.has(key))
    .map(([key, value]) => `${key} = ${value}`);
  if (!added.length) return false;
  lines.splice(header + 1, 0, ...added);
  await writeFile(file, lines.join("\n"));
  return true;
}

/** Writes or replaces LayerMap's marked note in an instructions file, leaving the rest as it is. */
export async function writeInstructionNote(file: string, note = AGENT_MAP_NOTE): Promise<void> {
  const block = `${BEGIN}\n${note}\n${END}`;
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const next =
    start >= 0 && end > start
      ? `${text.slice(0, start)}${block}${text.slice(end + END.length)}`
      : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
  if (next === text) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next);
}

/** Removes LayerMap's marked note and the blank line that set it apart. */
export async function removeInstructionNote(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const text = await readFile(file, "utf8");
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return;
  const before = text.slice(0, start).replace(/\n\n$/u, "\n");
  const rest = `${before}${text.slice(end + END.length).replace(/^\n/u, "")}`;
  // A file that held only the note, as setup created it, goes with it.
  if (!rest.trim()) await rm(file);
  else await writeFile(file, rest);
}

/** Removes the allow rules setup and allow added, keeping every other setting. */
export async function disallowInClaudeSettings(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const settings = JSON.parse(await readFile(file, "utf8"));
  const allow = settings?.permissions?.allow;
  const ours = (rule: unknown) => rule === SETUP_RULE || rule === PLUGIN_RULE;
  if (!Array.isArray(allow) || !allow.some(ours)) return;
  settings.permissions.allow = allow.filter((rule: unknown) => !ours(rule));
  // Setup may have created the list and the permissions around it; none is left empty.
  if (!settings.permissions.allow.length) delete settings.permissions.allow;
  if (!Object.keys(settings.permissions).length) delete settings.permissions;
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

const YAML_BEGIN = "# layermap:begin";
const YAML_END = "# layermap:end";

/**
 * The directory of the Node that agents should start LayerMap with: the first on PATH that has both
 * node and npx (a stable link such as /opt/homebrew/bin survives upgrades), else the running one's.
 */
const nodeDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.PATH ?? "")
    .split(path.delimiter)
    .find(
      (directory) =>
        path.isAbsolute(directory) &&
        existsSync(path.join(directory, "node")) &&
        existsSync(path.join(directory, "npx")),
    ) ?? path.dirname(process.execPath);

/**
 * LayerMap's row for DeepSeek Harness (dsh), in its YAML patch format. The launcher is absolute and
 * Node's directory leads PATH, so the server starts where dsh runs without a shell's PATH (its
 * desktop app). The server maps the project dsh was started in.
 */
export const dshPatchBlock = (command: readonly string[], env?: NodeJS.ProcessEnv): string => {
  const node = nodeDirectory(env);
  const npx = path.join(node, "npx");
  const [program = "", ...args] =
    command[0] === "npx" && existsSync(npx) ? [npx, ...command.slice(1)] : command;
  const searchPath = `${JSON.stringify(`${node}${path.delimiter}`)} + process.env.PATH`;
  return [
    `${YAML_BEGIN} (written by \`layermap setup dsh\`; \`layermap remove dsh\` deletes it)`,
    "- insert:",
    "    - id: layermap",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: layermap",
    "        transport: stdio",
    `        command: ${JSON.stringify(program)}`,
    `        args: ${JSON.stringify(args)}`,
    "        env:",
    `          PATH: !!js ${JSON.stringify(searchPath)}`,
    "        cwd: !!js process.cwd()",
    "        toolCallTimeoutMs: 120000",
    YAML_END,
  ].join("\n");
};

/** Adds or replaces LayerMap's row in a dsh patch layer, a YAML list, keeping everything else. */
export async function writeDshPatch(file: string, block: string): Promise<void> {
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const start = text.indexOf(YAML_BEGIN);
  const end = text.indexOf(YAML_END);
  let next: string;
  if (start >= 0 && end > start)
    next = `${text.slice(0, start)}${block}${text.slice(end + YAML_END.length)}`;
  else {
    const content = text.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
    // dsh writes new layers as an empty flow list.
    if (content.length === 1 && content[0]?.trim() === "[]")
      next = text.replace(/^[ \t]*\[\][ \t]*$/mu, block);
    else if (content.some((line) => line.trim().startsWith("[")))
      throw new Error(`${file} is a flow-style YAML list; add LayerMap's entry to it by hand.`);
    else next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${block}\n`;
  }
  if (next === text) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next);
}

/** Removes LayerMap's row from a dsh patch layer, leaving an empty layer as dsh writes one. */
export async function removeDshPatch(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const text = await readFile(file, "utf8");
  const start = text.indexOf(YAML_BEGIN);
  const end = text.indexOf(YAML_END);
  if (start < 0 || end < start) return;
  const rest = `${text.slice(0, start)}${text.slice(end + YAML_END.length).replace(/^\n/u, "")}`;
  if (!rest.trim()) return rm(file);
  const content = rest.split("\n").some((line) => line.trim() && !line.trim().startsWith("#"));
  await writeFile(file, content ? rest : `${rest}${rest.endsWith("\n") ? "" : "\n"}[]\n`);
}

/** Where each agent keeps the files setup touches, for a Claude Code scope. */
export const agentFiles = (
  options: Pick<SetupOptions, "agent" | "scope" | "project" | "env">,
): Readonly<{ settings: string; instructions: string }> => {
  const env = options.env ?? process.env;
  if (options.agent === "dsh") {
    // Its home patch layer applies to every profile; dsh reads an empty DSH_HOME as unset.
    const home = env.DSH_HOME || path.join(homedir(), ".dsh");
    return {
      settings: path.join(home, "cordis.patch.yml"),
      instructions: path.join(home, "AGENTS.md"),
    };
  }
  if (options.agent === "codex") {
    const home = env.CODEX_HOME ?? path.join(homedir(), ".codex");
    return { settings: path.join(home, "config.toml"), instructions: path.join(home, "AGENTS.md") };
  }
  if (options.scope === "user") {
    const home = env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
    return {
      settings: path.join(home, "settings.json"),
      instructions: path.join(home, "CLAUDE.md"),
    };
  }
  const local = options.scope === "local";
  return {
    settings: path.join(
      options.project,
      ".claude",
      local ? "settings.local.json" : "settings.json",
    ),
    instructions: path.join(options.project, local ? "CLAUDE.local.md" : "CLAUDE.md"),
  };
};

export async function setupAgent(options: SetupOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const { log } = options;
  const command = mcpLaunchCommand(options.version);
  const quoted = command.map((part) => (/^[\w./:@=-]+$/u.test(part) ? part : JSON.stringify(part)));
  const { settings, instructions } = agentFiles(options);
  const note = options.instructions !== false;
  if (options.agent === "dsh") {
    if (options.scope !== "user") {
      log("DeepSeek Harness is set up for all its profiles at once; --scope does not apply.");
      return false;
    }
    log(`add the ${SERVER} MCP server to ${settings}`);
    if (note) log(`add a note naming the map tools to ${instructions}`);
    if (options.dryRun) return true;
    await writeDshPatch(settings, dshPatchBlock(command, env));
    if (note) await writeInstructionNote(instructions);
    log(
      "Done. DeepSeek Harness reloads its settings by itself; its sessions have the mcp__layermap__project_* tools for the project dsh was started in.",
    );
    return true;
  }
  if (options.agent === "claude") {
    const scope = ["--scope", options.scope];
    log(`claude mcp add ${scope.join(" ")} ${SERVER} -- ${quoted.join(" ")}`);
    log(`allow ${SETUP_RULE} in ${settings}`);
  } else {
    log(`codex mcp add ${SERVER} -- ${quoted.join(" ")}`);
    log(`set default_tools_approval_mode = "approve" and tool_timeout_sec = 120 in ${settings}`);
  }
  if (note) log(`add a note naming the map tools to ${instructions}`);
  if (options.dryRun) return true;
  const agentCommand = options.agent;
  const scope = options.agent === "claude" ? ["--scope", options.scope] : [];
  await run(agentCommand, ["mcp", "remove", SERVER, ...scope], env);
  const added = await run(agentCommand, ["mcp", "add", ...scope, SERVER, "--", ...command], env);
  if (!added.ok) {
    log(
      `${agentCommand} did not add the server: ${added.output || `is the ${agentCommand} command installed?`}`,
    );
    return false;
  }
  if (options.agent === "claude") await allowInClaudeSettings(settings);
  else await configureCodexServer(settings);
  if (note) await writeInstructionNote(instructions);
  log(
    options.agent === "claude"
      ? "Done. Start a new Claude Code session; its map tools are mcp__layermap__project_*."
      : "Done. Start a new Codex session; its map tools come from the layermap server.",
  );
  return true;
}

/**
 * Lets the Claude Code plugin's read-only map tools run without a prompt, as the user chooses to:
 * the plugin itself asks before each tool's first use in a project.
 */
export async function allowAgent(options: SetupOptions): Promise<boolean> {
  if (options.agent !== "claude") {
    options.log(
      options.agent === "codex"
        ? "The Codex plugin already runs LayerMap's read-only tools without a prompt."
        : "DeepSeek Harness runs MCP tools without a prompt.",
    );
    return true;
  }
  const { settings } = agentFiles(options);
  options.log(`allow ${PLUGIN_RULE} in ${settings}`);
  if (options.dryRun) return true;
  await allowInClaudeSettings(settings, PLUGIN_RULE);
  options.log("Done. Claude Code runs the LayerMap plugin's map tools without asking.");
  return true;
}

/** Undoes setup and allow: the server, its approvals and the note. */
export async function removeAgent(options: SetupOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const { settings, instructions } = agentFiles(options);
  if (options.agent === "dsh") {
    options.log(
      `remove the ${SERVER} MCP server from ${settings} and its note from ${instructions}`,
    );
    if (options.dryRun) return true;
    await removeDshPatch(settings);
    await removeInstructionNote(instructions);
    options.log("Removed.");
    return true;
  }
  const scope = options.agent === "claude" ? ["--scope", options.scope] : [];
  options.log(`${options.agent} mcp remove ${SERVER} ${scope.join(" ")}`.trim());
  options.log(`remove LayerMap's approval from ${settings} and its note from ${instructions}`);
  if (options.dryRun) return true;
  await run(options.agent, ["mcp", "remove", SERVER, ...scope], env);
  if (options.agent === "claude") await disallowInClaudeSettings(settings);
  await removeInstructionNote(instructions);
  options.log("Removed.");
  return true;
}

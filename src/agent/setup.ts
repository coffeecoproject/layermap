import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type SetupAgent = "claude" | "codex";
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

import { AGENT_MAP_NOTE } from "./tools";

const SERVER = "layermap";
const BEGIN = "<!-- layermap:begin -->";
const END = "<!-- layermap:end -->";

/** How an agent starts this LayerMap's MCP server, whether run through npx or from a checkout. */
export const mcpLaunchCommand = (version: string): string[] => {
  const script = path.resolve(process.argv[1] ?? "");
  if (script.includes(`${path.sep}_npx${path.sep}`))
    return ["npx", "-y", `layermap@${version}`, "mcp"];
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

const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; output: string }>((resolve) =>
    execFile(command, args, { env, timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
    ),
  );

/** Adds an allow rule for every LayerMap tool to a Claude Code settings file, keeping the rest. */
export async function allowInClaudeSettings(file: string): Promise<boolean> {
  const rule = `mcp__${SERVER}`;
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
  await writeFile(file, `${before}${text.slice(end + END.length).replace(/^\n/u, "")}`);
}

/** Removes the allow rule setup added, keeping every other setting. */
export async function disallowInClaudeSettings(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const settings = JSON.parse(await readFile(file, "utf8"));
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow) || !allow.includes(`mcp__${SERVER}`)) return;
  settings.permissions.allow = allow.filter((rule: unknown) => rule !== `mcp__${SERVER}`);
  // Setup may have created the list and the permissions around it; none is left empty.
  if (!settings.permissions.allow.length) delete settings.permissions.allow;
  if (!Object.keys(settings.permissions).length) delete settings.permissions;
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Where each agent keeps the files setup touches, for a Claude Code scope. */
export const agentFiles = (
  options: Pick<SetupOptions, "agent" | "scope" | "project" | "env">,
): Readonly<{ settings: string; instructions: string }> => {
  const env = options.env ?? process.env;
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
  if (options.agent === "claude") {
    const scope = ["--scope", options.scope];
    log(`claude mcp add ${scope.join(" ")} ${SERVER} -- ${quoted.join(" ")}`);
    log(`allow mcp__${SERVER} in ${settings}`);
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

/** Undoes setup: the server, its approval and the note. */
export async function removeAgent(options: SetupOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const { settings, instructions } = agentFiles(options);
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

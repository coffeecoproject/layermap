// Writes the Claude Code and Codex plugins, their marketplace entries and the MCP Registry entry.
// The published plugins start the server with npx from npm; --dev writes the same plugins, started
// from this checkout, into another directory for trying them before a release.
//
// usage: node --import tsx scripts/plugins.ts [--dev <directory>]
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MAP_NOTE, AGENT_STOP_CHECK } from "../src/agent/tools";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY = "https://github.com/coffeecoproject/layermap";
/** The server's MCP Registry name; npm's `mcpName` must match it for the registry to verify. */
export const MCP_NAME = "io.github.coffeecoproject/layermap";
const LINKS = {
  documentation: `${REPOSITORY}#readme`,
  support: `${REPOSITORY}/issues`,
  privacy: `${REPOSITORY}/blob/main/PRIVACY.md`,
  security: `${REPOSITORY}/blob/main/SECURITY.md`,
};
const PROMPTS = [
  "What would changing this function affect? Trace its callers to the entry points.",
  "Where is this function used across the codebase?",
  "Give me a map of how this repository is organized.",
];
const DESCRIPTION =
  "A layered map of your codebase for coding agents: what calls a function, what a change affects up to the HTTP routes, handlers and jobs, and what each module contains, for TypeScript, JavaScript, Go, Python and Java. Built and kept locally; read-only.";
// The MCP Registry allows at most 100 characters.
const REGISTRY_DESCRIPTION =
  "Call graph for coding agents: callers up to HTTP routes, callees, usages for TS/JS, Go, Python, Java";
const KEYWORDS = [
  "code-map",
  "call-graph",
  "impact-analysis",
  "mcp",
  "typescript",
  "go",
  "python",
  "java",
];

/** Binary files of the plugins, copied from the package: published path → source path. */
export const PLUGIN_ASSETS: Record<string, string> = {
  "plugins/claude/assets/icon.png": "assets/icon.png",
  "plugins/codex/assets/icon.png": "assets/icon.png",
};

export type ServerLaunch = Readonly<{
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
}>;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// The code files LayerMap maps, and the same as git pathspecs.
const CODE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "py", "java"];
const CODE = CODE_EXTENSIONS.map((extension) => `'*.${extension}'`).join(" ");

// Shell shared by the Claude Code hooks: the hook's input fields, and a fingerprint of the working
// tree's uncommitted code changes (empty outside a repository or without changes). Plain sh and
// git, so the hooks start no runtime and the plugin directory's validator can read them.
const HOOK_SHELL = String.raw`input=$(cat 2>/dev/null | tr -d '\n')
field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
session=$(field session_id | tr -cd 'A-Za-z0-9_-')
[ -n "$session" ] || session=unknown
dir=$(field cwd)
[ -d "$dir" ] || dir=$PWD
state="${"$"}{TMPDIR:-/tmp}/layermap-claude"
mkdir -p "$state" 2>/dev/null
code_changes() {
  git -C "$dir" rev-parse --verify --quiet HEAD >/dev/null 2>&1 || return 0
  git -C "$dir" diff HEAD --no-ext-diff --no-color -- ${CODE} 2>/dev/null
  git -C "$dir" ls-files --others --exclude-standard -- ${CODE} 2>/dev/null |
    while IFS= read -r file; do printf '%s %s\n' "$file" "$(git -C "$dir" hash-object -- "$file" 2>/dev/null)"; done
}
changes=$(code_changes)
fingerprint=$(printf '%s' "$changes" | git hash-object --stdin 2>/dev/null)`;

/**
 * Every file of both plugins, both marketplaces and the MCP Registry entry, by path relative to the
 * repository root.
 */
export function generatedFiles(version: string, launch: ServerLaunch): Record<string, string> {
  const server = {
    command: launch.command,
    args: launch.args,
    ...(launch.env ? { env: launch.env } : {}),
  };
  const author = { name: "The LayerMap Authors", url: REPOSITORY };
  return {
    ".claude-plugin/marketplace.json": json({
      $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
      name: "layermap",
      description: "LayerMap for Claude Code.",
      owner: author,
      plugins: [
        {
          name: "layermap",
          source: "./plugins/claude",
          description: DESCRIPTION,
          category: "development",
        },
      ],
    }),
    "plugins/claude/.claude-plugin/plugin.json": json({
      name: "layermap",
      displayName: "LayerMap",
      version,
      description: DESCRIPTION,
      author,
      homepage: REPOSITORY,
      repository: REPOSITORY,
      license: "Apache-2.0",
      keywords: KEYWORDS,
      icon: "./assets/icon.png",
      documentationUrl: LINKS.documentation,
      supportUrl: LINKS.support,
      privacyPolicyUrl: LINKS.privacy,
    }),
    "plugins/claude/.mcp.json": json({ mcpServers: { layermap: server } }),
    // The note an agent needs to reach for the map (natural-adoption runs), added at session start
    // instead of written into the user's CLAUDE.md. The tools ask before their first use; the user
    // may allow them for good with `layermap allow claude`.
    // The stop hook asks Claude, once per set of code changes made in the session, to check what
    // they affect before finishing; LAYERMAP_STOP_CHECK=0 turns it off.
    "plugins/claude/hooks/hooks.json": json({
      description: "Tells Claude when the map helps, and to check what its code changes affect.",
      hooks: {
        SessionStart: [
          {
            hooks: [
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it when it runs the hook.
              { type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"' },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it when it runs the hook.
                command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/stop-check.sh"',
                timeout: 30,
              },
            ],
          },
        ],
      },
    }),
    // Notes the code changes the session starts with, so the stop hook asks only about the ones
    // made in it, and prints when the map helps.
    "plugins/claude/hooks/session-start.sh": `# Generated by scripts/plugins.ts.
${HOOK_SHELL}
printf '%s' "$fingerprint" > "$state/$session.start" 2>/dev/null
cat <<'EOF'
${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: AGENT_MAP_NOTE } })}
EOF
`,
    // Stops Claude once to check code changes made in the session: never while it is already
    // continuing for a stop hook, without changes, for the changes the session started with, twice
    // for the same changes, when the transcript shows no edit of its own to this repository (another
    // session sharing the work tree may have made them), or when it checked after its last edit.
    "plugins/claude/hooks/stop-check.sh": `# Generated by scripts/plugins.ts.
[ "\${LAYERMAP_STOP_CHECK:-1}" = 0 ] && exit 0
${HOOK_SHELL}
case "$input" in *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;; esac
[ -n "$changes" ] || exit 0
[ "$fingerprint" = "$(cat "$state/$session.start" 2>/dev/null)" ] && exit 0
[ "$fingerprint" = "$(cat "$state/$session.checked" 2>/dev/null)" ] && exit 0
printf '%s' "$fingerprint" > "$state/$session.checked" 2>/dev/null
transcript=$(field transcript_path)
if [ -f "$transcript" ]; then
  # The last edit this session made to a file among the code changes git sees.
  edited=$(grep -nE '"name": *"(Edit|Write|MultiEdit|NotebookEdit)"' "$transcript" 2>/dev/null |
    while IFS= read -r line; do
      file=$(printf '%s' "$line" | sed -nE 's/.*"(file|notebook)_path": *"([^"]*)".*/\\2/p')
      [ -n "$file" ] || continue
      printf '%s' "$file" | grep -qE '\\.(${CODE_EXTENSIONS.join("|")})$' || continue
      git -C "$dir" status --porcelain --untracked-files=all -- "$file" 2>/dev/null | grep -q . && printf '%s\\n' "\${line%%:*}"
    done | tail -n 1)
  [ -n "$edited" ] || exit 0
  checked=$(grep -nE '"name": *"[^"]*project_check_changes"' "$transcript" 2>/dev/null | tail -n 1 | cut -d: -f1)
  [ -n "$checked" ] && [ "$checked" -gt "$edited" ] && exit 0
fi
cat <<'EOF'
${JSON.stringify({ decision: "block", reason: AGENT_STOP_CHECK })}
EOF
`,
    "plugins/claude/README.md": `# LayerMap

A layered map of your codebase for coding agents. LayerMap answers, in one tool call, questions an
agent otherwise works out with many searches: what calls a function and what changing it affects
(callers traced up to 8 levels to HTTP routes, handlers, jobs and commands), what it calls, and what
a repository contains. It covers TypeScript, JavaScript, Go, Python and Java, and resolves calls with
each language's own compiler.

## Use it

Start a session in a Git repository and ask as usual, for example:

${PROMPTS.map((prompt) => `- "${prompt}"`).join("\n")}

## What it runs, fetches and sends

- It runs the LayerMap MCP server on your machine (\`${[launch.command, ...launch.args].join(" ")}\`).
  Java analysis uses your local JDK 21 or later.
- On first launch, npx downloads the pinned \`layermap\` package and its dependencies from the npm
  registry.
- LayerMap itself makes no network requests. Maps stay in your user cache, never in the repository.
  Your agent sends tool results to its model, as it does with any file it reads.
- A session-start hook adds one sentence telling the agent when the map helps.
- When Claude is about to finish after editing code in the repository itself, a stop hook asks it once to run
  \`project_check_changes\` and check what the changes affect. It only asks git whether code
  changed and never runs tests or edits anything. Set \`LAYERMAP_STOP_CHECK=0\` to turn it off.

## Permissions

The four tools only read the project and its map. Claude Code asks before each one's first use in a
project. Answer "Yes, and don't ask again", or run \`npx layermap allow claude\` once to allow them
everywhere (\`npx layermap remove claude\` takes it back).

## Requirements and support

Node.js 22.22 or later, macOS or Linux, and a Git repository. The links:

- [Documentation](${LINKS.documentation})
- [Issues](${LINKS.support})
- [Privacy](${LINKS.privacy})
- [Security](${LINKS.security})

License: Apache-2.0.
`,
    ".agents/plugins/marketplace.json": json({
      name: "layermap",
      interface: { displayName: "LayerMap" },
      plugins: [
        {
          name: "layermap",
          source: { source: "local", path: "./plugins/codex" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Developer Tools",
        },
      ],
    }),
    "plugins/codex/.codex-plugin/plugin.json": json({
      name: "layermap",
      version,
      description: DESCRIPTION,
      author,
      homepage: REPOSITORY,
      repository: REPOSITORY,
      license: "Apache-2.0",
      keywords: KEYWORDS,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "LayerMap",
        shortDescription: "Call chains and change impact",
        longDescription: DESCRIPTION,
        developerName: "The LayerMap Authors",
        category: "Developer Tools",
        capabilities: ["Read"],
        websiteURL: REPOSITORY,
        supportURL: LINKS.support,
        privacyPolicyURL: LINKS.privacy,
        logo: "./assets/icon.png",
        composerIcon: "./assets/icon.png",
        defaultPrompt: PROMPTS,
      },
    }),
    // Codex shows MCP tools only when it searches for them; a skill's description is always listed.
    "plugins/codex/.mcp.json": json({
      mcpServers: { layermap: { ...server, default_tools_approval_mode: "approve" } },
    }),
    "plugins/codex/skills/layermap/SKILL.md": `---
name: layermap
description: Use instead of grep when a task needs to know what calls a function or method, what changing it affects (up to HTTP routes, handlers, jobs and commands), where code is used, or how the code is organized, and once the edits are done to check what the changes affect before reporting the work done. The layermap MCP tools answer these from a static map of the repository in one call.
---

# LayerMap

${AGENT_MAP_NOTE}

- \`project_explore_map\` with \`path\` "." shows what the repository contains; a file \`path\` lists its declarations; with \`name\` (and \`line\` when names repeat) it shows a declaration's callers and callees. \`direction\` INCOMING with \`depth\` up to 8 traces callers up to the entry points; continue from any NOT EXPANDED declarations it names.
- \`project_search_map\` finds a declaration by words in its name, path or documentation.
- \`project_find_references\` lists every usage of a declaration, compiled from current source.
- \`project_check_changes\`, once the edits are done and before reporting them, lists the routes, jobs and commands the uncommitted changes reach, the existing tests related to them, and the existing tests the diff rewrote.

The map is static: dynamic dispatch, framework wiring and unresolved targets need source reading, and a missing relationship does not prove absence. A large repository's first map takes minutes to build; until then the tools say so, and you can read source meanwhile.
`,
    "server.json": json({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: MCP_NAME,
      title: "LayerMap",
      description: REGISTRY_DESCRIPTION,
      repository: { url: REPOSITORY, source: "github" },
      websiteUrl: LINKS.documentation,
      version,
      packages: [
        {
          registryType: "npm",
          identifier: "layermap",
          version,
          runtimeHint: "npx",
          transport: { type: "stdio" },
          packageArguments: [{ type: "positional", value: "mcp" }],
        },
      ],
    }),
  };
}

async function main() {
  const version = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ).version;
  const dev = process.argv.indexOf("--dev");
  const root = dev >= 0 ? path.resolve(process.argv[dev + 1] ?? "") : packageRoot;
  const launch: ServerLaunch =
    dev >= 0
      ? {
          command: process.execPath,
          args: [
            "--import",
            import.meta.resolve("tsx"),
            path.join(packageRoot, "src/cli.ts"),
            "mcp",
          ],
          ...(process.env.LAYERMAP_CACHE
            ? { env: { LAYERMAP_CACHE: process.env.LAYERMAP_CACHE } }
            : {}),
        }
      : { command: "npx", args: ["-y", `layermap@${version}`, "mcp"] };
  for (const [file, content] of Object.entries(generatedFiles(version, launch))) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  for (const [file, source] of Object.entries(PLUGIN_ASSETS)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(packageRoot, source), path.join(root, file));
  }
  process.stdout.write(`Plugins written under ${root}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();

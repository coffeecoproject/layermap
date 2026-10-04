# LayerMap

A layered map of your codebase for coding agents. LayerMap gives Claude Code, Codex and other
MCP clients three read-only tools that answer, in one call, questions an agent otherwise works out
with dozens of searches:

- **What calls this, and what does changing it affect?** A declaration's callers, traced up to 8
  levels to the entry points: HTTP routes, handlers, jobs and commands.
- **What does it call?** Callees down to 8 levels.
- **What is here?** Directories, modules, each file's declarations, and every usage of a symbol.

It maps **TypeScript, JavaScript, Go, Python and Java**, using each language's own compiler
(TypeScript, `go/types`, Pyright, javac with Lombok), so calls through imports, methods, interfaces
and decorators resolve the way the compiler resolves them.

## Install

### Claude Code

```
/plugin marketplace add coffeecoproject/layermap
/plugin install layermap@layermap
```

### Codex

```
codex plugin marketplace add coffeecoproject/layermap
codex plugin add layermap@layermap
```

Start a new session in a Git repository and ask as usual. The plugin tells the agent when the map
helps; you do not need to mention it.

### Other MCP clients, or without plugins

```
npx layermap setup claude      # or: npx layermap setup codex
```

`setup` registers the server with the agent's own `mcp add`, lets its read-only tools run without
a prompt, and adds one marked sentence to the agent's instructions file (`~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`) saying when to use the map; `--no-instructions` leaves that file alone, but
Codex then rarely finds the tools. `--scope project` writes the configuration into the repository
for a whole team. `npx layermap remove claude|codex` undoes it.

For any other MCP client, run `npx -y layermap mcp` as a stdio server in the repository.

## Requirements

- **Node.js 22.22 or later.**
- **macOS or Linux** (x64 or arm64).
- **Git**: LayerMap maps a Git work tree, the one around the directory the agent starts in.
- **Java projects only:** a JDK 21 or later (found through `LAYERMAP_JAVA_HOME`, `JAVA_HOME`, `PATH`,
  Homebrew or SDKMAN). Without one, Java files are listed but have no declarations or calls.

## How it works

The first tool call in a repository builds its map: seconds for a small project, a few minutes
for a large one (until then the tools say the map is still building). Every later call checks the
files first and re-analyzes only what changed, so the map always matches the working tree.

Maps live in your user cache (`~/Library/Caches/layermap` on macOS, `$XDG_CACHE_HOME/layermap`
or `~/.cache/layermap` on Linux, or `LAYERMAP_CACHE`), never in the repository. A project keeps
its three latest map versions; a map unused for 30 days is removed.

**Privacy:** LayerMap runs entirely on your machine and sends nothing anywhere. Your agent sends
the tool results to its model as it does with any file it reads.

## The tools

| Tool | Use |
|---|---|
| `project_explore_map` | `path` `"."` or a directory: modules and files. A file: its declarations, imports and importers. With `name` (and `line` when names repeat): the declaration's callers, callees, writes, heritage and members, `direction` INCOMING or OUTGOING with `depth` up to 8. |
| `project_search_map` | Find declarations by words in their names, paths or documentation. |
| `project_find_references` | Every usage of a declaration, compiled from current source. |

The map is static. Calls through interfaces and base members follow the implementations it links;
dynamic dispatch, framework wiring, reflection and computed names need source reading, and a
missing relationship does not prove absence. The tools say where a trace stops.

## Command line

```
npx layermap index                      # build or update the map now
npx layermap explore src/api/users.ts --name createUser --direction INCOMING --depth 8
npx layermap search "invoice total"
npx layermap refs src/billing/tax.ts calculateTax
```

## Development

Building from source needs pnpm, Go 1.24 for the Go analyzer and a JDK 21 or later for the Java
analyzer; a missing toolchain leaves its language unanalyzed.

```
pnpm install
pnpm test          # builds the analyzers once, then runs the tests
pnpm typecheck
pnpm lint
pnpm package       # the npm package, into .pack/
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

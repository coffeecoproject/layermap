<p align="center"><img src="https://raw.githubusercontent.com/coffeecoproject/layermap/main/assets/icon.png" alt="LayerMap" width="120"></p>

# LayerMap

**English** · [中文](https://github.com/coffeecoproject/layermap/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/layermap)](https://www.npmjs.com/package/layermap)
[![GitHub stars](https://img.shields.io/github/stars/coffeecoproject/layermap?style=social)](https://github.com/coffeecoproject/layermap/stargazers)
[![npm downloads](https://img.shields.io/npm/dm/layermap)](https://www.npmjs.com/package/layermap)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/coffeecoproject/layermap/blob/main/LICENSE)

**LayerMap tells your coding agent what calls a function and what changing it affects, up to the HTTP routes, in one call.** With at most 15 requests, agents found **97.9%** of affected endpoints with LayerMap vs 58.8% without; with no limit, Claude Code cost **33% less** in the 0.1.5 re-run ([benchmark](https://github.com/coffeecoproject/layermap/blob/main/docs/benchmark.md)).

**Resolved by each language's compiler or type checker, not guessed from names by tree-sitter:** calls through interfaces, base classes, templates and decorators link as the compiler links them, for TypeScript, JavaScript, Go, Python and Java.

<p align="center"><img src="https://raw.githubusercontent.com/coffeecoproject/layermap/main/assets/demo.svg" alt="Claude Code asks which HTTP endpoints changing Storage.MarkFeedAsRead affects; one LayerMap call returns all four callers with their routes" width="100%"></p>
<p align="center"><sub>A real Claude Code session on <a href="https://github.com/miniflux/v2">Miniflux</a>, replayed: one map call finds every endpoint, then the agent confirms them in source.</sub></p>

A layered map of your codebase for coding agents. LayerMap gives Claude Code, Codex, DeepSeek
Harness and other MCP clients read-only tools that answer, in one call, what an agent otherwise works out
with dozens of searches:

- **What calls this, and what does changing it affect?** Callers traced up to 8 levels, to the
  HTTP routes, handlers, jobs and commands they start from.
- **What does it call?** Callees down to 8 levels.
- **What is here?** Modules, each file's declarations, and every usage of a symbol.
- **What did my edit affect?** The routes, jobs and commands the uncommitted changes reach, and the
  existing tests related to them.

It maps **TypeScript, JavaScript, Go, Python and Java** with each language's own compiler, so calls
through interfaces, base classes, templates and decorators resolve as the compiler resolves them,
including the ones text search misses.

## Example

In [Miniflux](https://github.com/miniflux/v2), one call on `Storage.MarkFeedAsRead` finds all four
ways a request reaches it, each with its route:

```
DECLARATION internal/storage/entry.go: Storage.MarkFeedAsRead m656-680 exported
  ← called by internal/api/feed.go: handler.markFeedAsRead m140-155 @149
  ← called by internal/fever/handler.go: handler.handleWriteFeeds m492-519 @508
  ← called by internal/googlereader/handler.go: handler.markAllAsReadHandler m1261-1338 @1311
  ← called by internal/ui/feed_mark_as_read.go: handler.markFeedAsRead m14-30 @24
[1] internal/api/feed.go: handler.markFeedAsRead m140-155
  ← used as value by internal/api/api.go: Serve f25-84 @61 "PUT /v1/feeds/{feedID}/mark-all-as-read"
[1] internal/googlereader/handler.go: handler.markAllAsReadHandler m1261-1338
  ← used as value by internal/googlereader/handler.go: Serve f44-64 @62 "POST /reader/api/0/mark-all-as-read"
[1] internal/ui/feed_mark_as_read.go: handler.markFeedAsRead m14-30
  ← used as value by internal/ui/ui.go: Serve f18-180 @77 "POST /feed/{feedID}/mark-all-as-read"
… (the Fever API, then on down to main.go: main)
```

`m` and `f` mark methods and functions with their lines; `@` is the line of the call, and the quoted
route is what it is registered under: the HTTP method and the full path, with the `/v1` prefix its
subrouter adds. In Java, Python and TypeScript the route shows on the handler itself, as in
`@GetMapping("/{id}") route "GET /api/tasks/{id}"`.

## Results

Impact questions ("which HTTP endpoints does changing this affect?") on public Go, Python and Java
projects, graded blind against truth sets cross-checked with each language's own toolchain:

| | With LayerMap | Without |
|---|---|---|
| Endpoints found, at most 15 requests (`gpt-5.5`, 6 tasks × 3 runs) | **97.9%** | 58.8% |
| Used unprompted by Claude Code / Codex (plugin installed, two rounds) | **12 of 12 / 12 of 12** | — |
| Endpoints found, no request limit (Claude Code / Codex, 0.1.5) | 100% / 100% | 99.0% / 100% |
| Claude Code cost, no request limit (0.1.5 re-run; first round −32%) | **−33%** | |
| Codex input tokens, no request limit (current defaults) | +14% | |
| Time, no request limit (Claude Code / Codex) | +25% / +20% | |
| Failing tests the change check lists (Go / Python, functions made to fail) | **100% / 94–98%** | — |
| Ripple tasks: runs leaving other features' tests passing (Codex / Claude Code, 4 tasks × 6 runs with, × 3 without) | **23 of 24** / 11 of 24 | 3 of 12 / 4 of 12 |
| Everyday tasks, no impact analysis needed: done right / time (Claude Code and Codex, 8 tasks × 2 runs) | 32 of 32 / +12–31% | 32 of 32 |

With a tight budget, the map finds far more of the affected code, at about 24% more tokens. With
no limit, both agents find nearly everything either way. Claude Code costs a third less with the
map. Codex's current defaults already search lean, so the map no longer saves it tokens; at
reasoning effort max, in the first round, it saved 55%. Agents with the map explore more widely,
which takes longer. On requests whose obvious change breaks another feature, the change check
helped Codex keep to the requested feature. Claude Code saw which tests of other features it had
changed but often kept the broader change on purpose, so it showed no clear difference. On small
local tasks the map changed nothing but cost about a fifth more time and money. These are small samples on tasks written by LayerMap's authors.
The [report](https://github.com/coffeecoproject/layermap/blob/main/docs/benchmark.md) has the
setup, the published tasks and the limitations.

## How LayerMap differs

Other tools give agents part of this. LayerMap combines compiler accuracy with whole-chain traces
in one local map:

| | Tree-sitter code graphs (codegraph, GitNexus, …) | Language servers and IDEs (Claude Code's LSP tool, Serena, JetBrains) | Embedding search (Claude Context, Augment) | **LayerMap** |
|---|---|---|---|---|
| How calls are linked | Matched by names, imports and framework rules, often with confidence scores | The compiler's own resolution | Not linked; similar code is retrieved | **Resolved by each language's compiler or type checker** |
| Callers traced to routes and handlers | In several tools, at varying depth | One level per request (JetBrains: 5 by default) | — | **Up to 8 levels in one call** |
| Kept as a map | Yes, with file watching | No, answered live by a running server | An index of code chunks | **Yes, brought up to date on every call** |
| Runs on your machine | Yes; some send anonymous telemetry | Yes | Usually with cloud embeddings | **Yes, and sends nothing** |

Another tool fits better if you need:

- more languages, since tree-sitter graphs cover 30 or more;
- renaming and refactoring, from language servers;
- search by meaning, from embedding search;
- search across many repositories, with Sourcegraph.

## Install

**Claude Code**

```
/plugin marketplace add coffeecoproject/layermap
/plugin install layermap@layermap
```

**Codex**

```
codex plugin marketplace add coffeecoproject/layermap
codex plugin add layermap@layermap
```

**DeepSeek Harness**

```
npx layermap setup dsh
```

This adds LayerMap to every dsh profile. Each session maps the project dsh was started in, and
`npx layermap remove dsh` undoes it.

In every agent, start a new session in a Git repository and ask as usual. LayerMap tells the agent
when the map helps. On first launch, npx downloads the pinned `layermap` package from npm.

Claude Code asks once before each map tool runs in a project. Choose "don't ask again", or run
`npx layermap allow claude` to allow the plugin's read-only tools everywhere.

**After an edit.** When the agent changes code, `project_check_changes` lists what the change
affects: the routes, jobs and commands that reach the changed functions, what the map cannot see,
and the existing tests related to the change. When the changed code serves several areas (packages
or modules), it names each one with its tests, and it names the existing tests the diff rewrote, so
a change meant for one feature does not quietly change the others. Environment variables and
configuration keys are linked by name only, which no compiler sees, so when the diff removes one
from a file, the check names the files that still read or set the old name. In the same way, when
the change reaches a route's handler or renames a route, it names the code and templates that
request that path: a frontend's fetch, a generated API client, a redirect or a link. It never writes or runs tests. In Claude Code the
plugin asks the agent once, before it finishes, to run this check if it edited code in the repository
and has not checked since (changes another session makes in the same work tree do not count); set
`LAYERMAP_STOP_CHECK=0` to turn that off. Codex and DeepSeek Harness are told to run it.

**Without plugins:** run `npx layermap setup claude` or `npx layermap setup codex`. Setup does three
things:

- registers the server;
- lets its read-only tools run without a prompt;
- adds one marked sentence to the agent's instructions file.

Use `--scope project` to set it up for a whole team, and `npx layermap remove …` to undo it. For any
other MCP client, run `npx -y layermap mcp` as a stdio server in the repository.

**Requirements:**

- Node.js 22.22 or later.
- macOS or Linux (x64 or arm64); Windows (x64 or arm64) is experimental.
- A Git repository.
- For Java projects, a JDK 21 or later.

## How it works

The first call in a repository builds its map: seconds for a small project, a few minutes for a
large one. Later calls re-analyze only what changed, so the map always matches the working tree.

Maps stay in your user cache (`~/Library/Caches/layermap`, `~/.cache/layermap` or
`LAYERMAP_CACHE`), never in the repository. LayerMap runs entirely on your machine and sends
nothing anywhere ([privacy](https://github.com/coffeecoproject/layermap/blob/main/PRIVACY.md),
[security](https://github.com/coffeecoproject/layermap/blob/main/SECURITY.md)).

| Tool | Use |
|---|---|
| `project_explore_map` | A directory, a file, or a declaration's callers and callees (`direction` INCOMING or OUTGOING, `depth` up to 8). |
| `project_search_map` | Find declarations by words in their names, paths or documentation. |
| `project_find_references` | Every usage of a declaration, compiled from current source. |
| `project_check_changes` | What the uncommitted changes (or those since `base`) affect: changed and removed declarations, the routes, jobs and commands they reach, the areas that share the changed code, environment variables and configuration keys it removed that other files still use, code and templates that request the affected routes, what to check by hand, and related tests. |

The same from the command line:

```
npx layermap explore src/api/users.ts --name createUser --direction INCOMING --depth 8
npx layermap search "invoice total"
npx layermap refs src/billing/tax.ts calculateTax
npx layermap check --base main
```

## FAQ

**How long does the first map take?** On a recent Mac:

- Miniflux (400 Go files): about 3 s.
- Polar's server (1,900 Python files): about a minute.
- Conductor (1,500 Java and 1,300 TypeScript files): under two minutes.

**What can't it see?** Calls the compiler cannot resolve statically: dependency injection, unknown
framework routing, reflection and computed names. The tools say where a trace stops, and a missing
relationship does not prove absence.

**Windows?** Experimental. LayerMap's tests pass on Windows, but it has not yet been tried with
Claude Code or Codex on a real Windows machine, so please test it on your own projects first and
[report what breaks](https://github.com/coffeecoproject/layermap/issues). The Claude Code plugin's
hooks need Git for Windows (they run in Git Bash); without it the map tools still work, and the
session-start note and end-of-task check do not run.

**Claude Code in print mode (`claude -p`)?** Print mode, as of Claude Code 2.1, does not start the
servers that installed plugins bring, so the map tools are missing there while the plugin's hooks
still run. Pass the server yourself:

```bash
claude -p "..." --mcp-config '{"mcpServers":{"layermap":{"command":"npx","args":["-y","layermap","mcp"]}}}'
```

**How do I remove it?**

- Claude Code: `/plugin uninstall layermap@layermap`.
- Codex: `codex plugin remove layermap@layermap`.
- Then delete the cache directory.

## Development

You need pnpm, Go 1.24 and a JDK 21+. A missing toolchain leaves its language unanalyzed.

Run `pnpm install`. On the first install pnpm asks which dependencies may run build scripts; allow
esbuild only, since the SQLite package ships prebuilt binaries:

```
pnpm approve-builds esbuild '!@photostructure/sqlite'
```

Then run `pnpm test`, `pnpm typecheck` or `pnpm lint`.

`pnpm package` builds the npm package.

## License

Apache-2.0. See [LICENSE](https://github.com/coffeecoproject/layermap/blob/main/LICENSE) and
[NOTICE](https://github.com/coffeecoproject/layermap/blob/main/NOTICE).

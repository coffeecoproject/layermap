<p align="center"><img src="https://raw.githubusercontent.com/coffeecoproject/layermap/main/assets/icon.png" alt="LayerMap" width="120"></p>

# LayerMap

**English** · [中文](https://github.com/coffeecoproject/layermap/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/layermap)](https://www.npmjs.com/package/layermap)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/coffeecoproject/layermap/blob/main/LICENSE)

A layered map of your codebase for coding agents. LayerMap gives Claude Code, Codex and other MCP
clients three read-only tools that answer, in one call, what an agent otherwise works out with
dozens of searches:

- **What calls this, and what does changing it affect?** Callers traced up to 8 levels, to the
  HTTP routes, handlers, jobs and commands they start from.
- **What does it call?** Callees down to 8 levels.
- **What is here?** Modules, each file's declarations, and every usage of a symbol.

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
  ← used as value by internal/api/api.go: Serve f25-84 @61 "/feeds/{feedID}/mark-all-as-read"
[1] internal/googlereader/handler.go: handler.markAllAsReadHandler m1261-1338
  ← used as value by internal/googlereader/handler.go: Serve f44-64 @62 "/mark-all-as-read"
[1] internal/ui/feed_mark_as_read.go: handler.markFeedAsRead m14-30
  ← used as value by internal/ui/ui.go: Serve f18-180 @77 "/feed/{feedID}/mark-all-as-read"
… (the Fever API, then on down to main.go: main)
```

`m` and `f` mark methods and functions with their lines; `@` is the line of the call, and the quoted
path is the route it is registered under.

## Results

Impact questions ("which HTTP endpoints does changing this affect?") on public Go, Python and Java
projects, graded blind against truth sets cross-checked with each language's own toolchain:

| | With LayerMap | Without |
|---|---|---|
| Endpoints found, at most 15 requests (`gpt-5.5`, 6 tasks × 3 runs) | **97.9%** | 58.8% |
| Used unprompted by Claude Code / Codex (plugin installed) | **6 of 6 / 6 of 6** | — |
| Endpoints found, no request limit (Claude Code / Codex) | 99.3% / 98.0% | 99.0% / 98.6% |
| Cost, no request limit (Claude Code in USD / Codex in input tokens) | **−32% / −55%** | |
| Time, no request limit | +24% / +17% | |

With a tight budget, the map finds far more of the affected code, at about 24% more tokens. With
no limit, both agents get there either way. The map makes the run cheaper, and the agents explore
more widely, which takes longer. These are small samples on tasks written by LayerMap's authors.
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
- Windows;
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

Start a new session in a Git repository and ask as usual. The plugin tells the agent when the map
helps. On first launch, npx downloads the pinned `layermap` package from npm. Claude Code asks once
before each map tool runs in a project; choose "don't ask again", or run `npx layermap allow claude`
to allow the plugin's read-only tools everywhere.

**Without plugins:** run `npx layermap setup claude` or `npx layermap setup codex`. Setup does three
things:

- registers the server;
- lets its read-only tools run without a prompt;
- adds one marked sentence to the agent's instructions file.

Use `--scope project` to set it up for a whole team, and `npx layermap remove …` to undo it. For any
other MCP client, run `npx -y layermap mcp` as a stdio server in the repository.

**Requirements:**

- Node.js 22.22 or later.
- macOS or Linux (x64 or arm64).
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

The same from the command line:

```
npx layermap explore src/api/users.ts --name createUser --direction INCOMING --depth 8
npx layermap search "invoice total"
npx layermap refs src/billing/tax.ts calculateTax
```

## FAQ

**How long does the first map take?** On a recent Mac:

- Miniflux (400 Go files): about 3 s.
- Polar's server (1,900 Python files): about a minute.
- Conductor (1,500 Java and 1,300 TypeScript files): under two minutes.

**What can't it see?** Calls the compiler cannot resolve statically: dependency injection, unknown
framework routing, reflection and computed names. The tools say where a trace stops, and a missing
relationship does not prove absence.

**Windows?** Not yet.

**How do I remove it?**

- Claude Code: `/plugin uninstall layermap@layermap`.
- Codex: `codex plugin remove layermap@layermap`.
- Then delete the cache directory.

## Development

You need pnpm, Go 1.24 and a JDK 21+. A missing toolchain leaves its language unanalyzed.

Run `pnpm install`, then `pnpm test`, `pnpm typecheck` or `pnpm lint`.

`pnpm package` builds the npm package.

## License

Apache-2.0. See [LICENSE](https://github.com/coffeecoproject/layermap/blob/main/LICENSE) and
[NOTICE](https://github.com/coffeecoproject/layermap/blob/main/NOTICE).

# LayerMap

A layered map of your codebase for coding agents. LayerMap answers, in one tool call, questions an
agent otherwise works out with many searches: what calls a function and what changing it affects
(callers traced up to 8 levels to HTTP routes, handlers, jobs and commands), what it calls, and what
a repository contains. It covers TypeScript, JavaScript, Go, Python and Java, and resolves calls with
each language's own compiler.

## Use it

Start a session in a Git repository and ask as usual, for example:

- "What would changing this function affect? Trace its callers to the entry points."
- "Where is this function used across the codebase?"
- "Give me a map of how this repository is organized."

## What it runs, fetches and sends

- It runs the LayerMap MCP server on your machine (`npx -y layermap@0.1.6 mcp`).
  Java analysis uses your local JDK 21 or later.
- On first launch, npx downloads the pinned `layermap` package and its dependencies from the npm
  registry.
- LayerMap itself makes no network requests. Maps stay in your user cache, never in the repository.
  Your agent sends tool results to its model, as it does with any file it reads.
- A session-start hook adds one sentence telling the agent when the map helps.
- When Claude is about to finish after changing code, a stop hook asks it once to run
  `project_check_changes` and check what the changes affect. It only asks git whether code
  changed and never runs tests or edits anything. Set `LAYERMAP_STOP_CHECK=0` to turn it off.

## Permissions

The four tools only read the project and its map. Claude Code asks before each one's first use in a
project. Answer "Yes, and don't ask again", or run `npx layermap allow claude` once to allow them
everywhere (`npx layermap remove claude` takes it back).

## Requirements and support

Node.js 22.22 or later, macOS or Linux, and a Git repository. The links:

- [Documentation](https://github.com/coffeecoproject/layermap#readme)
- [Issues](https://github.com/coffeecoproject/layermap/issues)
- [Privacy](https://github.com/coffeecoproject/layermap/blob/main/PRIVACY.md)
- [Security](https://github.com/coffeecoproject/layermap/blob/main/SECURITY.md)

License: Apache-2.0.

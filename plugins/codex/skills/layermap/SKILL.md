---
name: layermap
description: Use instead of grep when a task needs to know what calls a function or method, what changing it affects (up to HTTP routes, handlers, jobs and commands), where code is used, or how the code is organized, and once the edits are done to check what the changes affect before reporting the work done. The layermap MCP tools answer these from a static map of the repository in one call.
---

# LayerMap

The layermap MCP server is available here. When a task needs to know what calls a function, what a change could affect beyond the code you are editing, or where code is used, use its project_explore_map tool (direction INCOMING, depth up to 8) instead of grep, then confirm in source; a change confined to code you have read does not need it. When the edits are done, call its project_check_changes tool once before reporting the work done.

- `project_explore_map` with `path` "." shows what the repository contains; a file `path` lists its declarations; with `name` (and `line` when names repeat) it shows a declaration's callers and callees. `direction` INCOMING with `depth` up to 8 traces callers up to the entry points; continue from any NOT EXPANDED declarations it names.
- `project_search_map` finds a declaration by words in its name, path or documentation.
- `project_find_references` lists every usage of a declaration, compiled from current source.
- `project_check_changes`, once the edits are done and before reporting them, lists the routes, jobs and commands the uncommitted changes reach, the existing tests related to them, and the existing tests the diff rewrote.

The map is static: dynamic dispatch, framework wiring and unresolved targets need source reading, and a missing relationship does not prove absence. A large repository's first map takes minutes to build; until then the tools say so, and you can read source meanwhile.

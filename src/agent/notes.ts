// The notes the agent integrations add to a session; kept apart from the server's code, so the
// Claude Code hooks and the Pi extension bundle them alone.

/**
 * One sentence for an agent's own instructions file. Codex shows MCP tools only when it searches for
 * them, so the tool descriptions alone do not bring it to the map; this names the server and when to
 * reach for it (natural-adoption runs, 2026-10-04).
 */
export const AGENT_MAP_NOTE =
  "The layermap MCP server is available here. When a task needs to know what calls a function, what a change could affect beyond the code you are editing, or where code is used, use its project_explore_map tool (direction INCOMING, depth up to 8) instead of grep, then confirm in source; a change confined to code you have read does not need it. When the edits are done, call its project_check_changes tool once before reporting the work done.";

/**
 * What the Claude Code plugin's stop hook and the Pi extension tell the agent, once per set of code
 * changes made in a session: check what they affect before finishing. The check itself is the map
 * tool; the hooks only ask git which of the session's edits are still there.
 */
export const AGENT_STOP_CHECK =
  "Code changed in this session. Before finishing, call the LayerMap tool project_check_changes: it lists the routes, jobs and commands the changes reach and the existing tests related to them. Check the affected entry points in source, and run the related tests if the change needs verifying. If it lists EXISTING TESTS CHANGED or code SHARED BY several areas, decide which of them the request is about; for the others, restore their tests and narrow the change. If it lists NEW MODULE DEPENDENCIES, check that each runs the way the project's layers do. If you already checked these changes, say so briefly and finish.";

/**
 * Added to AGENT_STOP_CHECK, followed by the repositories, when the changes to check are not all in
 * the repository the session started in: a check without a path covers only that one.
 */
export const AGENT_STOP_CHECK_REPOSITORIES =
  "The changes are in more than one repository, or not in the one the session started in: call project_check_changes once for each, with its path set to the repository: ";

/**
 * The line that heads each map tool result the server routed to a repository: the repository its
 * paths are relative to, so an agent that moved to another sees which one it read, and the hooks
 * which one a check covered.
 */
export const projectHeading = (project: string) => `Project ${project} (paths are relative to it)`;

import path from "node:path";

// A deliberately small, fail-closed declaration reader, not a general YAML parser. It reads the
// top-level `packages` list and passes over the file's other settings (allowBuilds, overrides and
// the like), which say nothing of membership. Other shapes of that list remain source-investigation
// gaps; they never create guessed links.
function pnpmPackages(text: string): string[] | undefined {
  const lines = text
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  const keys = lines.flatMap((line, index) =>
    /^packages:\s*(?:#.*)?$/u.test(line) ? [index] : [],
  );
  if (keys.length !== 1 || keys[0] === undefined) return undefined;
  // The list runs to the next top-level key; its items may sit at the key's own indentation.
  const after = lines.slice(keys[0] + 1);
  const end = after.findIndex((line) => !/^\s/u.test(line) && !line.startsWith("-"));
  const patterns: string[] = [];
  for (const line of end === -1 ? after : after.slice(0, end)) {
    const match = /^\s*-\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#]+)\s*(?:#.*)?$/u.exec(line);
    if (!match?.[1]) return undefined;
    const value = match[1];
    try {
      patterns.push(
        value.startsWith('"')
          ? JSON.parse(value)
          : value.startsWith("'")
            ? value.slice(1, -1).replaceAll("''", "'")
            : value,
      );
    } catch {
      return undefined;
    }
  }
  return patterns;
}

export function mapWorkspaceMembership(files: Readonly<Record<string, string>>) {
  let patterns: unknown;
  const pnpm = files["pnpm-workspace.yaml"];
  const configurationFiles: string[] = [];
  if (pnpm !== undefined) {
    configurationFiles.push("pnpm-workspace.yaml");
    patterns = pnpmPackages(pnpm);
  } else if (files["package.json"]) {
    configurationFiles.push("package.json");
    try {
      const root = JSON.parse(files["package.json"]);
      patterns = Array.isArray(root?.workspaces) ? root.workspaces : root?.workspaces?.packages;
    } catch {
      /* Invalid package configuration cannot authorize virtual workspace links. */
    }
  }
  const valid =
    Array.isArray(patterns) &&
    patterns.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        !path.posix.isAbsolute(entry.replace(/^!/u, "")) &&
        !entry.split("/").some((segment) => segment === ".."),
    );
  const accepted: string[] = valid ? (patterns as string[]) : [];
  const code:
    | "WORKSPACE_CONFIGURATION_UNSUPPORTED"
    | "WORKSPACE_MEMBERSHIP_NOT_ADMITTED"
    | undefined = valid
    ? undefined
    : pnpm !== undefined
      ? "WORKSPACE_CONFIGURATION_UNSUPPORTED"
      : "WORKSPACE_MEMBERSHIP_NOT_ADMITTED";
  return {
    configurationFiles,
    code,
    contains: (directory: string) =>
      accepted.some(
        (pattern) => !pattern.startsWith("!") && path.posix.matchesGlob(directory, pattern),
      ) &&
      !accepted.some(
        (pattern) => pattern.startsWith("!") && path.posix.matchesGlob(directory, pattern.slice(1)),
      ),
  };
}

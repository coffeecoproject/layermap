import path from "node:path";

// A deliberately small, fail-closed declaration reader, not a general YAML parser.
// Other pnpm YAML shapes remain source-investigation gaps; they never create guessed links.
function pnpmPackages(text: string): string[] | undefined {
  const lines = text
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (!/^packages:\s*(?:#.*)?$/u.test(lines[0] ?? "")) return undefined;
  const patterns: string[] = [];
  for (const line of lines.slice(1)) {
    const match = /^\s+-\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#]+)\s*(?:#.*)?$/u.exec(line);
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

import path from "node:path";
import { z } from "zod";
import {
  assertProjectEvidencePathNotSensitive,
  isProjectEvidenceTraversalExcluded,
  PROJECT_EVIDENCE_POLICY_DESCRIPTOR,
} from "./capture-policy";
import { ProjectEvidenceGrantPathPrefixSchema } from "./core";

export const InitialEvidenceScopeSchema = z
  .object({
    pathPrefixes: z.array(ProjectEvidenceGrantPathPrefixSchema).min(1).max(64),
  })
  .strict();

export type InitialEvidenceScope = Readonly<{
  pathPrefixes: readonly string[];
}>;

export const DEFAULT_INITIAL_EVIDENCE_SCOPE: InitialEvidenceScope = Object.freeze({
  pathPrefixes: Object.freeze(["."]),
});

const sourceExtensions = Object.freeze([
  ".c",
  ".cc",
  ".cpp",
  ".cjs",
  ".cts",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".mm",
  ".py",
  ".pyi",
  ".prisma",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
]);
// Dependency trees and caches, including Python virtual environments committed by mistake.
const excludedSegments = Object.freeze([
  "node_modules",
  "vendor",
  ".venv",
  "__pycache__",
  "site-packages",
]);

/** Which files a map reads: source, documentation, workspace and language configuration. */
export const SOURCE_POLICY = Object.freeze({
  sourceExtensions,
  excludedSegments,
  documentationFiles: Object.freeze(["readme.md", "agents.md"]),
  workspaceFiles: Object.freeze(["pnpm-workspace.yaml"]),
  // Language configuration read at any depth, such as Go modules, Python project settings and
  // Java builds.
  configurationFiles: Object.freeze([
    "go.mod",
    "go.work",
    "pyproject.toml",
    "setup.cfg",
    "pyrightconfig.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
  ]),
  basePolicy: PROJECT_EVIDENCE_POLICY_DESCRIPTOR,
  schemaVersion: 1,
});

const extensions = new Set(sourceExtensions);
const excluded = new Set(excludedSegments);

export const initialEvidenceScopeContains = (
  allowed: InitialEvidenceScope,
  admitted: InitialEvidenceScope,
): boolean =>
  admitted.pathPrefixes.every((prefix) =>
    allowed.pathPrefixes.some(
      (parent) => parent === "." || parent === prefix || prefix.startsWith(`${parent}/`),
    ),
  );

// Automatic preparation is narrower than explicitly requested, policy-bounded reads.
export const includesInitialEvidencePath = (
  relativePath: string,
  scope: InitialEvidenceScope,
): boolean => {
  try {
    assertProjectEvidencePathNotSensitive(relativePath);
  } catch {
    return false;
  }
  if (
    !scope.pathPrefixes.some(
      (prefix) =>
        prefix === "." || relativePath === prefix || relativePath.startsWith(`${prefix}/`),
    )
  )
    return false;
  if (isProjectEvidenceTraversalExcluded(relativePath)) return false;
  const segments = relativePath.toLowerCase().split("/");
  if (segments.slice(0, -1).some((segment) => excluded.has(segment))) return false;
  const basename = segments.at(-1) ?? "";
  return (
    extensions.has(path.posix.extname(basename)) ||
    SOURCE_POLICY.documentationFiles.includes(basename) ||
    SOURCE_POLICY.configurationFiles.includes(basename) ||
    SOURCE_POLICY.workspaceFiles.includes(relativePath)
  );
};

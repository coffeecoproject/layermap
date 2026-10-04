import path from "node:path";
import { PROJECT_EVIDENCE_FILE_UNIVERSE_POLICY } from "./file-universe";

const allowedTextExtensions = Object.freeze([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cjs",
  ".cts",
  ".css",
  ".csv",
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
  ".md",
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
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

// Text files recognized by their exact name rather than their extension.
const allowedTextBasenames = Object.freeze([
  "go.mod",
  "go.work",
  "setup.cfg",
  "build.gradle",
  "settings.gradle",
]);

const allowedExtensionlessNames = Object.freeze([
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

const sensitiveSegments = Object.freeze([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".azure",
]);

const sensitiveSegmentSequences = Object.freeze([
  Object.freeze([".config", "gcloud"]),
  Object.freeze([".config", "gh"]),
  Object.freeze([".config", "glab-cli"]),
  Object.freeze([".cargo", "credentials.toml"]),
]);

const sensitiveBasenames = Object.freeze([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "application_default_credentials.json",
  "service_account.json",
  "id_rsa",
  "id_ed25519",
]);

const sensitiveExtensions = Object.freeze([".key", ".pem", ".p12", ".pfx", ".cer", ".crt"]);
const traversalExcludedSegments = Object.freeze([".local"]);

export const PROJECT_EVIDENCE_POLICY_DESCRIPTOR = Object.freeze({
  maxDirectoryDepth: 4,
  maxDirectoryEntries: 200,
  maxSearchFilesPerPage: 500,
  maxSearchMatches: 50,
  captureConcurrency: 8,
  allowedTextExtensions,
  allowedTextBasenames,
  allowedExtensionlessNames,
  sensitiveSegments,
  sensitiveSegmentSequences,
  sensitiveBasenames,
  sensitiveExtensions,
  traversalExcludedSegments,
  symbolicLinks: "RECORDED_NOT_FOLLOWED",
  unsupportedEntries: "RECORDED_NOT_READ",
  fileUniverse: PROJECT_EVIDENCE_FILE_UNIVERSE_POLICY,
  schemaVersion: 1,
});

const allowedTextExtensionSet = new Set(allowedTextExtensions);
const allowedExtensionlessNameSet = new Set(allowedExtensionlessNames);
const allowedTextBasenameSet = new Set(allowedTextBasenames);
const sensitiveSegmentSet = new Set(sensitiveSegments);
const sensitiveBasenameSet = new Set(sensitiveBasenames);
const sensitiveExtensionSet = new Set(sensitiveExtensions);
const traversalExcludedSegmentSet = new Set(traversalExcludedSegments);

export class ProjectEvidencePolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectEvidencePolicyError";
  }
}

export const assertProjectEvidencePathNotSensitive = (relativePath: string): void => {
  const segments = relativePath.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  const extension = path.posix.extname(basename);
  const containsSensitiveSequence = sensitiveSegmentSequences.some(
    (sequence) =>
      segments.length >= sequence.length &&
      segments.some((_, start) =>
        sequence.every((segment, offset) => segments[start + offset] === segment),
      ),
  );
  if (
    segments.some((segment) => sensitiveSegmentSet.has(segment)) ||
    containsSensitiveSequence ||
    sensitiveBasenameSet.has(basename) ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    // SQLite databases and their journals hold application data, never project source.
    basename.endsWith(".sqlite") ||
    basename.includes(".sqlite-") ||
    sensitiveExtensionSet.has(extension)
  ) {
    throw new ProjectEvidencePolicyError("PROJECT_CONTENT_RESTRICTED");
  }
};

export const isProjectEvidenceTraversalExcluded = (relativePath: string): boolean =>
  relativePath
    .toLowerCase()
    .split("/")
    .some((segment) => traversalExcludedSegmentSet.has(segment));

export const isProjectEvidenceTextPath = (relativePath: string): boolean => {
  const basename = path.posix.basename(relativePath).toLowerCase();
  const extension = path.posix.extname(basename);
  if (allowedTextBasenameSet.has(basename)) return true;
  return extension
    ? allowedTextExtensionSet.has(extension)
    : allowedExtensionlessNameSet.has(basename);
};

import path from "node:path";
import { z } from "zod";

export class ProjectEvidenceError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ProjectEvidenceError";
  }
}

export class ProjectEvidencePathError extends Error {
  constructor(readonly code: "PROJECT_PATH_INVALID") {
    super(code);
    this.name = "ProjectEvidencePathError";
  }
}

export const normalizeProjectEvidencePath = (value: string, allowRoot = false): string => {
  if (value.includes("\0") || path.isAbsolute(value) || value.includes("\\")) {
    throw new ProjectEvidencePathError("PROJECT_PATH_INVALID");
  }
  if (value === ".") {
    if (allowRoot) return "";
    throw new ProjectEvidencePathError("PROJECT_PATH_INVALID");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized.length === 0 ||
    normalized !== value ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ProjectEvidencePathError("PROJECT_PATH_INVALID");
  }
  return normalized;
};

export const canonicalGrantPathPrefix = (value: string): string => {
  const normalized = normalizeProjectEvidencePath(value, true);
  return normalized.length === 0 ? "." : normalized;
};

export const isCanonicalProjectEvidenceGrantPathPrefix = (value: string): boolean => {
  try {
    return canonicalGrantPathPrefix(value) === value;
  } catch {
    return false;
  }
};

export const ProjectEvidenceGrantPathPrefixSchema = z
  .string()
  .min(1)
  .refine(isCanonicalProjectEvidenceGrantPathPrefix, {
    message: "Project Evidence Grant path prefix must be canonical.",
  });

export type ProjectEvidenceRevisionEntryState =
  | "TEXT"
  | "TYPE_RESTRICTED"
  | "TOO_LARGE"
  | "NON_TEXT"
  | "NOT_READABLE"
  | "SYMLINK"
  | "UNSUPPORTED_ENTRY";

export type ProjectEvidenceRevisionFileEntryV1 = Readonly<{
  path: string;
  state: ProjectEvidenceRevisionEntryState;
  byteLength: number;
  contentDigest?: string;
}>;

export type ProjectEvidenceRevisionPathStatusV1 =
  | Readonly<{
      path: string;
      status: "TEXT_READABLE";
      entryState: "TEXT";
      byteLength: number;
      contentDigest: string;
    }>
  | Readonly<{
      path: string;
      status: "KNOWN_NOT_READABLE";
      entryState: Exclude<ProjectEvidenceRevisionEntryState, "TEXT">;
      byteLength: number;
      contentDigest?: string;
    }>
  | Readonly<{
      path: string;
      status: "DIRECTORY";
    }>
  | Readonly<{
      path: string;
      status: "NOT_INCLUDED_IN_REVISION";
    }>
  | Readonly<{
      path: string;
      status: "CONTENT_POLICY_RESTRICTED";
    }>;

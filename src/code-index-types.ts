import type { InitialEvidenceScope } from "./source-scope";

/** A directory by its canonical path and the device and inode it had when it was chosen. */
export type DirectoryIdentity = Readonly<{
  canonicalPath: string;
  device: string;
  inode: string;
}>;

// The caller owns the source and permission to use it. No Goal identity is needed here.
export type CodeIndexSource = Readonly<{
  projectRef: string;
  directory: Readonly<DirectoryIdentity>;
}> &
  (Readonly<{ kind: "WORKTREE" }> | Readonly<{ kind: "COMMIT"; commit: string }>);

export type CodeIndexVersion = Readonly<{
  version: string;
  projectRef: string;
  pathPrefixes: readonly string[];
  fileCount: number;
  readableTextFileCount: number;
  capturedBytes: number;
  analyzer: string;
}>;

export type CodeIndexProgress = Readonly<{
  processedFiles: number;
  totalFiles: number;
  capturedBytes: number;
}>;

export type CodeIndexCaptureOptions = Readonly<{
  initialScope?: InitialEvidenceScope;
  onProgress?: (progress: CodeIndexProgress) => void;
}>;

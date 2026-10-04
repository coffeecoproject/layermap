import type { CodeIndexStore } from "./code-index-store";
import type { CodeIndexSource } from "./code-index-types";
import { ProjectEvidenceError, type ProjectEvidenceRevisionFileEntryV1 } from "./core";
import { ProjectMapSourceReader } from "./project-map-source";

export class ProjectMapReadSession {
  private worktree?: ProjectMapSourceReader;
  private readonly configurations = new Set<string>();
  readonly source: CodeIndexSource;

  constructor(
    private readonly store: CodeIndexStore,
    private readonly version: string,
    source: CodeIndexSource,
    private readonly signal: AbortSignal,
  ) {
    if (store.requireVersion(version).projectRef !== source.projectRef)
      throw new ProjectEvidenceError("PROJECT_EVIDENCE_ACCESS_REVOKED", false);
    this.source = Object.freeze({ ...source, directory: Object.freeze({ ...source.directory }) });
  }

  async read(entry: ProjectEvidenceRevisionFileEntryV1): Promise<Buffer> {
    if (this.source.kind === "WORKTREE")
      this.worktree ??= await ProjectMapSourceReader.open(this.source, this.signal, false);
    const reader =
      this.worktree ??
      (await ProjectMapSourceReader.open(this.source, this.signal, false, entry.path));
    for (const configuration of this.pendingConfigurations(entry)) {
      await reader.read(configuration.path, configuration);
      this.configurations.add(configuration.path);
    }
    const result = await reader.read(entry.path, entry);
    if (!result.content) throw new ProjectEvidenceError("PROJECT_MAP_SOURCE_CHANGED", true);
    this.configurations.add(entry.path);
    if (!this.worktree) await reader.assertStable();
    return result.content;
  }

  assertStable(): Promise<void> {
    return this.worktree?.assertStable() ?? Promise.resolve();
  }

  private pendingConfigurations(entry: ProjectEvidenceRevisionFileEntryV1) {
    return this.source.kind !== "WORKTREE"
      ? []
      : this.store
          .configurationEntries(this.version, entry.path)
          .filter((value) => value.path !== entry.path && !this.configurations.has(value.path));
  }
}

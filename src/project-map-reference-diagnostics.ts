import { DiagnosticCategory, type Project } from "typescript/unstable/async";
import { mapMissingPackage } from "./project-map-installed";
import type { MapDiagnostics } from "./project-map-reference-types";
import type { MapWorkerInput } from "./project-map-types";
import { mapRelativePath } from "./project-map-virtual-files";

/** What the compiler says is wrong in the context's own files, and the packages it could not find. */
export async function extractMapDiagnostics(
  project: Project,
  input: MapWorkerInput,
  programFiles: readonly string[],
): Promise<MapDiagnostics> {
  const diagnostics: MapDiagnostics["diagnostics"] = [];
  const missing = new Set<string>();
  // A `types` entry that is not there is the program's, not any file's.
  for (const item of await project.program.getProgramDiagnostics()) {
    const name = mapMissingPackage(item.code, item.text);
    if (name) missing.add(name);
  }
  for (const name of programFiles) {
    const relative = mapRelativePath(name);
    const text = relative === undefined ? undefined : input.files[relative];
    if (relative === undefined || text === undefined) continue;
    for (const item of await project.program.getSemanticDiagnostics(name)) {
      if (item.category !== DiagnosticCategory.Error) continue;
      const missed = mapMissingPackage(item.code, item.text);
      if (missed) missing.add(missed);
      let line = 1;
      for (let at = text.indexOf("\n"); at >= 0 && at < item.pos; at = text.indexOf("\n", at + 1))
        line++;
      diagnostics.push({
        path: relative,
        line,
        code: item.code,
        text: item.text,
        span: text.slice(item.pos, item.end).slice(0, 200),
      });
    }
  }
  return { diagnostics, missing: [...missing].sort(), requiredFiles: [] };
}

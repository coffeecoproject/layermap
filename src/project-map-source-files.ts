import { type Project, SymbolFlags } from "typescript/unstable/async";
import type { MapParserTrace } from "./project-map-failure";
import type { MapWorkerInput } from "./project-map-types";
import { mapRelativePath } from "./project-map-virtual-files";

export async function* mapSourceFiles(
  project: Project,
  input: MapWorkerInput,
  trace: MapParserTrace,
) {
  const owned = new Set(input.rootFiles ?? Object.keys(input.files));
  const names = (await project.program.getSourceFileNames()).filter((name) => {
    const relative = mapRelativePath(name);
    return (
      relative &&
      Object.hasOwn(input.files, relative) &&
      /(?:\.[cm]?[jt]sx?|\.json)$/u.test(relative)
    );
  });
  for (let start = 0; start < names.length; start += 16) {
    trace.phase = "SOURCE_AST";
    const batch = await Promise.allSettled(
      names.slice(start, start + 16).map(async (name) => {
        const file = await project.program.getSourceFile(name);
        const relative = mapRelativePath(name);
        if (!relative) throw new Error("PROJECT_MAP_CONTEXT_NOT_AVAILABLE");
        const syntaxErrors = file
          ? (await project.program.getSyntacticDiagnostics(name)).length
          : 0;
        const exports = new Set<number>();
        if (file && !syntaxErrors && owned.has(relative)) {
          const module = await project.checker.getSymbolAtLocation(file);
          for (const symbol of (await module?.getExports())?.values() ?? [])
            exports.add(
              symbol.flags & SymbolFlags.Alias
                ? (await project.checker.getAliasedSymbol(symbol)).id
                : symbol.id,
            );
        }
        return { file, path: relative, syntaxErrors, exports };
      }),
    );
    // Drain before throwing, and publish in program order rather than response arrival order.
    for (const item of batch) {
      if (item.status === "rejected") throw item.reason;
      yield item.value;
    }
  }
}

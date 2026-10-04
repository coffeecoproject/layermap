import type { Project } from "typescript/unstable/async";
import { digestValue } from "./digest";
import type { MapContext, MapWorkerInput } from "./project-map-types";
import { mapRelativePath } from "./project-map-virtual-files";

export function mapParsingContext(project: Project, input: MapWorkerInput): MapContext {
  return {
    ref: input.contextRef,
    ...(input.configPath ? { configPath: input.configPath } : {}),
    optionsDigest: digestValue(project.compilerOptions),
    mode: input.syntaxOnly ? "SYNTAX_ONLY" : input.configPath ? "CONFIGURED" : "INFERRED",
    inputFiles: Object.keys(input.files).sort(),
    configurationFiles: [],
    rootFiles: input.rootFiles
      ? [...input.rootFiles]
      : project.rootFiles.map(mapRelativePath).filter((file): file is string => file !== undefined),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    resolution: input.workspace?.redirects.length ? "WORKSPACE_SOURCE" : "DECLARED",
  };
}

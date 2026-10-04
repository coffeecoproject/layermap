import { withMapCompiler } from "./project-map-compiler";
import { applyMapWorkspace, discoverMapConfiguration } from "./project-map-configuration";
import { mapParsingContext } from "./project-map-context";
import { extractProjectMap } from "./project-map-extract";
import { type MapParserTrace, mapWorkerFailure } from "./project-map-failure";
import { extractMapReferences } from "./project-map-reference-extract";
import type { MapReferenceRequest } from "./project-map-reference-types";
import type { MapWorkerInput } from "./project-map-types";
import { MapVirtualFiles, mapRelativePath, mapVirtualPath } from "./project-map-virtual-files";
import { MapWorkerTimingCollector } from "./project-map-worker-timing";

const stopOwnedGroup = () => process.kill(-process.pid, "SIGKILL");
process.once("disconnect", stopOwnedGroup);
process.once("SIGTERM", stopOwnedGroup);
process.once("beforeExit", () => process.off("disconnect", stopOwnedGroup));
process.once(
  "message",
  async (
    message: MapWorkerInput & {
      operation: "BUILD" | "CONFIGURE" | "REFERENCES";
      reference?: MapReferenceRequest;
      collectTiming?: boolean;
    },
  ) => {
    const timing = message.collectTiming ? new MapWorkerTimingCollector() : undefined;
    const trace: MapParserTrace = timing?.trace ?? { phase: "INITIALIZE" };
    try {
      const files = new MapVirtualFiles(message);
      if (message.workspace) applyMapWorkspace(files, message.workspace);
      if (!message.configPath || message.syntaxOnly)
        files.set(
          "__layermap__.json",
          JSON.stringify({
            compilerOptions: {
              noEmit: true,
              allowJs: true,
              jsx: "preserve",
              target: "esnext",
              module: "nodenext",
              noResolve: message.syntaxOnly,
            },
            files: (
              message.rootFiles ??
              (message.syntaxOnly ? Object.keys(message.files) : message.inventory)
            ).filter((file) => /\.[cm]?[jt]sx?$/u.test(file)),
          }),
        );
      const result = await withMapCompiler(
        {
          tsserverPath: message.compilerPath,
          cwd: "/layermap",
          fs: files.fs,
          collectTiming: message.collectTiming === true,
        },
        async (api) => {
          if (timing) trace.checkpoint = (point) => timing.checkpoint(api, point);
          if (message.operation === "CONFIGURE") {
            const result = await discoverMapConfiguration(api, files);
            await timing?.checkpoint(api, "CONFIGURE");
            return result;
          }
          const config = mapVirtualPath(
            message.syntaxOnly || !message.configPath ? "__layermap__.json" : message.configPath,
          );
          trace.phase = "OPEN_PROJECT";
          const snapshot = await api.updateSnapshot({ openProjects: [config] });
          const project = snapshot.getProject(config);
          if (!project) throw new Error("PROJECT_MAP_CONTEXT_NOT_AVAILABLE");
          await timing?.checkpoint(api, "OPEN_PROJECT");
          trace.phase = message.operation === "REFERENCES" ? "REFERENCES" : "SOURCE_FILES";
          const programFiles = await project.program.getSourceFileNames();
          const result =
            message.operation === "REFERENCES" && message.reference
              ? await extractMapReferences(project, message, message.reference)
              : files.required.size
                ? {
                    contexts: [mapParsingContext(project, message)],
                    objects: [],
                    relations: [],
                    notes: [],
                    gaps: [],
                    parsedFiles: [],
                    requiredFiles: [],
                  }
                : await extractProjectMap(project, message, trace);
          result.requiredFiles = [...files.required].sort();
          if ("contexts" in result)
            for (const context of result.contexts) {
              const sourceInputs = new Set(
                programFiles
                  .map(mapRelativePath)
                  .filter(
                    (file): file is string =>
                      file !== undefined && Object.hasOwn(message.files, file),
                  ),
              );
              // Configuration inheritance accepts arbitrary filenames. Preserve actual
              // compiler inputs; JSON modules belong to sourceInputs, not configuration.
              context.configurationFiles = [
                ...new Set([
                  ...files.configurations,
                  ...[...files.readInputs].filter((file) => !sourceInputs.has(file)),
                ]),
              ].sort();
              context.inputFiles = [
                ...new Set([...sourceInputs, ...files.readInputs, ...context.configurationFiles]),
              ].sort();
            }
          trace.phase = "DISPOSE";
          await timing?.checkpoint(
            api,
            message.operation === "REFERENCES" ? "REFERENCES" : "ANALYSIS",
          );
          await snapshot.dispose();
          await timing?.checkpoint(api, "DISPOSE");
          return result;
        },
      );
      process.send?.({ result });
    } catch (error) {
      process.send?.(mapWorkerFailure(error, trace, import.meta.url));
      process.exitCode = 1;
    } finally {
      process.channel?.unref();
      // Natural exit waits for the compiler child; do not manufacture a successful stop with exit().
    }
  },
);

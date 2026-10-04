import { type MapParserTrace, mapWorkerFailure } from "./project-map-failure";
import { extractPython } from "./project-map-python-extract";
import { openPythonProgram } from "./project-map-python-host";
import { findPythonReferences } from "./project-map-python-references";

// Analyzes one Python map context in process with Pyright. Sources arrive in the request; the only
// files read from disk are the bundled standard library stubs.
// A parent that goes away stops the analysis; once finished, the worker exits on its own.
const orphaned = () => process.exit(1);
process.once("disconnect", orphaned);
process.once("beforeExit", () => process.off("disconnect", orphaned));
process.once(
  "message",
  (message: {
    compilerPath: string;
    operation: "BUILD" | "REFERENCES";
    files: Record<string, string>;
    root: string;
    pythonVersion: { major: number; minor: number };
    tests: string[];
    target?: { path: string; offset: number };
  }) => {
    const trace: MapParserTrace = { phase: "OPEN_PROJECT" };
    try {
      const source = openPythonProgram({
        files: message.files,
        typeshed: message.compilerPath,
        root: message.root,
        pythonVersion: message.pythonVersion,
      });
      try {
        if (message.operation === "REFERENCES") {
          if (!message.target) throw new Error("PROJECT_MAP_PROTOCOL_INVALID");
          trace.phase = "REFERENCES";
          process.send?.({ result: findPythonReferences(source, message.target) });
        } else {
          trace.phase = "TRAVERSAL";
          process.send?.({ result: extractPython(source, new Set(message.tests)) });
        }
      } finally {
        trace.phase = "DISPOSE";
        source.dispose();
      }
    } catch (error) {
      process.send?.(mapWorkerFailure(error, trace, import.meta.url));
      process.exitCode = 1;
    } finally {
      process.channel?.unref();
    }
  },
);

import { spawn } from "node:child_process";
import { childEnvironment, stopProcessTree } from "./platform";
import { type MapParserTrace, mapWorkerFailure } from "./project-map-failure";

// Relays one request to the native go-map program. The program reads sources only from the
// request, so it runs with an empty environment; this worker's process group owns it.
const stopOwnedGroup = () => stopProcessTree(process.pid, "SIGKILL");
process.once("disconnect", stopOwnedGroup);
process.once("SIGTERM", stopOwnedGroup);
process.once("beforeExit", () => process.off("disconnect", stopOwnedGroup));
process.once(
  "message",
  (message: {
    compilerPath: string;
    operation: string;
    modFile?: string;
    files: Record<string, string>;
    target?: { path: string; offset: number };
  }) => {
    const trace: MapParserTrace = { phase: "SOURCE_FILES" };
    const report = (error: Error) => {
      process.send?.(mapWorkerFailure(error, trace, import.meta.url));
      process.exitCode = 1;
      process.channel?.unref();
    };
    const helper = spawn(message.compilerPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment({}),
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let errors = "";
    helper.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    helper.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 4096) errors += chunk.toString("utf8");
    });
    helper.once("error", report);
    helper.once("close", (code) => {
      if (code !== 0) {
        // The program's first stderr line is a stable failure code.
        report(new Error(errors.split("\n", 1)[0] || "PROJECT_MAP_ANALYSIS_FAILED"));
        return;
      }
      trace.phase = "RESULT_VALIDATION";
      try {
        process.send?.({ result: JSON.parse(Buffer.concat(output).toString("utf8")) });
        process.channel?.unref();
      } catch {
        report(new Error("PROJECT_MAP_PROTOCOL_INVALID"));
      }
    });
    // A helper that exits before reading its request closes the pipe; its exit says why.
    helper.stdin.on("error", () => {});
    helper.stdin.end(
      JSON.stringify({
        operation: message.operation,
        modFile: message.modFile ?? "",
        files: message.files,
        ...(message.target ? { target: message.target } : {}),
      }),
    );
  },
);

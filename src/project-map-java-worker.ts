import { spawn } from "node:child_process";
import path from "node:path";
import { type MapParserTrace, mapWorkerFailure } from "./project-map-failure";

// Relays one request to the Java analyzer (java-map.jar on a Java runtime of 21 or later). The
// analyzer reads sources only from the request and runs with an empty environment; the Lombok jar
// beside it runs as javac's annotation processor. This worker's process group owns the JVM.
const stopOwnedGroup = () => process.kill(-process.pid, "SIGKILL");
process.once("disconnect", stopOwnedGroup);
process.once("SIGTERM", stopOwnedGroup);
process.once("beforeExit", () => process.off("disconnect", stopOwnedGroup));
process.once(
  "message",
  (message: {
    compilerPath: string;
    runtimePath: string;
    operation: string;
    files: Record<string, string>;
    release: number;
    tests: string[];
    target?: { path: string; offset: number };
    incremental?: { changed: string[]; state: unknown };
  }) => {
    const trace: MapParserTrace = { phase: "SOURCE_FILES" };
    const report = (error: Error) => {
      process.send?.(mapWorkerFailure(error, trace, import.meta.url));
      process.exitCode = 1;
      process.channel?.unref();
    };
    const helper = spawn(
      message.runtimePath,
      [
        // Large projects attribute every class in one compilation.
        "-XX:MaxRAMPercentage=40",
        "-XX:+UseParallelGC",
        // A references request attributes only the files that may refer to its target, through
        // javac's task implementation (Program.load).
        "--add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED",
        "-cp",
        message.compilerPath,
        "javamap.Main",
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: {} },
    );
    const output: Buffer[] = [];
    let errors = "";
    helper.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    helper.stderr.on("data", (chunk: Buffer) => {
      // Lombok warns about JDK internals it uses; the failure code is the first other line.
      if (errors.length < 4096) errors += chunk.toString("utf8");
    });
    helper.once("error", report);
    helper.once("close", (code) => {
      if (code !== 0) {
        const line = errors.split("\n").find((value) => /^[A-Z_]+$/u.test(value.trim()));
        report(new Error(line?.trim() || "PROJECT_MAP_ANALYSIS_FAILED"));
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
        files: message.files,
        release: message.release,
        tests: message.tests,
        lombok: path.join(path.dirname(message.compilerPath), "lombok.jar"),
        ...(message.target ? { target: message.target } : {}),
        ...(message.incremental ? { incremental: message.incremental } : {}),
      }),
    );
  },
);

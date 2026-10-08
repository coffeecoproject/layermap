import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import { ProjectEvidenceError } from "./core";
import { childEnvironment, executableName, processTreeGone, stopProcessTree } from "./platform";
import {
  type MapParserDiagnostic,
  MapParserDiagnosticSchema,
  MapWorkerFailureSchema,
  ProjectMapAnalysisError,
} from "./project-map-failure";
import { type MapParserTiming, MapWorkerTimingSchema } from "./project-map-timing";
import {
  type MapAnalysis,
  MapAnalysisSchema,
  type MapWorkerInput,
  PROJECT_MAP_LIMITS,
} from "./project-map-types";

export type MapParserResources = Readonly<{
  workerPath: string;
  compilerPath: string;
  execArgv?: readonly string[];
  collectTiming?: boolean;
}>;
export class ProjectMapStopUnconfirmedError extends ProjectEvidenceError {
  constructor() {
    super("PROJECT_MAP_STOP_UNCONFIRMED", false);
  }
}
export const installedMapParserResources = (): MapParserResources => {
  const directory = path.dirname(path.resolve(process.argv[1] ?? "."));
  return {
    workerPath: path.join(directory, "project-map-worker.mjs"),
    compilerPath: path.join(directory, "project-map-native/tsc"),
  };
};

/** The Python analyzer: a worker running Pyright, and the standard library stubs it reads. */
export const installedPythonMapResources = (): MapParserResources => {
  const directory = path.dirname(path.resolve(process.argv[1] ?? "."));
  return {
    workerPath: path.join(directory, "project-map-python-worker.mjs"),
    compilerPath: path.join(directory, "project-map-python/typeshed"),
  };
};

/** The Java analyzer's resources and the Java runtime (21 or later) it runs on, if any. */
export type JavaMapResources = MapParserResources &
  Readonly<{ runtimePath?: string; runtimeVersion?: string }>;

/**
 * A Java runtime of 21 or later with javac: LAYERMAP_JAVA_HOME, JAVA_HOME, the java on PATH, then
 * the one macOS selects for 21+. Its release file states the version, so nothing runs to find out.
 */
export function discoverJavaRuntime(
  env: NodeJS.ProcessEnv = process.env,
): { runtimePath: string; runtimeVersion: string } | undefined {
  const homes = [env.LAYERMAP_JAVA_HOME, env.JAVA_HOME];
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    const java = path.join(directory, executableName("java"));
    if (directory && existsSync(java)) homes.push(path.dirname(path.dirname(realpathSync(java))));
  }
  // An app started from the Finder has a short PATH: the usual package manager homes, whose
  // paths stay the same across upgrades. Homebrew's LTS formulas come before its latest JDK,
  // which Lombok supports only some time after a release.
  homes.push(
    ...["/opt/homebrew/opt", "/usr/local/opt"].flatMap((prefix) =>
      ["openjdk@25", "openjdk@21", "openjdk"].map(
        (formula) => `${prefix}/${formula}/libexec/openjdk.jdk/Contents/Home`,
      ),
    ),
    ...(env.HOME ? [path.join(env.HOME, ".sdkman/candidates/java/current")] : []),
  );
  if (process.platform === "darwin")
    try {
      homes.push(
        execFileSync("/usr/libexec/java_home", ["-v", "21+"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      // No Java runtime is registered with macOS.
    }
  for (const home of homes) {
    if (!home) continue;
    const runtimePath = path.join(home, "bin", executableName("java"));
    if (!existsSync(runtimePath) || !existsSync(path.join(home, "bin", executableName("javac"))))
      continue;
    let release = "";
    try {
      release = readFileSync(path.join(home, "release"), "utf8");
    } catch {
      continue;
    }
    const runtimeVersion = /^JAVA_VERSION="([^"]+)"/mu.exec(release)?.[1];
    if (runtimeVersion && Number(runtimeVersion.split(".", 1)[0]) >= 21)
      return { runtimePath, runtimeVersion };
  }
  return undefined;
}

/** The Java analyzer: a Node relay worker, java-map.jar with Lombok beside it, and a runtime. */
export const installedJavaMapResources = (): JavaMapResources => {
  const directory = path.dirname(path.resolve(process.argv[1] ?? "."));
  const compilerPath = path.join(directory, "project-map-java/java-map.jar");
  return {
    workerPath: path.join(directory, "project-map-java-worker.mjs"),
    compilerPath,
    // A build without a JDK leaves no analyzer to run, whatever runtime this machine has.
    ...(existsSync(compilerPath) ? discoverJavaRuntime() : {}),
  };
};

/** The Go analyzer: a Node relay worker and the native go-map program it runs. */
export const installedGoMapResources = (): MapParserResources => {
  const directory = path.dirname(path.resolve(process.argv[1] ?? "."));
  return {
    workerPath: path.join(directory, "project-map-go-worker.mjs"),
    compilerPath: path.join(directory, "project-map-go/go-map"),
  };
};

export function runMapParser(
  resources: MapParserResources,
  input: Omit<MapWorkerInput, "compilerPath">,
  signal: AbortSignal,
): Promise<MapAnalysis> {
  return runMapOperation(resources, { ...input, operation: "BUILD" }, MapAnalysisSchema, signal);
}

export function runMapOperation<T>(
  resources: MapParserResources,
  input: Omit<MapWorkerInput, "compilerPath"> & { operation: string; [key: string]: unknown },
  schema: ZodType<T>,
  signal: AbortSignal,
  observeTiming?: (event: MapParserTiming) => void,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new ProjectEvidenceError("PROJECT_READ_CANCELLED", true));
  if (!path.isAbsolute(resources.workerPath) || !path.isAbsolute(resources.compilerPath)) {
    return Promise.reject(
      new ProjectEvidenceError("PROJECT_MAP_PARSER_CONFIGURATION_INVALID", false),
    );
  }
  const serializing = performance.now();
  if (resources.collectTiming) {
    try {
      JSON.stringify(input);
    } catch {
      return Promise.reject(new ProjectEvidenceError("PROJECT_MAP_INPUT_FAILED", true));
    }
    observeTiming?.({
      source: "PARENT",
      phase: "INPUT_SERIALIZATION",
      elapsedMs: performance.now() - serializing,
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(resources.execArgv ?? []), resources.workerPath], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: childEnvironment({
        PATH: "/usr/bin:/bin",
        LANG: "C",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ELECTRON_RUN_AS_NODE: "1",
      }),
    });
    let result: T | undefined;
    let resultAt: number | undefined;
    let timingMessages = 0;
    let failure: Error | undefined;
    let settled = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      clearTimeout(reapTimer);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new ProjectEvidenceError("PROJECT_MAP_RESULT_MISSING", true));
    };
    const kill = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        stopProcessTree(child.pid, value);
      } catch {
        // The group may have exited between the worker message and this signal.
        // Only the bounded close/reap check below can confirm a safe stop.
      }
    };
    const stop = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      kill("SIGTERM");
      stopTimer = setTimeout(() => {
        kill("SIGKILL");
        reapTimer = setTimeout(
          () => finish(new ProjectMapStopUnconfirmedError()),
          PROJECT_MAP_LIMITS.stopMs,
        );
      }, PROJECT_MAP_LIMITS.stopMs);
    };
    const cancel = () => stop(new ProjectEvidenceError("PROJECT_READ_CANCELLED", true));
    const observe = (event: MapParserTiming) => {
      if (!resources.collectTiming) return;
      try {
        observeTiming?.(event);
      } catch {
        stop(new ProjectEvidenceError("PROJECT_MAP_TIMING_OBSERVER_FAILED", true));
      }
    };
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("spawn", () => {
      try {
        child.send(
          {
            ...input,
            compilerPath: resources.compilerPath,
            collectTiming: resources.collectTiming === true,
          },
          (error) => {
            if (error) stop(new ProjectEvidenceError("PROJECT_MAP_INPUT_FAILED", true));
          },
        );
      } catch {
        stop(new ProjectEvidenceError("PROJECT_MAP_INPUT_FAILED", true));
      }
    });
    child.on("message", (message) => {
      if (settled || failure) return;
      if (result) {
        stop(new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false));
        return;
      }
      const accounting = performance.now();
      if (message && typeof message === "object" && Object.hasOwn(message, "timing")) {
        const timing = MapWorkerTimingSchema.safeParse((message as { timing?: unknown }).timing);
        if (
          !resources.collectTiming ||
          Object.keys(message).length !== 1 ||
          ++timingMessages > 8 ||
          !timing.success
        ) {
          stop(new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false));
          return;
        }
        observe({ source: "WORKER", measurement: timing.data });
        return;
      }
      const reported = MapWorkerFailureSchema.safeParse(message);
      if (reported.success) {
        stop(new ProjectMapAnalysisError(reported.data.error, reported.data.diagnostic));
        return;
      }
      if (
        !message ||
        typeof message !== "object" ||
        Object.keys(message).length !== 1 ||
        !Object.hasOwn(message, "result")
      ) {
        stop(
          new ProjectMapAnalysisError("PROJECT_MAP_PROTOCOL_INVALID", {
            phase: "RESULT_VALIDATION",
            category: "SCHEMA",
            workerFrames: [],
            validationIssues: [{ section: "ROOT", code: "unrecognized_keys" }],
          }),
        );
        return;
      }
      const validationStart = performance.now();
      observe({
        source: "PARENT",
        phase: "OUTPUT_ACCOUNTING",
        elapsedMs: validationStart - accounting,
      });
      const parsed = schema.safeParse((message as { result?: unknown })?.result);
      observe({
        source: "PARENT",
        phase: "RESULT_VALIDATION",
        elapsedMs: performance.now() - validationStart,
      });
      if (!parsed.success) {
        const issueSchema = MapParserDiagnosticSchema.shape.validationIssues.unwrap().element;
        const validationIssues: NonNullable<MapParserDiagnostic["validationIssues"]> =
          parsed.error.issues.slice(0, 8).map((issue) => {
            const section = issueSchema.shape.section.safeParse(issue.path[0]);
            const code = issueSchema.shape.code.safeParse(issue.code);
            return {
              section: section.success ? section.data : "ROOT",
              code: code.success ? code.data : "OTHER",
            };
          });
        stop(
          new ProjectMapAnalysisError("PROJECT_MAP_PROTOCOL_INVALID", {
            phase: "RESULT_VALIDATION",
            category: "SCHEMA",
            workerFrames: [],
            validationIssues,
          }),
        );
        return;
      }
      result = parsed.data;
      resultAt = performance.now();
    });
    child.once("error", () =>
      stop(new ProjectEvidenceError("PROJECT_MAP_PARSER_UNAVAILABLE", true)),
    );
    child.once("close", (code) => {
      // No publication until both the worker and inherited compiler pipes have closed.
      const drained = async () => {
        const until = Date.now() + PROJECT_MAP_LIMITS.stopMs;
        while (child.pid) {
          // A departing process group can briefly report EPERM. Only ESRCH confirms exit.
          if (processTreeGone(child.pid)) return true;
          if (Date.now() >= until) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      };
      void drained().then(
        (confirmed) => {
          if (resultAt !== undefined)
            observe({
              source: "PARENT",
              phase: "RESULT_TO_EXIT",
              elapsedMs: performance.now() - resultAt,
            });
          finish(
            confirmed
              ? (failure ??
                  (code === 0
                    ? undefined
                    : new ProjectEvidenceError("PROJECT_MAP_ANALYSIS_FAILED", true)))
              : new ProjectMapStopUnconfirmedError(),
          );
        },
        () => finish(new ProjectMapStopUnconfirmedError()),
      );
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

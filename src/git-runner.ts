import { spawn } from "node:child_process";
import { childEnvironment, findExecutable } from "./platform";

const CONSTRAINED_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "credential.interactive=never",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export class GitCommandStopUnconfirmedError extends GitCommandError {
  constructor() {
    super("Git command stop could not be confirmed.");
    this.name = "GitCommandStopUnconfirmedError";
  }
}

export const isNotGitRepositoryError = (error: GitCommandError): boolean =>
  /fatal: not a git repository(?: \(or any of the parent directories\))?/i.test(error.stderr);

export const isMissingRevisionError = (error: GitCommandError): boolean =>
  error.exitCode !== undefined &&
  /(?:Needed a single revision|unknown revision|bad revision|not a valid object name)/i.test(
    error.stderr,
  );

export type GitRunOptions = {
  cwd: string;
  input?: Uint8Array;
  // Explicit null disables the corresponding limit; omitted options retain the defaults.
  timeoutMs?: number | null;
  maxOutputBytes?: number | null;
  readOnly?: boolean;
  signal?: AbortSignal;
};

export type GitRunResult = {
  stdout: Buffer;
  stderr: Buffer;
};

// Git runs with no user or system configuration, no prompts and no pager. Git for Windows maps
// /dev/null to NUL; it finds its own helpers, so its PATH stays, and it has no /usr/bin/false.
function gitEnvironment(): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  return childEnvironment({
    LANG: process.env.LANG ?? "C",
    LC_ALL: "C",
    PATH: windows ? (process.env.PATH ?? "") : "/usr/bin:/bin",
    ...(windows ? {} : { TMPDIR: process.env.TMPDIR ?? "/tmp" }),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    ...(windows ? {} : { GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false" }),
  });
}

// The git LayerMap runs: the system's on POSIX, where /usr/bin/git is always there, and the one on
// PATH on Windows, where Git for Windows installs wherever the user chose.
const defaultGit = () =>
  process.platform === "win32" ? (findExecutable("git") ?? "git.exe") : "/usr/bin/git";

export class GitRunner {
  constructor(private readonly executable = defaultGit()) {}

  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    if (options.signal?.aborted) {
      return Promise.reject(new GitCommandError("Git command aborted."));
    }
    const readOnly = options.readOnly !== false;
    const finalArgs = readOnly
      ? ["--no-optional-locks", ...CONSTRAINED_CONFIG, ...args]
      : [...CONSTRAINED_CONFIG, ...args];
    const timeoutMs = options.timeoutMs === undefined ? 5_000 : options.timeoutMs;
    const maxOutputBytes =
      options.maxOutputBytes === undefined ? 2 * 1024 * 1024 : options.maxOutputBytes;

    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, finalArgs, {
        cwd: options.cwd,
        env: gitEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (reapTimer) clearTimeout(reapTimer);
        options.signal?.removeEventListener("abort", stopFromSignal);
      };

      const fail = (error: Error): void => {
        if (settled || failure) return;
        failure = error;
        cleanup();
        if (!child.pid) {
          settled = true;
          reject(error);
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* Drain confirmation remains required. */
        }
        reapTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new GitCommandStopUnconfirmedError());
        }, 5_000);
      };
      const stopFromSignal = (): void => fail(new GitCommandError("Git command aborted."));
      const append = (target: Buffer[], chunk: Buffer): void => {
        if (failure || settled) return;
        outputBytes += chunk.length;
        if (maxOutputBytes !== null && outputBytes > maxOutputBytes) {
          fail(new GitCommandError("Git command exceeded the output limit."));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", fail);
      child.stdin.on("error", fail);
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure) {
          reject(failure);
          return;
        }
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        if (code !== 0) {
          reject(
            new GitCommandError(
              `Git command failed with exit code ${code ?? "unknown"}.`,
              code ?? undefined,
              stderrBuffer.toString("utf8"),
            ),
          );
          return;
        }
        resolve({ stdout: stdoutBuffer, stderr: stderrBuffer });
      });

      if (timeoutMs !== null) {
        timer = setTimeout(
          () => fail(new GitCommandError(`Git command exceeded ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }
      options.signal?.addEventListener("abort", stopFromSignal, { once: true });
      if (options.signal?.aborted) stopFromSignal();
      if (!settled && !failure) {
        if (options.input) child.stdin.end(options.input);
        else child.stdin.end();
      }
    });
  }

  async text(args: readonly string[], options: GitRunOptions): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf8").trim();
  }
}

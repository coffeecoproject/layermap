import type { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { API } from "typescript/unstable/async";

type Options = NonNullable<ConstructorParameters<typeof API>[0]> & { tsserverPath: string };

// The compiler API does not reject pending requests when its transport closes.
// Observe the owned native process so an exit also settles a partial RPC response.
export async function withMapCompiler<T>(
  options: Options,
  operation: (api: API) => Promise<T>,
): Promise<T> {
  const spawned = channel("child_process");
  const candidates = new Map<ChildProcess, () => void>();
  let compiler: ChildProcess | undefined;
  let closing = false;
  let failed = false;
  let rejectFailure: (error: Error) => void = () => {};
  let resolveClosed: () => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const fail = (error: Error) => {
    failed = true;
    rejectFailure(error);
  };
  const onError = (error: Error) => fail(error);
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!closing || !compiler?.stdin?.writableEnded || code !== 0 || signal !== null)
      fail(new Error("PROJECT_MAP_ANALYSIS_FAILED"));
    resolveClosed();
  };
  const observe = (message: unknown) => {
    const child = (message as { process: ChildProcess }).process;
    const onSpawn = () => {
      candidates.delete(child);
      if (child.spawnfile !== options.tsserverPath) return;
      compiler = child;
      child.once("error", onError);
      child.once("close", onClose);
    };
    // The diagnostic is emitted by the constructor, before spawnfile is assigned.
    candidates.set(child, onSpawn);
    child.once("spawn", onSpawn);
  };
  spawned.subscribe(observe);
  const api = new API(options);
  try {
    return await Promise.race([
      (async () => {
        try {
          return await operation(api);
        } finally {
          // A dead compiler can leave snapshot disposal pending. Report that failure
          // immediately; the parent then stops the worker and its entire process group.
          if (!failed) {
            closing = true;
            await api.close();
            if (compiler) await closed;
          }
        }
      })(),
      failure,
    ]);
  } finally {
    spawned.unsubscribe(observe);
    for (const [child, listener] of candidates) child.off("spawn", listener);
    compiler?.off("error", onError);
    compiler?.off("close", onClose);
  }
}

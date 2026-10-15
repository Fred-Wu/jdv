import { connect } from "node:net";

const CLEANUP_ATTEMPTS = 20;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

// Bound retries for transient Windows sharing violations after shutdown.
// Do not retry permission errors or unrelated filesystem failures.
export async function removeCacheDirectory(
  path: string,
  os: string = Deno.build.os,
  remove = () => Deno.remove(path, { recursive: true }),
  wait = pause,
): Promise<void> {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    try {
      await remove();
      return;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      if (
        os !== "windows" || !(error instanceof Error) ||
        !/\bos error 32\b/.test(error.message) ||
        attempt === CLEANUP_ATTEMPTS - 1
      ) throw error;
      await wait();
    }
  }
}

export async function assertServerReleased(server: {
  socketPath: string;
  discoveryPath: string;
}): Promise<void> {
  await assertMissing(server.discoveryPath);
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    if (await listenerClosed(server.socketPath)) {
      if (server.socketPath.startsWith("unix://")) {
        await assertMissing(server.socketPath.slice("unix://".length));
      }
      return;
    }
    if (attempt < CLEANUP_ATTEMPTS - 1) await pause();
  }
  throw new Error(
    `R listener still accepts connections after shutdown: ${server.socketPath}`,
  );
}

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`Server shutdown left its file behind: ${path}`);
}

function listenerClosed(address: string): Promise<boolean> {
  const pipePrefix = "npipe:////./pipe/";
  const options = address.startsWith(pipePrefix)
    ? { path: `\\\\.\\pipe\\${address.slice(pipePrefix.length)}` }
    : address.startsWith("unix://")
    ? { path: address.slice("unix://".length) }
    : { host: new URL(address).hostname, port: Number(new URL(address).port) };
  return new Promise((resolve, reject) => {
    const socket = connect(options);
    let result: boolean | Error = new Error(
      `R listener probe closed without a result: ${address}`,
    );
    const timer = setTimeout(() => {
      result = new Error(
        `Timed out probing the stopped R listener: ${address}`,
      );
      socket.destroy();
    }, 250);
    socket.once("connect", () => {
      result = false;
      socket.destroy();
    });
    socket.once("error", (error: Error & { code?: string }) => {
      result = error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? true
        : error;
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });
}

export async function stopRChild(
  child: Pick<Deno.ChildProcess, "kill" | "status">,
  exited: boolean,
  timeoutMs = 5_000,
): Promise<void> {
  let killError: unknown;
  let killFailed = false;
  if (!exited) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      killFailed = true;
      killError = error;
    }
  }
  try {
    await cleanupDeadline(
      child.status,
      timeoutMs,
      "R did not exit during integration cleanup.",
    );
  } catch (error) {
    if (killFailed) {
      throw new AggregateError(
        [killError, error],
        "R termination and exit confirmation failed.",
        { cause: killError },
      );
    }
    throw error;
  }
  // A failed kill is benign only when exit is confirmed and the error denotes an exit race.
  if (
    killFailed && !(killError instanceof Deno.errors.NotFound) &&
    !(killError instanceof TypeError &&
      /already (terminated|exited)/i.test(killError.message))
  ) {
    throw killError;
  }
}

export async function finishIntegrationCleanup(
  steps: Array<() => unknown | Promise<unknown>>,
  original: unknown[] = [],
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(
      [...original, ...errors],
      "Integration cleanup failed.",
      original.length ? { cause: original[0] } : undefined,
    );
  }
}

export async function cleanupDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

function exitRace(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound ||
    (error instanceof TypeError &&
      /already (terminated|exited)/i.test(error.message));
}

class CleanupTimeout extends Error {
  override name = "IntegrationCleanupTimeout";
}

export async function stopRChild(
  child: Pick<Deno.ChildProcess, "kill" | "status">,
  exited: boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const killErrors: unknown[] = [];
  if (!exited) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      killErrors.push(error);
    }
  }
  try {
    await cleanupDeadline(
      child.status,
      timeoutMs,
      "R did not exit during integration cleanup.",
    );
  } catch (error) {
    if (!(error instanceof CleanupTimeout)) {
      if (killErrors.length) {
        throw new AggregateError(
          [...killErrors, error],
          "R termination and exit confirmation failed.",
          { cause: error },
        );
      }
      throw error;
    }
    // Do not proceed from an unconfirmed soft shutdown without attempting a hard stop.
    try {
      child.kill("SIGKILL");
    } catch (killError) {
      killErrors.push(killError);
    }
    try {
      await cleanupDeadline(
        child.status,
        timeoutMs,
        "R did not exit after SIGKILL during integration cleanup.",
      );
    } catch (hardError) {
      throw new AggregateError(
        [...killErrors, error, hardError],
        "R remained unconfirmed after forced termination.",
        { cause: error },
      );
    }
  }
  // Exit-race errors are benign only after exit is confirmed; retain all other errors.
  const unexpected = killErrors.filter((error) => !exitRace(error));
  if (unexpected.length === 1) throw unexpected[0];
  if (unexpected.length > 1) {
    throw new AggregateError(unexpected, "R termination reported errors.", {
      cause: unexpected[0],
    });
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
        timer = setTimeout(
          () => reject(new CleanupTimeout(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Keep unread lines across calls and normalize only the CRLF line terminator.
export class ProcessLines {
  #decoder = new TextDecoder();
  #buffer = "";
  #done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0 || this.#done) {
        if (newline < 0 && !this.#buffer) return undefined;
        const line = newline < 0
          ? this.#buffer
          : this.#buffer.slice(0, newline);
        this.#buffer = newline < 0 ? "" : this.#buffer.slice(newline + 1);
        return line.replace(/\r$/, "");
      }
      const result = await cleanupDeadline(
        this.reader.read(),
        Math.max(1, deadline - Date.now()),
        "Timed out reading fixture stdout.",
      );
      this.#done = result.done;
      this.#buffer += this.#decoder.decode(result.value, {
        stream: !result.done,
      });
      if (this.#buffer.length > 64 * 1024) {
        throw new Error("Fixture stdout line exceeds 64 KiB.");
      }
    }
  }
}

export function pathWithin(
  path: string,
  parent: string,
  os = Deno.build.os,
): boolean {
  const normalize = (value: string) => {
    const slashes = (os === "windows" ? value.replace(/\\/g, "/") : value)
      .replace(/\/+$/, "");
    return os === "windows" ? slashes.toLowerCase() : slashes;
  };
  const candidate = normalize(path);
  const base = normalize(parent);
  return candidate === base || candidate.startsWith(`${base}/`);
}

export function fixturePid(value: string): number {
  const pid = Number(value);
  if (
    !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid) ||
    pid === Deno.pid
  ) {
    throw new Error(`Invalid owned R fixture PID: ${JSON.stringify(value)}`);
  }
  return pid;
}

export async function finishRFixture(
  child: Pick<Deno.ChildProcess, "pid" | "kill" | "status">,
  donePath: string,
  stderr: Promise<string>,
  pid?: number,
): Promise<void> {
  // Run later cleanup even if the graceful marker cannot be written.
  const failures: unknown[] = [];
  await finishIntegrationCleanup([
    () => Deno.writeTextFile(donePath, "done\n"),
    async () => {
      try {
        const status = await cleanupDeadline(
          child.status,
          5_000,
          "R graceful shutdown timed out.",
        );
        if (!status.success) {
          throw new Error(
            `R fixture exited unsuccessfully: ${JSON.stringify(status)}`,
          );
        }
      } catch (error) {
        if (!(error instanceof CleanupTimeout)) throw error;
        await stopRChild(child, false);
        // A fixture that needs termination did not complete its normal shutdown.
        throw error;
      }
    },
  ]).catch((error) => {
    failures.push(error);
  });
  await finishIntegrationCleanup([async () => {
    try {
      const output = await cleanupDeadline(
        stderr,
        5_000,
        "R stderr EOF timed out.",
      );
      if (output) console.log(`[R fixture stderr] ${output}`);
    } catch (error) {
      if (
        !(error instanceof CleanupTimeout) || Deno.build.os !== "windows" ||
        pid === undefined
      ) throw error;
      fixturePid(String(pid));
      console.error(
        `[cleanup] launcher ${child.pid} exited but R ${pid} still holds stderr; reclaiming owned process tree`,
      );
      const killer = new Deno.Command("taskkill", {
        args: ["/PID", String(pid), "/T", "/F"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let result: Deno.CommandOutput;
      try {
        result = await cleanupDeadline(
          killer.output(),
          5_000,
          "Owned R process tree termination timed out.",
        );
      } catch (killError) {
        await finishIntegrationCleanup([
          () => stopRChild(killer, false, 1_000),
        ], [error, killError]);
        throw new AggregateError(
          [error, killError],
          "Owned R process tree termination failed.",
          { cause: error },
        );
      }
      if (!result.success) {
        throw new AggregateError(
          [error, new Error(new TextDecoder().decode(result.stderr))],
          "Owned R process tree termination failed.",
          { cause: error },
        );
      }
      await cleanupDeadline(
        stderr,
        5_000,
        "R stderr remained open after process tree termination.",
      );
      // Retain the leak evidence even if forced recovery released the file handles.
      throw error;
    }
  }], failures);
  if (failures.length) throw failures[0];
}

export type ShutdownState = { requested: boolean };
export async function* fixtureFrames(
  connection: Pick<Deno.Conn, "read">,
  shutdown: ShutdownState,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const chunk = new Uint8Array(8192);
  let buffered = "";
  try {
    while (true) {
      const size = await connection.read(chunk);
      if (size === null) {
        if (!shutdown.requested) {
          throw new Error("Mock R connection ended before explicit shutdown.");
        }
        return;
      }
      buffered += decoder.decode(chunk.subarray(0, size), { stream: true });
      if (buffered.length > 10 * 1024 * 1024) {
        throw new Error("Mock R JSONL frame exceeds 10 MiB.");
      }
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
      }
    }
  } catch (error) {
    if (
      shutdown.requested &&
      (error instanceof Deno.errors.BadResource ||
        error instanceof Deno.errors.Interrupted)
    ) return;
    throw error;
  }
}

/** Test-only control for a real arf headless R session. */
import { dirname, resolve } from "node:path";

export interface ArfEvalResult {
  stdout: string | null;
  stderr: string | null;
  value: string | null;
  error: string | null;
}

export interface ArfEvalHandle {
  /** Resolves when R has finished evaluating the submitted expression. */
  result: Promise<ArfEvalResult>;
  wait(timeoutMs?: number): Promise<ArfEvalResult>;
  waitForOutput(
    predicate: (text: string) => boolean,
    timeoutMs?: number,
  ): Promise<string>;
}

export interface ArfSessionOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

const decoder = new TextDecoder();

export class ArfSession {
  #process?: Deno.ChildProcess;
  #pid?: number;
  #ipcDirectory?: string;
  #ipcSocket?: string;
  #logFile?: string;
  #stdoutReader?: ReadableStreamDefaultReader<Uint8Array>;
  #stdoutDrain?: Promise<void>;
  #environment?: Record<string, string>;
  #closePromise?: Promise<void>;
  #evalProcesses = new Set<Deno.ChildProcess>();

  /** Wait for a marker created by an evaluation that is still running. */
  async waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
    const target = resolve(path);
    if (await fileExists(target)) return;
    const watcher = Deno.watchFs(dirname(target));
    try {
      if (await fileExists(target)) return;
      await withTimeout(
        (async () => {
          for await (const event of watcher) {
            if (event.paths.some((entry) => resolve(entry) === target)) {
              if (await fileExists(target)) return;
            }
          }
          throw new Error(
            "Filesystem watcher closed before the marker appeared.",
          );
        })(),
        timeoutMs,
        `R marker file did not appear within ${timeoutMs} ms.`,
      );
    } finally {
      watcher.close();
    }
  }

  async start(options: ArfSessionOptions = {}): Promise<void> {
    if (this.#process || this.#closePromise) {
      throw new Error("ArfSession is already started or has been closed.");
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    this.#environment = options.env;
    const ipcDirectory = await Deno.makeTempDir({ prefix: "jdv-arf-" });
    this.#ipcDirectory = ipcDirectory;
    this.#ipcSocket = `${ipcDirectory}/arf.sock`;
    this.#logFile = `${ipcDirectory}/arf.log`;

    let process: Deno.ChildProcess | undefined;
    try {
      process = new Deno.Command("arf", {
        args: [
          "headless",
          "--json",
          "--ipc-bind",
          this.#ipcSocket,
          "--ipc-eval-unrestricted",
          "--vanilla",
          "--no-history",
          "--no-environ",
          "--no-site-file",
          "--no-init-file",
          "--log-file",
          this.#logFile,
        ],
        env: options.env,
        stdout: "piped",
        stderr: "null",
      }).spawn();
      this.#process = process;
      this.#stdoutReader = process.stdout.getReader();
      const ready = await withTimeout(
        this.#readReady(process),
        timeoutMs,
        `arf headless did not start within ${timeoutMs} ms.`,
      );
      this.#pid = ready.pid;
      this.#stdoutDrain = this.#drainStdout();
    } catch (error) {
      await this.#cleanupProcess(process);
      this.#process = undefined;
      this.#pid = undefined;
      await this.#removePrivateFiles();
      throw error;
    }
  }

  /** Submit an evaluation without waiting for R to return to its prompt. */
  send(code: string, options: { timeoutMs?: number } = {}): ArfEvalHandle {
    if (!this.#pid) throw new Error("ArfSession has not started.");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const result = this.#runEval(code, timeoutMs);
    return {
      result,
      wait: (waitTimeoutMs = timeoutMs + 2_000) =>
        withTimeout(
          result,
          waitTimeoutMs,
          `R evaluation did not finish within ${waitTimeoutMs} ms.`,
        ),
      // IPC output is available only after the expression finishes; use a
      // marker file and waitForFile() to observe the start of a long expression.
      waitForOutput: async (predicate, waitTimeoutMs = timeoutMs + 2_000) => {
        const evaluated = await withTimeout(
          result,
          waitTimeoutMs,
          `R evaluation did not finish within ${waitTimeoutMs} ms.`,
        );
        const output = [
          evaluated.stdout,
          evaluated.stderr,
          evaluated.value,
          evaluated.error,
        ].filter((part): part is string => part !== null).join("\n");
        if (!predicate(output)) {
          throw new Error(`R evaluation output did not match: ${output}`);
        }
        return output;
      },
    };
  }

  async eval(
    code: string,
    timeoutMs = 30_000,
  ): Promise<ArfEvalResult> {
    const result = await this.send(code, { timeoutMs }).wait(timeoutMs + 2_000);
    if (result.error !== null) {
      throw new Error(`R eval failed: ${result.error}`);
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closePromise = this.#closeSession();
    return await this.#closePromise;
  }

  async #closeSession(): Promise<void> {
    const process = this.#process;
    const pid = this.#pid;
    this.#process = undefined;
    this.#pid = undefined;

    if (process && pid !== undefined) {
      try {
        const shutdown = new Deno.Command("arf", {
          args: ["ipc", "shutdown", "--pid", String(pid)],
          env: this.#environment,
          stdout: "null",
          stderr: "null",
        }).spawn();
        try {
          await withTimeout(
            shutdown.status,
            5_000,
            "arf IPC shutdown timed out.",
          );
        } catch {
          try {
            shutdown.kill("SIGKILL");
          } catch {
            // The shutdown helper may already have exited.
          }
          await shutdown.status.catch(() => undefined);
          throw new Error("arf IPC shutdown could not be completed.");
        }
      } catch {
        try {
          process.kill("SIGKILL");
        } catch {
          // R may already have exited.
        }
      }
      try {
        await withTimeout(
          process.status,
          5_000,
          "R process did not exit.",
        );
      } catch {
        try {
          process.kill("SIGKILL");
        } catch {
          // R may already have exited.
        }
        await process.status.catch(() => undefined);
      }
      await Promise.all([...this.#evalProcesses].map(async (child) => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The IPC eval command may already have exited.
        }
        await child.status.catch(() => undefined);
      }));
    } else if (process) {
      await this.#cleanupProcess(process);
    }

    try {
      await this.#stdoutReader?.cancel();
    } catch {
      // The stream may already be closed.
    }
    await this.#stdoutDrain?.catch(() => undefined);
    this.#stdoutDrain = undefined;
    this.#stdoutReader = undefined;
    await this.#removePrivateFiles();
  }

  shutdown(): Promise<void> {
    return this.close();
  }

  async #runEval(code: string, timeoutMs: number): Promise<ArfEvalResult> {
    const pid = this.#pid;
    if (!pid) throw new Error("ArfSession has not started.");
    const command = new Deno.Command("arf", {
      args: [
        "ipc",
        "eval",
        "--pid",
        String(pid),
        "--timeout",
        String(timeoutMs),
        code,
      ],
      env: this.#environment,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#evalProcesses.add(command);
    try {
      const output = await withTimeout(
        command.output(),
        timeoutMs + 2_000,
        `arf ipc eval exceeded ${timeoutMs + 2_000} ms.`,
        () => {
          try {
            command.kill("SIGKILL");
          } catch {
            // The IPC process may already have exited.
          }
        },
      );
      if (!output.success) {
        const error = new Error(
          `arf ipc eval exited with ${output.code}: ${
            decoder.decode(output.stderr)
          }`,
        );
        await this.close();
        throw error;
      }
      return JSON.parse(decoder.decode(output.stdout)) as ArfEvalResult;
    } catch (error) {
      if (!this.#closePromise) await this.close();
      throw error;
    } finally {
      this.#evalProcesses.delete(command);
      await command.status.catch(() => undefined);
    }
  }

  async #readReady(
    process: Deno.ChildProcess,
  ): Promise<{ pid: number }> {
    const reader = this.#stdoutReader;
    if (!reader) throw new Error("arf stdout is unavailable.");
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        const status = await process.status;
        throw new Error(`arf exited before ready (exit ${status.code}).`);
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let ready: { pid?: unknown };
        try {
          ready = JSON.parse(line) as { pid?: unknown };
        } catch (error) {
          throw new Error(`Invalid arf ready JSON: ${line}`, { cause: error });
        }
        if (!Number.isSafeInteger(ready.pid) || Number(ready.pid) <= 0) {
          throw new Error(`arf ready JSON has no valid pid: ${line}`);
        }
        return { pid: Number(ready.pid) };
      }
    }
  }

  async #drainStdout(): Promise<void> {
    const reader = this.#stdoutReader;
    if (!reader) return;
    try {
      while (!(await reader.read()).done) {
        // Keep the headless stdout pipe flowing for the full session lifetime.
      }
    } catch {
      // Shutdown closes the pipe.
    }
  }

  async #cleanupProcess(process?: Deno.ChildProcess): Promise<void> {
    if (!process) return;
    try {
      process.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
    await process.status.catch(() => undefined);
    try {
      await this.#stdoutReader?.cancel();
    } catch {
      // The stream may already be closed.
    }
    await this.#stdoutDrain?.catch(() => undefined);
    this.#stdoutDrain = undefined;
    this.#stdoutReader = undefined;
  }

  async #removePrivateFiles(): Promise<void> {
    const directory = this.#ipcDirectory;
    this.#ipcDirectory = undefined;
    this.#ipcSocket = undefined;
    this.#logFile = undefined;
    if (directory) {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let rejectTimeout!: (reason: Error) => void;
  const timeout = new Promise<never>((_, reject) => rejectTimeout = reject);
  const timer = setTimeout(() => {
    onTimeout?.();
    rejectTimeout(new Error(message));
  }, timeoutMs);
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

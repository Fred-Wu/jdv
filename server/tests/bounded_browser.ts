import {
  type Browser,
  connect,
  generateBinArgs,
  getBinary,
} from "@astral/astral";
import {
  cleanupDeadline,
  finishIntegrationCleanup,
  removeCacheDirectory,
  stopRChild,
} from "./integration_cleanup.ts";

export async function phase<T>(
  name: string,
  operation: () => Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  console.log(`[browser phase] ${name}: start`);
  try {
    const value = await cleanupDeadline(
      operation(),
      timeoutMs,
      `Browser phase timed out: ${name}`,
    );
    console.log(`[browser phase] ${name}: complete`);
    return value;
  } catch (error) {
    console.error(`[browser phase] ${name}: failed`, error);
    throw error;
  }
}

/**
 * Record an overall body deadline without canceling the body. Wait for body
 * settlement before returning the failure so its resources can be cleaned up.
 * A runner's hard job timeout remains an independent outer bound.
 */
export async function bodyDeadline<T>(
  name: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const body = Promise.resolve().then(operation).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"elapsed">((resolve) => {
    timer = setTimeout(() => resolve("elapsed"), timeoutMs);
  });
  const first = await Promise.race([body, deadline]);
  if (first !== "elapsed") {
    if (timer !== undefined) clearTimeout(timer);
    if (first.ok) return first.value;
    throw first.error;
  }

  const deadlineError = new Error(
    `Test body deadline elapsed: ${name} exceeded ${timeoutMs} ms; ` +
      "waiting for the body to settle before cleanup.",
  );
  console.error(`[browser body] ${name}: deadline elapsed; waiting to settle`);
  const settled = await body;
  if (timer !== undefined) clearTimeout(timer);
  if (settled.ok) throw deadlineError;
  throw new AggregateError(
    [deadlineError, settled.error],
    `Test body failed after its deadline: ${name}`,
    { cause: deadlineError },
  );
}

export async function closeBrowserProcess(
  close: () => Promise<unknown>,
  process: {
    exitCode: number | null;
    signalCode: string | null;
    once(event: "exit", listener: () => void): unknown;
    kill(signal: "SIGKILL"): boolean;
  },
  timeoutMs = 5_000,
  force?: () => Promise<unknown>,
): Promise<void> {
  const exited = process.exitCode !== null || process.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => process.once("exit", () => resolve()));
  const errors: unknown[] = [];
  try {
    await cleanupDeadline(
      close(),
      timeoutMs,
      "Browser graceful shutdown timed out.",
    );
    await cleanupDeadline(
      exited,
      timeoutMs,
      "Browser process did not exit after shutdown.",
    );
    return;
  } catch (error) {
    errors.push(error);
  }
  if (force && process.exitCode === null && process.signalCode === null) {
    try {
      await cleanupDeadline(
        force(),
        timeoutMs,
        "Browser forced shutdown timed out.",
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (process.exitCode === null && process.signalCode === null) {
    try {
      process.kill("SIGKILL");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await cleanupDeadline(
      exited,
      timeoutMs,
      "Browser process remained alive after SIGKILL.",
    );
  } catch (error) {
    errors.push(error);
  }
  throw new AggregateError(
    errors,
    "Browser shutdown required forced recovery.",
    { cause: errors[0] },
  );
}

export async function finishOwnedBrowserProcess(
  child: Pick<Deno.ChildProcess, "kill" | "status">,
  hasExited: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const elapsed = Symbol("browser exit grace period elapsed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Deno.CommandStatus | typeof elapsed;
  try {
    result = await Promise.race([
      child.status,
      new Promise<typeof elapsed>((resolve) => {
        timer = setTimeout(() => resolve(elapsed), timeoutMs);
      }),
    ]);
  } catch (error) {
    await finishIntegrationCleanup([
      () => stopRChild(child, hasExited(), timeoutMs),
    ], [error]);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (result !== elapsed) return;
  // Browser.close acknowledges the request before every owned process exits.
  // Termination is part of teardown; only confirmed recovery completes cleanup.
  console.log(
    "[browser process recovery] grace period elapsed; terminating owned process",
  );
  await stopRChild(child, hasExited(), timeoutMs);
  const status = await child.status;
  console.log(
    `[browser process recovery] exit confirmed: code=${status.code}; signal=${status.signal}`,
  );
}

export class BrowserEndpointParser {
  #decoder = new TextDecoder();
  #buffer = "";
  push(bytes: Uint8Array): string | undefined {
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    if (this.#buffer.length > 65_536) {
      throw new Error("Browser stderr line exceeds 64 KiB.");
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return undefined;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      const endpoint = line.match(/DevTools listening on (ws:\/\/[^\s]+)$/)
        ?.[1];
      if (!endpoint) continue;
      const url = new URL(endpoint);
      if (
        url.protocol !== "ws:" || !url.host ||
        !url.pathname.startsWith("/devtools/browser/") ||
        url.pathname === "/devtools/browser/"
      ) {
        throw new Error(`Invalid browser endpoint: ${endpoint}`);
      }
      return endpoint;
    }
  }
}

export async function reclaimLateResult<T>(
  pending: Promise<T>,
  expired: () => boolean,
  dispose: (value: T) => Promise<void>,
): Promise<void> {
  const value = await pending;
  if (expired()) await dispose(value);
}

async function closeBindings(browser: Browser): Promise<void> {
  await Promise.all([
    ...browser.pages.map((page) => page.unsafelyGetCelestialBindings().close()),
    browser.unsafelyGetCelestialBindings().close(),
  ]);
}

export async function resolveBrowserBinary(
  path: string | undefined,
  acquire: () => Promise<string> = () => getBinary("chrome"),
  githubActions = Deno.env.get("GITHUB_ACTIONS") === "true",
): Promise<string> {
  if (path) {
    console.log(
      `[browser binary] existing executable: ${path}; acquisition skipped`,
    );
    return path;
  }
  if (!githubActions) {
    throw new Error(
      "Local browser tests require JDV_TEST_BROWSER or options.path; browser downloads are disabled locally.",
    );
  }
  return await phase("browser binary acquisition", acquire, 300_000);
}

export async function launchOwnedBrowser(
  options: { path?: string; args?: string[]; env?: Record<string, string> } =
    {},
) {
  const path = await resolveBrowserBinary(
    options.path ?? Deno.env.get("JDV_TEST_BROWSER"),
  );
  const profile = await Deno.makeTempDir({ prefix: "jdv-astral-profile-" });
  console.log(`[browser profile] ${profile}`);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(path, {
      args: generateBinArgs("chrome", {
        headless: true,
        args: [...(options.args ?? []), `--user-data-dir=${profile}`],
      }),
      env: options.env,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    await finishIntegrationCleanup([() => removeCacheDirectory(profile)], [
      error,
    ]);
    throw error;
  }
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let diagnostics = "";
  let exited = false;
  let closing = false;
  void child.status.then((status) => {
    exited = true;
    console.log(`[browser process exit] pid=${child.pid}; code=${status.code}`);
  });
  let browser: Browser | undefined;
  let drain: Promise<void> | undefined;
  const record = (value: Uint8Array) => {
    diagnostics = (diagnostics + decoder.decode(value, { stream: true })).slice(
      -16_384,
    );
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    await finishIntegrationCleanup([
      () =>
        browser
          ? phase(
            "browser CDP shutdown",
            () => browser!.unsafelyGetCelestialBindings().Browser.close(),
            5_000,
          )
          : undefined,
      () =>
        browser
          ? phase(
            "browser bindings shutdown",
            () => closeBindings(browser!),
            5_000,
          )
          : undefined,
      () =>
        phase(
          "browser process shutdown",
          () => finishOwnedBrowserProcess(child, () => exited),
          16_000,
        ),
      () =>
        cleanupDeadline(
          reader.cancel(),
          5_000,
          "Browser stderr cancellation timed out.",
        ),
      () =>
        drain
          ? cleanupDeadline(
            drain,
            5_000,
            "Browser stderr drain did not finish.",
          )
          : undefined,
      () => reader.releaseLock(),
      () =>
        cleanupDeadline(
          removeCacheDirectory(profile),
          2_500,
          "Browser profile cleanup timed out.",
        ),
    ]);
  };
  try {
    const endpointParser = new BrowserEndpointParser();
    const endpoint = await phase("browser endpoint", async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          throw new Error(`Browser exited before its endpoint: ${diagnostics}`);
        }
        record(next.value);
        const endpoint = endpointParser.push(next.value);
        if (endpoint) return endpoint;
      }
    }, 20_000);
    drain = (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          record(next.value);
        }
      } catch (error) {
        if (
          closing &&
          (error instanceof Deno.errors.BadResource ||
            error instanceof Deno.errors.Interrupted)
        ) return;
        throw error;
      }
    })();
    void drain.catch((error) => console.error("[browser stderr]", error));
    const connecting = connect({ endpoint });
    void reclaimLateResult(
      connecting,
      () => closing,
      (late) =>
        cleanupDeadline(
          closeBindings(late),
          5_000,
          "Late browser bindings did not close.",
        ),
    )
      .catch((error) => console.error("[browser late connection]", error));
    browser = await phase("browser connect", () => connecting, 20_000);
    console.log(
      `[browser version] ${await phase(
        "browser version",
        () => browser!.version(),
      )}`,
    );
    return { browser, close };
  } catch (error) {
    console.error(`[browser diagnostics] ${diagnostics}`);
    await finishIntegrationCleanup([close], [error]);
    throw error;
  }
}

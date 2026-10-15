// Match the pinned browser runtime used by the smoke tests.
// deno-lint-ignore no-import-prefix
import type { BrowserType, LaunchOptions } from "npm:playwright@1.56.1";
import {
  cleanupDeadline,
  finishIntegrationCleanup,
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

export async function launchOwnedBrowser(
  chromium: BrowserType,
  options: LaunchOptions,
) {
  // Playwright owns launch failures; launchServer also gives us the successful child handle.
  let expired = false;
  const launching = chromium.launchServer({ ...options, timeout: 30_000 });
  void launching.then(async (server) => {
    if (expired) {
      await closeBrowserProcess(
        () => server.close(),
        server.process(),
        5_000,
        () => server.kill(),
      );
    }
  }).catch((error) => console.error("[browser late launch cleanup]", error));
  let server;
  try {
    server = await phase("launch", () => launching, 35_000);
  } catch (error) {
    expired = true;
    throw error;
  }
  try {
    const browser = await phase(
      "connect",
      () => chromium.connect(server.wsEndpoint(), { timeout: 15_000 }),
    );
    return {
      browser,
      async close() {
        await finishIntegrationCleanup([
          () => phase("browser disconnect", () => browser.close(), 5_000),
          () =>
            phase(
              "browser process shutdown",
              () =>
                closeBrowserProcess(
                  () => server.close(),
                  server.process(),
                  5_000,
                  () => server.kill(),
                ),
              21_000,
            ),
        ]);
      },
    };
  } catch (error) {
    await finishIntegrationCleanup([
      () =>
        closeBrowserProcess(
          () => server.close(),
          server.process(),
          5_000,
          () => server.kill(),
        ),
    ], [error]);
    throw error;
  }
}

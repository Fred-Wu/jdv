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

import { assertEquals } from "./assert.ts";
import {
  finishIntegrationCleanup,
  removeCacheDirectory,
  stopRChild,
} from "./integration_cleanup.ts";

Deno.test("cache cleanup retries only transient Windows sharing violations", async () => {
  const sharing = new Error("The process cannot access the file (os error 32)");
  let attempts = 0;
  let waits = 0;
  await removeCacheDirectory("unused", "windows", () => {
    if (++attempts < 3) return Promise.reject(sharing);
    return Promise.resolve();
  }, () => {
    waits++;
    return Promise.resolve();
  });
  assertEquals(attempts, 3);
  assertEquals(waits, 2);
  for (
    const [os, error, expectedAttempts] of [
      ["windows", sharing, 20],
      ["linux", sharing, 1],
      ["windows", new Error("Access denied (os error 5)"), 1],
    ] as const
  ) {
    let calls = 0;
    let thrown: unknown;
    try {
      await removeCacheDirectory("unused", os, () => {
        calls++;
        return Promise.reject(error);
      }, () => Promise.resolve());
    } catch (caught) {
      thrown = caught;
    }
    assertEquals(thrown === error, true);
    assertEquals(calls, expectedAttempts);
  }
});

Deno.test("integration cleanup confirms exit races and retains other termination errors", async () => {
  const status = Promise.resolve({ code: 0, success: true, signal: null });
  for (
    const error of [
      new TypeError("Child process has already terminated"),
      new Deno.errors.NotFound("No such process"),
    ]
  ) {
    await stopRChild({
      status,
      kill() {
        throw error;
      },
    }, false);
  }
  const denied = new Error("Permission denied");
  let caught: unknown;
  try {
    await stopRChild({
      status,
      kill() {
        throw denied;
      },
    }, false);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught === denied, true);
});

Deno.test("cleanup continues after a failure and preserves the original error", async () => {
  const original = new Error("Original assertion failed");
  const cancel = new Error("Reader cancellation failed");
  const visited: string[] = [];
  let caught: unknown;
  try {
    await finishIntegrationCleanup([
      () => {
        visited.push("reader");
        throw cancel;
      },
      () => {
        visited.push("server");
      },
      () => {
        visited.push("cache");
      },
    ], [original]);
  } catch (error) {
    caught = error;
  }
  assertEquals(visited, ["reader", "server", "cache"]);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) {
    assertEquals(caught.errors[0] === original, true);
    assertEquals(caught.errors[1] === cancel, true);
    assertEquals(caught.cause === original, true);
  }
  visited.length = 0;
  caught = undefined;
  try {
    await finishIntegrationCleanup([
      () => stopRChild({ status: new Promise(() => {}), kill() {} }, false, 1),
      () => {
        visited.push("cache");
      },
    ]);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof AggregateError, true);
  assertEquals(visited, ["cache"]);
});

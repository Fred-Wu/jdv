import { assert } from "./assert.ts";
import { join, resolve } from "node:path";
import { removeCacheDirectory } from "./integration_cleanup.ts";
import {
  combineArfCleanupError,
  observeArfEvaluation,
  waitForMarkerFile,
} from "./helpers/arf_session.ts";

Deno.test("arf cleanup failures retain the primary evaluation error", () => {
  const primary = new Error("ipc evaluation failed");
  const cleanup = new Error("arf shutdown failed");
  const combined = combineArfCleanupError(
    primary,
    cleanup,
    "evaluation and cleanup failed",
  );
  assert(
    combined.cause === primary,
    "The primary error was not retained as cause.",
  );
  assert(
    combined.errors[0] === primary && combined.errors[1] === cleanup,
    "The primary and cleanup errors were not both retained.",
  );
});

Deno.test("observing an evaluation keeps its original rejection available", async () => {
  const expected = new Error("deferred evaluation failure");
  let observed: unknown;
  const original = Promise.reject<number>(expected);
  const result = observeArfEvaluation(original, (outcome) => {
    if (outcome.state === "rejected") observed = outcome.error;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  const actual = await result.then(
    () => null,
    (error: unknown) => error,
  );
  assert(
    actual === expected,
    "The observer replaced or swallowed the rejection.",
  );
  assert(
    observed === expected,
    "The observer did not retain the rejection detail.",
  );
});

Deno.test("marker wait handles canonical watcher paths and requested aliases", async () => {
  const root = await Deno.makeTempDir({ prefix: "jdv-marker-alias-" });
  const realDirectory = join(root, "real");
  const requestedDirectory = join(root, "requested");
  await Deno.mkdir(realDirectory);
  const canonicalDirectory = await Deno.realPath(realDirectory);
  let watcher: Deno.FsWatcher | undefined;
  let controller: AbortController | undefined;
  let waitingOutcome:
    | Promise<
      | { ok: true }
      | { ok: false; error: unknown }
    >
    | undefined;
  try {
    let target: string;
    if (Deno.build.os === "windows") {
      target = join(realDirectory, "entered");
    } else {
      await Deno.symlink(realDirectory, requestedDirectory, { type: "dir" });
      target = join(requestedDirectory, "entered");
      watcher = Deno.watchFs(canonicalDirectory);
    }

    controller = new AbortController();
    const waiting = waitForMarkerFile(target, 3_000, controller.signal);
    waitingOutcome = waiting.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    await Deno.writeTextFile(target, "ready");

    if (watcher) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let event: IteratorResult<Deno.FsEvent>;
      try {
        event = await Promise.race([
          watcher[Symbol.asyncIterator]().next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Canonical marker event timed out.")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const eventPaths: string[] = event.value?.paths.map((path: string) =>
        resolve(path)
      ) ?? [];
      const canonicalTarget = join(canonicalDirectory, "entered");
      assert(
        eventPaths.some((path) =>
          path === canonicalDirectory || path === canonicalTarget
        ),
        `Expected a canonical watcher event at the watched directory or its marker, got ${
          JSON.stringify(eventPaths)
        }.`,
      );
      assert(
        resolve(target) !== canonicalTarget &&
          !eventPaths.includes(resolve(target)),
        "The test did not exercise a watcher path spelling different from the requested alias.",
      );
    }

    const outcome = await waitingOutcome;
    if (outcome?.ok !== true) {
      throw new Error(
        `The marker wait did not resolve: ${
          outcome && "error" in outcome ? String(outcome.error) : "no outcome"
        }`,
      );
    }
  } finally {
    controller?.abort();
    await waitingOutcome;
    watcher?.close();
    await removeCacheDirectory(root);
  }
});

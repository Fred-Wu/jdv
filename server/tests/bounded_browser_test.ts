import type { Page } from "@astral/astral";
import { waitFor } from "./astral_page.ts";
import { assertEquals } from "./assert.ts";
import { finishIntegrationCleanup } from "./integration_cleanup.ts";
import {
  BrowserEndpointParser,
  finishOwnedBrowserProcess,
  launchOwnedBrowser,
  reclaimLateResult,
  resolveBrowserBinary,
} from "./bounded_browser.ts";

Deno.test("an explicit existing browser path never calls binary acquisition", async () => {
  let acquisitions = 0;
  const path = "/existing/chrome";
  assertEquals(
    await resolveBrowserBinary(path, () => {
      acquisitions++;
      throw new Error("Browser acquisition is forbidden in this test.");
    }),
    path,
  );
  assertEquals(acquisitions, 0);
});

Deno.test("CI can use the supplied acquisition function once without a browser path", async () => {
  let acquisitions = 0;
  assertEquals(
    await resolveBrowserBinary(undefined, () => {
      acquisitions++;
      return Promise.resolve("/injected/browser");
    }, true),
    "/injected/browser",
  );
  assertEquals(acquisitions, 1);
});

Deno.test("local browser path omission fails without calling acquisition", async () => {
  let acquisitions = 0;
  let caught: unknown;
  try {
    await resolveBrowserBinary(undefined, () => {
      acquisitions++;
      throw new Error("Acquisition must not run locally.");
    }, false);
  } catch (error) {
    caught = error;
  }
  assertEquals(acquisitions, 0);
  assertEquals(String(caught).includes("downloads are disabled locally"), true);
});

Deno.test("a connection resolving after expiry is reclaimed exactly once", async () => {
  let finish!: (value: { id: string }) => void;
  const pending = new Promise<{ id: string }>((resolve) => {
    finish = resolve;
  });
  let expired = false;
  const closed: string[] = [];
  const recovery = reclaimLateResult(pending, () => expired, (value) => {
    closed.push(value.id);
    return Promise.resolve();
  });
  expired = true;
  finish({ id: "late" });
  await recovery;
  assertEquals(closed, ["late"]);
  await reclaimLateResult(
    Promise.resolve({ id: "active" }),
    () => false,
    () => {
      throw new Error("An active connection must remain owned by its caller.");
    },
  );
});

Deno.test("a stalled CDP predicate is bounded before its polling loop can continue", async () => {
  let calls = 0;
  const page = {
    evaluate() {
      calls++;
      return new Promise(() => {});
    },
  } as unknown as Page;
  let caught: unknown;
  try {
    await waitFor(page, () => true, undefined, { timeout: 2 });
  } catch (error) {
    caught = error;
  }
  assertEquals(calls, 1);
  assertEquals(String(caught).includes("predicate evaluation"), true);
});

Deno.test("an owned process that fails before a browser endpoint is reaped and its profile removed", async () => {
  const log = console.log;
  let profile: string | undefined;
  let exited = false;
  console.log = (...args: unknown[]) => {
    const message = String(args[0]);
    if (message.startsWith("[browser profile] ")) {
      profile = message.slice("[browser profile] ".length);
    }
    if (message.startsWith("[browser process exit] ")) exited = true;
    log(...args);
  };
  let caught: unknown;
  try {
    await launchOwnedBrowser({ path: Deno.execPath() });
  } catch (error) {
    caught = error;
  } finally {
    console.log = log;
  }
  assertEquals(
    String(caught).includes("Browser exited before its endpoint"),
    true,
  );
  assertEquals(exited, true);
  assertEquals(typeof profile, "string");
  let absent = false;
  try {
    await Deno.stat(profile!);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    absent = true;
  }
  assertEquals(absent, true);
});

Deno.test("browser endpoint parsing waits for a complete CRLF line across chunks", () => {
  const parser = new BrowserEndpointParser();
  const bytes = (text: string) => new TextEncoder().encode(text);
  assertEquals(
    parser.push(
      bytes("warning\nDevTools listening on ws://127.0.0.1:9222/devtools/bro"),
    ),
    undefined,
  );
  assertEquals(parser.push(bytes("wser/test-id\r")), undefined);
  assertEquals(
    parser.push(bytes("\nnext diagnostic")),
    "ws://127.0.0.1:9222/devtools/browser/test-id",
  );
});

Deno.test("acknowledged browser cleanup confirms a slow owned process after termination", async () => {
  let finish!: (status: Deno.CommandStatus) => void;
  const signals: string[] = [];
  const child = {
    status: new Promise<Deno.CommandStatus>((resolve) => finish = resolve),
    kill(signal?: Deno.Signal | number) {
      signals.push(String(signal));
      finish({ success: false, code: 1, signal: null });
    },
  };
  await finishOwnedBrowserProcess(child, () => false, 2);
  assertEquals(signals, ["SIGTERM"]);
});

Deno.test("browser cleanup escalates to a hard stop and requires confirmed exit", async () => {
  for (const exits of [true, false]) {
    let finish!: (status: Deno.CommandStatus) => void;
    const signals: string[] = [];
    const child = {
      status: new Promise<Deno.CommandStatus>((resolve) => finish = resolve),
      kill(signal?: Deno.Signal | number) {
        signals.push(String(signal));
        if (signal === "SIGKILL" && exits) {
          finish({ success: false, code: 137, signal: "SIGKILL" });
        }
      },
    };
    let caught: unknown;
    try {
      await finishOwnedBrowserProcess(child, () => false, 2);
    } catch (error) {
      caught = error;
    }
    assertEquals(signals, ["SIGTERM", "SIGKILL"]);
    assertEquals(caught instanceof AggregateError, !exits);
  }
});

Deno.test("browser cleanup retains unexpected termination errors after exit confirmation", async () => {
  const original = new Error("Unexpected process permission failure");
  let finish!: (status: Deno.CommandStatus) => void;
  const child = {
    status: new Promise<Deno.CommandStatus>((resolve) => finish = resolve),
    kill() {
      finish({ success: false, code: 1, signal: null });
      throw original;
    },
  };
  let caught: unknown;
  try {
    await finishOwnedBrowserProcess(child, () => false, 2);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught, original);
});

Deno.test("browser status errors are not mistaken for an elapsed exit grace period", async () => {
  const original = new Error("Unexpected status failure");
  let killed = false;
  let caught: unknown;
  try {
    await finishOwnedBrowserProcess(
      {
        status: Promise.reject(original),
        kill() {
          killed = true;
        },
      },
      () => false,
      2,
    );
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) assertEquals(caught.cause, original);
  assertEquals(killed, true);
});

Deno.test("a CDP failure stays fatal even when owned process recovery succeeds", async () => {
  const original = new Error("Unexpected CDP shutdown failure");
  let finish!: (status: Deno.CommandStatus) => void;
  let killed = false;
  const child = {
    status: new Promise<Deno.CommandStatus>((resolve) => finish = resolve),
    kill() {
      killed = true;
      finish({ success: false, code: 1, signal: null });
    },
  };
  let caught: unknown;
  try {
    await finishIntegrationCleanup([
      () => Promise.reject(original),
      () => finishOwnedBrowserProcess(child, () => false, 2),
    ]);
  } catch (error) {
    caught = error;
  }
  assertEquals(killed, true);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) assertEquals(caught.errors, [original]);
});

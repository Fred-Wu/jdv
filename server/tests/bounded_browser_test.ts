import type { Page } from "@astral/astral";
import { waitFor } from "./astral_page.ts";
import { assertEquals } from "./assert.ts";
import {
  BrowserEndpointParser,
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

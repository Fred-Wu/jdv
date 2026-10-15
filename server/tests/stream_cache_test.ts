import { assert, assertEquals } from "./assert.ts";
import {
  STREAM_CACHE_PAGE_OVERHEAD,
  StreamPageCache,
} from "../stream_cache.ts";
import { createBrowserClient, parseOptions, startServer } from "../main.ts";

const page = (first = 0, count = 2, done = false) => ({
  first_row: first,
  rows_fetched: count,
  rows_seen: first + count,
  done,
});

Deno.test("host cache owns opaque buffers and applies per-view and global FIFO", () => {
  const unit = STREAM_CACHE_PAGE_OVERHEAD + 3;
  const cache = new StreamPageCache({
    streamCacheBytes: 3 * unit,
    streamCacheViewBytes: 2 * unit,
  });
  const a = {}, b = {};
  const backing = new Uint8Array(10000).fill(9);
  const source = backing.subarray(100, 103);
  cache.record(a, page(), source);
  backing.fill(1);
  assertEquals([...cache.get(a, 0)!.body], [9, 9, 9]);
  assertEquals(cache.get(a, 0)!.body.buffer.byteLength, 3);
  cache.record(b, page(), new Uint8Array(3));
  cache.record(a, page(2), new Uint8Array(3));
  cache.record(a, page(4), new Uint8Array(3));
  assertEquals(cache.info(a).pages.map((p) => p.page), [1, 2]);
  assertEquals(cache.info(a).unavailable_before, 2);
  assertEquals(cache.info(b).pages.length, 1);
  cache.record(b, page(2), new Uint8Array(3));
  assertEquals(cache.info(b).pages.map((p) => p.page), [1]);
  assertEquals(cache.info(b).unavailable_before, 2);
  assertEquals(cache.bytes, 3 * unit);
  cache.drop(a);
  cache.drop(a);
  assertEquals(cache.bytes, unit);
  cache.clear();
  assertEquals(cache.bytes, 0);
});

Deno.test("oversized and empty pages keep bounded metadata and exact progress after eviction", () => {
  const key = {};
  const cache = new StreamPageCache({
    streamCacheBytes: 2 * STREAM_CACHE_PAGE_OVERHEAD,
    streamCacheViewBytes: 2 * STREAM_CACHE_PAGE_OVERHEAD,
  });
  for (let i = 0; i < 20; i++) cache.record(key, page(0, 0), new Uint8Array());
  assertEquals(cache.info(key).pages.map((p) => p.page), [18, 19]);
  assertEquals(cache.bytes, 2 * STREAM_CACHE_PAGE_OVERHEAD);
  cache.record(
    key,
    page(0, 7, true),
    new Uint8Array(2 * STREAM_CACHE_PAGE_OVERHEAD),
  );
  assertEquals(cache.info(key), {
    pages: [],
    next_after: null,
    last_page: 20,
    rows_seen: 7,
    done: true,
    unavailable_before: 7,
  });
  assertEquals(cache.bytes, 0);
  assertEquals(cache.get(key, 20), null);
  assertEquals(cache.record(key, page(7), new Uint8Array()), null);
  assertEquals(cache.record(key, page(7, 0, false), new Uint8Array()), null);
  const repeated = cache.record(key, page(7, 0, true), new Uint8Array());
  assertEquals(repeated?.page, 21);
  assertEquals(cache.info(key).done, true);
});

Deno.test("cache catalogs paginate empty pages and retain bounded gaps in page metadata", () => {
  const cache = new StreamPageCache();
  const key = {};
  for (let i = 0; i < 140; i++) cache.record(key, page(0, 0), new Uint8Array());
  const first = cache.info(key, -1, 128);
  assertEquals(first.pages.length, 128);
  assertEquals(first.next_after, 127);
  const second = cache.info(key, first.next_after!, 128);
  assertEquals(second.pages.length, 12);
  assertEquals(second.next_after, null);
  cache.record(key, page(10, 2), new Uint8Array());
  const metadata = cache.info(key, 139).pages[0];
  assertEquals(metadata.unavailable_before_range, [0, 10]);
  metadata.unavailable_before_range![0] = 999;
  assertEquals(cache.get(key, 140)!.metadata.unavailable_before_range, [0, 10]);
  assertEquals(cache.record(key, page(1), new Uint8Array()), null);
});

Deno.test("disabled host cache and startup byte options preserve explicit limits", () => {
  const cache = new StreamPageCache({ streamCacheBytes: 0 });
  assertEquals(cache.capability(), false);
  assertEquals(cache.record({}, page(), new Uint8Array()), null);
  const options = parseOptions([
    "--tcp",
    "--stream-cache-bytes",
    "2048",
    "--stream-cache-view-bytes",
    "1024",
  ]);
  assertEquals(options.streamCacheBytes, 2048);
  assertEquals(options.streamCacheViewBytes, 1024);
  for (const value of ["-1", "1.5", "9007199254740992", "no"]) {
    let failure: unknown;
    try {
      parseOptions(["--stream-cache-bytes", value]);
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error);
  }
});

Deno.test("invalid host cache configuration fails before creating listener resources", async () => {
  const work = await Deno.makeTempDir({ prefix: "jdv-cache-config-" });
  const cacheDir = `${work}/not-created`;
  try {
    let failure: unknown;
    try {
      await startServer({
        mode: "tcp",
        httpPort: 0,
        cacheDir,
        streamCacheBytes: -1,
      });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error);
    let created = true;
    try {
      await Deno.stat(cacheDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) created = false;
      else throw error;
    }
    assertEquals(created, false);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});

class QueuedBrowserSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sentBytes: number[] = [];
  closed: Array<number | undefined> = [];
  failSend = false;

  send(value: string | Uint8Array): void {
    if (this.failSend) throw new Error("Fixture send failure");
    this.sentBytes.push(
      typeof value === "string" ? value.length : value.byteLength,
    );
  }

  close(code?: number): void {
    this.closed.push(code);
    this.readyState = WebSocket.CLOSING;
  }
}

Deno.test("cache queue admission preserves large aggregate welcome and existing output", () => {
  const socket = new QueuedBrowserSocket();
  let detached = 0;
  const client = createBrowserClient(socket, () => detached++);
  const text = "x".repeat(9 * 1024 * 1024);
  const views = Array.from({ length: 4 }, (_, index) => ({
    method: "view/open",
    params: {
      view: `snapshot-${index}`,
      generation: 1,
      kind: "grid",
      access: "snapshot",
      encoding: "r-json",
      title: "Snapshot",
      mode: "snapshot",
      nrow: 1,
      ncol: 1,
      columns: [{ position: 0, name: "x", type: "string" }],
      data: { columns: ["x"], rows: [[text]] },
    },
  }));
  client.send({
    type: "welcome",
    protocol: 1,
    sessions: [{
      hello: { method: "hello", params: { session: "r-1" } },
      views,
    }],
  });
  assert(socket.sentBytes[0] > 32 * 1024 * 1024);
  socket.bufferedAmount = socket.sentBytes[0];
  client.send({ type: "notification", message: { method: "fixture/live" } });
  client.send({ type: "response", id: "live", result: {} });
  client.sendBinary(new Uint8Array([1, 2]));
  assertEquals(socket.sentBytes.length, 4);
  assertEquals(socket.closed, []);
  assertEquals(detached, 0);
  client.send({ type: "response", id: "cache-info", result: {} }, true);
  assertEquals(socket.sentBytes.length, 4);
  assertEquals(socket.closed, [1013]);
  assertEquals(detached, 1);
  client.send({ type: "error", id: "cache-get", code: "unavailable" }, true);
  assertEquals(socket.closed, [1013]);
  assertEquals(detached, 1);
});

Deno.test("cache binary queue admission counts the reply and all send failures detach", () => {
  const socket = new QueuedBrowserSocket();
  let detached = 0;
  const client = createBrowserClient(socket, () => detached++);
  socket.bufferedAmount = 32 * 1024 * 1024 - 2;
  client.sendBinary(new Uint8Array(2), true);
  assertEquals(socket.sentBytes, [2]);
  client.sendBinary(new Uint8Array(3), true);
  assertEquals(socket.sentBytes, [2]);
  assertEquals(socket.closed, [1013]);
  assertEquals(detached, 1);
  for (const binary of [false, true]) {
    const failing = new QueuedBrowserSocket();
    let failedDetach = 0;
    const failedClient = createBrowserClient(failing, () => failedDetach++);
    failing.failSend = true;
    if (binary) failedClient.sendBinary(new Uint8Array());
    else failedClient.send({ type: "notification" });
    assertEquals(failing.closed.length, 1);
    assertEquals(failedDetach, 1);
  }
});

import { assert } from "./assert.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface WireFrame {
  direction: "to-r" | "from-r";
  time: number;
  value: Record<string, unknown>;
}

class FrameLog {
  readonly frames: WireFrame[] = [];
  #waiters: Array<() => void> = [];

  add(direction: WireFrame["direction"], value: Record<string, unknown>): void {
    this.frames.push({ direction, time: performance.now(), value });
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async waitFor(
    predicate: (frame: WireFrame) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<WireFrame> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}.`);
      }
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        delay(remaining).then(() => undefined),
      ]);
    }
  }
}

class BrowserMessages {
  readonly messages: Array<{
    value: Record<string, unknown>;
    time: number;
  }> = [];
  #waiters: Array<() => void> = [];

  add(value: Record<string, unknown>): void {
    this.messages.push({ value, time: performance.now() });
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<{ value: Record<string, unknown>; time: number }> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((message) => predicate(message.value));
      if (found) return found;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}.`);
      }
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        delay(remaining).then(() => undefined),
      ]);
    }
  }
}

class OutputLog {
  text = "";
  #chunks: Array<{ start: number; end: number; time: number }> = [];
  #waiters: Array<() => void> = [];

  add(value: string): void {
    const start = this.text.length;
    this.text += value;
    this.#chunks.push({
      start,
      end: this.text.length,
      time: performance.now(),
    });
    for (const wake of this.#waiters.splice(0)) wake();
  }

  timeAt(offset: number): number {
    const chunk = this.#chunks.find(({ start, end }) =>
      offset >= start && offset <= end
    );
    return chunk?.time ?? performance.now();
  }

  async waitFor(
    predicate: (text: string) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (predicate(this.text)) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for ${description}. Recent R output: ${
            this.text.slice(-1000)
          }`,
        );
      }
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        delay(remaining).then(() => undefined),
      ]);
    }
  }
}

class RawWebSocket {
  readonly #connection: Deno.Conn;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  private constructor(connection: Deno.Conn) {
    this.#connection = connection;
    this.#reader = connection.readable.getReader();
  }

  static async connect(url: string): Promise<RawWebSocket> {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    const client = new RawWebSocket(connection);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const key = btoa(String.fromCharCode(...nonce));
    await writeAll(
      connection,
      encoder.encode(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${parsed.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    const headers = await client.#readHeaders();
    if (!headers.startsWith("HTTP/1.1 101 ")) {
      throw new Error(`WebSocket upgrade failed: ${headers.split("\r\n")[0]}`);
    }
    const accept = headers.match(/\r\nsec-websocket-accept:\s*(.+)\r\n/i)?.[1];
    const digest = await crypto.subtle.digest(
      "SHA-1",
      encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
    assert(accept === expected, "The WebSocket accept value was invalid.");
    return client;
  }

  async read(): Promise<Record<string, unknown>> {
    const header = await this.#readExact(2);
    let length = header[1] & 0x7f;
    if (length === 126) {
      const extended = await this.#readExact(2);
      length = (extended[0] << 8) | extended[1];
    } else if (length === 127) {
      const extended = await this.#readExact(8);
      const size = new DataView(extended.buffer).getBigUint64(0, false);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket message is too large for this test.");
      }
      length = Number(size);
    }
    assert((header[0] & 0x0f) === 1, "Expected a WebSocket text frame.");
    return JSON.parse(decoder.decode(await this.#readExact(length)));
  }

  async send(value: Record<string, unknown>): Promise<void> {
    const payload = encoder.encode(JSON.stringify(value));
    const mask = crypto.getRandomValues(new Uint8Array(4));
    let header: Uint8Array;
    if (payload.length < 126) {
      header = new Uint8Array([0x81, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = new Uint8Array([
        0x81,
        0xfe,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
      ]);
    } else {
      throw new Error("WebSocket request is too large for this test.");
    }
    const masked = payload.map((byte, index) => byte ^ mask[index % 4]);
    await writeAll(this.#connection, concat(header, mask, masked));
  }

  close(): void {
    try {
      this.#connection.close();
    } catch {
      // Closing test sockets is idempotent.
    }
  }

  async #readHeaders(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 16 * 1024) {
      bytes.push((await this.#readExact(1))[0]);
      const length = bytes.length;
      if (
        length >= 4 && bytes[length - 4] === 13 && bytes[length - 3] === 10 &&
        bytes[length - 2] === 13 && bytes[length - 1] === 10
      ) return decoder.decode(new Uint8Array(bytes));
    }
    throw new Error("WebSocket response headers exceeded 16 KiB.");
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const next = await this.#reader.read();
      if (next.done) {
        throw new Error("WebSocket connection closed unexpectedly.");
      }
      this.#buffer = concat(this.#buffer, next.value);
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
}

Deno.test({
  name: "interactive R resumes queued requests after sleep and browser frames",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
    const cacheRoot = await Deno.makeTempDir({
      prefix: "jdv-interactive-cache-",
    });
    const serverCache = `${cacheRoot}/server`;
    await Deno.mkdir(serverCache, { recursive: true });

    let server:
      | Awaited<ReturnType<typeof import("../main.ts").startServer>>
      | undefined;
    let proxy: Deno.Listener | undefined;
    let proxyTask: Promise<void> | undefined;
    let browser: RawWebSocket | undefined;
    let r: Deno.ChildProcess | undefined;
    let rWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let rStdoutTask: Promise<void> | undefined;
    let rStderrTask: Promise<void> | undefined;
    const proxyConnections = new Set<Deno.Conn>();
    const proxyErrors: string[] = [];

    try {
      const { startServer } = await import("../main.ts");
      server = await startServer({
        mode: "tcp",
        httpPort: 0,
        cacheDir: serverCache,
      });
      const target = new URL(server.socketPath);
      assert(
        target.protocol === "tcp:",
        "The actual server did not expose TCP.",
      );
      proxy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const proxyPort = (proxy.addr as Deno.NetAddr).port;
      const frameLog = new FrameLog();
      proxyTask = (async () => {
        for await (const incoming of proxy!) {
          proxyConnections.add(incoming);
          const upstream = await Deno.connect({
            hostname: target.hostname,
            port: Number(target.port),
          });
          proxyConnections.add(upstream);
          void Promise.all([
            forward(incoming, upstream, "from-r", frameLog),
            forward(upstream, incoming, "to-r", frameLog),
          ])
            .catch((error) => proxyErrors.push(String(error)))
            .finally(() => {
              proxyConnections.delete(incoming);
              proxyConnections.delete(upstream);
              closeQuietly(incoming);
              closeQuietly(upstream);
            });
        }
      })();

      browser = await RawWebSocket.connect(server.url);
      const browserMessages = new BrowserMessages();
      void (async () => {
        try {
          for (;;) browserMessages.add(await browser!.read());
        } catch {
          // The test closes the browser socket during cleanup.
        }
      })();
      await browserMessages.waitFor(
        (message) => message.type === "welcome",
        5_000,
        "viewer welcome",
      );

      const env = Deno.env.toObject();
      env.XDG_CACHE_HOME = cacheRoot;
      env.JDV_ADDRESS = `tcp://127.0.0.1:${proxyPort}`;
      if (testLibrary) env.R_LIBS_USER = testLibrary;
      r = new Deno.Command("R", {
        args: ["--interactive", "--no-readline", "--vanilla", "-q"],
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      rWriter = r.stdin.getWriter();
      const output = new OutputLog();
      rStdoutTask = (async () => {
        const reader = r!.stdout.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return;
            output.add(decoder.decode(next.value));
          }
        } catch {
          // Process shutdown closes the stream.
        }
      })();
      rStderrTask = (async () => {
        const reader = r!.stderr.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return;
            output.add(`\n[R stderr] ${decoder.decode(next.value)}`);
          }
        } catch {
          // Process shutdown closes the stream.
        }
      })();
      const sendR = async (code: string) => {
        await rWriter!.write(encoder.encode(`${code}\n`));
      };

      await sendR(
        `library(jdv); id <- jdv_view(data.frame(x = 1:1000), mode = "paged"); cat("TABLE_READY\\n")`,
      );
      await output.waitFor(
        (text) => hasOutputLine(text, "TABLE_READY"),
        15_000,
        "R table setup",
      );
      const opened = await browserMessages.waitFor(
        (message) => message.type === "view/open",
        10_000,
        "R view/open event",
      );
      const openMessage = opened.value;
      const session = String(openMessage.session);
      const openEnvelope = openMessage.message as Record<string, unknown>;
      const openParams = openEnvelope.params as Record<string, unknown>;
      const table = String(openParams.view);
      const generation = Number(openParams.generation);
      assert(session.startsWith("r-"), "R did not announce its real session.");
      assert(
        table.length > 0 && generation === 1,
        "The paged table was invalid.",
      );

      const sendRows = async (id: string, offset: number) => {
        await sendRequest(id, "table/rows", {
          view: table,
          generation,
          offset,
          limit: 1,
        });
      };
      const sendSchema = async (id: string) => {
        await sendRequest(id, "view/schema", { view: table, generation });
      };
      const sendRequest = async (
        id: string,
        method: string,
        params: Record<string, unknown>,
      ) => {
        await browser!.send({
          type: "request",
          id,
          session,
          method,
          params,
        });
      };
      const rRequest = (offset: number) => (frame: WireFrame) =>
        frame.direction === "to-r" && frame.value.method === "table/rows" &&
        (frame.value.params as Record<string, unknown> | undefined)?.offset ===
          offset;
      const rSchemaRequest = (after: number) => (frame: WireFrame) =>
        frame.time >= after && frame.direction === "to-r" &&
        frame.value.method === "view/schema" &&
        (frame.value.params as Record<string, unknown> | undefined)?.view ===
          table;
      const terminal = (wireId: string) => (frame: WireFrame) =>
        frame.direction === "from-r" && frame.value.id === wireId &&
        ("result" in frame.value || "error" in frame.value);
      const response = (id: string) => (message: Record<string, unknown>) =>
        message.type === "response" && message.id === id;

      const sleepId = "interactive-sleep-rows";
      const sleepCommandTime = performance.now();
      await sendR('Sys.sleep(10); cat("SLEEP_DONE\\n")');
      await delay(500);
      await sendRows(sleepId, 0);
      await frameLog.waitFor(
        rRequest(0),
        5_000,
        "sleep page request on the R TCP stream",
      );
      await delay(1_000);
      assert(
        !browserMessages.messages.some((message) =>
          response(sleepId)(message.value)
        ),
        "The sleep request unexpectedly ran while R was inside Sys.sleep().",
      );
      await output.waitFor(
        (text) => hasOutputLine(text, "SLEEP_DONE"),
        15_000,
        "Sys.sleep return marker",
      );
      const sleepMarkerIndex = output.text.lastIndexOf("SLEEP_DONE");
      const sleepMarkerAt = output.timeAt(sleepMarkerIndex);
      const sleepPromptAt = await waitForPromptAfter(
        output,
        "SLEEP_DONE",
        5_000,
      );
      const sleepResponse = await browserMessages.waitFor(
        response(sleepId),
        1_000,
        "automatic response after Sys.sleep returns",
      );
      const sleepDelay = sleepResponse.time - sleepPromptAt;
      assert(
        sleepDelay <= 1_000,
        `Sleep response arrived ${
          sleepDelay.toFixed(0)
        } ms after the R prompt.`,
      );
      assert(
        sleepPromptAt >= sleepMarkerAt,
        "The R prompt preceded the sleep marker.",
      );
      console.log(
        `interactive regression: Sys.sleep prompt-return response in ${
          sleepDelay.toFixed(0)
        } ms (command ${
          ((sleepPromptAt - sleepCommandTime) / 1000).toFixed(2)
        } s)`,
      );

      const browserEntry = output.text.length;
      await sendR('local({ browser(); cat("BROWSER_DONE\\n") })');
      await output.waitFor(
        (text) => text.slice(browserEntry).includes("Browse[1]>"),
        10_000,
        "function-scoped browser prompt",
      );
      const browserStartedAt = performance.now();

      const browserRowsId = "interactive-browser-rows";
      await sendRows(browserRowsId, 1);
      await frameLog.waitFor(
        rRequest(1),
        5_000,
        "browser page request on the R TCP stream",
      );
      await delay(1_000);
      assert(
        !browserMessages.messages.some((message) =>
          response(browserRowsId)(message.value)
        ),
        "The browser-frame request unexpectedly ran inside the function frame.",
      );

      const cycles = 50;
      const cancelWireIds: string[] = [];
      for (let index = 0; index < cycles; index++) {
        const id = `interactive-cancel-${index + 1}`;
        const sentAfter = performance.now();
        await sendSchema(id);
        let wireRequest: WireFrame;
        try {
          wireRequest = await frameLog.waitFor(
            rSchemaRequest(sentAfter),
            3_000,
            `cancel cycle ${index + 1} request on the R TCP stream`,
          );
        } catch (error) {
          const recentWire = frameLog.frames.slice(-12).map((frame) => ({
            direction: frame.direction,
            value: frame.value,
          }));
          const recentBrowser = browserMessages.messages.slice(-8).map((item) =>
            item.value
          );
          throw new Error(
            `${error}\nRecent wire frames: ${
              JSON.stringify(recentWire)
            }\nRecent browser messages: ${JSON.stringify(recentBrowser)}`,
          );
        }
        const wireId = String(wireRequest.value.id);
        cancelWireIds.push(wireId);
        await browser!.send({ type: "cancel", id, session });
        await frameLog.waitFor(
          (frame) =>
            frame.direction === "to-r" && frame.value.method === "cancel" &&
            (frame.value.params as Record<string, unknown> | undefined)?.id ===
              wireId,
          3_000,
          `cancel cycle ${index + 1} cancel frame on the R TCP stream`,
        );
      }

      await delay(6_000);
      assert(
        performance.now() - browserStartedAt >= 5_000,
        "The function-scoped browser frame was not held for at least five seconds.",
      );
      const acks = frameLog.frames
        .filter((frame) =>
          frame.direction === "from-r" && frame.value.method === "ack"
        )
        .map((frame) =>
          Number((frame.value.params as Record<string, unknown>).frames)
        );
      for (let index = 1; index < acks.length; index++) {
        assert(
          acks[index] > acks[index - 1],
          "R acknowledgement counters were not strictly increasing.",
        );
      }
      assert(
        acks.length > 0 && acks.at(-1)! > 96,
        `Expected cumulative ACK progress beyond 96 frames, got ${
          acks.at(-1) ?? 0
        }.`,
      );

      await sendR("c");
      await output.waitFor(
        (text) => hasOutputLine(text, "BROWSER_DONE"),
        5_000,
        "browser frame return marker",
      );
      const browserPromptAt = await waitForPromptAfter(
        output,
        "BROWSER_DONE",
        5_000,
      );
      const browserRowsResponse = await browserMessages.waitFor(
        response(browserRowsId),
        1_000,
        "automatic response after leaving function-scoped browser",
      );
      const browserDelay = browserRowsResponse.time - browserPromptAt;
      const browserHeldMs = browserPromptAt - browserStartedAt;
      assert(
        browserDelay <= 1_000,
        `Browser-frame response arrived ${
          browserDelay.toFixed(0)
        } ms after the R prompt.`,
      );

      for (const wireId of cancelWireIds) {
        const terminals = frameLog.frames.filter(terminal(wireId));
        assert(
          terminals.length === 1,
          `Expected exactly one R terminal response for ${wireId}, got ${terminals.length}.`,
        );
        const error = terminals[0].value.error as
          | Record<string, unknown>
          | undefined;
        assert(
          error?.code === "cancelled",
          `Expected cancelled terminal for ${wireId}, got ${
            JSON.stringify(terminals[0].value)
          }.`,
        );
      }

      const freshId = "interactive-after-cancels";
      const freshStartedAt = performance.now();
      await sendRows(freshId, 100);
      await frameLog.waitFor(
        rRequest(100),
        5_000,
        "post-cancellation page request on the R TCP stream",
      );
      const freshResponse = await browserMessages.waitFor(
        response(freshId),
        1_000,
        "fresh request after fifty cancellation cycles",
      );
      const freshDelay = freshResponse.time - freshStartedAt;
      assert(
        freshDelay <= 1_000,
        `Fresh request arrived ${freshDelay.toFixed(0)} ms after submission.`,
      );
      assert(
        proxyErrors.length === 0,
        `TCP proxy failed: ${proxyErrors.join("; ")}`,
      );

      console.log(
        `interactive regression: browser prompt-return response in ${
          browserDelay.toFixed(0)
        } ms after holding the function frame for ${
          browserHeldMs.toFixed(0)
        } ms; ${cycles}/${cycles} R cancellation terminals exactly once; ACK reached ${
          acks.at(-1)
        } frames; fresh response in ${freshDelay.toFixed(0)} ms`,
      );
      await sendR('q("no")');
      const exitStatus = await Promise.race([
        r.status,
        delay(5_000).then(() => null),
      ]);
      assert(exitStatus, "The interactive R child did not exit after q().");
      assert(
        exitStatus.success,
        `Interactive R exited with code ${exitStatus.code}.`,
      );
    } finally {
      browser?.close();
      if (rWriter) {
        try {
          await Promise.race([
            rWriter.write(encoder.encode('q("no")\n')),
            delay(500),
          ]);
        } catch {
          // Process may already have exited.
        }
        try {
          await rWriter.close();
        } catch {
          // Child teardown closes stdin.
        }
      }
      if (r) {
        try {
          const exited = await Promise.race([
            r.status.then(() => true),
            delay(2_000).then(() => false),
          ]);
          if (!exited) r.kill("SIGKILL");
        } catch {
          try {
            r.kill("SIGKILL");
          } catch {
            // Child may already be reaped.
          }
        }
        await r.status.catch(() => undefined);
      }
      for (const connection of proxyConnections) {
        closeQuietly(connection);
      }
      proxy?.close();
      await proxyTask?.catch(() => undefined);
      await rStdoutTask?.catch(() => undefined);
      await rStderrTask?.catch(() => undefined);
      await server?.close();
      await Deno.remove(cacheRoot, { recursive: true }).catch(() => undefined);
    }
  },
});

async function forward(
  source: Deno.Conn,
  destination: Deno.Conn,
  direction: WireFrame["direction"],
  log: FrameLog,
): Promise<void> {
  const reader = source.readable.getReader();
  const writer = destination.writable.getWriter();
  let pending = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      await writer.write(next.value);
      pending += decoder.decode(next.value, { stream: true });
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length) {
          try {
            const value = JSON.parse(line);
            if (value && typeof value === "object") log.add(direction, value);
          } catch {
            throw new Error(
              `Invalid JSONL frame through the test proxy: ${
                line.slice(0, 120)
              }`,
            );
          }
        }
      }
    }
  } finally {
    try {
      await writer.close();
    } catch {
      // The opposite forwarding direction may have closed the socket.
    }
    try {
      await reader.cancel();
    } catch {
      // Socket teardown is idempotent.
    }
  }
}

async function writeAll(
  connection: Deno.Conn,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await connection.write(bytes.subarray(offset));
  }
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function closeQuietly(connection: Deno.Conn): void {
  try {
    connection.close();
  } catch {
    // Socket cleanup is idempotent.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPromptAfter(
  output: OutputLog,
  marker: string,
  timeoutMs: number,
): Promise<number> {
  const markerIndex = output.text.lastIndexOf(marker);
  assert(markerIndex >= 0, `Missing R output marker ${marker}.`);
  await output.waitFor(
    (text) => /(?:^|\n)>\s*$/.test(text.slice(markerIndex + marker.length)),
    timeoutMs,
    `R prompt after ${marker}`,
  );
  const afterMarker = output.text.slice(markerIndex + marker.length);
  const prompt = /(?:^|\n)>\s*$/.exec(afterMarker);
  assert(prompt, `Missing R prompt after ${marker}.`);
  const promptCharacter = prompt[0].lastIndexOf(">");
  return output.timeAt(
    markerIndex + marker.length + prompt.index + promptCharacter,
  );
}

function hasOutputLine(text: string, marker: string): boolean {
  return text.includes(`\n${marker}\n`) || text.startsWith(`${marker}\n`);
}

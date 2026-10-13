import { assertEquals, assertStringIncludes } from "./assert.ts";
import { type BrowserClient, Hub } from "../hub.ts";
import type { ByteConnection } from "../platform.ts";

class MemoryConnection implements ByteConnection {
  readonly writes: string[] = [];
  #chunks: Array<Uint8Array | null> = [];
  #readers: Array<(value: Uint8Array | null) => void> = [];
  #writeWaiters: Array<() => void> = [];
  closed = false;

  async read(): Promise<Uint8Array | null> {
    if (this.#chunks.length) return this.#chunks.shift() ?? null;
    return await new Promise((resolve) => this.#readers.push(resolve));
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(new TextDecoder().decode(bytes));
    for (const wake of this.#writeWaiters.splice(0)) wake();
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#push(null);
  }

  inject(value: unknown): void {
    this.injectRaw(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  }

  injectRaw(bytes: Uint8Array): void {
    this.#push(bytes);
  }

  async nextWrite(index = this.writes.length): Promise<JsonRecord> {
    while (this.writes.length <= index) {
      await new Promise<void>((resolve) => this.#writeWaiters.push(resolve));
    }
    return JSON.parse(this.writes[index]) as JsonRecord;
  }

  #push(value: Uint8Array | null): void {
    const reader = this.#readers.shift();
    if (reader) reader(value);
    else this.#chunks.push(value);
  }
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_LIMITS = {
  max_receive_frames: 128,
  max_receive_bytes: 512 * 1024,
  queue_messages: 128,
  queue_bytes: 16 * 1024 * 1024,
  max_request_bytes: 10 * 1024 * 1024,
};

class MemoryBrowser implements BrowserClient {
  readonly messages: JsonRecord[] = [];
  #waiters: Array<() => void> = [];

  send(value: JsonRecord): void {
    this.messages.push(value);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  close(): void {}

  async nextMessage(
    predicate: (value: JsonRecord) => boolean,
  ): Promise<JsonRecord> {
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}

function notification(method: string, params: JsonRecord): JsonRecord {
  return { method, params };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function openTable(connection: MemoryConnection, generation = 1): void {
  connection.inject(notification("table/open", {
    table: "table-1",
    generation,
    title: "Snapshot",
    mode: "snapshot",
    data: { columns: ["x"], rows: [[1]] },
  }));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached in time.");
}

Deno.test("invalid hello followed by valid hello in one chunk is terminal", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  const invalid = JSON.stringify({
    id: "bad",
    method: "hello",
    params: { protocol: 2 },
  });
  const valid = JSON.stringify({
    id: "good",
    method: "hello",
    params: { protocol: 1, session: "r-1-1", limits: { ...DEFAULT_LIMITS } },
  });
  connection.injectRaw(new TextEncoder().encode(`${invalid}\n${valid}\n`));
  await waitFor(() => connection.closed);

  const browser = new MemoryBrowser();
  hub.attach(browser);
  const welcome = browser.messages[0];
  assertEquals(welcome.type, "welcome");
  assertEquals(welcome.sessions, []);
  assertEquals(JSON.parse(connection.writes[0]).error.code, "unsupported");
  hub.close();
});

Deno.test("hello requires every positive integer receive and queue limit", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  const { max_request_bytes: _maxRequestBytes, ...incomplete } = DEFAULT_LIMITS;
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-5000-1", limits: incomplete },
  });
  await waitFor(() => connection.closed);
  assertEquals(JSON.parse(connection.writes[0]).error.code, "unsupported");
  hub.close();
});

Deno.test("R request ids are remapped and table close updates the Snapshot cache", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-1-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "table/open");

  hub.handleBrowser(browser, {
    type: "request",
    id: "browser-1",
    session: "r-1-1",
    method: "table/schema",
    params: { table: "table-1", generation: 1 },
  });
  const request = await connection.nextWrite(0);
  assertEquals(typeof request.id, "string");
  assertStringIncludes(request.id as string, "jdv-");
  connection.inject({ id: request.id, result: { columns: ["x"] } });
  const response = await browser.nextMessage((message) =>
    message.type === "response"
  );
  assertEquals(response.id, "browser-1");
  assertEquals(response.result, { columns: ["x"] });

  hub.handleBrowser(browser, {
    type: "request",
    id: "browser-close",
    session: "r-1-1",
    method: "table/close",
    params: { table: "table-1", generation: 1 },
  });
  const closeRequest = await connection.nextWrite(1);
  connection.inject({
    id: closeRequest.id,
    result: { table: "table-1", generation: 1, closed: true },
  });
  const closed = await browser.nextMessage((message) =>
    message.type === "table/closed"
  );
  assertEquals((closed.message as JsonRecord).method, "table/closed");
  const welcome = await browser.nextMessage((message) =>
    message.type === "response" && message.id === "browser-close"
  );
  assertEquals((welcome.result as JsonRecord).closed, true);
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  assertEquals(
    (lateBrowser.messages[0].sessions as JsonRecord[])[0].tables,
    [],
  );
  hub.close();
});

Deno.test("cancelled late replies release their request slot without reaching the browser", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-2-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "table/open");
  hub.handleBrowser(browser, {
    type: "request",
    id: "cancel-me",
    session: "r-2-1",
    method: "table/rows",
    params: { table: "table-1", generation: 1, offset: 0, limit: 10 },
  });
  const request = await connection.nextWrite(0);
  hub.handleBrowser(browser, {
    type: "cancel",
    id: "cancel-me",
    session: "r-2-1",
  });
  const cancel = await connection.nextWrite(1);
  assertEquals(cancel.method, "cancel");
  connection.inject({ id: request.id, result: { rows: [] } });
  await waitFor(() => connection.writes.length >= 2);
  assertEquals(
    browser.messages.some((message) =>
      message.type === "response" && message.id === "cancel-me"
    ),
    false,
  );
  hub.close();
});

Deno.test("queued row pages coalesce and wait behind the already sent page", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-3-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "table/open");
  const request = (id: string, offset: number) =>
    hub.handleBrowser(browser, {
      type: "request",
      id,
      session: "r-3-1",
      method: "table/rows",
      params: { table: "table-1", generation: 1, offset, limit: 10 },
    });
  request("page-1", 0);
  const sent = await connection.nextWrite(0);
  request("page-2", 10);
  request("page-3", 20);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(connection.writes.length, 1);
  connection.inject({ id: sent.id, result: { rows: [] } });
  const latest = await connection.nextWrite(1);
  assertEquals((latest.params as JsonRecord).offset, 20);
  assertEquals(
    browser.messages.some((message) =>
      message.type === "response" && message.id === "page-2"
    ),
    false,
  );
  hub.close();
});

Deno.test("terminal replies free request slots without acknowledging wire credit", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-4-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "table/open");

  for (let index = 0; index < 32; index++) {
    hub.handleBrowser(browser, {
      type: "request",
      id: `request-${index}`,
      session: "r-4-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
  }
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "table/schema"
    ).length >= 32
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "request-33",
    session: "r-4-1",
    method: "table/schema",
    params: { table: "table-1", generation: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "table/schema"
    ).length,
    32,
  );

  const first = JSON.parse(connection.writes[0]) as JsonRecord;
  const second = JSON.parse(connection.writes[1]) as JsonRecord;
  connection.inject({
    id: first.id,
    error: { code: "limit_exceeded", message: "R receive queue is full." },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "table/schema"
    ).length,
    33,
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "request-34",
    session: "r-4-1",
    method: "table/schema",
    params: { table: "table-1", generation: 1 },
  });
  connection.inject({ id: second.id, result: { columns: [] } });
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "table/schema"
    ).length === 34
  );
  hub.close();
});

Deno.test("repeated limit errors release request slots but retain frame credit", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-11-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    for (let index = 0; index < 96; index++) {
      const id = `reject-${index}`;
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-11-1",
        method: "table/schema",
        params: { table: "table-1", generation: 1 },
      });
      await waitFor(() =>
        connection.writes.filter((line) =>
          (JSON.parse(line) as JsonRecord).method === "table/schema"
        ).length > index
      );
      const request = connection.writes.map((line) =>
        JSON.parse(line) as JsonRecord
      ).filter((frame) =>
        frame.method === "table/schema"
      )[index];
      connection.inject({
        id: request.id,
        error: { code: "limit_exceeded", message: "R receive queue is full." },
      });
      await browser.nextMessage((message) =>
        message.type === "response" && message.id === id
      );
    }

    hub.handleBrowser(browser, {
      type: "request",
      id: "blocked-by-frame-credit",
      session: "r-11-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
    await browser.nextMessage((message) =>
      message.type === "busy" && message.reason === "wire_credit"
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "table/schema"
      ).length,
      96,
    );
    const ordinaryBytes = connection.writes.reduce(
      (sum, line) => sum + new TextEncoder().encode(line).byteLength,
      0,
    );
    assertEquals(ordinaryBytes <= 496 * 1024, true);
  } finally {
    hub.close();
  }
});

Deno.test("reserved cancellation slots remain usable behind a full ordinary queue", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-5-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "table/open");

  for (let index = 0; index < 32; index++) {
    hub.handleBrowser(browser, {
      type: "request",
      id: `active-${index}`,
      session: "r-5-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
  }
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "table/schema"
    ).length === 32
  );

  for (let index = 0; index < 480; index++) {
    hub.handleBrowser(browser, {
      type: "request",
      id: `queued-${index}`,
      session: "r-5-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
  }
  for (let index = 0; index < 32; index++) {
    hub.handleBrowser(browser, {
      type: "cancel",
      id: `active-${index}`,
      session: "r-5-1",
    });
  }
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "cancel"
    ).length === 32
  );
  assertEquals(
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "table/schema"
    ).length,
    32,
  );
  hub.close();
});

Deno.test("late close results update only their still-current table generation", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection, 1);
  await browser.nextMessage((message) => message.type === "table/open");

  hub.handleBrowser(browser, {
    type: "request",
    id: "old-close",
    session: "r-6-1",
    method: "table/close",
    params: { table: "table-1", generation: 1 },
  });
  const oldClose = await connection.nextWrite(0);
  hub.handleBrowser(browser, {
    type: "cancel",
    id: "old-close",
    session: "r-6-1",
  });
  openTable(connection, 2);
  await browser.nextMessage((message) => {
    const event = message.message;
    return message.type === "table/open" && isRecord(event) &&
      isRecord(event.params) && event.params.generation === 2;
  });
  connection.inject({
    id: oldClose.id,
    result: { table: "table-1", generation: 1, closed: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  const welcome = lateBrowser.messages[0];
  const session = (welcome.sessions as JsonRecord[])[0];
  assertEquals(
    ((session.tables as JsonRecord[])[0].params as JsonRecord).generation,
    2,
  );
  hub.close();
});

Deno.test("a cancelled table close still clears its current Snapshot cache", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-7-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "table/open");
  hub.handleBrowser(browser, {
    type: "request",
    id: "close-timeout",
    session: "r-7-1",
    method: "table/close",
    params: { table: "table-1", generation: 1 },
  });
  const closeRequest = await connection.nextWrite(0);
  hub.handleBrowser(browser, {
    type: "cancel",
    id: "close-timeout",
    session: "r-7-1",
  });
  await connection.nextWrite(1);
  connection.inject({
    id: closeRequest.id,
    result: { table: "table-1", generation: 1, closed: true },
  });
  await browser.nextMessage((message) => message.type === "table/closed");
  assertEquals(
    browser.messages.some((message) =>
      message.type === "response" && message.id === "close-timeout"
    ),
    false,
  );
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  assertEquals(
    (lateBrowser.messages[0].sessions as JsonRecord[])[0].tables,
    [],
  );
  hub.close();
});

Deno.test("request timeout stops wakes and ignores a later result", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-8-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "times-out",
      session: "r-8-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
      timeoutMs: 100,
    });
    const request = await connection.nextWrite(0);
    const timeout = await browser.nextMessage((message) =>
      message.type === "error" && message.code === "timeout"
    );
    assertEquals(timeout.id, "times-out");
    await waitFor(() =>
      connection.writes.some((line) =>
        (JSON.parse(line) as JsonRecord).method === "cancel"
      )
    );
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "cancel"
      ).length,
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 125));
    const stoppedWakeCount = connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "wake"
    ).length;
    await new Promise((resolve) =>
      setTimeout(resolve, 100)
    );
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "wake"
      ).length,
      stoppedWakeCount,
    );

    connection.inject({ id: request.id, result: { columns: ["late"] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      browser.messages.some((message) =>
        message.type === "response" && message.id === "times-out"
      ),
      false,
    );
    hub.handleBrowser(browser, {
      type: "request",
      id: "after-late-result",
      session: "r-8-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
    await waitFor(() =>
      connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "table/schema" && value.id !== request.id;
      })
    );
  } finally {
    hub.close();
  }
});

Deno.test("silent wake traffic pauses at the frame window and resumes on a result", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-9-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "long-running",
      session: "r-9-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
      timeoutMs: 10_000,
    });
    const first = await connection.nextWrite(0);
    await browser.nextMessage((message) =>
      message.type === "busy" && message.reason === "wire_credit"
    );
    const ordinary = connection.writes.map((line) =>
      JSON.parse(line) as JsonRecord
    )
      .filter((frame) => frame.method !== "cancel");
    assertEquals(ordinary.length, 96);
    assertEquals(
      ordinary.filter((frame) => frame.method === "wake").length > 0,
      true,
    );
    const ordinaryBytes = connection.writes.map((line) =>
      new TextEncoder().encode(line).byteLength
    ).reduce((sum, bytes) => sum + bytes, 0);
    assertEquals(ordinaryBytes <= 496 * 1024, true);
    assertEquals(ordinaryBytes <= 512 * 1024, true);

    hub.handleBrowser(browser, {
      type: "request",
      id: "waiting-request",
      session: "r-9-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(
      connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "table/schema" && value.id !== first.id;
      }),
      false,
    );
    connection.inject({ id: first.id, result: { columns: [] } });
    connection.inject(
      notification("ack", { frames: connection.writes.length }),
    );
    await waitFor(() =>
      connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "table/schema" && value.id !== first.id;
      })
    );
  } finally {
    hub.close();
  }
});

Deno.test("future ACKs and terminal replies cannot free wire credit", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5001-1",
      limits: {
        ...DEFAULT_LIMITS,
        max_receive_frames: 9,
        queue_messages: 8,
      },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    const request = (id: string) =>
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-5001-1",
        method: "table/schema",
        params: { table: "table-1", generation: 1 },
      });
    request("one");
    const first = await connection.nextWrite(0);
    assertEquals(first.method, "table/schema");

    connection.inject(notification("ack", { frames: 2 }));
    connection.inject({ id: first.id, result: { columns: [] } });
    request("two");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "table/schema"
      ).length,
      1,
    );

    connection.inject(notification("ack", { frames: 1 }));
    const second = await connection.nextWrite(1);
    assertEquals(second.method, "table/schema");
    connection.inject(notification("ack", { frames: 1 }));
    connection.inject({ id: second.id, result: { columns: [] } });
    await browser.nextMessage((message) =>
      message.type === "response" && message.id === "two"
    );
    request("three");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "table/schema"
      ).length,
      2,
    );
    connection.inject(notification("ack", { frames: 2 }));
    const third = await connection.nextWrite(2);
    assertEquals(third.method, "table/schema");
    connection.inject(notification("ack", { frames: 3 }));
    connection.inject({ id: third.id, result: { columns: [] } });
  } finally {
    hub.close();
  }
});

Deno.test("a request larger than R's negotiated single-request limit is rejected", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5004-1",
      limits: { ...DEFAULT_LIMITS, max_request_bytes: 128 },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "too-large",
      session: "r-5004-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
    const rejected = await browser.nextMessage((message) =>
      message.type === "error" && message.id === "too-large"
    );
    assertEquals(rejected.code, "limit_exceeded");
    assertEquals(connection.writes.length, 0);
  } finally {
    hub.close();
  }
});

Deno.test("a single request larger than R's queue byte limit is rejected", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5006-1",
      limits: { ...DEFAULT_LIMITS, queue_bytes: 1024 },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "too-many-bytes",
      session: "r-5006-1",
      method: "table/schema",
      params: {
        table: "table-1",
        generation: 1,
        padding: "x".repeat(1500),
      },
    });
    const rejected = await browser.nextMessage((message) =>
      message.type === "error" && message.id === "too-many-bytes"
    );
    assertEquals(rejected.code, "limit_exceeded");
    assertEquals(connection.writes.length, 0);
  } finally {
    hub.close();
  }
});

Deno.test("a one-message R queue retains the latest unsent page behind a live page", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5005-1",
      limits: {
        ...DEFAULT_LIMITS,
        max_receive_frames: 2,
        queue_messages: 1,
      },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    const requestPage = (id: string, offset: number) =>
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-5005-1",
        method: "table/rows",
        params: { table: "table-1", generation: 1, offset, limit: 10 },
      });
    requestPage("live-page", 0);
    const first = await connection.nextWrite(0);
    assertEquals(first.method, "table/rows");
    connection.inject(notification("ack", { frames: 1 }));
    requestPage("old-page", 10);
    requestPage("latest-page", 20);
    await browser.nextMessage((message) =>
      message.type === "cancelled" && message.id === "old-page"
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    assertEquals(connection.writes.length, 1);

    connection.inject({ id: first.id, result: { rows: [] } });
    await browser.nextMessage((message) =>
      message.type === "response" && message.id === "live-page"
    );
    const next = await connection.nextWrite(1);
    assertEquals(next.method, "table/rows");
    assertEquals((next.params as JsonRecord).offset, 20);
    connection.inject(notification("ack", { frames: 2 }));
    connection.inject({ id: next.id, result: { rows: [] } });
  } finally {
    hub.close();
  }
});

Deno.test("R queue bytes are charged on send and retained through a terminal reply", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5002-1",
      limits: { ...DEFAULT_LIMITS, queue_bytes: 1024 },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    const request = (id: string) =>
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-5002-1",
        method: "table/schema",
        params: {
          table: "table-1",
          generation: 1,
          padding: "x".repeat(512),
        },
      });
    request("first");
    await waitFor(() => connection.writes.length >= 1);
    const first = await connection.nextWrite(0);
    assertEquals(first.method, "table/schema");
    connection.inject(notification("ack", { frames: 1 }));
    request("second");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assertEquals(connection.writes.length, 1);

    connection.inject({ id: first.id, result: { columns: [] } });
    await browser.nextMessage((message) =>
      message.type === "response" && message.id === "first"
    );
    const second = await connection.nextWrite(1);
    assertEquals(second.method, "table/schema");
    connection.inject(
      notification("ack", { frames: connection.writes.length }),
    );
    connection.inject({ id: second.id, result: { columns: [] } });
  } finally {
    hub.close();
  }
});

Deno.test("more than 32 cancelled request waves leave the session usable", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5003-1",
      limits: { ...DEFAULT_LIMITS },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    for (let index = 0; index < 40; index++) {
      const start = connection.writes.length;
      hub.handleBrowser(browser, {
        type: "request",
        id: `cancel-${index}`,
        session: "r-5003-1",
        method: "table/schema",
        params: { table: "table-1", generation: 1 },
      });
      const request = await connection.nextWrite(start);
      hub.handleBrowser(browser, {
        type: "cancel",
        id: `cancel-${index}`,
        session: "r-5003-1",
      });
      const cancel = await connection.nextWrite(start + 1);
      assertEquals(cancel.method, "cancel");
      connection.inject({
        id: request.id,
        error: { code: "cancelled", message: "Cancelled." },
      });
      connection.inject(
        notification("ack", { frames: connection.writes.length }),
      );
    }

    const finalStart = connection.writes.length;
    hub.handleBrowser(browser, {
      type: "request",
      id: "after-cancel-waves",
      session: "r-5003-1",
      method: "table/schema",
      params: { table: "table-1", generation: 1 },
    });
    const finalRequest = await connection.nextWrite(finalStart);
    assertEquals(finalRequest.method, "table/schema");
  } finally {
    hub.close();
  }
});

Deno.test("large ordinary frames stop at the 496 KiB byte budget", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptR(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-10-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "table/open");
    for (let index = 0; index < 8; index++) {
      hub.handleBrowser(browser, {
        type: "request",
        id: `large-${index}`,
        session: "r-10-1",
        method: "table/schema",
        params: {
          table: "table-1",
          generation: 1,
          padding: "x".repeat(60 * 1024),
        },
      });
      await waitFor(() =>
        connection.writes.filter((line) =>
          (JSON.parse(line) as JsonRecord).method === "table/schema"
        ).length > index
      );
      const request = connection.writes.map((line) =>
        JSON.parse(line) as JsonRecord
      ).filter((frame) =>
        frame.method === "table/schema"
      )[index];
      connection.inject({
        id: request.id,
        error: { code: "limit_exceeded", message: "R receive queue is full." },
      });
      await browser.nextMessage((message) =>
        message.type === "response" && message.id === `large-${index}`
      );
    }
    hub.handleBrowser(browser, {
      type: "request",
      id: "large-8",
      session: "r-10-1",
      method: "table/schema",
      params: {
        table: "table-1",
        generation: 1,
        padding: "x".repeat(60 * 1024),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const frames = connection.writes.map((line) =>
      JSON.parse(line) as JsonRecord
    );
    assertEquals(
      frames.filter((frame) => frame.method === "table/schema").length,
      8,
    );
    const bytes = connection.writes.reduce(
      (sum, line) => sum + new TextEncoder().encode(line).byteLength,
      0,
    );
    assertEquals(bytes <= 496 * 1024, true);
    assertEquals(bytes <= 512 * 1024, true);
  } finally {
    hub.close();
  }
});

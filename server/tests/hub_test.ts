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
  max_message_bytes: 10 * 1024 * 1024,
};

class MemoryBrowser implements BrowserClient {
  readonly messages: JsonRecord[] = [];
  readonly binaryMessages: Uint8Array[] = [];
  readonly messageCacheReplies: boolean[] = [];
  readonly binaryCacheReplies: boolean[] = [];
  #waiters: Array<() => void> = [];

  send(value: JsonRecord, cacheReply = false): void {
    this.messages.push(value);
    this.messageCacheReplies.push(cacheReply);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  sendBinary(bytes: Uint8Array, cacheReply = false): void {
    this.binaryMessages.push(bytes.slice());
    this.binaryCacheReplies.push(cacheReply);
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
  connection.inject(notification("view/open", {
    view: "table-1",
    generation,
    kind: "grid",
    access: "snapshot",
    encoding: "r-json",
    title: "Snapshot",
    mode: "snapshot",
    nrow: 1,
    ncol: 1,
    columns: [{
      position: 0,
      name: "x",
      type: "integer",
      sortable: true,
      filterable: true,
    }],
    capabilities: {
      seek: true,
      sort: true,
      filter: true,
      known_total: true,
      next: false,
      children: false,
    },
    data: { columns: ["x"], rows: [[1]] },
  }));
}

function openTree(
  connection: MemoryConnection,
  view = "tree-1",
  generation = 1,
) {
  connection.inject(notification("view/open", {
    view,
    generation,
    kind: "tree",
    access: "random",
    encoding: "r-json",
    title: "Tree fixture",
    capabilities: {
      seek: true,
      sort: false,
      filter: false,
      known_total: true,
      next: false,
      children: true,
    },
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

function encodeRBinaryResponse(
  id: string,
  byteLength: number,
  body: Uint8Array,
  view = "table-1",
  generation = 1,
  envelopeFields: JsonRecord = {},
): Uint8Array {
  const header = new TextEncoder().encode(`${
    JSON.stringify({
      ...envelopeFields,
      id,
      result: {
        view,
        generation,
        transfer: { encoding: "arrow-ipc", byte_length: byteLength },
      },
      warnings: [],
    })
  }\n`);
  return concatBytes(header, body);
}

function decodeBrowserBinary(frame: Uint8Array): {
  envelope: JsonRecord;
  body: Uint8Array;
} {
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    4,
  ).getUint32(0, true);
  return {
    envelope: JSON.parse(
      new TextDecoder().decode(frame.subarray(4, 4 + headerLength)),
    ) as JsonRecord,
    body: frame.subarray(4 + headerLength),
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

Deno.test("invalid hello followed by valid hello in one chunk is terminal", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  const invalid = JSON.stringify({
    id: "bad",
    method: "hello",
    params: { protocol: 2 },
  });
  const valid = JSON.stringify({
    id: "good",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-1-1",
      limits: (({ max_message_bytes: _unused, ...legacyLimits }) =>
        legacyLimits)(
          DEFAULT_LIMITS,
        ),
    },
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
  hub.acceptProducer(connection);
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

Deno.test("hello accepts an omitted max_message_bytes limit for older peers", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  const browser = new MemoryBrowser();
  hub.attach(browser);
  const { max_message_bytes: _unused, ...legacyLimits } = DEFAULT_LIMITS;
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session: "r-5001-1",
      limits: legacyLimits,
    },
  });
  await browser.nextMessage((message) =>
    message.type === "session/open" && message.session === "r-5001-1"
  );
  assertEquals(connection.closed, false);
  hub.close();
});

Deno.test("Hub relays a bounded Arrow IPC body in one browser binary frame", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6100-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "binary-page",
      session: "r-6100-1",
      method: "table/rows",
      params: { view: "table-1", generation: 1, max_bytes: 5 },
    });
    const request = await connection.nextWrite(0);
    assertEquals((request.params as JsonRecord).max_bytes, 5);
    const body = new Uint8Array([0x00, 0x0a, 0xff, 0x00, 0x7f]);
    connection.injectRaw(
      encodeRBinaryResponse(
        request.id as string,
        body.length,
        body,
        "table-1",
        1,
        { type: "r-internal-response", session: "r-forged-session" },
      ),
    );
    await waitFor(() => browser.binaryMessages.length === 1);
    const decoded = decodeBrowserBinary(browser.binaryMessages[0]);
    assertEquals(decoded.envelope, {
      type: "response",
      session: "r-6100-1",
      id: "binary-page",
      result: {
        view: "table-1",
        generation: 1,
        transfer: { encoding: "arrow-ipc", byte_length: body.length },
      },
      warnings: [],
    });
    assertEquals(decoded.body, body);
    assertEquals(
      browser.messages.some((message) => message.id === "binary-page"),
      false,
    );
  } finally {
    hub.close();
  }
});

Deno.test("Hub relays an empty binary body for a zero-byte request budget", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6102-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "empty-binary",
      session: "r-6102-1",
      method: "table/rows",
      params: { view: "table-1", generation: 1, max_bytes: 0 },
    });
    const request = await connection.nextWrite(0);
    assertEquals((request.params as JsonRecord).max_bytes, 0);
    connection.inject({
      id: request.id,
      result: {
        view: "table-1",
        generation: 1,
        transfer: { encoding: "arrow-ipc", byte_length: 0 },
      },
      warnings: [],
    });
    await waitFor(() => browser.binaryMessages.length === 1);
    const decoded = decodeBrowserBinary(browser.binaryMessages[0]);
    assertEquals(decoded.body.length, 0);
    assertEquals((decoded.envelope.result as JsonRecord).transfer, {
      encoding: "arrow-ipc",
      byte_length: 0,
    });
  } finally {
    hub.close();
  }
});

Deno.test("Hub rejects a binary response for a different view generation", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6110-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "wrong-generation",
      session: "r-6110-1",
      method: "table/rows",
      params: { view: "table-1", generation: 1 },
    });
    const request = await connection.nextWrite(0);
    const body = new Uint8Array([0x00, 0x0a]);
    connection.injectRaw(
      encodeRBinaryResponse(
        request.id as string,
        body.length,
        body,
        "table-1",
        2,
      ),
    );
    const error = await browser.nextMessage((message) =>
      message.type === "error" && message.id === "wrong-generation"
    );
    assertEquals(error.code, "stale_generation");
    assertEquals(browser.binaryMessages.length, 0);
  } finally {
    hub.close();
  }
});

Deno.test("Hub drains a cancelled binary body before the next JSONL response", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6111-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");
  hub.handleBrowser(browser, {
    type: "request",
    id: "cancelled-binary",
    session: "r-6111-1",
    method: "table/rows",
    params: { view: "table-1", generation: 1, max_bytes: 2 },
  });
  const binaryRequest = await connection.nextWrite(0);
  hub.handleBrowser(browser, {
    type: "cancel",
    id: "cancelled-binary",
    session: "r-6111-1",
  });
  assertEquals((await connection.nextWrite(1)).method, "cancel");
  await browser.nextMessage((message) =>
    message.type === "cancelled" && message.id === "cancelled-binary"
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "after-binary",
    session: "r-6111-1",
    method: "table/rows",
    params: { view: "table-1", generation: 1, offset: 1, limit: 1 },
  });
  const nextRequest = await connection.nextWrite(2);
  const body = new Uint8Array([0x00, 0x0a]);
  connection.injectRaw(concatBytes(
    encodeRBinaryResponse(binaryRequest.id as string, body.length, body),
    new TextEncoder().encode(`${
      JSON.stringify({
        id: nextRequest.id,
        result: { view: "table-1", generation: 1, rows: [] },
      })
    }\n`),
  ));
  const response = await browser.nextMessage((message) =>
    message.type === "response" && message.id === "after-binary"
  );
  assertEquals((response.result as JsonRecord).rows, []);
  assertEquals(browser.binaryMessages.length, 0);
  assertEquals(
    browser.messages.filter((message) =>
      (message.type === "cancelled" || message.type === "error" ||
        message.type === "response") && message.id === "cancelled-binary"
    ).length,
    1,
  );
  hub.close();
});

Deno.test("Hub rejects an over-budget binary response and continues with the next JSONL response", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6101-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    for (const [id, maxBytes] of [["too-small", 1], ["next-json", 10]]) {
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-6101-1",
        method: "view/schema",
        params: { view: "table-1", generation: 1, max_bytes: maxBytes },
      });
    }
    const first = await connection.nextWrite(0);
    const second = await connection.nextWrite(1);
    const body = new Uint8Array([0x00, 0x0a]);
    const next = new TextEncoder().encode(`${
      JSON.stringify({
        id: second.id,
        result: { columns: ["x"] },
        warnings: [],
      })
    }\n`);
    connection.injectRaw(concatBytes(
      encodeRBinaryResponse(first.id as string, body.length, body),
      next,
    ));
    const rejected = await browser.nextMessage((message) =>
      message.type === "error" && message.id === "too-small"
    );
    assertEquals(rejected.code, "limit_exceeded");
    const continued = await browser.nextMessage((message) =>
      message.type === "response" && message.id === "next-json"
    );
    assertEquals(continued.result, { columns: ["x"] });
    assertEquals(browser.binaryMessages.length, 0);
    assertEquals(
      browser.messages.filter((message) => message.id === "too-small").length,
      1,
    );
  } finally {
    hub.close();
  }
});

Deno.test("R request ids are remapped and table close updates the Snapshot cache", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-1-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");

  hub.handleBrowser(browser, {
    type: "request",
    id: "legacy-method",
    session: "r-1-1",
    method: "table/schema",
    params: { table: "table-1", generation: 1 },
  });
  assertEquals(
    (await browser.nextMessage((message) => message.id === "legacy-method"))
      .code,
    "method_not_found",
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "legacy-id-key",
    session: "r-1-1",
    method: "view/schema",
    params: { table: "table-1", generation: 1 },
  });
  assertEquals(
    (await browser.nextMessage((message) => message.id === "legacy-id-key"))
      .code,
    "invalid_request",
  );

  hub.handleBrowser(browser, {
    type: "request",
    id: "browser-1",
    session: "r-1-1",
    method: "view/schema",
    params: { view: "table-1", generation: 1 },
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
    method: "view/close",
    params: { view: "table-1", generation: 1 },
  });
  const closeRequest = await connection.nextWrite();
  connection.inject({
    id: closeRequest.id,
    result: { view: "table-1", generation: 1, closed: true },
  });
  const closed = await browser.nextMessage((message) =>
    message.type === "view/closed"
  );
  assertEquals((closed.message as JsonRecord).method, "view/closed");
  const welcome = await browser.nextMessage((message) =>
    message.type === "response" && message.id === "browser-close"
  );
  assertEquals((welcome.result as JsonRecord).closed, true);
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  assertEquals(
    (lateBrowser.messages[0].sessions as JsonRecord[])[0].views,
    [],
  );
  hub.close();
});

Deno.test("tree child requests route typed paths and distinguish stale views", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-81-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTree(connection);
  await browser.nextMessage((message) => message.type === "view/open");

  const path = [
    { type: "binding", name: "outer" },
    { type: "index", index: 2 },
    { type: "slot", name: "state" },
    { type: "attr", name: "names" },
  ];
  hub.handleBrowser(browser, {
    type: "request",
    id: "children-page",
    session: "r-81-1",
    method: "object/children",
    params: { view: "tree-1", generation: 1, path, offset: 20, limit: 100 },
  });
  const request = await connection.nextWrite(0);
  assertEquals(request.method, "object/children");
  assertEquals(request.params, {
    view: "tree-1",
    generation: 1,
    path,
    offset: 20,
    limit: 100,
  });
  connection.inject({
    id: request.id,
    result: {
      view: "tree-1",
      generation: 1,
      path,
      offset: 20,
      children: [],
      total_children: 20,
    },
  });
  const response = await browser.nextMessage((message) =>
    message.type === "response" && message.id === "children-page"
  );
  assertEquals((response.result as JsonRecord).path, path);

  hub.handleBrowser(browser, {
    type: "request",
    id: "children-defaults",
    session: "r-81-1",
    method: "object/children",
    params: { view: "tree-1", generation: 1, path: [] },
  });
  const defaultRequest = await connection.nextWrite(1);
  assertEquals(defaultRequest.method, "object/children");
  assertEquals(defaultRequest.params, {
    view: "tree-1",
    generation: 1,
    path: [],
  });
  connection.inject({
    id: defaultRequest.id,
    result: {
      view: "tree-1",
      generation: 1,
      path: [],
      offset: 0,
      children: [],
      total_children: 0,
    },
  });
  await browser.nextMessage((message) =>
    message.type === "response" && message.id === "children-defaults"
  );

  hub.handleBrowser(browser, {
    type: "request",
    id: "open-root",
    session: "r-81-1",
    method: "object/open",
    params: { view: "tree-1", generation: 1, path: [] },
  });
  assertEquals(
    (await browser.nextMessage((message) => message.id === "open-root")).code,
    "invalid_request",
  );

  hub.handleBrowser(browser, {
    type: "request",
    id: "bad-path",
    session: "r-81-1",
    method: "object/children",
    params: {
      view: "tree-1",
      generation: 1,
      path: [{ type: "binding", name: "x" }, {
        type: "expression",
        value: "x",
      }],
      offset: 0,
      limit: 20,
    },
  });
  assertEquals(
    (await browser.nextMessage((message) => message.id === "bad-path")).code,
    "invalid_request",
  );

  hub.handleBrowser(browser, {
    type: "request",
    id: "stale-generation",
    session: "r-81-1",
    method: "object/children",
    params: { view: "tree-1", generation: 0, path: [], offset: 0, limit: 20 },
  });
  assertEquals(
    (await browser.nextMessage((message) => message.id === "stale-generation"))
      .code,
    "stale_generation",
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "missing-view",
    session: "r-81-1",
    method: "object/children",
    params: { view: "missing", generation: 1, path: [], offset: 0, limit: 20 },
  });
  assertEquals(
    (await browser.nextMessage((message) => message.id === "missing-view"))
      .code,
    "view_not_found",
  );
  hub.close();
});

Deno.test("object/open registers the child from R's notification even after browser detach", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-82-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTree(connection, "tree-root");
  await browser.nextMessage((message) => message.type === "view/open");

  hub.handleBrowser(browser, {
    type: "request",
    id: "open-child",
    session: "r-82-1",
    method: "object/open",
    params: {
      view: "tree-root",
      generation: 1,
      path: [{ type: "index", index: 2 }],
      mode: "snapshot",
      collation: "locale",
    },
  });
  const request = await connection.nextWrite(0);
  assertEquals(request.method, "object/open");
  assertEquals((request.params as JsonRecord).mode, "snapshot");
  assertEquals((request.params as JsonRecord).collation, "locale");
  hub.detach(browser);
  const descriptor = {
    view: "child-grid",
    generation: 1,
    kind: "grid",
    access: "snapshot",
    encoding: "r-json",
    mode: "snapshot",
    title: "Child table",
    parent: "tree-root",
    nrow: 1,
    ncol: 1,
    columns: [{ position: 0, name: "x", type: "integer" }],
    capabilities: {
      seek: true,
      sort: true,
      filter: true,
      known_total: true,
      next: false,
      children: false,
    },
    data: { columns: ["x"], rows: [[5]] },
  };
  // R announces the child with a notification ahead of the response.
  connection.inject(notification("view/open", descriptor));
  connection.inject({ id: request.id, result: descriptor });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  const session = (lateBrowser.messages[0].sessions as JsonRecord[])[0];
  const views = session.views as JsonRecord[];
  assertEquals(views.map((item) => (item.params as JsonRecord).view), [
    "tree-root",
    "child-grid",
  ]);
  assertEquals(
    browser.messages.some((message) => message.type === "response"),
    false,
  );

  connection.inject(notification("view/closed", {
    view: "tree-root",
    generation: 1,
  }));
  const childClosed = await lateBrowser.nextMessage((message) => {
    const params = isRecord(message.message) &&
        isRecord(message.message.params)
      ? message.message.params
      : null;
    return message.type === "view/closed" && params?.view === "child-grid";
  });
  assertEquals(
    ((childClosed.message as JsonRecord).params as JsonRecord).reason,
    "parent_closed",
  );
  hub.close();
});

const CHILD_DESCRIPTOR = {
  view: "child-grid",
  generation: 1,
  kind: "grid",
  access: "snapshot",
  encoding: "r-json",
  mode: "snapshot",
  parent: "tree-root",
  nrow: 1,
  ncol: 1,
  columns: [{ position: 0, name: "x", type: "integer" }],
  capabilities: {
    seek: true,
    sort: true,
    filter: true,
    known_total: true,
    next: false,
    children: false,
  },
  data: { columns: ["x"], rows: [[5]] },
};

async function openChildRequest(
  hub: Hub,
  connection: MemoryConnection,
  browser: MemoryBrowser,
  session: string,
): Promise<JsonRecord> {
  openTree(connection, "tree-root");
  await browser.nextMessage((message) => message.type === "view/open");
  hub.handleBrowser(browser, {
    type: "request",
    id: "open-child",
    session,
    method: "object/open",
    params: {
      view: "tree-root",
      generation: 1,
      path: [{ type: "index", index: 2 }],
    },
  });
  return await connection.nextWrite(0);
}

function viewIds(browser: MemoryBrowser): string[] {
  const session = (browser.messages[0].sessions as JsonRecord[])[0];
  return (session.views as JsonRecord[]).map((item) =>
    (item.params as JsonRecord).view as string
  );
}

Deno.test("an object/open response alone never registers a child view", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-84-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  const request = await openChildRequest(hub, connection, browser, "r-84-1");
  connection.inject({ id: request.id, result: CHILD_DESCRIPTOR });
  const delivered = await browser.nextMessage((message) =>
    message.type === "response" && message.id === "open-child"
  );
  assertEquals((delivered.result as JsonRecord).view, "child-grid");
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  assertEquals(viewIds(lateBrowser), ["tree-root"]);
  assertEquals(
    browser.messages.some((message) =>
      message.type === "view/open" &&
      ((message.message as JsonRecord).params as JsonRecord).view ===
        "child-grid"
    ),
    false,
  );
  hub.close();
});

Deno.test("a closed child is not revived by a late object/open response", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-85-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  const request = await openChildRequest(hub, connection, browser, "r-85-1");
  connection.inject(notification("view/open", CHILD_DESCRIPTOR));
  connection.inject(notification("view/closed", {
    view: "child-grid",
    generation: 1,
  }));
  await browser.nextMessage((message) =>
    message.type === "view/closed" &&
    ((message.message as JsonRecord).params as JsonRecord).view === "child-grid"
  );
  connection.inject({ id: request.id, result: CHILD_DESCRIPTOR });
  await browser.nextMessage((message) =>
    message.type === "response" && message.id === "open-child"
  );
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  assertEquals(viewIds(lateBrowser), ["tree-root"]);
  hub.close();
});

Deno.test("view lineage rejects self-parent and cycles before cascade close", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-83-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTree(connection, "tree-a");
  await browser.nextMessage((message) =>
    message.type === "view/open" &&
    (message.message as JsonRecord).params !== undefined
  );
  connection.inject(notification("view/open", {
    view: "tree-b",
    generation: 1,
    kind: "tree",
    access: "random",
    encoding: "r-json",
    parent: "tree-a",
    path: [],
    capabilities: {
      seek: true,
      sort: false,
      filter: false,
      known_total: true,
      next: false,
      children: true,
    },
  }));
  await browser.nextMessage((message) => {
    const params = isRecord(message.message) &&
        isRecord(message.message.params)
      ? message.message.params
      : null;
    return message.type === "view/open" && params?.view === "tree-b";
  });

  // Neither a direct self-parent nor a cycle may replace a valid cached view.
  connection.inject(notification("view/open", {
    view: "tree-a",
    generation: 2,
    kind: "tree",
    access: "random",
    encoding: "r-json",
    parent: "tree-b",
    path: [],
    capabilities: {
      seek: true,
      sort: false,
      filter: false,
      known_total: true,
      next: false,
      children: true,
    },
  }));
  connection.inject(notification("view/open", {
    view: "tree-self",
    generation: 1,
    kind: "tree",
    access: "random",
    encoding: "r-json",
    parent: "tree-self",
    path: [],
    capabilities: {
      seek: true,
      sort: false,
      filter: false,
      known_total: true,
      next: false,
      children: true,
    },
  }));
  connection.inject(notification("view/closed", {
    view: "tree-a",
    generation: 1,
  }));
  const childClosed = await browser.nextMessage((message) => {
    const params = isRecord(message.message) &&
        isRecord(message.message.params)
      ? message.message.params
      : null;
    return message.type === "view/closed" && params?.view === "tree-b";
  });
  assertEquals(
    ((childClosed.message as JsonRecord).params as JsonRecord).reason,
    "parent_closed",
  );
  await browser.nextMessage((message) => {
    const params = isRecord(message.message) &&
        isRecord(message.message.params)
      ? message.message.params
      : null;
    return message.type === "view/closed" && params?.view === "tree-a";
  });

  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  await lateBrowser.nextMessage((message) => message.type === "welcome");
  const session = (lateBrowser.messages[0].sessions as JsonRecord[])[0];
  const views = session.views as JsonRecord[];
  assertEquals(views, []);
  hub.close();
});

Deno.test("cancelled late replies release their request slot without reaching the browser", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-2-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");
  hub.handleBrowser(browser, {
    type: "request",
    id: "cancel-me",
    session: "r-2-1",
    method: "table/rows",
    params: { view: "table-1", generation: 1, offset: 0, limit: 10 },
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
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-3-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");
  const request = (id: string, offset: number) =>
    hub.handleBrowser(browser, {
      type: "request",
      id,
      session: "r-3-1",
      method: "table/rows",
      params: { view: "table-1", generation: 1, offset, limit: 10 },
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
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-4-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");

  for (let index = 0; index < 32; index++) {
    hub.handleBrowser(browser, {
      type: "request",
      id: `request-${index}`,
      session: "r-4-1",
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
    });
  }
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "view/schema"
    ).length >= 32
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "request-33",
    session: "r-4-1",
    method: "view/schema",
    params: { view: "table-1", generation: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "view/schema"
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
      (JSON.parse(line) as JsonRecord).method === "view/schema"
    ).length,
    33,
  );
  hub.handleBrowser(browser, {
    type: "request",
    id: "request-34",
    session: "r-4-1",
    method: "view/schema",
    params: { view: "table-1", generation: 1 },
  });
  connection.inject({ id: second.id, result: { columns: [] } });
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "view/schema"
    ).length === 34
  );
  hub.close();
});

Deno.test("repeated limit errors release request slots but retain frame credit", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-11-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    for (let index = 0; index < 96; index++) {
      const id = `reject-${index}`;
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-11-1",
        method: "view/schema",
        params: { view: "table-1", generation: 1 },
      });
      await waitFor(() =>
        connection.writes.filter((line) =>
          (JSON.parse(line) as JsonRecord).method === "view/schema"
        ).length > index
      );
      const request = connection.writes.map((line) =>
        JSON.parse(line) as JsonRecord
      ).filter((frame) =>
        frame.method === "view/schema"
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
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
    });
    await browser.nextMessage((message) =>
      message.type === "busy" && message.reason === "wire_credit"
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "view/schema"
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
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-5-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");

  for (let index = 0; index < 32; index++) {
    hub.handleBrowser(browser, {
      type: "request",
      id: `active-${index}`,
      session: "r-5-1",
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
    });
  }
  await waitFor(() =>
    connection.writes.filter((line) =>
      (JSON.parse(line) as JsonRecord).method === "view/schema"
    ).length === 32
  );

  for (let index = 0; index < 480; index++) {
    hub.handleBrowser(browser, {
      type: "request",
      id: `queued-${index}`,
      session: "r-5-1",
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
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
      (JSON.parse(line) as JsonRecord).method === "view/schema"
    ).length,
    32,
  );
  hub.close();
});

Deno.test("late close results update only their still-current table generation", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-6-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection, 1);
  await browser.nextMessage((message) => message.type === "view/open");

  hub.handleBrowser(browser, {
    type: "request",
    id: "old-close",
    session: "r-6-1",
    method: "view/close",
    params: { view: "table-1", generation: 1 },
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
    return message.type === "view/open" && isRecord(event) &&
      isRecord(event.params) && event.params.generation === 2;
  });
  connection.inject({
    id: oldClose.id,
    result: { view: "table-1", generation: 1, closed: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  const welcome = lateBrowser.messages[0];
  const session = (welcome.sessions as JsonRecord[])[0];
  assertEquals(
    ((session.views as JsonRecord[])[0].params as JsonRecord).generation,
    2,
  );
  assertEquals("tables" in session, false);
  hub.close();
});

Deno.test("a cancelled table close still clears its current Snapshot cache", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-7-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  await browser.nextMessage((message) => message.type === "view/open");
  hub.handleBrowser(browser, {
    type: "request",
    id: "close-timeout",
    session: "r-7-1",
    method: "view/close",
    params: { view: "table-1", generation: 1 },
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
    result: { view: "table-1", generation: 1, closed: true },
  });
  await browser.nextMessage((message) => message.type === "view/closed");
  assertEquals(
    browser.messages.some((message) =>
      message.type === "response" && message.id === "close-timeout"
    ),
    false,
  );
  const lateBrowser = new MemoryBrowser();
  hub.attach(lateBrowser);
  assertEquals(
    (lateBrowser.messages[0].sessions as JsonRecord[])[0].views,
    [],
  );
  hub.close();
});

Deno.test("closing a child clears only that view and cancels its pending work", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-83-1", limits: { ...DEFAULT_LIMITS } },
  });
  const reader = new MemoryBrowser();
  const closer = new MemoryBrowser();
  hub.attach(reader);
  hub.attach(closer);
  openTree(connection, "tree-root");
  await closer.nextMessage((message) => message.type === "view/open");
  connection.inject(notification("view/open", {
    view: "child-grid",
    generation: 1,
    kind: "grid",
    access: "snapshot",
    encoding: "r-json",
    mode: "snapshot",
    title: "Child",
    parent: "tree-root",
    nrow: 1,
    ncol: 0,
    columns: [],
    capabilities: {
      seek: true,
      sort: true,
      filter: true,
      known_total: true,
      next: false,
      children: false,
    },
    data: { columns: [], rows: [[]] },
  }));
  await reader.nextMessage((message) => {
    const params = isRecord(message.message) &&
        isRecord(message.message.params)
      ? message.message.params
      : null;
    return message.type === "view/open" && params?.view === "child-grid";
  });

  hub.handleBrowser(reader, {
    type: "request",
    id: "child-schema",
    session: "r-83-1",
    method: "view/schema",
    params: { view: "child-grid", generation: 1 },
  });
  const schemaRequest = await connection.nextWrite(0);
  hub.handleBrowser(closer, {
    type: "request",
    id: "close-child",
    session: "r-83-1",
    method: "view/close",
    params: { view: "child-grid", generation: 1 },
  });
  const closeRequest = await connection.nextWrite(1);
  connection.inject({
    id: closeRequest.id,
    result: { view: "child-grid", generation: 1, closed: true },
  });
  const stale = await reader.nextMessage((message) =>
    message.type === "error" && message.id === "child-schema"
  );
  assertEquals(stale.code, "stale_generation");
  const closed = await closer.nextMessage((message) => {
    const params = isRecord(message.message) &&
        isRecord(message.message.params)
      ? message.message.params
      : null;
    return message.type === "view/closed" && params?.view === "child-grid";
  });
  assertEquals(
    ((closed.message as JsonRecord).params as JsonRecord).reason,
    undefined,
  );
  const cancel = await connection.nextWrite(2);
  assertEquals(cancel.method, "cancel");
  const late = new MemoryBrowser();
  hub.attach(late);
  const views =
    ((late.messages[0].sessions as JsonRecord[])[0].views as JsonRecord[])
      .map((view) => (view.params as JsonRecord).view);
  assertEquals(views, ["tree-root"]);
  assertEquals(schemaRequest.method, "view/schema");
  hub.close();
});

Deno.test("request timeout stops wakes and ignores a later result", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-8-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "times-out",
      session: "r-8-1",
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
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
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
    });
    await waitFor(() =>
      connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "view/schema" && value.id !== request.id;
      })
    );
  } finally {
    hub.close();
  }
});

Deno.test("silent wake traffic pauses at the frame window and resumes on a result", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-9-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "long-running",
      session: "r-9-1",
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
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
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(
      connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "view/schema" && value.id !== first.id;
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
        return value.method === "view/schema" && value.id !== first.id;
      })
    );
  } finally {
    hub.close();
  }
});

Deno.test("future ACKs and terminal replies cannot free wire credit", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
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
    await browser.nextMessage((message) => message.type === "view/open");
    const request = (id: string) =>
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-5001-1",
        method: "view/schema",
        params: { view: "table-1", generation: 1 },
      });
    request("one");
    const first = await connection.nextWrite(0);
    assertEquals(first.method, "view/schema");

    connection.inject(notification("ack", { frames: 2 }));
    connection.inject({ id: first.id, result: { columns: [] } });
    request("two");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "view/schema"
      ).length,
      1,
    );

    connection.inject(notification("ack", { frames: 1 }));
    const second = await connection.nextWrite(1);
    assertEquals(second.method, "view/schema");
    connection.inject(notification("ack", { frames: 1 }));
    connection.inject({ id: second.id, result: { columns: [] } });
    await browser.nextMessage((message) =>
      message.type === "response" && message.id === "two"
    );
    request("three");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(
      connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "view/schema"
      ).length,
      2,
    );
    connection.inject(notification("ack", { frames: 2 }));
    const third = await connection.nextWrite(2);
    assertEquals(third.method, "view/schema");
    connection.inject(notification("ack", { frames: 3 }));
    connection.inject({ id: third.id, result: { columns: [] } });
  } finally {
    hub.close();
  }
});

Deno.test("a request larger than R's negotiated single-request limit is rejected", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
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
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "too-large",
      session: "r-5004-1",
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
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
  hub.acceptProducer(connection);
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
    await browser.nextMessage((message) => message.type === "view/open");
    hub.handleBrowser(browser, {
      type: "request",
      id: "too-many-bytes",
      session: "r-5006-1",
      method: "view/schema",
      params: {
        view: "table-1",
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
  hub.acceptProducer(connection);
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
    await browser.nextMessage((message) => message.type === "view/open");
    const requestPage = (id: string, offset: number) =>
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-5005-1",
        method: "table/rows",
        params: { view: "table-1", generation: 1, offset, limit: 10 },
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
  hub.acceptProducer(connection);
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
    await browser.nextMessage((message) => message.type === "view/open");
    const request = (id: string) =>
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-5002-1",
        method: "view/schema",
        params: {
          view: "table-1",
          generation: 1,
          padding: "x".repeat(512),
        },
      });
    request("first");
    await waitFor(() => connection.writes.length >= 1);
    const first = await connection.nextWrite(0);
    assertEquals(first.method, "view/schema");
    connection.inject(notification("ack", { frames: 1 }));
    request("second");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assertEquals(connection.writes.length, 1);

    connection.inject({ id: first.id, result: { columns: [] } });
    await browser.nextMessage((message) =>
      message.type === "response" && message.id === "first"
    );
    const second = await connection.nextWrite(1);
    assertEquals(second.method, "view/schema");
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
  hub.acceptProducer(connection);
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
    await browser.nextMessage((message) => message.type === "view/open");
    for (let index = 0; index < 40; index++) {
      const start = connection.writes.length;
      hub.handleBrowser(browser, {
        type: "request",
        id: `cancel-${index}`,
        session: "r-5003-1",
        method: "view/schema",
        params: { view: "table-1", generation: 1 },
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
      method: "view/schema",
      params: { view: "table-1", generation: 1 },
    });
    const finalRequest = await connection.nextWrite(finalStart);
    assertEquals(finalRequest.method, "view/schema");
  } finally {
    hub.close();
  }
});

Deno.test("large ordinary frames stop at the 496 KiB byte budget", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-10-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  try {
    await browser.nextMessage((message) => message.type === "view/open");
    for (let index = 0; index < 8; index++) {
      hub.handleBrowser(browser, {
        type: "request",
        id: `large-${index}`,
        session: "r-10-1",
        method: "view/schema",
        params: {
          view: "table-1",
          generation: 1,
          padding: "x".repeat(60 * 1024),
        },
      });
      await waitFor(() =>
        connection.writes.filter((line) =>
          (JSON.parse(line) as JsonRecord).method === "view/schema"
        ).length > index
      );
      const request = connection.writes.map((line) =>
        JSON.parse(line) as JsonRecord
      ).filter((frame) =>
        frame.method === "view/schema"
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
      method: "view/schema",
      params: {
        view: "table-1",
        generation: 1,
        padding: "x".repeat(60 * 1024),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const frames = connection.writes.map((line) =>
      JSON.parse(line) as JsonRecord
    );
    assertEquals(
      frames.filter((frame) => frame.method === "view/schema").length,
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

Deno.test("grid cell opens validate original row selectors and tree suffixes", async () => {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: { protocol: 1, session: "r-85-1", limits: { ...DEFAULT_LIMITS } },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  connection.inject(notification("view/open", {
    view: "cells",
    generation: 1,
    kind: "grid",
    nrow: 500,
    ncol: 2,
    columns: [
      { position: 0, name: "duplicate", drillable: true },
      { position: 1, name: "duplicate", drillable: false },
    ],
    capabilities: { children: true },
  }));
  await browser.nextMessage((message) => message.type === "view/open");
  try {
    const cell = { kind: "cell", row_index: 205, column: 0 };
    const invalid = [
      { method: "object/children", path: [cell] },
      { method: "object/open", path: [] },
      { method: "object/open", path: [{ ...cell, row_index: 0 }] },
      { method: "object/open", path: [{ ...cell, row_index: 501 }] },
      { method: "object/open", path: [{ ...cell, row_index: 1.5 }] },
      { method: "object/open", path: [{ ...cell, row_index: "205" }] },
      { method: "object/open", path: [{ ...cell, column: 1 }] },
      { method: "object/open", path: [{ ...cell, column: 2 }] },
      { method: "object/open", path: [{ ...cell, column: -1 }] },
      { method: "object/open", path: [{ type: "index", index: 1 }] },
      { method: "object/open", path: [cell, cell] },
      { method: "object/open", path: [{ ...cell, type: "index", index: 1 }] },
      {
        method: "object/open",
        path: [cell, { ...cell, type: "index", index: 1 }],
      },
      {
        method: "object/open",
        path: [cell, { type: "expression", value: "x" }],
      },
      {
        method: "object/open",
        path: [cell, ...Array(32).fill({ type: "index", index: 1 })],
      },
    ];
    for (const [index, request] of invalid.entries()) {
      const id = `invalid-cell-${index}`;
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-85-1",
        method: request.method,
        params: { view: "cells", generation: 1, path: request.path },
      });
      assertEquals(
        (await browser.nextMessage((message) => message.id === id)).code,
        "invalid_request",
      );
    }
    for (
      const [index, path] of [
        [cell],
        [cell, { type: "index", index: 2 }, { type: "attr", name: "names" }],
        [cell, ...Array(31).fill({ type: "index", index: 1 })],
      ].entries()
    ) {
      const id = `valid-cell-${index}`;
      const writes = connection.writes.length;
      hub.handleBrowser(browser, {
        type: "request",
        id,
        session: "r-85-1",
        method: "object/open",
        params: { view: "cells", generation: 1, path },
      });
      const forwarded = await connection.nextWrite(writes);
      assertEquals((forwarded.params as JsonRecord).path, path);
      connection.inject({ id: forwarded.id, result: { captured: true } });
      await browser.nextMessage((message) =>
        message.id === id && message.type === "response"
      );
    }
    openTree(connection);
    await browser.nextMessage((message) =>
      message.type === "view/open" &&
      ((message.message as JsonRecord)?.params as JsonRecord)?.view === "tree-1"
    );
    hub.handleBrowser(browser, {
      type: "request",
      id: "tree-cell",
      session: "r-85-1",
      method: "object/open",
      params: {
        view: "tree-1",
        generation: 1,
        path: [{ ...cell, type: "index", index: 1 }],
      },
    });
    assertEquals(
      (await browser.nextMessage((message) => message.id === "tree-cell")).code,
      "invalid_request",
    );
  } finally {
    hub.close();
  }
});

async function sequentialHubFixture(
  maxPageRows?: number,
  options: ConstructorParameters<typeof Hub>[0] = {},
) {
  const hub = new Hub(options);
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    method: "hello",
    params: { protocol: 1, session: "r-9010-1", limits: { ...DEFAULT_LIMITS } },
  });
  const owner = new MemoryBrowser();
  const other = new MemoryBrowser();
  hub.attach(owner);
  hub.attach(other);
  const open = (generation = 1, parent?: string) =>
    connection.inject(notification("view/open", {
      view: "stream-1",
      generation,
      kind: "grid",
      access: "sequential",
      encoding: "arrow-ipc",
      ...(maxPageRows === undefined ? {} : { max_page_rows: maxPageRows }),
      capabilities: {
        seek: false,
        sort: false,
        filter: false,
        known_total: false,
        next: true,
        children: false,
      },
      nrow: null,
      ncol: 0,
      columns: [],
      schema: { format: "+s", children: [] },
      mapping: [],
      ...(parent === undefined ? {} : { parent }),
    }));
  open();
  await owner.nextMessage((m) => m.type === "view/open");
  const request = (
    browser: MemoryBrowser,
    id: string,
    params: JsonRecord = {},
    timeoutMs?: number,
  ) =>
    hub.handleBrowser(browser, {
      type: "request",
      id,
      session: "r-9010-1",
      method: "stream/next",
      timeoutMs,
      params: { view: "stream-1", generation: 1, ...params },
    });
  const sent = () =>
    connection.writes.map((line) => JSON.parse(line) as JsonRecord).filter((
      m,
    ) => m.method === "stream/next");
  const finish = (id: unknown, firstRow: number, generation = 1) => {
    const body = new Uint8Array([0, 10, 255]);
    const header = new TextEncoder().encode(
      JSON.stringify({
        id,
        result: {
          view: "stream-1",
          generation,
          first_row: firstRow,
          rows_fetched: 3,
          rows_seen: firstRow + 3,
          done: false,
          transfer: { encoding: "arrow-ipc", byte_length: 3 },
        },
        warnings: [],
      }) + "\n",
    );
    connection.injectRaw(concatBytes(header, body));
  };
  return { hub, connection, owner, other, request, sent, finish, open };
}

Deno.test("sequential lease survives replies and releases on detach after late completion", async () => {
  const f = await sequentialHubFixture();
  try {
    f.request(f.owner, "first");
    await waitFor(() => f.sent().length === 1);
    f.request(f.owner, "concurrent");
    f.request(f.other, "other");
    assertEquals(
      f.owner.messages.find((m) => m.id === "concurrent")?.code,
      "in_use",
    );
    assertEquals(
      f.other.messages.find((m) => m.id === "other")?.code,
      "in_use",
    );
    f.finish(f.sent()[0].id, 0);
    await waitFor(() => f.owner.binaryMessages.length === 1);
    f.request(f.other, "still-owned");
    assertEquals(
      f.other.messages.find((m) => m.id === "still-owned")?.code,
      "in_use",
    );
    f.request(f.owner, "detaching");
    await waitFor(() => f.sent().length === 2);
    f.hub.detach(f.owner);
    f.request(f.other, "still-running");
    assertEquals(
      f.other.messages.find((m) => m.id === "still-running")?.code,
      "in_use",
    );
    f.finish(f.sent()[1].id, 3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.request(f.other, "continued");
    await waitFor(() => f.sent().length === 3);
    f.finish(f.sent()[2].id, 6);
    await waitFor(() => f.other.binaryMessages.length === 1);
    const delivered = decodeBrowserBinary(f.other.binaryMessages[0]);
    assertEquals((delivered.envelope.result as JsonRecord).first_row, 6);
    assertEquals(f.owner.binaryMessages.length, 1);
    assertEquals(f.other.messages.some((m) => m.type === "view/closed"), false);
  } finally {
    f.hub.close();
  }
});

Deno.test("sequential cancel and timeout retain the slot until a late terminal", async () => {
  const f = await sequentialHubFixture();
  try {
    f.request(f.owner, "cancelled");
    await waitFor(() => f.sent().length === 1);
    f.hub.handleBrowser(f.owner, {
      type: "cancel",
      id: "cancelled",
      session: "r-9010-1",
    });
    f.request(f.owner, "before-terminal");
    assertEquals(
      f.owner.messages.find((m) => m.id === "before-terminal")?.code,
      "in_use",
    );
    f.finish(f.sent()[0].id, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.request(f.owner, "timeout", {}, 100);
    await waitFor(() => f.sent().length === 2);
    await f.owner.nextMessage((m) =>
      m.id === "timeout" && m.code === "timeout"
    );
    f.request(f.owner, "after-timeout");
    assertEquals(
      f.owner.messages.find((m) => m.id === "after-timeout")?.code,
      "in_use",
    );
    f.finish(f.sent()[1].id, 3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.request(f.other, "sticky-owner");
    assertEquals(
      f.other.messages.find((m) => m.id === "sticky-owner")?.code,
      "in_use",
    );
    f.request(f.owner, "recovered");
    await waitFor(() => f.sent().length === 3);
    f.finish(f.sent()[2].id, 6);
    await waitFor(() => f.owner.binaryMessages.length === 1);
    assertEquals(
      f.connection.writes.some((line) =>
        (JSON.parse(line) as JsonRecord).method === "stream/fail"
      ),
      false,
    );
  } finally {
    f.hub.close();
  }
});

Deno.test("sequential validation precedes lease acquisition and generations reset ownership", async () => {
  const f = await sequentialHubFixture();
  try {
    for (
      const [i, params] of [
        { offset: 0 },
        { sort: [] },
        { filter: null },
        { count: true },
        { max_rows: 0 },
        { max_rows: 2001 },
        { max_rows: null },
        { max_bytes: null },
        { max_bytes: -1 },
        { max_bytes: 0.5 },
        { max_bytes: "1" },
        { max_bytes: Number.MAX_SAFE_INTEGER + 1 },
      ].entries()
    ) {
      f.request(f.owner, `invalid-${i}`, params);
      assertEquals(
        f.owner.messages.find((m) => m.id === `invalid-${i}`)?.code,
        "invalid_request",
      );
    }
    f.request(f.other, "accepted");
    await waitFor(() => f.sent().length === 1);
    f.open(2);
    await f.owner.nextMessage((m) =>
      m.type === "view/open" &&
      ((m.message as JsonRecord).params as JsonRecord).generation === 2
    );
    f.request(f.other, "stale");
    assertEquals(
      f.other.messages.find((m) => m.id === "stale")?.code,
      "stale_generation",
    );
    f.request(f.owner, "new-generation", { generation: 2 });
    await waitFor(() => f.sent().length === 2);
    f.finish(f.sent()[0].id, 0);
    f.finish(f.sent()[1].id, 0, 2);
    await waitFor(() => f.owner.binaryMessages.length === 1);
    assertEquals(f.other.binaryMessages.length, 0);
    assertEquals(f.sent().length, 2);
  } finally {
    f.hub.close();
  }
});

Deno.test("sequential captured row caps are checked before acquiring a lease", async () => {
  const f = await sequentialHubFixture(1);
  try {
    f.request(f.owner, "over-cap", { max_rows: 2 });
    assertEquals(
      f.owner.messages.find((m) => m.id === "over-cap")?.code,
      "invalid_request",
    );
    assertEquals(f.sent().length, 0);
    f.request(f.other, "default-within-cap");
    await waitFor(() => f.sent().length === 1);
    assertEquals(
      f.other.messages.some((m) =>
        m.id === "default-within-cap" && m.type === "error"
      ),
      false,
    );
  } finally {
    f.hub.close();
  }
});

function cacheRequest(
  f: Awaited<ReturnType<typeof sequentialHubFixture>>,
  client: MemoryBrowser,
  id: string,
  method = "stream/cache/info",
  params: JsonRecord = {},
) {
  f.hub.handleBrowser(client, {
    type: "request",
    id,
    session: "r-9010-1",
    method,
    params: { view: "stream-1", generation: 1, ...params },
  });
  return client.messages.findLast((m) => m.id === id);
}
function cachedResult(value: JsonRecord | undefined): JsonRecord {
  return value?.result as JsonRecord;
}
function injectStreamResult(
  f: Awaited<ReturnType<typeof sequentialHubFixture>>,
  id: unknown,
  overrides: JsonRecord = {},
  bytes = new Uint8Array([0, 10, 255]),
) {
  const header = new TextEncoder().encode(
    JSON.stringify({
      id,
      result: {
        view: "stream-1",
        generation: 1,
        first_row: 0,
        rows_fetched: 3,
        rows_seen: 3,
        done: false,
        ...overrides,
        transfer: { encoding: "arrow-ipc", byte_length: bytes.length },
      },
      warnings: ["not retained in cache"],
    }) + "\n",
  );
  f.connection.injectRaw(concatBytes(header, bytes));
}
async function streamBarrier(
  f: Awaited<ReturnType<typeof sequentialHubFixture>>,
  nonce: string,
) {
  f.connection.inject({ method: "fixture/barrier", params: { nonce } });
  await f.other.nextMessage((m) =>
    m.type === "notification" &&
    ((m.message as JsonRecord)?.params as JsonRecord)?.nonce === nonce
  );
}

Deno.test("host cache serves any browser without R traffic or a lease and guards stale append cursors", async () => {
  const f = await sequentialHubFixture();
  try {
    const capability = (f.owner.messages[0].capabilities as JsonRecord)
      .stream_cache as JsonRecord;
    assertEquals(capability.version, 1);
    f.request(f.owner, "live", { after_page: -1 });
    await waitFor(() => f.sent().length === 1);
    assertEquals(
      Object.hasOwn(f.sent()[0].params as JsonRecord, "after_page"),
      false,
    );
    injectStreamResult(f, f.sent()[0].id);
    await waitFor(() => f.owner.binaryMessages.length === 1);
    assertEquals(f.owner.binaryCacheReplies[0], false);
    assertEquals(f.owner.messageCacheReplies[0], false);
    const live = decodeBrowserBinary(f.owner.binaryMessages[0]).envelope;
    assertEquals(
      ((live.result as JsonRecord).cache_page as JsonRecord).page,
      0,
    );
    const info = cachedResult(cacheRequest(f, f.other, "info"));
    assertEquals(f.other.messageCacheReplies.at(-1), true);
    assertEquals(info.last_page, 0);
    assertEquals(info.rows_seen, 3);
    assertEquals((info.pages as JsonRecord[])[0].byte_length, 3);
    cacheRequest(f, f.other, "get", "stream/cache/get", {
      page: 0,
      max_bytes: 3,
    });
    assertEquals(f.other.binaryMessages.length, 1);
    assertEquals(f.other.binaryCacheReplies[0], true);
    cacheRequest(f, f.other, "missing-page", "stream/cache/get", { page: 99 });
    assertEquals(f.other.messages.at(-1)?.code, "unavailable");
    assertEquals(f.other.messageCacheReplies.at(-1), true);
    const cached = decodeBrowserBinary(f.other.binaryMessages[0]);
    assertEquals([...cached.body], [0, 10, 255]);
    assertEquals(cached.envelope.warnings, []);
    assertEquals(
      (cached.envelope.result as JsonRecord).cache_page,
      (info.pages as JsonRecord[])[0],
    );
    assertEquals(f.sent().length, 1);
    f.request(f.other, "owned", { after_page: 0 });
    assertEquals(
      f.other.messages.find((m) => m.id === "owned")?.code,
      "in_use",
    );
    f.hub.detach(f.owner);
    f.request(f.other, "stale-tail", { after_page: -1 });
    assertEquals(
      f.other.messages.find((m) => m.id === "stale-tail")?.code,
      "cache_changed",
    );
    assertEquals(f.other.messages.find((m) => m.id === "stale-tail")?.details, {
      last_page: 0,
      rows_seen: 3,
      done: false,
    });
    assertEquals(f.sent().length, 1);
    const newcomer = new MemoryBrowser();
    f.hub.attach(newcomer);
    f.request(newcomer, "next", { after_page: 0 });
    await waitFor(() => f.sent().length === 2);
  } finally {
    f.hub.close();
  }
});

Deno.test("cancelled timed-out and detached valid stream pages enter the host cache", async () => {
  for (const scenario of ["cancel", "timeout", "detach"]) {
    const f = await sequentialHubFixture();
    try {
      f.request(
        f.owner,
        "pending",
        {},
        scenario === "timeout" ? 100 : undefined,
      );
      await waitFor(() => f.sent().length === 1);
      if (scenario === "cancel") {
        f.hub.handleBrowser(f.owner, {
          type: "cancel",
          id: "pending",
          session: "r-9010-1",
        });
      }
      if (scenario === "detach") f.hub.detach(f.owner);
      if (scenario === "timeout") {
        await f.owner.nextMessage((m) =>
          m.id === "pending" && m.code === "timeout"
        );
      }
      injectStreamResult(f, f.sent()[0].id);
      await streamBarrier(f, scenario);
      assertEquals(f.owner.binaryMessages.length, 0);
      const info = cachedResult(cacheRequest(f, f.other, `info-${scenario}`));
      assertEquals(info.last_page, 0);
      assertEquals(info.rows_seen, 3);
      cacheRequest(f, f.other, `get-${scenario}`, "stream/cache/get", {
        page: 0,
      });
      assertEquals(f.other.binaryMessages.length, 1);
      assertEquals(f.sent().length, 1);
    } finally {
      f.hub.close();
    }
  }
});

Deno.test("invalid late sequential bodies never populate cache or resurrect replaced generations", async () => {
  for (
    const scenario of [
      "view",
      "generation",
      "budget",
      "rows",
      "regression",
      "replacement",
    ]
  ) {
    const f = await sequentialHubFixture();
    try {
      if (scenario === "regression") {
        f.request(f.owner, "first");
        await waitFor(() => f.sent().length === 1);
        injectStreamResult(f, f.sent()[0].id);
        await streamBarrier(f, "first");
      }
      const index = f.sent().length;
      f.request(f.owner, "late", scenario === "budget" ? { max_bytes: 2 } : {});
      await waitFor(() => f.sent().length === index + 1);
      f.hub.handleBrowser(f.owner, {
        type: "cancel",
        id: "late",
        session: "r-9010-1",
      });
      if (scenario === "replacement") {
        f.open(2);
        await f.other.nextMessage((m) =>
          m.type === "view/open" &&
          ((m.message as JsonRecord).params as JsonRecord).generation === 2
        );
      }
      const override = scenario === "view"
        ? { view: "different" }
        : scenario === "generation"
        ? { generation: 2 }
        : scenario === "rows"
        ? { rows_seen: 9 }
        : {};
      injectStreamResult(f, f.sent()[index].id, override);
      await streamBarrier(f, scenario);
      const info = cachedResult(
        cacheRequest(f, f.other, "info", "stream/cache/info", {
          generation: scenario === "replacement" ? 2 : 1,
        }),
      );
      assertEquals(info.last_page, scenario === "regression" ? 0 : -1);
      assertEquals(
        (info.pages as JsonRecord[]).length,
        scenario === "regression" ? 1 : 0,
      );
    } finally {
      f.hub.close();
    }
  }
});

Deno.test("host cache validates catalog and get budgets and keeps disabled legacy behavior", async () => {
  const f = await sequentialHubFixture();
  try {
    for (
      const [index, params] of [
        { after_page: -1 },
        { after_page: null },
        { limit: 0 },
        { limit: 129 },
        { limit: "2" },
        { unexpected: true },
      ].entries()
    ) {
      assertEquals(
        cacheRequest(
          f,
          f.other,
          `invalid-${index}`,
          "stream/cache/info",
          params,
        )?.code,
        "invalid_request",
      );
    }
    f.request(f.owner, "live");
    await waitFor(() => f.sent().length === 1);
    injectStreamResult(f, f.sent()[0].id);
    await streamBarrier(f, "stored");
    assertEquals(
      cacheRequest(f, f.other, "small", "stream/cache/get", {
        page: 0,
        max_bytes: 2,
      })?.code,
      "limit_exceeded",
    );
    for (
      const [index, params] of [
        { page: -1 },
        { page: 0.5 },
        { page: 0, max_bytes: null },
        { page: 0, max_bytes: -1 },
        { page: 0, extra: true },
      ].entries()
    ) {
      assertEquals(
        cacheRequest(
          f,
          f.other,
          `invalid-get-${index}`,
          "stream/cache/get",
          params,
        )?.code,
        "invalid_request",
      );
    }
    assertEquals(
      cacheRequest(f, f.other, "missing", "stream/cache/get", { page: 99 })
        ?.code,
      "unavailable",
    );
    assertEquals(f.sent().length, 1);
  } finally {
    f.hub.close();
  }
  const disabled = await sequentialHubFixture(undefined, {
    streamCacheBytes: 0,
  });
  try {
    assertEquals(
      (disabled.owner.messages[0].capabilities as JsonRecord).stream_cache,
      false,
    );
    assertEquals(
      cacheRequest(disabled, disabled.other, "info")?.code,
      "unsupported",
    );
    disabled.request(disabled.owner, "legacy");
    await waitFor(() => disabled.sent().length === 1);
    injectStreamResult(disabled, disabled.sent()[0].id);
    await waitFor(() => disabled.owner.binaryMessages.length === 1);
    assertEquals(
      (decodeBrowserBinary(disabled.owner.binaryMessages[0]).envelope
        .result as JsonRecord).cache_page,
      undefined,
    );
  } finally {
    disabled.hub.close();
  }
});

Deno.test("stream cache invalidates on generation close cascade and session disconnect", async () => {
  const f = await sequentialHubFixture();
  try {
    f.request(f.owner, "old");
    await waitFor(() => f.sent().length === 1);
    injectStreamResult(f, f.sent()[0].id);
    await streamBarrier(f, "old");
    f.open(2);
    await f.other.nextMessage((m) =>
      m.type === "view/open" &&
      ((m.message as JsonRecord).params as JsonRecord).generation === 2
    );
    assertEquals(
      cacheRequest(f, f.other, "old-get", "stream/cache/get", { page: 0 })
        ?.code,
      "stale_generation",
    );
    assertEquals(
      cachedResult(
        cacheRequest(f, f.other, "fresh", "stream/cache/info", {
          generation: 2,
        }),
      ).last_page,
      -1,
    );
    f.request(f.owner, "new", { generation: 2 });
    await waitFor(() => f.sent().length === 2);
    injectStreamResult(f, f.sent()[1].id, { generation: 2 });
    await streamBarrier(f, "new");
    f.connection.inject(
      notification("view/closed", { view: "stream-1", generation: 2 }),
    );
    await f.other.nextMessage((m) => m.type === "view/closed");
    assertEquals(
      cacheRequest(f, f.other, "closed", "stream/cache/get", {
        page: 0,
        generation: 2,
      })?.code,
      "view_not_found",
    );
    openTable(f.connection);
    await f.other.nextMessage((m) =>
      m.type === "view/open" &&
      ((m.message as JsonRecord).params as JsonRecord).view === "table-1"
    );
    f.open(3, "table-1");
    await f.other.nextMessage((m) =>
      m.type === "view/open" &&
      ((m.message as JsonRecord).params as JsonRecord).generation === 3
    );
    f.request(f.owner, "child", { generation: 3 });
    await waitFor(() => f.sent().length === 3);
    injectStreamResult(f, f.sent()[2].id, { generation: 3 });
    await streamBarrier(f, "child");
    assertEquals(
      cachedResult(
        cacheRequest(f, f.other, "child-info", "stream/cache/info", {
          generation: 3,
        }),
      ).last_page,
      0,
    );
    f.connection.inject(
      notification("view/closed", { view: "table-1", generation: 1 }),
    );
    await f.other.nextMessage((m) =>
      m.type === "view/closed" &&
      ((m.message as JsonRecord).params as JsonRecord).view === "stream-1" &&
      ((m.message as JsonRecord).params as JsonRecord).generation === 3
    );
    assertEquals(
      cacheRequest(f, f.other, "cascade", "stream/cache/get", {
        page: 0,
        generation: 3,
      })?.code,
      "view_not_found",
    );
    f.open(4);
    await f.other.nextMessage((m) =>
      m.type === "view/open" &&
      ((m.message as JsonRecord).params as JsonRecord).generation === 4
    );
    f.connection.close();
    await f.other.nextMessage((m) => m.type === "session/closed");
    assertEquals(
      cacheRequest(f, f.other, "disconnected", "stream/cache/info", {
        generation: 3,
      })?.code,
      "session_not_found",
    );
  } finally {
    f.hub.close();
  }
});

Deno.test("host cache keeps progress after immediate eviction and accepts legacy repeated EOF", async () => {
  const f = await sequentialHubFixture(undefined, {
    streamCacheBytes: 1024,
    streamCacheViewBytes: 1024,
  });
  try {
    f.request(f.owner, "eof", { after_page: -1 });
    await waitFor(() => f.sent().length === 1);
    injectStreamResult(f, f.sent()[0].id, { done: true });
    await streamBarrier(f, "eof");
    assertEquals(cachedResult(cacheRequest(f, f.other, "info")), {
      view: "stream-1",
      generation: 1,
      pages: [],
      next_after: null,
      last_page: 0,
      rows_seen: 3,
      done: true,
      unavailable_before: 3,
    });
    assertEquals(
      cacheRequest(f, f.other, "get", "stream/cache/get", { page: 0 })?.code,
      "unavailable",
    );
    f.request(f.owner, "repeat");
    await waitFor(() => f.sent().length === 2);
    injectStreamResult(f, f.sent()[1].id, {
      first_row: 3,
      rows_fetched: 0,
      rows_seen: 3,
      done: true,
    }, new Uint8Array());
    await streamBarrier(f, "repeat");
    assertEquals(f.owner.binaryMessages.length, 2);
    const info = cachedResult(cacheRequest(f, f.other, "repeat-info"));
    assertEquals(info.last_page, 1);
    assertEquals(info.rows_seen, 3);
    assertEquals(info.done, true);
  } finally {
    f.hub.close();
  }
});

function refreshFixture(session: string, limits: JsonRecord = {}) {
  const hub = new Hub();
  const connection = new MemoryConnection();
  hub.acceptProducer(connection);
  connection.inject({
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session,
      limits: { ...DEFAULT_LIMITS, ...limits },
    },
  });
  const browser = new MemoryBrowser();
  hub.attach(browser);
  openTable(connection);
  const request = (id: string, method = "view/refresh", generation = 1) =>
    hub.handleBrowser(browser, {
      type: "request",
      id,
      session,
      method,
      params: { view: "table-1", generation },
    });
  const refreshed = (
    id: string,
    previous = 1,
    generation = previous + 1,
  ): JsonRecord => ({
    id,
    result: {
      view: "table-1",
      previous_generation: previous,
      generation,
      refreshed: true,
    },
    warnings: [],
  });
  return { hub, connection, browser, request, refreshed };
}

function messagesFor(browser: MemoryBrowser, id: string): JsonRecord[] {
  return browser.messages.filter((message) => message.id === id);
}

Deno.test("a successful refresh response is delivered after its own view/open", async () => {
  const f = refreshFixture("r-9100-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("refresh");
    const sent = await f.connection.nextWrite(0);
    assertEquals(sent.method, "view/refresh");
    assertEquals(sent.params, { view: "table-1", generation: 1 });

    // R queues the new generation's view/open before the response.
    openTable(f.connection, 2);
    f.connection.inject(f.refreshed(sent.id as string));
    const response = await f.browser.nextMessage((message) =>
      message.type === "response" && message.id === "refresh"
    );
    assertEquals((response.result as JsonRecord).generation, 2);
    const opens = f.browser.messages.filter((message) =>
      message.type === "view/open"
    );
    assertEquals(opens.length, 2);
    assertEquals(messagesFor(f.browser, "refresh").length, 1);
    // The next request on the new generation is accepted.
    f.request("after", "view/schema", 2);
    const next = await f.connection.nextWrite(1);
    assertEquals((next.params as JsonRecord).generation, 2);
  } finally {
    f.hub.close();
  }
});

Deno.test("a failed refresh response is delivered even after a newer view/open", async () => {
  const f = refreshFixture("r-9101-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("failing");
    const sent = await f.connection.nextWrite(0);
    openTable(f.connection, 2);
    f.connection.inject({
      id: sent.id,
      error: { code: "stale_generation", message: "stale" },
      warnings: [],
    });
    const error = await f.browser.nextMessage((message) =>
      message.id === "failing" && message.type === "response"
    );
    assertEquals((error.error as JsonRecord).code, "stale_generation");

    f.request("r-error", "view/refresh", 2);
    const second = await f.connection.nextWrite(1);
    f.connection.inject({
      id: second.id,
      error: { code: "producer_error", message: "boom" },
      warnings: [],
    });
    const failure = await f.browser.nextMessage((message) =>
      message.id === "r-error" && message.type === "response"
    );
    assertEquals((failure.error as JsonRecord).code, "producer_error");
  } finally {
    f.hub.close();
  }
});

Deno.test("a refresh response that does not match the request is rejected", async () => {
  const f = refreshFixture("r-9102-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    const cases: Array<[string, JsonRecord]> = [
      ["wrong-previous", { previous_generation: 5, generation: 6 }],
      ["wrong-next", { previous_generation: 1, generation: 3 }],
      ["wrong-view", { view: "other", previous_generation: 1, generation: 2 }],
      ["not-refreshed", {
        previous_generation: 1,
        generation: 2,
        refreshed: false,
      }],
    ];
    let index = 0;
    for (const [id, override] of cases) {
      f.request(id);
      const sent = await f.connection.nextWrite(index++);
      const base = f.refreshed(sent.id as string).result as JsonRecord;
      f.connection.inject({
        id: sent.id,
        result: { ...base, ...override },
        warnings: [],
      });
      const error = await f.browser.nextMessage((message) =>
        message.type === "error" && message.id === id
      );
      assertEquals(error.code, "invalid_request");
    }
    assertEquals(
      f.browser.messages.some((message) => message.type === "response"),
      false,
    );
  } finally {
    f.hub.close();
  }
});

Deno.test("view/refresh accepts only view and generation", async () => {
  const f = refreshFixture("r-9103-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.hub.handleBrowser(f.browser, {
      type: "request",
      id: "extra",
      session: "r-9103-1",
      method: "view/refresh",
      params: { view: "table-1", generation: 1, mode: "paged" },
    });
    const error = await f.browser.nextMessage((message) =>
      message.id === "extra"
    );
    assertEquals(error.code, "invalid_request");
    f.hub.handleBrowser(f.browser, {
      type: "request",
      id: "stale",
      session: "r-9103-1",
      method: "view/refresh",
      params: { view: "table-1", generation: 9 },
    });
    const stale = await f.browser.nextMessage((message) =>
      message.id === "stale"
    );
    assertEquals(stale.code, "stale_generation");
    assertEquals(f.connection.writes.length, 0);
  } finally {
    f.hub.close();
  }
});

Deno.test("an older-generation read is cancelled but the sent refresh survives", async () => {
  const f = refreshFixture("r-9104-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("read", "view/schema");
    f.request("refresh");
    const read = await f.connection.nextWrite(0);
    const refresh = await f.connection.nextWrite(1);
    assertEquals(read.method, "view/schema");
    assertEquals(refresh.method, "view/refresh");

    openTable(f.connection, 2);
    const stale = await f.browser.nextMessage((message) =>
      message.type === "error" && message.id === "read"
    );
    assertEquals(stale.code, "stale_generation");
    await waitFor(() =>
      f.connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "cancel" &&
          (value.params as JsonRecord).id === read.id;
      })
    );
    assertEquals(
      f.connection.writes.some((line) => {
        const value = JSON.parse(line) as JsonRecord;
        return value.method === "cancel" &&
          (value.params as JsonRecord).id === refresh.id;
      }),
      false,
    );
    f.connection.inject(f.refreshed(refresh.id as string));
    await f.browser.nextMessage((message) =>
      message.type === "response" && message.id === "refresh"
    );
    // The late result of the cancelled read is not delivered.
    f.connection.inject({ id: read.id, result: { columns: [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(messagesFor(f.browser, "read").length, 1);
  } finally {
    f.hub.close();
  }
});

Deno.test("an unsent refresh of an older generation is invalidated", async () => {
  const f = refreshFixture("r-9105-1", { queue_messages: 1 });
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("read", "view/schema");
    f.request("queued-refresh");
    const read = await f.connection.nextWrite(0);
    assertEquals(f.connection.writes.length, 1);

    openTable(f.connection, 2);
    const stale = await f.browser.nextMessage((message) =>
      message.type === "error" && message.id === "queued-refresh"
    );
    assertEquals(stale.code, "stale_generation");
    f.connection.inject({ id: read.id, result: { columns: [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(
      f.connection.writes.filter((line) =>
        (JSON.parse(line) as JsonRecord).method === "view/refresh"
      ).length,
      0,
    );
  } finally {
    f.hub.close();
  }
});

Deno.test("a refresh still times out, cancels, and ends on disconnect", async () => {
  const f = refreshFixture("r-9106-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.hub.handleBrowser(f.browser, {
      type: "request",
      id: "times-out",
      session: "r-9106-1",
      method: "view/refresh",
      params: { view: "table-1", generation: 1 },
      timeoutMs: 100,
    });
    const first = await f.connection.nextWrite(0);
    const timeout = await f.browser.nextMessage((message) =>
      message.type === "error" && message.code === "timeout"
    );
    assertEquals(timeout.id, "times-out");
    openTable(f.connection, 2);
    f.connection.inject(f.refreshed(first.id as string));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(
      f.browser.messages.some((message) => message.type === "response"),
      false,
    );

    f.request("cancelled", "view/refresh", 2);
    const second = await f.connection.nextWrite(
      f.connection.writes.length,
    );
    assertEquals(second.method, "view/refresh");
    f.hub.handleBrowser(f.browser, {
      type: "cancel",
      session: "r-9106-1",
      id: "cancelled",
    });
    await f.browser.nextMessage((message) =>
      message.type === "cancelled" && message.id === "cancelled"
    );
    f.connection.inject(f.refreshed(second.id as string, 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(messagesFor(f.browser, "cancelled").length, 1);

    f.request("detached", "view/refresh", 2);
    const third = await f.connection.nextWrite(f.connection.writes.length);
    f.hub.detach(f.browser);
    const before = f.browser.messages.length;
    f.connection.inject(f.refreshed(third.id as string, 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(f.browser.messages.length, before);
  } finally {
    f.hub.close();
  }
});

Deno.test("an older refresh response never rolls the cached view back", async () => {
  const f = refreshFixture("r-9107-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("refresh");
    const sent = await f.connection.nextWrite(0);
    openTable(f.connection, 2);
    openTable(f.connection, 3);
    f.connection.inject(f.refreshed(sent.id as string));
    await f.browser.nextMessage((message) =>
      message.type === "response" && message.id === "refresh"
    );
    // The hub still serves generation 3 only.
    f.request("old", "view/schema", 2);
    const stale = await f.browser.nextMessage((message) =>
      message.id === "old"
    );
    assertEquals(stale.code, "stale_generation");
    f.request("new", "view/schema", 3);
    const next = await f.connection.nextWrite(1);
    assertEquals((next.params as JsonRecord).generation, 3);
  } finally {
    f.hub.close();
  }
});

Deno.test("view/update_failed reaches browsers only for the current generation", async () => {
  const f = refreshFixture("r-9200-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    const failed = (params: JsonRecord) =>
      f.connection.inject(notification("view/update_failed", params));
    const barrier = async (nonce: string) => {
      f.connection.inject(notification("fixture/barrier", { nonce }));
      await f.browser.nextMessage((message) =>
        message.type === "notification" &&
        ((message.message as JsonRecord)?.params as JsonRecord)?.nonce ===
          nonce
      );
    };
    const reports = () =>
      f.browser.messages.filter((message) =>
        (message.message as JsonRecord | undefined)?.method ===
          "view/update_failed"
      );

    failed({
      view: "table-1",
      generation: 1,
      code: "limit_exceeded",
      message: "x".repeat(2000),
      extra: "dropped",
    });
    await barrier("one");
    assertEquals(reports().length, 1);
    const delivered = (reports()[0].message as JsonRecord)
      .params as JsonRecord;
    assertEquals(Object.keys(delivered).sort(), [
      "code",
      "generation",
      "message",
      "view",
    ]);
    assertEquals(delivered.code, "limit_exceeded");
    assertEquals((delivered.message as string).length, 1024);

    // Unknown views, other generations, and malformed reports are dropped.
    failed({ view: "other", generation: 1, code: "producer_error", message: "m" });
    failed({ view: "table-1", generation: 2, code: "producer_error", message: "m" });
    failed({ view: "table-1", generation: 1, code: 7, message: "m" });
    failed({ view: "table-1", generation: 1, code: "producer_error" });
    failed("not an object" as unknown as JsonRecord);
    await barrier("two");
    assertEquals(reports().length, 1);

    // After a newer view/open the old generation is stale.
    openTable(f.connection, 2);
    failed({ view: "table-1", generation: 1, code: "producer_error", message: "m" });
    failed({ view: "table-1", generation: 2, code: "producer_error", message: "m" });
    await barrier("three");
    assertEquals(reports().length, 2);
    assertEquals(
      ((reports()[1].message as JsonRecord).params as JsonRecord).generation,
      2,
    );
  } finally {
    f.hub.close();
  }
});

function trackedOpen(
  connection: MemoryConnection,
  generation: number,
  state = "active",
): void {
  connection.inject(notification("view/open", {
    view: "table-1",
    generation,
    kind: "grid",
    access: "snapshot",
    encoding: "r-json",
    title: "Snapshot",
    mode: "snapshot",
    reason: generation === 1 ? "register" : "tracked",
    nrow: 1,
    ncol: 1,
    columns: [{
      position: 0,
      name: "x",
      type: "integer",
      sortable: true,
      filterable: true,
    }],
    capabilities: {
      seek: true,
      sort: true,
      filter: true,
      known_total: true,
      next: false,
      children: false,
      refresh: true,
      track: true,
    },
    tracking: { name: "df", state },
    data: { columns: ["x"], rows: [[1]] },
  }));
}

function trackFixture(session: string) {
  const f = refreshFixture(session);
  const track = (
    id: string,
    enabled: unknown,
    generation = 1,
    extra: JsonRecord = {},
  ) =>
    f.hub.handleBrowser(f.browser, {
      type: "request",
      id,
      session,
      method: "view/track",
      params: { view: "table-1", generation, enabled, ...extra },
    });
  return { ...f, track };
}

Deno.test("view/track is forwarded and validated", async () => {
  const f = trackFixture("r-9300-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    for (
      const [id, enabled, extra] of [
        ["not-boolean", "yes", {}],
        ["missing", undefined, {}],
        ["extra", true, { mode: "paged" }],
      ] as Array<[string, unknown, JsonRecord]>
    ) {
      f.track(id, enabled, 1, extra);
      const error = await f.browser.nextMessage((message) => message.id === id);
      assertEquals(error.code, "invalid_request");
    }
    f.track("stale", false, 9);
    const stale = await f.browser.nextMessage((message) =>
      message.id === "stale"
    );
    assertEquals(stale.code, "stale_generation");
    assertEquals(f.connection.writes.length, 0);

    f.track("pause", false);
    const sent = await f.connection.nextWrite(0);
    assertEquals(sent.method, "view/track");
    assertEquals(sent.params, {
      view: "table-1",
      generation: 1,
      enabled: false,
    });
    f.connection.inject({
      id: sent.id,
      result: {
        view: "table-1",
        generation: 1,
        tracking: { name: "df", state: "paused" },
      },
      warnings: [],
    });
    const response = await f.browser.nextMessage((message) =>
      message.type === "response" && message.id === "pause"
    );
    assertEquals(
      ((response.result as JsonRecord).tracking as JsonRecord).state,
      "paused",
    );
  } finally {
    f.hub.close();
  }
});

Deno.test("a resuming view/track survives the view/open it caused", async () => {
  const f = trackFixture("r-9301-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.track("resume", true);
    const sent = await f.connection.nextWrite(0);
    trackedOpen(f.connection, 2);
    f.connection.inject({
      id: sent.id,
      result: {
        view: "table-1",
        generation: 2,
        tracking: { name: "df", state: "active" },
      },
      warnings: [],
    });
    const response = await f.browser.nextMessage((message) =>
      message.type === "response" && message.id === "resume"
    );
    assertEquals((response.result as JsonRecord).generation, 2);

    // A response that does not match the request is refused.
    f.track("bad", false, 2);
    const bad = await f.connection.nextWrite(1);
    f.connection.inject({
      id: bad.id,
      result: { view: "table-1", generation: 5, tracking: "paused" },
      warnings: [],
    });
    const error = await f.browser.nextMessage((message) =>
      message.id === "bad" && message.type === "error"
    );
    assertEquals(error.code, "invalid_request");
  } finally {
    f.hub.close();
  }
});

Deno.test("view/tracking updates the cached descriptor and reaches browsers for the current generation", async () => {
  const f = trackFixture("r-9302-1");
  try {
    await f.browser.nextMessage((message) => message.type === "view/open");
    const barrier = async (nonce: string) => {
      f.connection.inject(notification("fixture/barrier", { nonce }));
      await f.browser.nextMessage((message) =>
        message.type === "notification" &&
        ((message.message as JsonRecord)?.params as JsonRecord)?.nonce ===
          nonce
      );
    };
    const tracking = () =>
      f.browser.messages.filter((message) =>
        (message.message as JsonRecord | undefined)?.method ===
          "view/tracking"
      );

    f.connection.inject(notification("view/tracking", {
      view: "table-1",
      generation: 1,
      tracking: {
        name: "df",
        state: "lost",
        reason: "removed",
        message: "m".repeat(2000),
        extra: "dropped",
      },
      extra: "dropped",
    }));
    await barrier("one");
    assertEquals(tracking().length, 1);
    assertEquals((tracking()[0].message as JsonRecord).params, {
      view: "table-1",
      generation: 1,
      tracking: {
        name: "df",
        state: "lost",
        reason: "removed",
        message: "m".repeat(1024),
      },
    });

    // Other generations, unknown views, and malformed reports are dropped.
    for (
      const params of [
        {
          view: "table-1",
          generation: 2,
          tracking: { name: "df", state: "paused" },
        },
        {
          view: "nope",
          generation: 1,
          tracking: { name: "df", state: "paused" },
        },
        {
          view: "table-1",
          generation: 1,
          tracking: { name: "df", state: "x" },
        },
        { view: "table-1", generation: 1 },
      ]
    ) f.connection.inject(notification("view/tracking", params));
    await barrier("two");
    assertEquals(tracking().length, 1);

    // A browser that connects later sees the current state.
    const late = new MemoryBrowser();
    f.hub.attach(late);
    const welcome = late.messages[0];
    const views = (welcome.sessions as JsonRecord[])[0].views as JsonRecord[];
    const params = views[0].params as JsonRecord;
    assertEquals((params.tracking as JsonRecord).state, "lost");
    assertEquals((params.capabilities as JsonRecord).track, false);
  } finally {
    f.hub.close();
  }
});

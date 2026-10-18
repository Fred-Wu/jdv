import { assertEquals } from "./assert.ts";
import { assertStringIncludes } from "./assert.ts";
import {
  type JsonObject,
  MAX_PRODUCER_BINARY_FRAME_BYTES,
  startProtocolPeer,
} from "../producer_listener.ts";
import type { ByteConnection } from "../platform.ts";

class ReadConnection implements ByteConnection {
  readonly writes: string[] = [];
  #chunks: Array<Uint8Array | null> = [];
  #waiters: Array<(value: Uint8Array | null) => void> = [];
  closed = false;

  read(): Promise<Uint8Array | null> {
    if (this.#chunks.length) {
      return Promise.resolve(this.#chunks.shift() ?? null);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(new TextDecoder().decode(bytes));
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.push(null);
  }

  push(value: Uint8Array | null): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#chunks.push(value);
  }
}

Deno.test("protocol peer parses JSON Lines (JSONL) frames split across chunks and serializes writes", async () => {
  const connection = new ReadConnection();
  const messages: JsonObject[] = [];
  let closes = 0;
  const peer = startProtocolPeer(
    connection,
    (message) => messages.push(message),
    () => closes++,
  );
  const bytes = new TextEncoder().encode('{"name":"東京"}\n{"n":2}\n');
  connection.push(bytes.slice(0, 8));
  connection.push(bytes.slice(8));
  for (let i = 0; i < 100 && messages.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(messages, [{ name: "東京" }, { n: 2 }]);
  await Promise.all([peer.send({ id: "a" }), peer.send({ id: "b" })]);
  assertEquals(connection.writes, ['{"id":"a"}\n', '{"id":"b"}\n']);
  peer.close();
  peer.close();
  assertEquals(closes, 1);
});

Deno.test("protocol peer rejects malformed JSON and closes exactly once", async () => {
  const connection = new ReadConnection();
  let closes = 0;
  startProtocolPeer(connection, () => {}, () => closes++);
  connection.push(new TextEncoder().encode("{bad}\n"));
  for (let i = 0; i < 100 && !connection.closed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(connection.closed, true);
  assertEquals(closes, 1);
});

Deno.test("a read resolved before peer close does not deliver after close", async () => {
  const connection = new ReadConnection();
  const messages: JsonObject[] = [];
  let closes = 0;
  const peer = startProtocolPeer(
    connection,
    (message) => messages.push(message),
    () => closes++,
  );
  connection.push(new TextEncoder().encode('{"method":"hello"}\n'));
  peer.close();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(messages, []);
  assertEquals(closes, 1);
});

Deno.test("protocol peer delivers opaque binary bodies before parsing the next JSONL frame", async () => {
  const connection = new ReadConnection();
  const messages: Array<{ message: JsonObject; body?: Uint8Array }> = [];
  const peer = startProtocolPeer(
    connection,
    (message, body) => messages.push({ message, body }),
    () => {},
  );
  const header = new TextEncoder().encode(
    `${
      JSON.stringify({
        id: "r-1",
        result: {
          view: "v-1",
          generation: 1,
          transfer: { encoding: "arrow-ipc", byte_length: 5 },
        },
        warnings: [],
      })
    }\n`,
  );
  const body = new Uint8Array([0x00, 0x0a, 0x0d, 0xff, 0x7f]);
  const next = new TextEncoder().encode(
    '{"method":"ack","params":{"frames":1}}\n',
  );
  connection.push(header);
  connection.push(body.slice(0, 2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(messages, []);
  connection.push(concatBytes(body.slice(2), next));
  for (let i = 0; i < 100 && messages.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(messages[0], {
    message: {
      id: "r-1",
      result: {
        view: "v-1",
        generation: 1,
        transfer: { encoding: "arrow-ipc", byte_length: 5 },
      },
      warnings: [],
    },
    body,
  });
  assertEquals(messages[1]?.message, { method: "ack", params: { frames: 1 } });
  peer.close();
});

Deno.test("protocol peer rejects invalid and oversized binary transfer descriptors", async () => {
  const validTransfer = { encoding: "arrow-ipc", byte_length: 1 };
  const malformed = [
    {
      id: "r-1",
      result: {
        view: "v-1",
        generation: 1,
        transfer: { ...validTransfer, encoding: "unknown" },
      },
    },
    {
      id: "r-1",
      result: {
        view: "v-1",
        generation: 1,
        transfer: { ...validTransfer, byte_length: -1 },
      },
    },
    {
      id: "r-1",
      result: {
        view: "v-1",
        generation: 1,
        transfer: { ...validTransfer, byte_length: Number.MAX_SAFE_INTEGER },
      },
    },
    {
      id: "r-1",
      method: "grid/rows",
      result: { view: "v-1", generation: 1, transfer: validTransfer },
    },
    {
      id: "r-1",
      error: { code: "bad" },
      result: { view: "v-1", generation: 1, transfer: validTransfer },
    },
    { id: "r-1", result: { view: "", generation: 1, transfer: validTransfer } },
    {
      id: "r-1",
      result: { view: "v-1", generation: 0, transfer: validTransfer },
    },
  ];
  for (const message of malformed) {
    const connection = new ReadConnection();
    let closes = 0;
    startProtocolPeer(connection, () => {}, () => closes++);
    connection.push(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    for (let i = 0; i < 100 && !connection.closed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(connection.closed, true);
    assertEquals(closes, 1);
  }
  assertEquals(MAX_PRODUCER_BINARY_FRAME_BYTES, 10 * 1024 * 1024);
});

Deno.test("protocol peer closes on a partial binary body or its absolute timeout", async () => {
  for (const options of [{ binaryBodyTimeoutMs: 10 }, {}]) {
    const connection = new ReadConnection();
    let closeReason: unknown;
    startProtocolPeer(
      connection,
      () => {},
      (reason) => closeReason = reason,
      options,
    );
    connection.push(new TextEncoder().encode(`${
      JSON.stringify({
        id: "r-1",
        result: {
          view: "v-1",
          generation: 1,
          transfer: { encoding: "arrow-ipc", byte_length: 2 },
        },
      })
    }\n`));
    connection.push(new Uint8Array([0x01]));
    if (options.binaryBodyTimeoutMs) {
      for (let i = 0; i < 100 && !connection.closed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } else {
      connection.push(null);
      for (let i = 0; i < 100 && !connection.closed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    assertEquals(connection.closed, true);
    if (!(closeReason instanceof Error)) {
      throw new Error("Expected a binary close reason.");
    }
    assertStringIncludes(
      closeReason.message,
      options.binaryBodyTimeoutMs ? "absolute timeout" : "partial",
    );
  }
});

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

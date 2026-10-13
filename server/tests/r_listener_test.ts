import { assertEquals } from "./assert.ts";
import { type JsonObject, startRPeer } from "../r_listener.ts";
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

Deno.test("R peer parses NDJSON split across chunks and serializes writes", async () => {
  const connection = new ReadConnection();
  const messages: JsonObject[] = [];
  let closes = 0;
  const peer = startRPeer(
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

Deno.test("R peer rejects malformed JSON and closes exactly once", async () => {
  const connection = new ReadConnection();
  let closes = 0;
  startRPeer(connection, () => {}, () => closes++);
  connection.push(new TextEncoder().encode("{bad}\n"));
  for (let i = 0; i < 100 && !connection.closed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(connection.closed, true);
  assertEquals(closes, 1);
});

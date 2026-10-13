import type { ByteConnection } from "./platform.ts";

export const MAX_R_FRAME_BYTES = 10 * 1024 * 1024;

export interface JsonObject {
  [key: string]: unknown;
}

export interface RPeer {
  readonly connection: ByteConnection;
  readonly onMessage: (message: JsonObject) => void;
  readonly onClose: (reason: unknown) => void;
  send(message: JsonObject): Promise<void>;
  close(): void;
}

export function startRPeer(
  connection: ByteConnection,
  onMessage: (message: JsonObject) => void,
  onClose: (reason: unknown) => void,
): RPeer {
  const encoder = new TextEncoder();
  let closed = false;
  let writeTail = Promise.resolve();
  const peer: RPeer = {
    connection,
    onMessage,
    onClose,
    send(message) {
      if (closed) return Promise.reject(new Error("R connection is closed."));
      const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
      const next = writeTail.then(() => connection.write(bytes));
      writeTail = next.catch(() => undefined);
      return next;
    },
    close() {
      finish(null);
    },
  };

  void readFrames().catch((error) => finish(error));
  return peer;

  async function readFrames(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = new Uint8Array(0);
    while (!closed) {
      const chunk = await connection.read();
      if (chunk === null) {
        if (pending.length) {
          throw new Error("R closed with a partial NDJSON frame.");
        }
        finish(null);
        return;
      }
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let start = 0;
      for (let index = 0; index < merged.length; index++) {
        if (merged[index] !== 0x0a) continue;
        const frame = merged.subarray(start, index);
        if (frame.length > MAX_R_FRAME_BYTES) {
          throw new Error("R frame exceeds 10 MiB.");
        }
        if (frame.length === 0) {
          throw new Error("R sent an empty NDJSON frame.");
        }
        const value = JSON.parse(decoder.decode(frame)) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("R sent a JSON frame that is not an object.");
        }
        onMessage(value as JsonObject);
        if (closed) return;
        start = index + 1;
      }
      pending = merged.slice(start);
      if (pending.length > MAX_R_FRAME_BYTES) {
        throw new Error("R frame exceeds 10 MiB.");
      }
    }
  }

  function finish(reason: unknown): void {
    if (closed) return;
    closed = true;
    connection.close();
    onClose(reason);
  }
}

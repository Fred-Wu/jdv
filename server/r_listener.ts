import type { ByteConnection } from "./platform.ts";

export const MAX_R_FRAME_BYTES = 10 * 1024 * 1024;
export const MAX_R_BINARY_HEADER_BYTES = 64 * 1024;
export const MAX_R_BINARY_FRAME_BYTES = 10 * 1024 * 1024;
export const DEFAULT_R_BINARY_BODY_TIMEOUT_MS = 30_000;

export interface JsonObject {
  [key: string]: unknown;
}

export interface RPeer {
  readonly connection: ByteConnection;
  readonly onMessage: (message: JsonObject, body?: Uint8Array) => void;
  readonly onClose: (reason: unknown) => void;
  send(message: JsonObject): Promise<void>;
  close(): void;
}

export interface RPeerOptions {
  binaryBodyTimeoutMs?: number;
}

export function startRPeer(
  connection: ByteConnection,
  onMessage: (message: JsonObject, body?: Uint8Array) => void,
  onClose: (reason: unknown) => void,
  options: RPeerOptions = {},
): RPeer {
  const encoder = new TextEncoder();
  let closed = false;
  let writeTail = Promise.resolve();
  let binaryBody: {
    message: JsonObject;
    bytes: Uint8Array;
    copied: number;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;
  const binaryBodyTimeoutMs = options.binaryBodyTimeoutMs ??
    DEFAULT_R_BINARY_BODY_TIMEOUT_MS;
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
      if (closed) return;
      if (chunk === null) {
        if (pending.length || binaryBody) {
          throw new Error("R closed with a partial JSONL or binary frame.");
        }
        finish(null);
        return;
      }
      let offset = 0;
      while (offset < chunk.length && !closed) {
        if (binaryBody) {
          const transfer = binaryBody;
          const count = Math.min(
            transfer.bytes.length - transfer.copied,
            chunk.length - offset,
          );
          transfer.bytes.set(
            chunk.subarray(offset, offset + count),
            transfer.copied,
          );
          transfer.copied += count;
          offset += count;
          if (transfer.copied === transfer.bytes.length) {
            clearTimeout(transfer.timer);
            binaryBody = undefined;
            onMessage(transfer.message, transfer.bytes);
          }
          continue;
        }

        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          const remaining = chunk.subarray(offset);
          pending = new Uint8Array(append(pending, remaining));
          if (pending.length > MAX_R_FRAME_BYTES) {
            throw new Error("R JSONL frame exceeds 10 MiB.");
          }
          break;
        }
        const frame = append(pending, chunk.subarray(offset, newline));
        pending = new Uint8Array(0);
        if (frame.length > MAX_R_FRAME_BYTES) {
          throw new Error("R JSONL frame exceeds 10 MiB.");
        }
        if (frame.length === 0) {
          throw new Error("R sent an empty JSONL frame.");
        }
        const value = JSON.parse(decoder.decode(frame)) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("R sent a JSON frame that is not an object.");
        }
        const message = value as JsonObject;
        offset = newline + 1;
        const bodyLength = parseBinaryTransferLength(message, frame.length);
        if (bodyLength === null) {
          onMessage(message);
        } else {
          const bytes = new Uint8Array(bodyLength);
          const timer = setTimeout(() => {
            finish(new Error("R binary body exceeded its absolute timeout."));
          }, binaryBodyTimeoutMs);
          binaryBody = { message, bytes, copied: 0, timer };
          if (bodyLength === 0) {
            clearTimeout(timer);
            binaryBody = undefined;
            onMessage(message, bytes);
          }
        }
      }
    }
  }

  function finish(reason: unknown): void {
    if (closed) return;
    closed = true;
    if (binaryBody) clearTimeout(binaryBody.timer);
    binaryBody = undefined;
    connection.close();
    onClose(reason);
  }
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function parseBinaryTransferLength(
  message: JsonObject,
  headerBytes: number,
): number | null {
  if (!Object.hasOwn(message, "result") || !isObject(message.result)) {
    return null;
  }
  const result = message.result;
  if (!Object.hasOwn(result, "transfer")) return null;
  if (
    typeof message.id !== "string" || Object.hasOwn(message, "method") ||
    Object.hasOwn(message, "error") || typeof result.view !== "string" ||
    result.view.length === 0 || !Number.isSafeInteger(result.generation) ||
    Number(result.generation) < 1 ||
    !isObject(result.transfer) || result.transfer.encoding !== "arrow-ipc" ||
    !Number.isSafeInteger(result.transfer.byte_length) ||
    Number(result.transfer.byte_length) < 0
  ) throw new Error("R sent an invalid binary transfer descriptor.");
  if (headerBytes > MAX_R_BINARY_HEADER_BYTES) {
    throw new Error("R binary JSON header exceeds 64 KiB.");
  }
  const length = Number(result.transfer.byte_length);
  if (headerBytes + 1 + length > MAX_R_BINARY_FRAME_BYTES) {
    throw new Error("R binary frame exceeds 10 MiB.");
  }
  return length;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

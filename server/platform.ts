/** Deno-specific platform operations used by the reference server. */

import { createServer } from "node:net";
import { join } from "node:path";

export interface ByteConnection {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface ByteListener extends AsyncIterable<ByteConnection> {
  close(): void;
}

export function validateUnixSocketPath(
  path: string,
  os: string = Deno.build.os,
): void {
  const maximum = os === "darwin" ? 103 : 107;
  const bytes = new TextEncoder().encode(path).byteLength;
  if (bytes > maximum) {
    throw new Error(
      `Unix socket path is too long (${bytes} UTF-8 bytes; maximum ${maximum} on ${os}). Use a shorter --cache-dir or --tcp.`,
    );
  }
}

class DenoByteConnection implements ByteConnection {
  readonly #connection: Deno.Conn;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(connection: Deno.Conn) {
    this.#connection = connection;
    this.#reader = connection.readable.getReader();
    this.#writer = connection.writable.getWriter();
  }

  async read(): Promise<Uint8Array | null> {
    const result = await this.#reader.read();
    return result.done ? null : result.value;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.#writer.write(bytes);
  }

  close(): void {
    void this.#reader.cancel().catch(() => undefined);
    void this.#writer.abort().catch(() => undefined);
    try {
      this.#connection.close();
    } catch {
      // Close is idempotent from the server's perspective.
    }
  }
}

class DenoByteListener implements ByteListener {
  readonly #listener: Deno.Listener;
  #closed = false;

  constructor(listener: Deno.Listener) {
    this.#listener = listener;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ByteConnection> {
    try {
      for await (const connection of this.#listener) {
        yield new DenoByteConnection(connection);
      }
    } catch (error) {
      if (!this.#closed && !(error instanceof Deno.errors.BadResource)) {
        throw error;
      }
    }
  }

  close(): void {
    this.#closed = true;
    try {
      this.#listener.close();
    } catch {
      // Listener may already be closed.
    }
  }
}

class NodePipeConnection implements ByteConnection {
  readonly #socket: import("node:net").Socket;
  readonly #chunks: Uint8Array[] = [];
  readonly #waiters: Array<() => void> = [];
  #ended = false;
  #closed = false;

  constructor(socket: import("node:net").Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Uint8Array) => {
      this.#chunks.push(new Uint8Array(chunk));
      this.#wake();
    });
    socket.on("end", () => {
      this.#ended = true;
      this.#wake();
    });
    socket.on("close", () => {
      this.#ended = true;
      this.#wake();
    });
    socket.on("error", () => {
      this.#ended = true;
      this.#wake();
    });
  }

  async read(): Promise<Uint8Array | null> {
    while (!this.#chunks.length && !this.#ended) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.#chunks.shift() ?? null;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed || this.#ended) throw new Error("Named pipe is closed.");
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(bytes, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#ended = true;
    this.#wake();
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

export class NodePipeListener implements ByteListener {
  readonly #server = createServer();
  readonly ready: Promise<void>;
  readonly #queue: NodePipeConnection[] = [];
  readonly #waiters: Array<(connection: NodePipeConnection | null) => void> =
    [];
  #closed = false;

  constructor(path: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(path, () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
    this.#server.on("connection", (socket) => {
      const connection = new NodePipeConnection(socket);
      const waiter = this.#waiters.shift();
      if (waiter) waiter(connection);
      else this.#queue.push(connection);
    });
    this.#server.on("error", (error) => {
      for (const waiter of this.#waiters.splice(0)) waiter(null);
      console.error(`Named pipe listener failed: ${error.message}`);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ByteConnection> {
    while (!this.#closed) {
      const connection = this.#queue.shift() ??
        await new Promise<NodePipeConnection | null>(
          (resolve) => this.#waiters.push(resolve),
        );
      if (!connection) return;
      yield connection;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of this.#queue.splice(0)) connection.close();
    for (const waiter of this.#waiters.splice(0)) waiter(null);
    try {
      this.#server.close();
    } catch {
      // The server may not have reached its listening state.
    }
  }
}

export async function listenProducer(options: {
  mode: "default" | "tcp";
  cacheDir: string;
}): Promise<{ listener: ByteListener; socketPath: string }> {
  if (options.mode === "tcp") {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const address = listener.addr as Deno.NetAddr;
    return {
      listener: new DenoByteListener(listener),
      socketPath: `tcp://127.0.0.1:${address.port}`,
    };
  }

  if (Deno.build.os === "windows") {
    const name = `jdv-${crypto.randomUUID()}`;
    const pipePath = `\\\\.\\pipe\\${name}`;
    const listener = new NodePipeListener(pipePath);
    await listener.ready;
    return { listener, socketPath: `npipe:////./pipe/${name}` };
  }

  const path = join(options.cacheDir, `jdv-${crypto.randomUUID()}.sock`);
  validateUnixSocketPath(path);
  const listener = Deno.listen({ transport: "unix", path });
  try {
    Deno.chmodSync(path, 0o600);
  } catch (error) {
    listener.close();
    try {
      Deno.removeSync(path);
    } catch {
      // Preserve the original permission error.
    }
    throw error;
  }
  return {
    listener: new DenoByteListener(listener),
    socketPath: `unix://${path}`,
  };
}

export function cacheDirectory(): string {
  const home = nonEmptyEnv("HOME") ?? nonEmptyEnv("USERPROFILE") ?? ".";
  if (Deno.build.os === "windows") {
    return join(
      nonEmptyEnv("LOCALAPPDATA") ?? join(home, "AppData", "Local"),
      "jdv",
    );
  }
  if (Deno.build.os === "darwin") return join(home, "Library", "Caches", "jdv");
  return join(nonEmptyEnv("XDG_CACHE_HOME") ?? join(home, ".cache"), "jdv");
}

function nonEmptyEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.length > 0 ? value : undefined;
}

export async function preparePrivateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o700);
}

export async function writeAtomicPrivate(
  path: string,
  contents: string,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await Deno.open(temporary, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  let writeError: unknown;
  let writeFailed = false;
  try {
    const bytes = new TextEncoder().encode(contents);
    let offset = 0;
    while (offset < bytes.length) {
      const written = await file.write(bytes.subarray(offset));
      if (written === 0) {
        throw new Error("Discovery file write made no progress.");
      }
      offset += written;
    }
    await file.sync();
  } catch (error) {
    writeFailed = true;
    writeError = error;
  } finally {
    file.close();
  }
  if (writeFailed) {
    try {
      await Deno.remove(temporary);
    } catch {
      // Preserve the original write error.
    }
    throw writeError;
  }
  try {
    await Deno.rename(temporary, path);
    if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch {
      // The rename may already have moved the temporary file.
    }
    throw error;
  }
}

export async function removeIfOwned(
  path: string,
  pid: number,
  instance: string,
): Promise<void> {
  try {
    const value = JSON.parse(await Deno.readTextFile(path)) as {
      pid?: number;
      instance?: string;
    };
    if (value.pid === pid && value.instance === instance) {
      await Deno.remove(path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`Could not remove discovery file: ${error}`);
    }
  }
}

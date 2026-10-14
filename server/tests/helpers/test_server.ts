/** Real reference server and TCP wire observer for end-to-end tests. */

interface RunningServer {
  url: string;
  socketPath: string;
  discoveryPath: string;
  close(): Promise<void>;
}

export interface WireFrame {
  direction: "r-to-server" | "server-to-r";
  bytes: number;
  method?: string;
  id?: string | number;
  view?: string;
  generation?: number;
  offset?: number;
  limit?: number;
  rowCount?: number;
  dataBytes?: number;
  hasData?: boolean;
  clientId?: string;
}

export interface WireSnapshot {
  /** Frames sent by R to the reference server. */
  fromRFrames: WireFrame[];
  /** Frames sent by the reference server to R. */
  toRFrames: WireFrame[];
  rToServerFrames: WireFrame[];
  serverToRFrames: WireFrame[];
  tableRowsRequests: WireFrame[];
  tableRowsResponses: WireFrame[];
  tableOpenDescriptors: WireFrame[];
  observationErrors: string[];
}

export interface TestBrowser {
  read(timeoutMs?: number): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  close(): void;
}

interface RelayConnection {
  client: Deno.Conn;
  upstream: Deno.Conn;
}

interface BrowserRowRequest {
  id: string;
  view?: string;
  generation?: number;
  offset?: number;
  limit?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class TestServer {
  #server?: RunningServer;
  #cacheRoot?: string;
  #relay?: Deno.Listener;
  #connections = new Set<RelayConnection>();
  #bridgeTasks = new Set<Promise<void>>();
  #relayTask?: Promise<void>;
  #rToServerFrames: WireFrame[] = [];
  #serverToRFrames: WireFrame[] = [];
  #tableRowsRequests: WireFrame[] = [];
  #tableRowsResponses: WireFrame[] = [];
  #tableOpenDescriptors: WireFrame[] = [];
  #requestMethods = new Map<string, string>();
  #browserRowsQueue: BrowserRowRequest[] = [];
  #rRequestClientIds = new Map<string, string>();
  #changeWaiters = new Set<() => void>();
  #observationErrors: string[] = [];
  #closed = false;

  get url(): string {
    if (!this.#server) throw new Error("TestServer has not started.");
    return this.#server.url;
  }

  get rAddress(): string {
    const address = this.#relay?.addr;
    if (!address || address.transport !== "tcp") {
      throw new Error("TestServer TCP relay has not started.");
    }
    return `tcp://${address.hostname}:${address.port}`;
  }

  get wire(): {
    snapshot(): WireSnapshot;
    waitFor(
      predicate: (snapshot: WireSnapshot) => boolean,
      timeoutMs?: number,
    ): Promise<WireSnapshot>;
  } {
    return {
      snapshot: () => this.#snapshot(),
      waitFor: (predicate, timeoutMs = 5_000) =>
        this.#waitForWire(predicate, timeoutMs),
    };
  }

  async start(): Promise<void> {
    if (this.#server || this.#relay) {
      throw new Error("TestServer is already running.");
    }
    this.#closed = false;
    this.#cacheRoot = await Deno.makeTempDir({ prefix: "jdv-e2e-" });
    try {
      const { startServer } = await import("../../main.ts");
      this.#server = await startServer({
        mode: "tcp",
        httpPort: 0,
        cacheDir: `${this.#cacheRoot}/server`,
      });
      const serverAddress = new URL(this.#server.socketPath);
      this.#relay = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      this.#relayTask = this.#acceptLoop(
        serverAddress.hostname,
        Number(serverAddress.port),
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Return an environment overlay that connects R through the test relay. */
  rEnv(libPath?: string): Record<string, string> {
    if (!this.#cacheRoot) throw new Error("TestServer has not started.");
    const env = Deno.env.toObject();
    for (
      const name of [
        "JDV_DISCOVERY_PATH",
        "JDV_CACHE_DIR",
        "R_PROFILE_USER",
        "R_ENVIRON_USER",
        "ARF_CONFIG",
      ]
    ) delete env[name];
    env.JDV_ADDRESS = this.rAddress;
    env.XDG_CACHE_HOME = this.#cacheRoot;
    if (libPath) env.R_LIBS_USER = libPath;
    return env;
  }

  async connectBrowser(): Promise<TestBrowser> {
    return await RawTestBrowser.connect(
      this.url,
      (message) => {
        if (
          message.type === "request" && message.method === "table/rows" &&
          typeof message.id === "string"
        ) {
          const params = isRecord(message.params) ? message.params : {};
          this.#browserRowsQueue.push({
            id: message.id,
            view: typeof params.view === "string" ? params.view : undefined,
            generation: typeof params.generation === "number"
              ? params.generation
              : undefined,
            offset: typeof params.offset === "number"
              ? params.offset
              : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          });
        }
      },
      (message) => {
        if (message.type === "response" && typeof message.id === "string") {
          const index = this.#browserRowsQueue.findIndex((request) =>
            request.id === message.id
          );
          if (index >= 0) this.#browserRowsQueue.splice(index, 1);
        }
      },
    );
  }

  /** Disconnect all R TCP clients while keeping the server and relay alive. */
  dropR(): void {
    for (const connection of this.#connections) {
      closeConnection(connection.client);
      closeConnection(connection.upstream);
    }
  }

  async stop(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#relay?.close();
    this.#relay = undefined;
    this.dropR();
    await this.#relayTask?.catch(() => undefined);
    this.#relayTask = undefined;
    await Promise.allSettled([...this.#bridgeTasks]);
    const server = this.#server;
    this.#server = undefined;
    await server?.close();
    const cacheRoot = this.#cacheRoot;
    this.#cacheRoot = undefined;
    if (cacheRoot) {
      await Deno.remove(cacheRoot, { recursive: true }).catch(() => undefined);
    }
    this.#notifyWireChanged();
  }

  async #acceptLoop(hostname: string, port: number): Promise<void> {
    const relay = this.#relay;
    if (!relay) return;
    try {
      for await (const client of relay) {
        if (this.#closed) {
          closeConnection(client);
          continue;
        }
        const task = this.#bridge(client, hostname, port).catch((error) => {
          this.#recordObservationError(String(error));
        }).finally(() => this.#bridgeTasks.delete(task));
        this.#bridgeTasks.add(task);
      }
    } catch (error) {
      if (!this.#closed && !(error instanceof Deno.errors.BadResource)) {
        throw error;
      }
    }
  }

  async #bridge(
    client: Deno.Conn,
    hostname: string,
    port: number,
  ): Promise<void> {
    let upstream: Deno.Conn;
    try {
      upstream = await Deno.connect({ hostname, port });
    } catch {
      closeConnection(client);
      return;
    }
    if (this.#closed) {
      closeConnection(client);
      closeConnection(upstream);
      return;
    }
    const pair = { client, upstream };
    this.#connections.add(pair);
    const fromRRecorder = new JsonLineRecorder(
      (frame) => this.#recordFrame(frame),
      (error) => this.#recordObservationError(error),
    );
    const toRRecorder = new JsonLineRecorder(
      (frame) => this.#recordFrame(frame),
      (error) => this.#recordObservationError(error),
    );
    const fromR = this.#copy(client, upstream, "r-to-server", fromRRecorder);
    const toR = this.#copy(upstream, client, "server-to-r", toRRecorder);
    await Promise.race([fromR, toR]);
    closeConnection(client);
    closeConnection(upstream);
    await Promise.allSettled([fromR, toR]);
    fromRRecorder.finish();
    toRRecorder.finish();
    this.#connections.delete(pair);
  }

  async #copy(
    source: Deno.Conn,
    destination: Deno.Conn,
    direction: WireFrame["direction"],
    recorder: JsonLineRecorder,
  ): Promise<void> {
    const reader = source.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        recorder.push(value, direction);
        this.#notifyWireChanged();
        await writeAll(destination, value);
      }
    } catch {
      // Connection teardown is part of the test harness lifecycle.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The source may already be closed.
      }
    }
  }

  #recordFrame(frame: WireFrame): void {
    if (frame.direction === "r-to-server") {
      this.#rToServerFrames.push(frame);
      if (frame.method === "view/open") this.#tableOpenDescriptors.push(frame);
      if (
        frame.id !== undefined && this.#requestMethods.has(String(frame.id))
      ) {
        const method = this.#requestMethods.get(String(frame.id));
        if (method === "table/rows") {
          frame.clientId = this.#rRequestClientIds.get(String(frame.id));
          this.#tableRowsResponses.push(frame);
        }
        this.#requestMethods.delete(String(frame.id));
        this.#rRequestClientIds.delete(String(frame.id));
      }
    } else {
      this.#serverToRFrames.push(frame);
      if (frame.method === "table/rows") this.#tableRowsRequests.push(frame);
      if (frame.id !== undefined && frame.method) {
        this.#requestMethods.set(String(frame.id), frame.method);
        if (frame.method === "table/rows") {
          const index = this.#browserRowsQueue.findIndex((request) =>
            request.view === frame.view &&
            request.generation === frame.generation &&
            request.offset === frame.offset &&
            request.limit === frame.limit
          );
          const matched = index >= 0
            ? this.#browserRowsQueue.splice(index, 1)[0]
            : this.#browserRowsQueue.find((request) =>
              request.view === frame.view &&
              request.generation === frame.generation
            );
          if (matched) {
            this.#rRequestClientIds.set(String(frame.id), matched.id);
          }
        }
      }
    }
  }

  #snapshot(): WireSnapshot {
    const clone = (frames: WireFrame[]) =>
      frames.map((frame) => ({ ...frame }));
    const fromRFrames = clone(this.#rToServerFrames);
    const toRFrames = clone(this.#serverToRFrames);
    return {
      fromRFrames,
      toRFrames,
      rToServerFrames: fromRFrames,
      serverToRFrames: toRFrames,
      tableRowsRequests: clone(this.#tableRowsRequests),
      tableRowsResponses: clone(this.#tableRowsResponses),
      tableOpenDescriptors: clone(this.#tableOpenDescriptors),
      observationErrors: [...this.#observationErrors],
    };
  }

  async #waitForWire(
    predicate: (snapshot: WireSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<WireSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = this.#snapshot();
      if (snapshot.observationErrors.length) {
        throw new Error(
          `Wire observation failed: ${snapshot.observationErrors.join("; ")}`,
        );
      }
      if (predicate(snapshot)) return snapshot;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Wire condition timed out after ${timeoutMs} ms.`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#changeWaiters.delete(wake);
          reject(new Error(`Wire condition timed out after ${timeoutMs} ms.`));
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          this.#changeWaiters.delete(wake);
          resolve();
        };
        this.#changeWaiters.add(wake);
      });
    }
  }

  #notifyWireChanged(): void {
    for (const wake of [...this.#changeWaiters]) wake();
  }

  #recordObservationError(error: string): void {
    this.#observationErrors.push(error);
    this.#notifyWireChanged();
  }
}

class RawTestBrowser implements TestBrowser {
  readonly #connection: Deno.Conn;
  readonly #reader: TestWebSocketReader;
  readonly #queued: Record<string, unknown>[] = [];
  readonly #waiters: Array<{
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
  }> = [];
  #closed = false;
  #closing = false;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    connection: Deno.Conn,
    private readonly onSend: (message: Record<string, unknown>) => void,
    private readonly onReceive: (message: Record<string, unknown>) => void,
  ) {
    this.#connection = connection;
    this.#reader = new TestWebSocketReader(connection.readable);
  }

  static async connect(
    url: string,
    onSend: (message: Record<string, unknown>) => void,
    onReceive: (message: Record<string, unknown>) => void,
  ): Promise<RawTestBrowser> {
    const parsed = new URL(url);
    const connection = await Deno.connect({
      hostname: parsed.hostname,
      port: Number(parsed.port),
    });
    const browser = new RawTestBrowser(connection, onSend, onReceive);
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const key = btoa(String.fromCharCode(...nonce));
      await writeAll(
        connection,
        encoder.encode(
          `GET /ws HTTP/1.1\r\nHost: ${parsed.host}\r\nOrigin: ${parsed.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      const response = await browser.#reader.readHeaders();
      if (!response.startsWith("HTTP/1.1 101 ")) {
        throw new Error(
          `WebSocket upgrade failed: ${response.split("\r\n")[0]}`,
        );
      }
      const accept = response.match(/\r\nsec-websocket-accept:\s*(.+)\r\n/i)
        ?.[1];
      const digest = await crypto.subtle.digest(
        "SHA-1",
        encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
      );
      const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
      if (accept !== expected) {
        throw new Error("Invalid WebSocket accept value.");
      }
      void browser.#readLoop();
      return browser;
    } catch (error) {
      browser.close();
      throw error;
    }
  }

  read(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const existing = this.#queued.shift();
    if (existing) return Promise.resolve(existing);
    if (this.#closed) return Promise.reject(new Error("WebSocket is closed."));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter = {
        resolve: (value: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`WebSocket read timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
    });
  }

  send(message: Record<string, unknown>): void {
    if (this.#closed) throw new Error("WebSocket is closed.");
    const payload = encoder.encode(JSON.stringify(message));
    if (payload.length > 64 * 1024) {
      throw new Error("Browser WebSocket message exceeds 64 KiB.");
    }
    this.onSend(message);
    void this.#sendFrame(0x1, payload).catch((error) =>
      this.#finish(error instanceof Error ? error : new Error(String(error)))
    );
  }

  close(): void {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    void this.#sendFrame(0x8, new Uint8Array()).finally(() => {
      this.#finish(new Error("WebSocket was closed by the test."));
    });
  }

  async #readLoop(): Promise<void> {
    try {
      for (;;) {
        const { opcode, payload } = await this.#reader.readFrame();
        if (opcode === 0x9) {
          await this.#sendFrame(0xa, payload);
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x8) {
          this.#finish(new Error("Viewer closed the WebSocket."));
          return;
        }
        if (opcode !== 0x1) {
          throw new Error(`Unexpected WebSocket opcode ${opcode}.`);
        }
        const value = JSON.parse(decoder.decode(payload)) as Record<
          string,
          unknown
        >;
        this.onReceive(value);
        const waiter = this.#waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.#queued.push(value);
      }
    } catch (error) {
      this.#finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #sendFrame(opcode: number, payload: Uint8Array): Promise<void> {
    if (payload.length > 65_535) {
      throw new Error("WebSocket test frame exceeds 65535 bytes.");
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const prefix = payload.length < 126
      ? new Uint8Array([0x80 | opcode, 0x80 | payload.length])
      : new Uint8Array([
        0x80 | opcode,
        0xfe,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
      ]);
    const masked = payload.map((byte, index) => byte ^ mask[index % 4]);
    const write = this.#writeQueue.then(() =>
      writeAll(this.#connection, concatBytes(prefix, mask, masked))
    );
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  #finish(reason: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    closeConnection(this.#connection);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
  }
}

class TestWebSocketReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readHeaders(): Promise<string> {
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

  async readFrame(): Promise<{ opcode: number; payload: Uint8Array }> {
    const header = await this.#readExact(2);
    let length = header[1] & 0x7f;
    if (length === 126) {
      const extended = await this.#readExact(2);
      length = (extended[0] << 8) | extended[1];
    } else if (length === 127) {
      const extended = await this.#readExact(8);
      const value = new DataView(extended.buffer, extended.byteOffset)
        .getBigUint64(0, false);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame exceeds the safe size limit.");
      }
      length = Number(value);
    }
    return { opcode: header[0] & 0x0f, payload: await this.#readExact(length) };
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const { value, done } = await this.#reader.read();
      if (done) throw new Error("WebSocket connection ended unexpectedly.");
      this.#buffer = concatBytes(this.#buffer, value);
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
}

class JsonLineRecorder {
  #buffer = "";
  #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(
    private readonly onFrame: (frame: WireFrame) => void,
    private readonly onError: (error: string) => void,
  ) {}

  push(bytes: Uint8Array, direction: WireFrame["direction"]): void {
    try {
      this.#buffer += this.#decoder.decode(bytes, { stream: true });
    } catch (error) {
      this.onError(`Invalid UTF-8 in ${direction} wire: ${String(error)}`);
      this.#buffer = "";
      this.#decoder = new TextDecoder("utf-8", { fatal: true });
      return;
    }
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onFrame(
          summarizeFrame(
            JSON.parse(line),
            direction,
            encoder.encode(line).byteLength + 1,
          ),
        );
      } catch (error) {
        this.onError(
          `Could not observe ${direction} JSONL frame: ${String(error)}`,
        );
      }
    }
  }

  finish(): void {
    try {
      this.#buffer += this.#decoder.decode();
    } catch (error) {
      this.onError(`Incomplete UTF-8 in wire frame: ${String(error)}`);
    }
    if (this.#buffer.trim()) {
      this.onError("Wire connection ended with an incomplete JSONL frame.");
    }
    this.#buffer = "";
  }
}

function summarizeFrame(
  value: unknown,
  direction: WireFrame["direction"],
  bytes: number,
): WireFrame {
  const frame: WireFrame = { direction, bytes };
  if (!isRecord(value)) return frame;
  if (typeof value.method === "string") frame.method = value.method;
  if (typeof value.id === "string" || typeof value.id === "number") {
    frame.id = value.id;
  }
  const params = isRecord(value.params) ? value.params : undefined;
  const result = isRecord(value.result) ? value.result : undefined;
  const payload = params ?? result;
  if (payload) {
    if (typeof payload.view === "string") frame.view = payload.view;
    if (typeof payload.generation === "number") {
      frame.generation = payload.generation;
    }
    if (typeof payload.offset === "number") frame.offset = payload.offset;
    if (typeof payload.limit === "number") frame.limit = payload.limit;
    const data = isRecord(payload.data) ? payload.data : payload;
    if (Array.isArray(data.row_index)) frame.rowCount = data.row_index.length;
    if (payload.data !== undefined) {
      frame.hasData = true;
      frame.dataBytes = encoder.encode(JSON.stringify(payload.data)).byteLength;
    }
  }
  return frame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function closeConnection(connection: Deno.Conn): void {
  try {
    connection.close();
  } catch {
    // Closing a test socket is idempotent.
  }
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

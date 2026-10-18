/** R-free producer fixture for host compatibility and browser tests. */

type Json = Record<string, unknown>;

const limits = {
  max_unacked_frames: 16,
  max_unacked_bytes: 512 * 1024,
  queue_messages: 16,
  queue_bytes: 1024 * 1024,
  max_request_bytes: 1024,
  max_message_bytes: 1024 * 1024,
};

const arrowBundle = new URL(
  "../../web/vendor/arrow-21.2.0.min.js",
  import.meta.url,
);
let arrowPromise:
  | Promise<Record<string, (...args: never[]) => unknown>>
  | undefined;

async function arrow(): Promise<Record<string, (...args: never[]) => unknown>> {
  if (!arrowPromise) {
    arrowPromise = (async () => {
      const source = await Deno.readTextFile(arrowBundle);
      const wrapped = source.replace("}(this,", "}(globalThis,");
      new Function(wrapped)();
      return (globalThis as typeof globalThis & {
        Arrow: Record<string, (...args: never[]) => unknown>;
      }).Arrow;
    })();
  }
  return await arrowPromise;
}

export class NonRProducerHarness {
  readonly url: string;
  readonly producer: FixtureProducer;
  readonly #server: { close(): Promise<void> };
  readonly #cacheDir: string;
  readonly #socketPath: string;

  private constructor(
    server: { url: string; socketPath: string; close(): Promise<void> },
    producer: FixtureProducer,
    cacheDir: string,
    socketPath: string,
  ) {
    this.url = server.url;
    this.#server = server;
    this.producer = producer;
    this.#cacheDir = cacheDir;
    this.#socketPath = socketPath;
  }

  static async start(): Promise<NonRProducerHarness> {
    const { startServer } = await import("../../main.ts");
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-nonr-unit-" });
    const server = await startServer({ mode: "tcp", httpPort: 0, cacheDir });
    const address = new URL(server.socketPath);
    const connection = await Deno.connect({
      hostname: address.hostname,
      port: Number(address.port),
    });
    const producer = new FixtureProducer(connection);
    const harness = new NonRProducerHarness(
      server,
      producer,
      cacheDir,
      server.socketPath,
    );
    try {
      await producer.connect();
      return harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.producer.close();
    await this.#server.close();
    await Deno.remove(this.#cacheDir, { recursive: true }).catch(() =>
      undefined
    );
  }

  async duplicateHello(): Promise<Json> {
    const address = new URL(this.#socketPath);
    const connection = await Deno.connect({
      hostname: address.hostname,
      port: Number(address.port),
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(`${
      JSON.stringify({
        method: "hello",
        params: {
          protocol: 1,
          session: this.producer.session,
          producer: { name: "compat-duplicate", version: "1.0.0" },
          limits,
        },
      })
    }\n`);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += await connection.write(bytes.subarray(offset));
      }
      let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      for (;;) {
        const chunk = new Uint8Array(4096);
        const count = await connection.read(chunk);
        if (count === null) {
          throw new Error("Duplicate hello socket closed without a response.");
        }
        buffer = append(buffer, chunk.subarray(0, count));
        const newline = buffer.indexOf(10);
        if (newline >= 0) {
          return JSON.parse(
            decoder.decode(buffer.subarray(0, newline)),
          ) as Json;
        }
      }
    } finally {
      connection.close();
    }
  }
}

export class FixtureProducer {
  readonly session = "fixture.python:compat-1";
  readonly #connection: Deno.Conn;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #reader: Promise<void>;
  #writeTail = Promise.resolve();
  #frameCount = 0;
  #nextId = 1;
  #closed = false;
  #holdNext = false;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(connection: Deno.Conn) {
    this.#connection = connection;
    this.#reader = this.#readLoop();
  }

  async connect(): Promise<void> {
    await this.#send({
      method: "hello",
      params: {
        protocol: 1,
        session: this.session,
        producer: { name: "compat-fixture", version: "1.0.0" },
        limits,
      },
    });
    // The producer acknowledges host-to-producer frames, not its own hello.
  }

  holdNext(): void {
    this.#holdNext = true;
  }

  async openSequential(
    generation = 1,
    view = "fixture-seq",
  ): Promise<Json> {
    const data = await arrow();
    const pages = [
      ipcBytes(data, [1, 2]),
      ipcBytes(data, [3]),
      ipcBytes(data, []),
    ];
    const descriptor = {
      view,
      generation,
      kind: "grid",
      access: "sequential",
      encoding: "arrow-ipc",
      title: "Sequential fixture",
      reason: "register",
      nrow: null,
      ncol: 1,
      max_page_rows: 2,
      columns: [{
        index: 0,
        position: 0,
        ipc_index: 0,
        name: "value",
        type: "integer",
        sortable: false,
        filterable: false,
        drillable: false,
        unsupported: null,
      }],
      capabilities: {
        seek: false,
        sort: false,
        filter: false,
        known_total: false,
        next: true,
        children: false,
      },
    };
    this.#notify("view/open", descriptor);
    this.#setView(view, async (method, params, id) => {
      if (method === "view/schema") {
        await this.#reply(id, {
          view: params.view,
          generation: params.generation,
          nrow: null,
          ncol: 1,
          columns: descriptor.columns,
        });
      } else if (method === "stream/next") {
        if (this.#holdNext) {
          this.#holdNext = false;
          return;
        }
        const page = pages.shift() ?? pages[pages.length - 1];
        const first = page.first;
        const rows = page.rows;
        await this.#sendBinary({
          id,
          result: {
            view,
            generation,
            first_row: first,
            rows_fetched: rows,
            rows_seen: first + rows,
            done: page.done,
            transfer: {
              encoding: "arrow-ipc",
              byte_length: page.bytes.byteLength,
            },
          },
          warnings: [],
        }, page.bytes);
      } else if (method === "view/close") {
        await this.#reply(id, {
          view,
          generation,
          closed: true,
        });
      } else {
        await this.#reply(id, undefined, {
          code: "unsupported",
          message: "Unsupported fixture request.",
        });
      }
    });
    return descriptor;
  }

  openSnapshot(): Json {
    return this.#openJson("snapshot", "fixture-snapshot", "Snapshot fixture", [
      10,
      20,
      30,
    ]);
  }

  openRandom(): Json {
    return this.#openJson("random", "fixture-random", "Random fixture", [
      10,
      20,
      30,
    ]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
    void this.#reader.catch(() => undefined);
  }

  #openJson(
    access: "snapshot" | "random",
    view: string,
    title: string,
    values: number[],
  ): Json {
    const descriptor = {
      view,
      generation: 1,
      kind: "grid",
      access,
      encoding: "jdv-json",
      title,
      reason: "register",
      collation: "C",
      nrow: values.length,
      ncol: 1,
      row_labels: null,
      columns: [{
        position: 0,
        name: "value",
        type: "integer",
        sortable: false,
        filterable: false,
      }],
      capabilities: {
        seek: true,
        sort: false,
        filter: false,
        known_total: true,
        next: false,
        children: false,
        refresh: false,
        track: false,
      },
      ...(access === "snapshot"
        ? {
          data: {
            source_row: values.map((_, index) => index),
            row_labels: null,
            columns: [{
              values,
              display: values.map(String),
              na: values.map(() => false),
            }],
          },
        }
        : {}),
    };
    this.#notify("view/open", descriptor);
    this.#setView(view, async (method, params, id) => {
      if (method === "grid/rows") {
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? values.length);
        const selected = values.slice(offset, offset + limit);
        await this.#reply(id, {
          view,
          generation: 1,
          total: values.length,
          total_unfiltered: values.length,
          offset,
          limit: selected.length,
          data: {
            source_row: selected.map((_, index) => offset + index),
            row_labels: null,
            columns: [{
              schema: descriptor.columns[0],
              data: {
                display: selected.map(String),
                na: selected.map(() => false),
              },
              errors: [],
            }],
          },
        });
      } else if (method === "view/schema") {
        await this.#reply(id, {
          view,
          generation: 1,
          nrow: values.length,
          ncol: 1,
          columns: descriptor.columns,
        });
      } else if (method === "view/close") {
        await this.#reply(id, { view, generation: 1, closed: true });
      } else {
        await this.#reply(id, undefined, {
          code: "unsupported",
          message: "Unsupported fixture request.",
        });
      }
    });
    return descriptor;
  }

  #handlers = new Map<
    string,
    (method: string, params: Json, id: string) => void | Promise<void>
  >();

  #setView(
    view: string,
    handler: (method: string, params: Json, id: string) => void | Promise<void>,
  ): void {
    this.#handlers.set(view, handler);
  }

  async #readLoop(): Promise<void> {
    while (!this.#closed) {
      const chunk = new Uint8Array(64 * 1024);
      const count = await this.#connection.read(chunk);
      if (count === null) return;
      this.#buffer = append(this.#buffer, chunk.subarray(0, count));
      for (;;) {
        const newline = this.#buffer.indexOf(10);
        if (newline < 0) break;
        const bytes = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const frame = JSON.parse(this.#decoder.decode(bytes)) as Json;
        this.#frameCount++;
        if (frame.method === "ack") continue;
        if (typeof frame.id === "string" && frame.method === undefined) {
          await this.#acknowledge();
          continue;
        }
        const method = String(frame.method ?? "");
        const params = isRecord(frame.params) ? frame.params : {};
        if (method === "wake" || method === "cancel") {
          await this.#acknowledge();
          continue;
        }
        const view = String(params.view ?? "");
        const handler = this.#handlers.get(view);
        if (typeof frame.id === "string" && handler) {
          await handler(method, params, frame.id);
        }
        await this.#acknowledge();
      }
    }
  }

  async #reply(id: string, result?: Json, error?: Json): Promise<void> {
    await this.#send({ id, ...(error ? { error } : { result }), warnings: [] });
  }

  async #acknowledge(): Promise<void> {
    await this.#send({ method: "ack", params: { frames: this.#frameCount } });
  }

  async #sendBinary(header: Json, body: Uint8Array): Promise<void> {
    await this.#write(
      append(this.#encoder.encode(`${JSON.stringify(header)}\n`), body),
    );
  }

  async #send(value: Json): Promise<void> {
    await this.#write(
      this.#encoder.encode(`${JSON.stringify(value)}\n`),
    );
  }

  #write(bytes: Uint8Array): Promise<void> {
    const next = this.#writeTail.then(async () => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        offset += await this.#connection.write(bytes.subarray(offset));
      }
    });
    this.#writeTail = next.catch(() => undefined);
    return next;
  }

  #notify(method: string, params: Json): void {
    void this.#send({ method, params });
  }
}

function ipcBytes(
  arrowApi: Record<string, (...args: never[]) => unknown>,
  values: number[],
): { bytes: Uint8Array; first: number; rows: number; done: boolean } {
  const table = arrowApi.tableFromArrays(
    { value: Int32Array.from(values) } as never,
  );
  const bytes = arrowApi.tableToIPC(table as never) as Uint8Array;
  const first = values.length === 0 ? 3 : values[0] === 1 ? 0 : 2;
  return { bytes, first, rows: values.length, done: values.length === 0 };
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const value = new Uint8Array(left.byteLength + right.byteLength);
  value.set(left);
  value.set(right, left.byteLength);
  return value;
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

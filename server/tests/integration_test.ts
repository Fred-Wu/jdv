import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertServerReleased,
  cleanupDeadline,
  finishIntegrationCleanup,
  removeCacheDirectory,
  stopRChild,
} from "./integration_cleanup.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RunningServer {
  url: string;
  socketPath: string;
  discoveryPath: string;
  close(): Promise<void>;
}

class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #onPing: (payload: Uint8Array) => Promise<void>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(
    stream: ReadableStream<Uint8Array>,
    onPing: (payload: Uint8Array) => Promise<void> = async () => {},
  ) {
    this.#reader = stream.getReader();
    this.#onPing = onPing;
  }

  async readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const next = await this.#reader.read();
      if (next.done) throw new Error("Unexpected end of socket stream.");
      this.#buffer = concat(this.#buffer, next.value);
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }

  async readHeaders(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 16 * 1024) {
      bytes.push((await this.readExact(1))[0]);
      const length = bytes.length;
      if (
        length >= 4 && bytes[length - 4] === 13 && bytes[length - 3] === 10 &&
        bytes[length - 2] === 13 && bytes[length - 1] === 10
      ) return decoder.decode(new Uint8Array(bytes));
    }
    throw new Error("HTTP response headers exceeded 16 KiB.");
  }

  async readWebSocketText(): Promise<Record<string, unknown>> {
    for (;;) {
      const header = await this.readExact(2);
      let length = header[1] & 0x7f;
      if (length === 126) {
        const extended = await this.readExact(2);
        length = (extended[0] << 8) | extended[1];
      } else if (length === 127) {
        const extended = await this.readExact(8);
        const value = new DataView(extended.buffer).getBigUint64(0, false);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket test frame is too large.");
        }
        length = Number(value);
      }
      const opcode = header[0] & 0x0f;
      const payload = await this.readExact(length);
      if (opcode === 9) {
        await this.#onPing(payload);
        continue;
      }
      if (opcode === 10) continue;
      if (opcode !== 1) {
        throw new Error(`Expected a text frame, got ${opcode}.`);
      }
      return JSON.parse(decoder.decode(payload));
    }
  }
}

class RawWebSocket {
  readonly #connection: Deno.Conn;
  readonly #reader: ByteReader;

  private constructor(connection: Deno.Conn) {
    this.#connection = connection;
    this.#reader = new ByteReader(
      connection.readable,
      (payload) => this.#sendControl(0x8a, payload),
    );
  }

  static async connect(url: string, token?: string): Promise<RawWebSocket> {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    const client = new RawWebSocket(connection);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const key = btoa(String.fromCharCode(...nonce));
    const target = token ? `/ws?token=${encodeURIComponent(token)}` : "/ws";
    await writeAll(
      connection,
      encoder.encode(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${parsed.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    const response = await client.#reader.readHeaders();
    if (!response.startsWith("HTTP/1.1 101 ")) {
      connection.close();
      throw new Error(`WebSocket upgrade failed: ${response.split("\r\n")[0]}`);
    }
    const accept = response.match(/\r\nsec-websocket-accept:\s*(.+)\r\n/i)?.[1];
    const digest = await crypto.subtle.digest(
      "SHA-1",
      encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (accept !== expected) throw new Error("Invalid WebSocket accept value.");
    return client;
  }

  read(): Promise<Record<string, unknown>> {
    return this.#reader.readWebSocketText();
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
      throw new Error("WebSocket test payload exceeds 65535 bytes.");
    }
    const masked = payload.map((byte, index) => byte ^ mask[index % 4]);
    await writeAll(this.#connection, concat(header, mask, masked));
  }

  async #sendControl(opcode: number, payload: Uint8Array): Promise<void> {
    if (payload.length > 125) {
      throw new Error("WebSocket control payload exceeds 125 bytes.");
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const masked = payload.map((byte, index) => byte ^ mask[index % 4]);
    await writeAll(
      this.#connection,
      concat(
        new Uint8Array([0x80 | opcode, 0x80 | payload.length]),
        mask,
        masked,
      ),
    );
  }

  close(): void {
    try {
      this.#connection.close();
    } catch {
      // Closing a test socket is idempotent.
    }
  }
}

Deno.test({
  name: "HTTP origin checks, R relay, browser cache, and discovery cleanup",
  ignore: Deno.build.os === "windows",
  async fn() {
    const cacheDir = await makeSocketTempDir("jdv-server-cache-");
    let server: RunningServer | undefined;
    let rConnection: Deno.Conn | undefined;
    const clients: RawWebSocket[] = [];
    try {
      const { startServer } = await import("../main.ts");
      server = await startServer({ mode: "default", httpPort: 0, cacheDir });
      const root = await fetch(server.url);
      if (root.status !== 200) {
        throw new Error(`Viewer returned ${root.status}.`);
      }
      if (!root.headers.get("content-type")?.startsWith("text/html")) {
        throw new Error("Viewer HTML has the wrong content type.");
      }
      const asset = await fetch(new URL("/assets/app.js", server.url));
      if (asset.status !== 200) {
        throw new Error(`App asset returned ${asset.status}.`);
      }
      if (!asset.headers.get("content-type")?.startsWith("text/javascript")) {
        throw new Error("Viewer JavaScript has the wrong content type.");
      }
      for (
        const [assetPath, expectedType] of [
          ["/assets/vendor/arrow-21.2.0.min.js", "text/javascript"],
          ["/assets/vendor/APACHE-ARROW-JS-LICENSE.txt", "text/plain"],
          ["/assets/vendor/APACHE-ARROW-JS-NOTICE.txt", "text/plain"],
        ]
      ) {
        const vendorAsset = await fetch(new URL(assetPath, server.url));
        if (
          vendorAsset.status !== 200 ||
          !vendorAsset.headers.get("content-type")?.startsWith(expectedType)
        ) {
          throw new Error(`${assetPath} was not served as ${expectedType}.`);
        }
      }
      const favicon = await fetch(new URL("/favicon.ico", server.url));
      if (favicon.status !== 204) {
        throw new Error(`Favicon returned ${favicon.status}.`);
      }

      const port = Number(new URL(server.url).port);
      const badHost = await rawHttp(port, {
        path: "/",
        host: `attacker.invalid:${port}`,
      });
      if (!badHost.startsWith("HTTP/1.1 421 ")) {
        throw new Error(`Unexpected hostile Host response: ${badHost}`);
      }
      const badOrigin = await rawHttp(port, {
        path: "/",
        host: `127.0.0.1:${port}`,
        origin: "http://attacker.invalid",
      });
      if (!badOrigin.startsWith("HTTP/1.1 403 ")) {
        throw new Error(`Unexpected hostile Origin response: ${badOrigin}`);
      }
      const badWebSocketOrigin = await rawHttp(port, {
        path: "/ws",
        host: `127.0.0.1:${port}`,
        origin: "http://localhost",
        upgrade: true,
      });
      if (!badWebSocketOrigin.startsWith("HTTP/1.1 403 ")) {
        throw new Error(
          `Unexpected WebSocket Origin response: ${badWebSocketOrigin}`,
        );
      }

      const socketPath = server.socketPath.slice("unix://".length);
      rConnection = await Deno.connect({ transport: "unix", path: socketPath });
      const browser = await RawWebSocket.connect(server.url);
      clients.push(browser);
      const welcome = await browser.read();
      assertMessage(welcome, "welcome");
      if (!Array.isArray(welcome.sessions) || welcome.sessions.length !== 0) {
        throw new Error("New browser did not receive an empty welcome.");
      }

      await writeLine(rConnection, {
        method: "hello",
        params: {
          protocol: 1,
          session: "r-4242-1",
          limits: {
            max_receive_frames: 128,
            max_receive_bytes: 512 * 1024,
            queue_messages: 128,
            queue_bytes: 16 * 1024 * 1024,
            max_request_bytes: 10 * 1024 * 1024,
            max_message_bytes: 10 * 1024 * 1024,
          },
          pid: 4242,
          r_version: "4.6.1",
          jdv_version: "0.1.0",
        },
      });
      assertMessage(await browser.read(), "session/open");
      const snapshot = {
        method: "view/open",
        params: {
          view: "t-snapshot",
          generation: 1,
          kind: "grid",
          access: "snapshot",
          encoding: "r-json",
          mode: "snapshot",
          title: "snapshot fixture",
          nrow: 2,
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
          data: { columns: [{ name: "x", values: [4, 9] }] },
        },
      };
      await writeLine(rConnection, snapshot);
      const opened = await browser.read();
      assertMessage(opened, "view/open");

      const reconnect = await RawWebSocket.connect(server.url);
      clients.push(reconnect);
      const cachedWelcome = await reconnect.read();
      assertMessage(cachedWelcome, "welcome");
      const sessions = cachedWelcome.sessions as Array<Record<string, unknown>>;
      if (sessions.length !== 1) {
        throw new Error("Welcome did not cache the R session.");
      }
      const tables = sessions[0].views as Array<Record<string, unknown>>;
      if (tables.length !== 1) {
        throw new Error("Welcome did not cache the table.");
      }
      if (JSON.stringify(tables[0]) !== JSON.stringify(snapshot)) {
        throw new Error("Snapshot table data was not preserved in welcome.");
      }

      await reconnect.send({
        type: "request",
        id: "close-table",
        session: "r-4242-1",
        method: "view/close",
        params: { view: "t-snapshot", generation: 1 },
      });
      const closeRequest = await readJsonLine(rConnection);
      if (closeRequest.method !== "view/close") {
        throw new Error("The close request was not relayed to R.");
      }
      await writeLine(rConnection, {
        id: closeRequest.id,
        result: { closed: true, view: "t-snapshot", generation: 1 },
        warnings: [],
      });
      const response = await reconnect.read();
      assertMessage(response, "response");
      const closed = await reconnect.read();
      assertMessage(closed, "view/closed");

      rConnection.close();
      rConnection = undefined;
      assertMessage(await reconnect.read(), "session/closed");

      const discovery = JSON.parse(
        await Deno.readTextFile(server.discoveryPath),
      ) as Record<string, unknown>;
      discovery.instance = "replacement-instance";
      await Deno.writeTextFile(server.discoveryPath, JSON.stringify(discovery));
      await server.close();
      server = undefined;
      const preserved = JSON.parse(
        await Deno.readTextFile(`${cacheDir}/discovery.json`),
      ) as Record<string, unknown>;
      if (preserved.instance !== "replacement-instance") {
        throw new Error(
          "Shutdown removed a discovery file owned by a replacement.",
        );
      }
    } finally {
      for (const client of clients) client.close();
      rConnection?.close();
      await server?.close();
      await Deno.remove(cacheDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "TCP mode keeps assets public and checks the optional browser token",
  async fn() {
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-tcp-cache-" });
    let server: RunningServer | undefined;
    let rConnection: Deno.Conn | undefined;
    let browser: RawWebSocket | undefined;
    const token = "local-viewer-token-2026";
    try {
      const { startServer } = await import("../main.ts");
      server = await startServer({ mode: "tcp", httpPort: 0, cacheDir, token });
      const page = await fetch(server.url);
      if (page.status !== 200) {
        throw new Error("Token unexpectedly gated HTTP assets.");
      }
      const port = Number(new URL(server.url).port);
      for (const path of ["/ws", "/ws?token=incorrect-token-value"]) {
        const response = await rawHttp(port, {
          path,
          host: `127.0.0.1:${port}`,
          origin: new URL(server.url).origin,
          upgrade: true,
        });
        if (!response.startsWith("HTTP/1.1 403 ")) {
          throw new Error(`Invalid token was accepted: ${response}`);
        }
      }
      browser = await RawWebSocket.connect(server.url, token);
      assertMessage(await browser.read(), "welcome");

      const address = new URL(server.socketPath);
      rConnection = await Deno.connect({
        hostname: address.hostname,
        port: Number(address.port),
      });
      await writeLine(rConnection, {
        method: "hello",
        params: {
          protocol: 1,
          session: "r-4243-1",
          limits: {
            max_receive_frames: 128,
            max_receive_bytes: 512 * 1024,
            queue_messages: 128,
            queue_bytes: 16 * 1024 * 1024,
            max_request_bytes: 10 * 1024 * 1024,
            max_message_bytes: 10 * 1024 * 1024,
          },
          pid: 4243,
          r_version: "4.6.1",
          jdv_version: "0.1.0",
        },
      });
      assertMessage(await browser.read(), "session/open");
      rConnection.close();
      rConnection = undefined;
      assertMessage(await browser.read(), "session/closed");
    } finally {
      browser?.close();
      rConnection?.close();
      await server?.close();
      await Deno.remove(cacheDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "installed R package connects and services a browser schema request",
  async fn() {
    const testLibrary = Deno.env.get("JDV_TEST_R_LIB")?.trim();
    const cacheRoot = await makeSocketTempDir("jdv-r-integration-");
    const cacheDir = join(cacheRoot, "jdv");
    const donePath = join(cacheDir, "finish-r-loop");
    const scriptPath = join(cacheDir, "mock-r.R");
    let server: RunningServer | undefined;
    let rChild: Deno.ChildProcess | undefined;
    let outputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let browser: RawWebSocket | undefined;
    let stderrOutput: Promise<string> | undefined;
    let rExited = false;
    const originalFailure: unknown[] = [];
    try {
      const { startServer } = await import("../main.ts");
      server = await startServer({ mode: "default", httpPort: 0, cacheDir });
      if (Deno.build.os === "windows") {
        if (!server.socketPath.startsWith("npipe:")) {
          throw new Error(
            "The default Windows R listener was not a named pipe.",
          );
        }
      }
      const browserClient = await RawWebSocket.connect(server.url);
      browser = browserClient;
      assertMessage(await browserClient.read(), "welcome");
      const source = [
        "args <- commandArgs(trailingOnly = TRUE)",
        "done_path <- args[[1L]]",
        "library(jdv)",
        'cat("JDV_PACKAGE\\t", find.package("jdv"), "\\n", sep = "", file = stderr())',
        'id <- jdv_view(data.frame(value = c(2L, 4L, 8L)), title = "Phase 6 integration", mode = "paged")',
        'cat("READY\\t", id, "\\n", sep = "")',
        "flush.console()",
        "repeat {",
        "  jdv_rpc(NULL)",
        "  if (file.exists(done_path)) break",
        "  Sys.sleep(0.01)",
        "}",
        "jdv_close(id)",
        'cat("CLOSED\\n")',
        "flush.console()",
      ].join("\n");
      await Deno.writeTextFile(scriptPath, source);
      const rEnv = Deno.env.toObject();
      rEnv.XDG_CACHE_HOME = cacheRoot;
      for (
        const name of [
          "JDV_ADDRESS",
          "JDV_DISCOVERY_PATH",
          "JDV_CACHE_DIR",
          "R_PROFILE_USER",
          "R_ENVIRON_USER",
        ]
      ) delete rEnv[name];
      rEnv.JDV_ADDRESS = server.socketPath;
      if (testLibrary) rEnv.R_LIBS_USER = testLibrary;
      rChild = new Deno.Command("Rscript", {
        args: ["--vanilla", scriptPath, donePath],
        env: rEnv,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      outputReader = rChild.stdout.getReader();
      stderrOutput = new Response(rChild.stderr).text();
      const readyLine = await readLine(outputReader, 10_000);
      if (!readyLine?.startsWith("READY\t")) {
        const status = await rChild.status;
        rExited = true;
        const error = await stderrOutput;
        throw new Error(
          `Installed R package did not start: ${status.code}: ${error}`,
        );
      }
      const tableId = readyLine.slice("READY\t".length);
      let sessionOpen: Record<string, unknown>;
      try {
        sessionOpen = await withTimeout(
          browserClient.read(),
          10_000,
          "Timed out waiting for the R session to connect.",
        );
      } catch (error) {
        try {
          await stopRChild(rChild, rExited);
          rExited = true;
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "R session connection and termination failed.",
            { cause: error },
          );
        }
        const status = await rChild.status;
        rExited = true;
        const stderr = await stderrOutput;
        const discovery = await Deno.readTextFile(server.discoveryPath)
          .catch(() => "unavailable");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ` +
            `R exit=${status.code}; server socket=${server.socketPath}; ` +
            `discovery=${discovery}; stderr=${stderr}`,
        );
      }
      assertMessage(sessionOpen, "session/open");
      const tableOpen = await browserClient.read();
      assertMessage(tableOpen, "view/open");
      const descriptor = tableOpen.message as Record<string, unknown>;
      const params = descriptor.params as Record<string, unknown>;
      if (params.view !== tableId || params.generation !== 1) {
        throw new Error(
          "R view/open does not match the installed API result.",
        );
      }

      await browserClient.send({
        type: "request",
        id: "schema-from-installed-r",
        session: sessionOpen.session,
        method: "view/schema",
        params: { view: tableId, generation: 1 },
      });
      const response = await browserClient.read();
      assertMessage(response, "response");
      if (response.id !== "schema-from-installed-r") {
        throw new Error(
          "R schema response did not preserve the browser request id.",
        );
      }
      const result = response.result as Record<string, unknown>;
      if (!Array.isArray(result.columns) || result.columns.length !== 1) {
        throw new Error(
          "Installed R package returned an unexpected table schema.",
        );
      }

      await Deno.writeTextFile(donePath, "done\n");
      const closedLine = await readLine(outputReader, 10_000);
      if (closedLine !== "CLOSED") {
        const status = await rChild.status;
        rExited = true;
        const error = await stderrOutput;
        throw new Error(
          `Installed R package did not close cleanly: ${status.code}: ${error}`,
        );
      }
      const status = await rChild.status;
      rExited = true;
      if (!status.success) {
        const error = await stderrOutput;
        throw new Error(`Installed R package exited ${status.code}: ${error}`);
      }
      assertMessage(await browserClient.read(), "view/closed");
      assertMessage(await browserClient.read(), "session/closed");
    } catch (error) {
      originalFailure.push(error);
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => browser?.close(),
        () => rChild ? stopRChild(rChild, rExited) : undefined,
        () =>
          outputReader
            ? cleanupDeadline(
              outputReader.cancel(),
              5_000,
              "R stdout did not close during cleanup.",
            )
            : undefined,
        () => outputReader?.releaseLock(),
        () =>
          stderrOutput
            ? cleanupDeadline(
              stderrOutput,
              5_000,
              "R stderr did not close during cleanup.",
            )
            : undefined,
        () =>
          server
            ? cleanupDeadline(
              server.close(),
              5_000,
              "Server shutdown did not finish during cleanup.",
            )
            : undefined,
        () => server ? assertServerReleased(server) : undefined,
        () => removeCacheDirectory(cacheRoot),
      ], originalFailure);
    }
  },
});

Deno.test({
  name: "URL startup loads the complete module graph from HTTP in an empty cwd",
  ignore: Deno.build.os === "windows",
  async fn() {
    const rootDir = fileURLToPath(new URL("../../", import.meta.url));
    const emptyCwd = await Deno.makeTempDir({ prefix: "jdv-empty-cwd-" });
    const denoDir = await Deno.makeTempDir({ prefix: "jdv-deno-cache-" });
    const cacheDir = await makeSocketTempDir("jdv-url-cache-");
    const fixture = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      async (req) => {
        const pathname = decodeURIComponent(new URL(req.url).pathname);
        if (!pathname.startsWith("/server/")) {
          return new Response("Not found", { status: 404 });
        }
        const relative = pathname.slice(1);
        const filePath = join(rootDir, relative);
        try {
          const body = await Deno.readFile(filePath);
          return new Response(body, {
            headers: { "content-type": contentType(filePath) },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      },
    );
    let child: Deno.ChildProcess | undefined;
    let outputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const fixtureUrl = `http://127.0.0.1:${fixture.addr.port}/server/main.ts`;
      child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-config",
          fixtureUrl,
          "--cache-dir",
          cacheDir,
        ],
        cwd: emptyCwd,
        env: { ...Deno.env.toObject(), DENO_DIR: denoDir },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      outputReader = child.stdout.getReader();
      const readyLine = await readLine(outputReader, 45_000);
      if (!readyLine) {
        const status = await child.status;
        const stderr = await new Response(child.stderr).text();
        throw new Error(
          `URL server exited ${status.code} without readiness: ${stderr}`,
        );
      }
      const ready = JSON.parse(readyLine) as Record<string, unknown>;
      if (
        typeof ready.url !== "string" || typeof ready.socketPath !== "string" ||
        typeof ready.discoveryPath !== "string" || typeof ready.pid !== "number"
      ) {
        throw new Error(`Invalid startup line: ${readyLine}`);
      }
      const page = await fetch(ready.url);
      if (
        page.status !== 200 || !(await page.text()).includes('id="sessions"')
      ) {
        throw new Error("URL-started viewer did not serve the bundled page.");
      }
      for (
        const assetPath of [
          "/assets/app.js",
          "/assets/style.css",
          "/assets/vendor/arrow-21.2.0.min.js",
          "/assets/vendor/APACHE-ARROW-JS-LICENSE.txt",
          "/assets/vendor/APACHE-ARROW-JS-NOTICE.txt",
        ]
      ) {
        const asset = await fetch(new URL(assetPath, ready.url));
        if (asset.status !== 200) {
          throw new Error(`${assetPath} returned ${asset.status}.`);
        }
        const expectedType = assetPath.endsWith(".js")
          ? "text/javascript"
          : assetPath.endsWith(".css")
          ? "text/css"
          : "text/plain";
        if (!asset.headers.get("content-type")?.startsWith(expectedType)) {
          throw new Error(`${assetPath} had an invalid content type.`);
        }
      }

      const existingDiscovery = await Deno.readTextFile(
        ready.discoveryPath as string,
      );
      const existingSockets = await socketFiles(cacheDir);
      const conflict = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-config",
          fixtureUrl,
          "--http-port",
          String(new URL(ready.url as string).port),
          "--cache-dir",
          cacheDir,
        ],
        cwd: emptyCwd,
        env: { ...Deno.env.toObject(), DENO_DIR: denoDir },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const result = await Promise.race([
        conflict.status,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 10_000)
        ),
      ]);
      if (!result) {
        conflict.kill("SIGTERM");
        await conflict.status;
        throw new Error("URL-started server hung on an occupied HTTP port.");
      }
      if (result.success) {
        throw new Error("Server accepted an occupied HTTP port.");
      }
      const error = await new Response(conflict.stderr).text();
      if (!error) throw new Error("Port conflict exited without a diagnostic.");
      const afterFailure = await Deno.readTextFile(
        ready.discoveryPath as string,
      );
      if (afterFailure !== existingDiscovery) {
        throw new Error("Failed startup replaced the live discovery record.");
      }
      const socketsAfterFailure = await socketFiles(cacheDir);
      if (
        JSON.stringify(socketsAfterFailure) !== JSON.stringify(existingSockets)
      ) {
        throw new Error("Failed startup left its Unix socket behind.");
      }
    } finally {
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited on its own.
        }
        await child.status;
      }
      await outputReader?.cancel().catch(() => undefined);
      await fixture.shutdown();
      await Deno.remove(emptyCwd, { recursive: true });
      await Deno.remove(denoDir, { recursive: true });
      await Deno.remove(cacheDir, { recursive: true });
    }
  },
});

async function rawHttp(
  port: number,
  options: { path: string; host: string; origin?: string; upgrade?: boolean },
): Promise<string> {
  const connection = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const key = btoa("0123456789abcdef");
    const headers = [
      `GET ${options.path} HTTP/1.1`,
      `Host: ${options.host}`,
      "Connection: Upgrade",
      ...(options.origin ? [`Origin: ${options.origin}`] : []),
      ...(options.upgrade
        ? [
          "Upgrade: websocket",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
        ]
        : []),
      "",
      "",
    ];
    await writeAll(connection, encoder.encode(headers.join("\r\n")));
    return (await new ByteReader(connection.readable).readHeaders()).split(
      "\r\n",
    )[0];
  } finally {
    connection.close();
  }
}

async function writeLine(connection: Deno.Conn, value: unknown): Promise<void> {
  await writeAll(connection, encoder.encode(`${JSON.stringify(value)}\n`));
}

async function readJsonLine(
  connection: Deno.Conn,
): Promise<Record<string, unknown>> {
  const reader = connection.readable.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        throw new Error("R connection closed before a response.");
      }
      buffer = concat(buffer, result.value);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        return JSON.parse(decoder.decode(buffer.subarray(0, newline)));
      }
    }
  } finally {
    reader.releaseLock();
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
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function assertMessage(value: Record<string, unknown>, type: string): void {
  if (value.type !== type) {
    throw new Error(
      `Expected browser message ${type}, received ${JSON.stringify(value)}.`,
    );
  }
}

async function readLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string | undefined> {
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), remaining)
      ),
    ]);
    if (!result) throw new Error("Timed out waiting for URL startup line.");
    if (result.done) return text || undefined;
    text += decoder.decode(result.value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  return undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function contentType(path: string): string {
  if (path.endsWith(".ts")) return "application/typescript; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

async function socketFiles(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.endsWith(".sock")) names.push(entry.name);
  }
  return names.sort();
}

function makeSocketTempDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({
    prefix,
    ...(Deno.build.os === "darwin" ? { dir: "/tmp" } : {}),
  });
}

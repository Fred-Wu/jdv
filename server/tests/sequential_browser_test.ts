import { assert, assertEquals } from "./assert.ts";
import { sequentialCapabilities } from "./sequential_capabilities.ts";
import { startServer } from "../main.ts";

type BrowserRuntime = {
  document: {
    querySelector(selector: string): { textContent: string | null } | null;
  };
};

const executable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraries = Deno.env.get("JDV_TEST_BROWSER_LIBS");
const rLibrary = Deno.env.get("JDV_TEST_R_LIB") ||
  Deno.env.get("JDV_TEST_BINARY_R_LIB");

const capabilities = await sequentialCapabilities(rLibrary);
if (rLibrary && (!capabilities.arrow || !capabilities.nanoarrow)) {
  console.info(
    "Sequential browser tests require the optional R arrow and nanoarrow packages.",
  );
}
if (rLibrary && !capabilities.polars) {
  console.info(
    "The optional Polars browser test is skipped because the R polars package is unavailable.",
  );
}

async function sequentialBrowser(polarsOnly = false) {
  const arrowModule = "npm:apache-arrow@21.2.0";
  const Arrow = await import(arrowModule);
  const playwrightModule = "npm:playwright@1.56.1";
  const { chromium } = await import(playwrightModule);
  const work = await Deno.makeTempDir({ prefix: "jdv-sequential-browser-" });
  const ipc = `${work}/source.arrows`;
  const finish = `${work}/finish`;
  const script = `${work}/producer.R`;
  const rowCount = 1600;
  function coefficient(width: number, value: bigint) {
    const words = new Uint32Array(rowCount * width / 32);
    for (let row = 0; row < rowCount; row++) {
      for (let word = 0; word < width / 32; word++) {
        words[row * width / 32 + word] = Number(
          (BigInt.asUintN(width, value) >> BigInt(word * 32)) & 0xffffffffn,
        );
      }
    }
    return words;
  }
  const table = new Arrow.Table({
    int64: Arrow.vectorFromArray(
      Array(rowCount).fill(-9223372036854775807n),
      new Arrow.Int64(),
    ),
    uint64: Arrow.vectorFromArray(
      Array(rowCount).fill(18446744073709551615n),
      new Arrow.Uint64(),
    ),
    decimal128: Arrow.makeVector(
      Arrow.makeData({
        type: new Arrow.Decimal(10, 38, 128),
        length: rowCount,
        data: coefficient(128, -123456789012345678901234567890n),
      }),
    ),
    decimal256: Arrow.makeVector(
      Arrow.makeData({
        type: new Arrow.Decimal(10, 76, 256),
        length: rowCount,
        data: coefficient(
          256,
          12345678901234567890123456789012345678901234567890n,
        ),
      }),
    ),
    negative_scale: Arrow.makeVector(
      Arrow.makeData({
        type: new Arrow.Decimal(-3, 38, 128),
        length: rowCount,
        data: coefficient(128, -12n),
      }),
    ),
    timestamp: Arrow.makeVector(
      Arrow.makeData({
        type: new Arrow.TimestampNanosecond("Asia/Kolkata"),
        length: rowCount,
        data: new BigInt64Array(rowCount).fill(-1n),
      }),
    ),
    binary: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => new Uint8Array([0, 10, 255])),
      new Arrow.Binary(),
    ),
    nested: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => [1, 2]),
      new Arrow.List(new Arrow.Field("item", new Arrow.Int32(), true)),
    ),
    text: Arrow.vectorFromArray(
      Array.from(
        { length: rowCount },
        (_, row) => `${row}:` + "x".repeat(8192),
      ),
      new Arrow.Utf8(),
    ),
    code: Arrow.vectorFromArray(
      Array(rowCount).fill("dictionary-red"),
      new Arrow.Dictionary(new Arrow.Utf8(), new Arrow.Int8(), 7),
    ),
    large: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => [3, 4, 5]),
      new Arrow.LargeList(new Arrow.Field("item", new Arrow.Int32(), true)),
    ),
    record: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => ({ id: 1, label: "a" })),
      new Arrow.Struct([
        new Arrow.Field("id", new Arrow.Int32(), true),
        new Arrow.Field("label", new Arrow.Utf8(), true),
      ]),
    ),
    entries: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => new Map([["a", 1]])),
      new Arrow.Map_(
        new Arrow.Field(
          "entries",
          new Arrow.Struct([
            new Arrow.Field("key", new Arrow.Utf8(), false),
            new Arrow.Field("value", new Arrow.Int32(), true),
          ]),
          false,
        ),
        false,
      ),
    ),
    extension_payload: Arrow.vectorFromArray(
      Array(rowCount).fill(777),
      new Arrow.Int32(),
    ),
  });
  table.schema.fields.at(-1)!.metadata.set(
    "ARROW:extension:name",
    "org.example.jdv.test",
  );
  table.schema.fields.at(-1)!.metadata.set("ARROW:extension:metadata", "v1");
  await Deno.writeFile(ipc, Arrow.tableToIPC(table, "stream"));
  const server = await startServer({
    mode: "tcp",
    httpPort: 0,
    cacheDir: `${work}/cache`,
  });
  const source = [
    "args <- commandArgs(TRUE)",
    ".libPaths(c(args[[1]], .libPaths()))",
    "library(jdv)",
    "stopifnot(startsWith(normalizePath(find.package('jdv')), normalizePath(args[[1]])))",
    "stopifnot(startsWith(getLoadedDLLs()[['jdv']][['path']], normalizePath(find.package('jdv'))))",
    "value <- arrow::read_ipc_stream(args[[2]], as_data_frame=FALSE)",
    "jdv_view(value, title='Exact sequential stream')",
    "jdv_view(data.frame(x=1:2), title='Ordinary table')",
    ...(polarsOnly
      ? [
        "pl <- getExportedValue('polars','pl')",
        "jdv_view(pl$DataFrame(label=c('polars-alpha','polars-beta'), values=pl$Series('values',list(c('x','y'),character()))), title='Polars newest stream')",
      ]
      : []),
    "cat('READY\n'); flush.console()",
    "while (!file.exists(args[[3]])) { jdv_rpc(NULL); Sys.sleep(0.005) }",
    "jdv_close()",
  ].join("\n");
  await Deno.writeTextFile(script, source);
  const child = new Deno.Command("Rscript", {
    args: ["--vanilla", script, rLibrary!, ipc, finish],
    env: { JDV_ADDRESS: server.socketPath, R_LIBS_USER: rLibrary! },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let browser;
  const trace: Record<string, unknown>[] = [];
  const reader = child.stdout.pipeThrough(new TextDecoderStream())
    .getReader();
  const stderr = new Response(child.stderr).text();
  try {
    let output = "";
    const deadline = Date.now() + 30_000;
    while (!output.includes("READY\n")) {
      const next = await new Promise<ReadableStreamReadResult<string>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("R readiness timed out")),
            Math.max(1, deadline - Date.now()),
          );
          reader.read().then((value) => {
            clearTimeout(timer);
            resolve(value);
          }, (error) => {
            clearTimeout(timer);
            reject(error);
          });
        },
      );
      if (next.done) {
        throw new Error(`R fixture stopped: ${output}; ${await stderr}`);
      }
      output += next.value;
    }
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ["--no-sandbox"],
      ...(browserLibraries
        ? {
          env: { ...Deno.env.toObject(), LD_LIBRARY_PATH: browserLibraries },
        }
        : {}),
    });
    const first = await browser.newPage();
    const second = await browser.newPage();
    const errors: string[] = [];

    for (
      const [name, page] of [["first", first], ["second", second]] as const
    ) {
      page.on(
        "websocket",
        (
          socket: {
            on(
              event: string,
              callback: (frame: { payload: string | Uint8Array }) => void,
            ): unknown;
          },
        ) => {
          for (const direction of ["framesent", "framereceived"]) {
            socket.on(direction, ({ payload }) => {
              let message;
              if (typeof payload === "string") {
                try {
                  message = JSON.parse(payload);
                } catch {
                  return;
                }
              } else {
                const length = new DataView(
                  payload.buffer,
                  payload.byteOffset,
                  4,
                ).getUint32(0, true);
                message = JSON.parse(
                  new TextDecoder().decode(payload.subarray(4, 4 + length)),
                );
              }
              if (
                message.method === "stream/next" ||
                message.code !== undefined || message.error !== undefined ||
                message.result?.first_row !== undefined
              ) {
                const metadata = message.result;
                trace.push({
                  browser: name,
                  direction,
                  id: message.id,
                  method: message.method,
                  code: message.code ?? message.error?.code,
                  first_row: metadata?.first_row,
                  rows_fetched: metadata?.rows_fetched,
                  rows_seen: metadata?.rows_seen,
                  done: metadata?.done,
                });
              }
            });
          }
        },
      );
    }
    first.on("pageerror", (error: Error) => errors.push(error.message));
    second.on("pageerror", (error: Error) => errors.push(error.message));
    // Match one terminal response by request id before reading the completed UI.
    const clickNext = async (page: typeof first, name: string) => {
      const start = trace.length;
      await page.locator("#sequential-next").click();
      async function waitForFrame(
        predicate: (frame: Record<string, unknown>) => boolean,
      ) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const frame = trace.slice(start).find(predicate);
          if (frame) return frame;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          `No terminal frame for ${name}: ${
            JSON.stringify(trace.slice(start))
          }`,
        );
      }
      const request = await waitForFrame((frame) =>
        frame.browser === name && frame.direction === "framesent" &&
        frame.method === "stream/next"
      );
      const terminal = await waitForFrame((frame) =>
        frame.browser === name && frame.direction === "framereceived" &&
        frame.id === request.id
      );
      await page.waitForFunction(() =>
        (globalThis as unknown as BrowserRuntime).document.querySelector(
          "#sequential-next",
        )?.textContent !== "Loading…"
      );
      assertEquals(
        trace.slice(start).filter((frame) =>
          frame.browser === name && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length,
        1,
      );
      assertEquals(
        trace.slice(start).filter((frame) =>
          frame.browser === name && frame.direction === "framereceived" &&
          frame.id === request.id
        ).length,
        1,
      );
      return terminal;
    };
    const expectPage = (
      terminal: Record<string, unknown>,
      firstRow: number,
      count: number,
      done = false,
    ) => {
      assertEquals({
        code: terminal.code,
        first_row: terminal.first_row,
        rows_fetched: terminal.rows_fetched,
        rows_seen: terminal.rows_seen,
        done: terminal.done,
      }, {
        code: undefined,
        first_row: firstRow,
        rows_fetched: count,
        rows_seen: firstRow + count,
        done,
      });
    };
    const expectProgress = async (
      page: typeof first,
      received: number,
      advanced: number,
      done = false,
    ) => {
      assertEquals(
        await page.locator("#sequential-progress").innerText(),
        `${received} rows received; ${advanced} rows advanced; ${
          done ? "end of stream" : "total unknown"
        }.`,
      );
    };
    for (const page of [first, second]) {
      await page.goto(server.url);
      await page.locator("#tables article").filter({
        hasText: polarsOnly
          ? "Polars newest stream"
          : "Exact sequential stream",
      }).getByRole("button", { name: "Open view", exact: true }).click();
    }
    if (polarsOnly) {
      expectPage(await clickNext(first, "first"), 0, 2);
      await expectProgress(first, 2, 2);
      const content = await first.locator("#column-window").innerText();
      for (const value of ["polars-alpha", "polars-beta", "<list: 2 items>"]) {
        assert(content.includes(value));
      }
      assertEquals(errors, []);
      return;
    }
    expectPage(await clickNext(first, "first"), 0, 200);
    await expectProgress(first, 200, 200);
    const content = await first.locator("#column-window").innerText();
    for (
      const exact of [
        "-9223372036854775807",
        "18446744073709551615",
        "-12345678901234567890.1234567890",
        "1234567890123456789012345678901234567890.1234567890",
        "-12000",
        "1970-01-01T05:29:59.999999999+05:30 [Asia/Kolkata]",
        "000aff",
        "<list: 2 items>",
        "dictionary-red",
        "<list: 3 items>",
        "<struct: 2 fields>",
        "<map>",
        "777",
      ]
    ) {
      assert(content.includes(exact), `Missing exact display: ${exact}`);
    }
    assertEquals((await clickNext(second, "second")).code, "in_use");
    await expectProgress(second, 0, 0);
    await first.locator("#tables article").filter({
      hasText: "Ordinary table",
    }).getByRole("button", { name: "Open view", exact: true }).click();
    await first.locator("#tables article").filter({
      hasText: "Exact sequential stream",
    }).getByRole("button", { name: "Open view", exact: true }).click();
    expectPage(await clickNext(first, "first"), 200, 200);
    await expectProgress(first, 400, 400);
    assert(
      !(await first.locator("#sequential-notice").innerText()).includes(
        "advanced but not displayed",
      ),
    );
    await first.close();
    // Retry only a completed in_use response. Every successful page is consumed once.
    let acquired = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const terminal = await clickNext(second, "second");
      if (terminal.code === "in_use") continue;
      expectPage(terminal, 400, 200);
      await expectProgress(second, 200, 600);
      acquired = true;
      break;
    }
    assert(acquired, "The detached owner's lease was not released.");
    assert(
      (await second.locator("#sequential-notice").innerText()).includes(
        "1–400 rows advanced but not displayed",
      ),
    );
    for (let received = 400; received <= 1200; received += 200) {
      expectPage(await clickNext(second, "second"), received + 200, 200);
      await expectProgress(second, received, received + 400);
    }
    assert(
      (await second.locator("#sequential-notice").innerText()).includes(
        "evicted",
      ),
    );
    // The last data page above has done=false; only this zero-row page observes EOF.
    assertEquals(await second.locator("#sequential-next").isDisabled(), false);
    expectPage(await clickNext(second, "second"), 1600, 0, true);
    await expectProgress(second, 1200, 1600, true);
    assertEquals(await second.locator("#sequential-next").isDisabled(), true);
    assertEquals(errors, []);
  } finally {
    console.info(JSON.stringify({ sequential_trace: trace }));
    await browser?.close();
    await Deno.writeTextFile(finish, "done");
    const status = await child.status;
    const diagnostics = await stderr;
    reader.releaseLock();
    await server.close();
    await Deno.remove(work, { recursive: true });
    assert(status.code === 0, diagnostics);
  }
}
Deno.test({
  name:
    "real R sequential Arrow pages preserve exact values, leases, progress, and eviction",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(false),
});
Deno.test({
  name: "optional Polars newest sequential view renders in Chromium",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.polars ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(true),
});

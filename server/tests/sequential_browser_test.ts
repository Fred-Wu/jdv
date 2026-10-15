import { launchOwnedBrowser, phase } from "./bounded_browser.ts";
import {
  assertServerReleased,
  cleanupDeadline,
  finishIntegrationCleanup,
  finishRFixture,
  fixturePid,
  ProcessLines,
  removeCacheDirectory,
} from "./integration_cleanup.ts";
import { assert, assertEquals } from "./assert.ts";
import { sequentialCapabilities } from "./sequential_capabilities.ts";
import { startServer } from "../main.ts";

type BrowserRuntime = {
  document: {
    querySelector(selector: string): {
      textContent: string | null;
      hasAttribute(name: string): boolean;
      getAttribute(name: string): string | null;
    } | null;
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

async function sequentialBrowser(
  polarsOnly = false,
  cacheEnabled = true,
  options: {
    verifyEarlyEviction?: boolean;
    hostCacheBytes?: number;
    verifyHostRecovery?: boolean;
  } = {},
) {
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
  const decimal128Type = new Arrow.Decimal(10, 38, 128);
  const decimal256Type = new Arrow.Decimal(10, 76, 256);
  const timestampType = new Arrow.TimestampNanosecond("Asia/Kolkata");
  const decimal128Vector = Arrow.makeVector(
    Arrow.makeData({
      type: decimal128Type,
      length: rowCount,
      data: coefficient(128, -123456789012345678901234567890n),
    }),
  );
  const decimal256Vector = Arrow.makeVector(
    Arrow.makeData({
      type: decimal256Type,
      length: rowCount,
      data: coefficient(
        256,
        12345678901234567890123456789012345678901234567890n,
      ),
    }),
  );
  const timestampVector = Arrow.makeVector(
    Arrow.makeData({
      type: timestampType,
      length: rowCount,
      data: new BigInt64Array(rowCount).fill(-1n),
    }),
  );
  const dictionaryVector = Arrow.vectorFromArray(
    Array(rowCount).fill("dictionary-red"),
    new Arrow.Dictionary(new Arrow.Utf8(), new Arrow.Int8(), 7),
  );
  const nestedPrecisionType = new Arrow.Struct([
    new Arrow.Field("decimal128", decimal128Type, true),
    new Arrow.Field("decimal256", decimal256Type, true),
    new Arrow.Field("timestamp", timestampType, true),
    new Arrow.Field("category", dictionaryVector.type, true),
  ]);
  const nestedPrecision = Arrow.makeVector(
    Arrow.makeData({
      type: nestedPrecisionType,
      length: rowCount,
      children: [
        decimal128Vector.data[0],
        decimal256Vector.data[0],
        timestampVector.data[0],
        dictionaryVector.data[0],
      ],
    }),
  );
  const table = new Arrow.Table({
    int64: Arrow.vectorFromArray(
      Array(rowCount).fill(-9223372036854775807n),
      new Arrow.Int64(),
    ),
    uint64: Arrow.vectorFromArray(
      Array(rowCount).fill(18446744073709551615n),
      new Arrow.Uint64(),
    ),
    decimal128: decimal128Vector,
    decimal256: decimal256Vector,
    negative_scale: Arrow.makeVector(
      Arrow.makeData({
        type: new Arrow.Decimal(-3, 38, 128),
        length: rowCount,
        data: coefficient(128, -12n),
      }),
    ),
    timestamp: Arrow.makeVector(
      Arrow.makeData({
        type: timestampType,
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
        (_, row) =>
          `${row}:` + (options.verifyHostRecovery ? "x" : "x".repeat(8192)),
      ),
      new Arrow.Utf8(),
    ),
    code: dictionaryVector,
    large: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => [3, 4, 5]),
      new Arrow.LargeList(new Arrow.Field("item", new Arrow.Int32(), true)),
    ),
    record: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => ({
        id: 9007199254740997n,
        label: "a",
      })),
      new Arrow.Struct([
        new Arrow.Field("id", new Arrow.Int64(), true),
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
    precise_list: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => [
        7n,
        9007199254740993n,
      ]),
      new Arrow.List(new Arrow.Field("exact", new Arrow.Int64(), true)),
    ),
    fixed_list: Arrow.vectorFromArray(
      Array.from({ length: rowCount }, () => [
        11n,
        9007199254740995n,
      ]),
      new Arrow.FixedSizeList(
        2,
        new Arrow.Field("exact", new Arrow.Int64(), true),
      ),
    ),
    large_nested: Arrow.vectorFromArray(
      Array.from(
        { length: rowCount },
        () => Array.from({ length: 1000 }, (_, item) => item),
      ),
      new Arrow.List(new Arrow.Field("item", new Arrow.Int32(), true)),
    ),
    nested_precision: nestedPrecision,
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
    ...(cacheEnabled
      ? options.hostCacheBytes === undefined
        ? {}
        : { streamCacheBytes: options.hostCacheBytes }
      : { streamCacheBytes: 0 }),
  });
  const source = [
    "args <- commandArgs(TRUE)",
    ".libPaths(c(args[[1]], .libPaths()))",
    "library(jdv)",
    "canonical_path <- function(x) { path <- normalizePath(x, winslash='/', mustWork=TRUE); if (.Platform$OS.type == 'windows') path <- tolower(path); sub('/+$', '', path) }",
    "path_within <- function(path, parent) identical(path, parent) || startsWith(path, paste0(parent, '/'))",
    "package_path <- canonical_path(find.package('jdv'))",
    "library_path <- canonical_path(args[[1]])",
    "dll_path <- canonical_path(getLoadedDLLs()[['jdv']][['path']])",
    "namespace_path <- canonical_path(getNamespaceInfo(asNamespace('jdv'), 'path'))",
    "stopifnot(path_within(package_path, library_path), path_within(dll_path, package_path), identical(namespace_path, package_path))",
    "value <- arrow::read_ipc_stream(args[[2]], as_data_frame=FALSE)",
    "jdv_view(value, title='Exact sequential stream')",
    "jdv_view(data.frame(x=1:2), title='Ordinary table')",
    ...(polarsOnly
      ? [
        "pl <- getExportedValue('polars','pl')",
        "jdv_view(pl$DataFrame(label=c('polars-alpha','polars-beta'), values=pl$Series('values',list(c('x','y'),character()))), title='Polars newest stream')",
      ]
      : []),
    "cat('READY\\t', Sys.getpid(), '\\n', sep=''); flush.console()",
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
  let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
  let rPid: number | undefined;
  const originalFailure: unknown[] = [];
  const trace: Record<string, unknown>[] = [];
  const traceWaiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  const pushTrace = (frame: Record<string, unknown>) => {
    trace.push(frame);
    for (let i = traceWaiters.length - 1; i >= 0; i--) {
      const waiter = traceWaiters[i];
      if (waiter.predicate(frame)) {
        clearTimeout(waiter.timer);
        traceWaiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
  };
  const waitForTrace = (
    predicate: (frame: Record<string, unknown>) => boolean,
  ) => {
    const existing = trace.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = traceWaiters.indexOf(waiter);
          if (index >= 0) traceWaiters.splice(index, 1);
          reject(new Error("Timed out waiting for the browser trace."));
        }, 30_000),
      };
      traceWaiters.push(waiter);
    });
  };
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  try {
    const lines = new ProcessLines(reader);
    const ready = await phase(
      "sequential R ready",
      () => lines.read(30_000),
      31_000,
    );
    if (!ready?.startsWith("READY\t")) {
      throw new Error(
        `R fixture stopped: ${JSON.stringify(ready)}; ${await cleanupDeadline(
          stderr,
          5_000,
          "R stderr did not close after readiness failure.",
        )}`,
      );
    }
    rPid = fixturePid(ready.slice("READY\t".length));
    owned = await launchOwnedBrowser(chromium, {
      executablePath: executable,
      headless: true,
      args: ["--no-sandbox"],
      ...(browserLibraries
        ? {
          env: { ...Deno.env.toObject(), LD_LIBRARY_PATH: browserLibraries },
        }
        : {}),
    });
    const browser = owned.browser;
    await phase("sequential browser test body", async () => {
      const first = await phase(
        "first sequential page",
        () => browser.newPage(),
      );
      const second = await phase(
        "second sequential page",
        () => browser.newPage(),
      );
      for (const page of [first, second]) {
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(20_000);
      }
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
                  (direction === "framesent" &&
                    typeof message.method === "string") ||
                  message.code !== undefined || message.error !== undefined ||
                  message.result?.first_row !== undefined
                ) {
                  const metadata = message.result;
                  pushTrace({
                    browser: name,
                    direction,
                    id: message.id,
                    method: message.method,
                    view: message.params?.view,
                    page: message.params?.page,
                    code: message.code ?? message.error?.code,
                    first_row: metadata?.first_row,
                    rows_fetched: metadata?.rows_fetched,
                    rows_seen: metadata?.rows_seen,
                    done: metadata?.done,
                    cache_page: metadata?.cache_page?.page,
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
        assert(received <= advanced);
        assertEquals(
          await page.locator("#sequential-progress").innerText(),
          `${advanced} rows seen; ${advanced} rows advanced; ${
            done ? "end of stream" : "total unknown"
          }.`,
        );
      };
      const inspectCell = async (page: typeof first, column: number) => {
        await page.locator(
          `#column-window button[data-action="inspect-arrow-cell"][data-row-index="1"][data-column="${column}"]`,
        ).click();
        await page.waitForFunction(() => {
          const tree = (globalThis as unknown as BrowserRuntime).document
            .querySelector("#tree-viewer");
          const status = (globalThis as unknown as BrowserRuntime).document
            .querySelector("#child-open-status");
          return (tree !== null && !tree.hasAttribute("hidden")) ||
            status?.getAttribute("data-state") === "error";
        });
        return await page.locator("#tree-child-list").innerText();
      };
      const returnFromInspection = async (page: typeof first) => {
        await page.locator("#tree-parent-return").click();
        await page.waitForFunction(() => {
          const viewer = (globalThis as unknown as BrowserRuntime).document
            .querySelector("#viewer");
          return viewer !== null && !viewer.hasAttribute("hidden");
        });
      };
      const rRequestCount = (browserName: string) =>
        trace.filter((frame) =>
          frame.browser === browserName && frame.direction === "framesent" &&
          typeof frame.method === "string" &&
          frame.method !== "stream/cache/info" &&
          frame.method !== "stream/cache/get"
        ).length;
      for (
        const [name, page] of [["first", first], ["second", second]] as const
      ) {
        await phase(
          `${name} sequential navigation`,
          () => page.goto(server.url),
          25_000,
        );
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
        for (
          const value of ["polars-alpha", "polars-beta", "<list: 2 items>"]
        ) {
          assert(content.includes(value));
        }
        const requestsBeforeInspect = rRequestCount("first");
        const children = await inspectCell(first, 1);
        assert(children.includes("x"), children);
        assert(children.includes("y"), children);
        await returnFromInspection(first);
        assertEquals(rRequestCount("first"), requestsBeforeInspect);
        assertEquals(errors, []);
        return;
      }
      if (options.verifyHostRecovery) {
        expectPage(await clickNext(first, "first"), 0, 200);
        await expectProgress(first, 200, 200);
        for (let page = 1; page < 8; page++) {
          expectPage(await clickNext(first, "first"), page * 200, 200);
          await expectProgress(first, page * 200, page * 200 + 200);
        }
        expectPage(await clickNext(first, "first"), 1600, 0, true);
        await expectProgress(first, 1600, 1600, true);
        const requestsBeforeInspect = rRequestCount("first");
        if (cacheEnabled) {
          await inspectCell(first, 16);
          assert(
            trace.some((frame) =>
              frame.browser === "first" && frame.direction === "framesent" &&
              frame.method === "stream/cache/get" && frame.page === 0
            ),
            "An IPC-cache miss should ask the host for the page.",
          );
          if (options.hostCacheBytes !== undefined) {
            await first.waitForFunction(() =>
              (globalThis as unknown as BrowserRuntime).document.querySelector(
                "#child-open-status",
              )?.getAttribute("data-state") === "error"
            );
            const message = await first.locator("#child-open-status")
              .innerText();
            assert(
              message.startsWith("Could not inspect this value:"),
              message,
            );
            assert(
              trace.some((frame) =>
                frame.browser === "first" &&
                frame.direction === "framereceived" &&
                frame.code === "unavailable"
              ),
              "The host should report that the page has been evicted.",
            );
            assertEquals(await first.locator("#tree-viewer").isHidden(), true);
          } else {
            assert(
              (await first.locator("#tree-child-list").innerText()).includes(
                "[1]",
              ),
            );
            await returnFromInspection(first);
            await second.reload();
            await second.locator("#tables article").filter({
              hasText: "Exact sequential stream",
            }).getByRole("button", { name: "Open view", exact: true }).click();
            const secondRequestsBeforeInspect = rRequestCount("second");
            await inspectCell(second, 16);
            assert(
              trace.some((frame) =>
                frame.browser === "second" && frame.direction === "framesent" &&
                frame.method === "stream/cache/get" && frame.page === 0
              ),
              "A fresh browser page should recover a retained IPC page from the host.",
            );
            assert(
              (await second.locator("#tree-child-list").innerText()).includes(
                "[1]",
              ),
            );
            assert(
              rRequestCount("second") === secondRequestsBeforeInspect,
              "Reloaded-page inspection must not issue requests to R.",
            );
          }
        } else {
          await first.locator(
            '#column-window button[data-action="inspect-arrow-cell"][data-row-index="1"][data-column="16"]',
          ).click();
          await first.waitForFunction(() =>
            (globalThis as unknown as BrowserRuntime).document.querySelector(
              "#child-open-status",
            )?.textContent?.includes("no longer retained") === true
          );
          assertEquals(
            await first.locator("#tree-viewer").isHidden(),
            true,
          );
        }
        assert(
          rRequestCount("first") === requestsBeforeInspect,
          "Inspection must not add R requests, including after a browser-cache miss.",
        );
        assertEquals(errors, []);
        return;
      }
      expectPage(await clickNext(first, "first"), 0, 200);
      await expectProgress(first, 200, 200);
      const firstPageRequests = trace.filter((frame) =>
        frame.browser === "first" && frame.direction === "framesent" &&
        frame.method === "stream/next"
      ).length;
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
      const requestsBeforeInspect = rRequestCount("first");
      const hostGetsBeforeInspect = trace.filter((frame) =>
        frame.browser === "first" && frame.direction === "framesent" &&
        frame.method === "stream/cache/get"
      ).length;
      const listChildren = await inspectCell(first, 7);
      assert(listChildren.includes("[1]"));
      assert(listChildren.includes("[2]"));
      await returnFromInspection(first);
      const preciseChildren = await inspectCell(first, 14);
      assert(
        preciseChildren.includes("9007199254740993"),
        `Unexpected precise-list children: ${preciseChildren}`,
      );
      await returnFromInspection(first);
      const fixedChildren = await inspectCell(first, 15);
      assert(fixedChildren.includes("9007199254740995"));
      await returnFromInspection(first);
      const structChildren = await inspectCell(first, 11);
      assert(structChildren.includes("9007199254740997"));
      await returnFromInspection(first);
      const mapChildren = await inspectCell(first, 12);
      assert(mapChildren.includes("Entry 1"));
      await first.locator(
        "#tree-child-list li[data-child-index='0'] button",
      ).click();
      assert(
        (await first.locator("#tree-child-list").innerText()).includes("key"),
      );
      assert(
        (await first.locator("#tree-child-list").innerText()).includes("value"),
      );
      await returnFromInspection(first);
      const nestedPrecisionChildren = await inspectCell(first, 17);
      for (
        const exact of [
          "-12345678901234567890.1234567890",
          "1234567890123456789012345678901234567890.1234567890",
          "1970-01-01T05:29:59.999999999+05:30 [Asia/Kolkata]",
          "dictionary-red",
        ]
      ) {
        assert(
          nestedPrecisionChildren.includes(exact),
          `Missing exact nested Arrow value: ${exact}`,
        );
      }
      await returnFromInspection(first);
      assert(
        rRequestCount("first") === requestsBeforeInspect,
        "Arrow-cell inspection must not add R-directed requests.",
      );
      assert(
        trace.filter((frame) =>
          frame.browser === "first" && frame.direction === "framesent" &&
          frame.method === "stream/cache/get"
        ).length === hostGetsBeforeInspect,
        "The visible page should be inspected from the browser's local IPC cache.",
      );
      await first.locator("#tables article").filter({
        hasText: "Ordinary table",
      }).getByRole("button", { name: "Open view", exact: true }).click();
      await first.locator("#tables article").filter({
        hasText: "Exact sequential stream",
      }).getByRole("button", { name: "Open view", exact: true }).click();
      await first.waitForFunction(() =>
        (globalThis as unknown as BrowserRuntime).document.querySelector(
          "#column-window",
        )?.textContent?.includes("-9223372036854775807") === true
      );
      assert(
        (await first.locator("#column-window").innerText()).includes(
          "-9223372036854775807",
        ),
        "Switching away and back should retain the displayed page.",
      );
      assertEquals(
        trace.filter((frame) =>
          frame.browser === "first" && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length,
        firstPageRequests,
      );
      const requestsBeforeReturnInspection = rRequestCount("first");
      const returnedChildren = await inspectCell(first, 14);
      assert(returnedChildren.includes("9007199254740993"));
      await returnFromInspection(first);
      assert(
        rRequestCount("first") === requestsBeforeReturnInspection,
        "Inspecting a locally retained page after returning to a view must not request data from R.",
      );
      if (!cacheEnabled) {
        expectPage(await clickNext(first, "first"), 200, 200);
        await expectProgress(first, 400, 400);
        assertEquals(errors, []);
        return;
      }
      expectPage(await clickNext(first, "first"), 200, 200);
      await expectProgress(first, 400, 400);
      if (options.verifyEarlyEviction) {
        for (let page = 2; page < 6; page++) {
          expectPage(await clickNext(first, "first"), page * 200, 200);
          await expectProgress(first, page * 200 + 200, page * 200 + 200);
        }
        assertEquals(
          await first.locator("#sequential-earlier").isHidden(),
          false,
        );
        const beforeEarlier = trace.filter((frame) =>
          frame.browser === "first" && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length;
        await first.locator("#sequential-earlier").click();
        await first.waitForFunction(() =>
          (globalThis as unknown as BrowserRuntime).document.querySelector(
            "#sequential-earlier",
          )?.hasAttribute("disabled") === false
        );
        assert(
          (await first.locator("#column-window").innerText()).includes(
            "-9223372036854775807",
          ),
        );
        assert(
          trace.filter((frame) =>
            frame.browser === "first" && frame.direction === "framesent" &&
            frame.method === "stream/next"
          ).length === beforeEarlier,
          "Restoring host pages after local eviction must not consume R again.",
        );
        assertEquals(errors, []);
        return;
      }
      if (options.hostCacheBytes !== undefined) {
        for (let page = 2; page < 8; page++) {
          expectPage(await clickNext(first, "first"), page * 200, 200);
          await expectProgress(first, page * 200, page * 200 + 200);
        }
        expectPage(await clickNext(first, "first"), 1600, 0, true);
        await expectProgress(first, 1600, 1600, true);
        const notice = await first.locator("#sequential-notice").innerText();
        assert(
          notice.includes("Rows 1–1600 are no longer retained by the host."),
          `Expected exact one-based prefix eviction notice, got: ${notice}`,
        );
        const secondRequests = trace.filter((frame) =>
          frame.browser === "second" && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length;
        await second.reload();
        await second.locator("#tables article").filter({
          hasText: "Exact sequential stream",
        }).getByRole("button", { name: "Open view", exact: true }).click();
        await second.waitForFunction(() =>
          (globalThis as unknown as BrowserRuntime).document.querySelector(
            "#sequential-progress",
          )?.textContent?.includes(
            "1600 rows seen; 1600 rows advanced; end of stream.",
          ) === true
        );
        assert(
          (await second.locator("#sequential-notice").innerText()).includes(
            "Rows 1–1600 are no longer retained by the host.",
          ),
        );
        assertEquals(
          await second.locator("#sequential-next").isDisabled(),
          true,
        );
        assert(
          trace.filter((frame) =>
            frame.browser === "second" && frame.direction === "framesent" &&
            frame.method === "stream/next"
          ).length === secondRequests,
          "Reloading an evicted host page must restore progress without consuming R.",
        );
        assertEquals(errors, []);
        return;
      }
      await second.locator("#tables article").filter({
        hasText: "Exact sequential stream",
      }).getByRole("button", { name: "Open view", exact: true }).click();
      await second.waitForFunction(() =>
        (globalThis as unknown as BrowserRuntime).document.querySelector(
          "#column-window",
        )?.textContent?.includes("-9223372036854775807") === true
      );
      const secondRequests = trace.filter((frame) =>
        frame.browser === "second" && frame.direction === "framesent" &&
        frame.method === "stream/next"
      ).length;
      assertEquals(secondRequests, 0);
      await second.reload();
      await second.locator("#tables article").filter({
        hasText: "Exact sequential stream",
      }).getByRole("button", { name: "Open view", exact: true }).click();
      await second.waitForFunction(() =>
        (globalThis as unknown as BrowserRuntime).document.querySelector(
          "#column-window",
        )?.textContent?.includes("-9223372036854775807") === true
      );
      assert(
        trace.filter((frame) =>
          frame.browser === "second" && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length === secondRequests,
        "Reloading should restore host-cached rows without consuming R.",
      );
      assertEquals((await clickNext(second, "second")).code, "in_use");
      await expectProgress(second, 200, 400);
      assert(
        !(await first.locator("#sequential-notice").innerText()).includes(
          "advanced but not displayed",
        ),
      );
      await phase("sequential owner page detach", () =>
        first.close(), 5_000);
      // Retry only a completed in_use response. Every successful page is consumed once.
      let acquired = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const terminal = await clickNext(second, "second");
        if (terminal.code === "in_use") {
          continue;
        }
        expectPage(terminal, 400, 200);
        await expectProgress(second, 200, 600);
        acquired = true;
        break;
      }
      assert(acquired, "The detached owner's lease was not released.");
      assert(
        !(await second.locator("#sequential-notice").innerText()).includes(
          "advanced but not displayed",
        ),
        "Host cache restore must not report recoverable rows as a gap.",
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
      assertEquals(
        await second.locator("#sequential-next").isDisabled(),
        false,
      );
      expectPage(await clickNext(second, "second"), 1600, 0, true);
      await expectProgress(second, 1200, 1600, true);
      assertEquals(await second.locator("#sequential-next").isDisabled(), true);
      assertEquals(
        await second.locator("#sequential-earlier").isHidden(),
        false,
      );
      const beforeEarlier = trace.filter((frame) =>
        frame.browser === "second" && frame.direction === "framesent" &&
        frame.method === "stream/next"
      ).length;
      await second.locator("#sequential-earlier").click();
      await second.waitForFunction(() =>
        (globalThis as unknown as BrowserRuntime).document.querySelector(
          "#sequential-earlier",
        )?.hasAttribute("disabled") === false
      );
      assert(
        (await second.locator("#column-window").innerText()).includes(
          "-9223372036854775807",
        ),
        "Earlier retained pages should be recoverable after browser-cache eviction.",
      );
      assert(
        trace.filter((frame) =>
          frame.browser === "second" && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length === beforeEarlier,
        "Recovering earlier host pages must not consume another R page.",
      );
      const beforeCachedForward = trace.filter((frame) =>
        frame.browser === "second" && frame.direction === "framesent" &&
        frame.method === "stream/next"
      ).length;
      const cacheStart = trace.length;
      await second.locator("#sequential-next").click();
      await waitForTrace((frame) =>
        trace.indexOf(frame) >= cacheStart && frame.browser === "second" &&
        frame.direction === "framereceived" && frame.cache_page === 4
      );
      await second.waitForFunction(() =>
        (globalThis as unknown as BrowserRuntime).document.querySelector(
          "#sequential-next",
        )?.textContent !== "Loading…"
      );
      assert(
        trace.filter((frame) =>
          frame.browser === "second" && frame.direction === "framesent" &&
          frame.method === "stream/next"
        ).length === beforeCachedForward,
        "Moving forward within retained pages must not consume another R page.",
      );
      assertEquals(errors, []);
    }, 120_000);
  } catch (error) {
    originalFailure.push(error);
    throw error;
  } finally {
    console.info(JSON.stringify({ sequential_trace: trace }));
    for (const waiter of traceWaiters.splice(0)) clearTimeout(waiter.timer);
    await finishIntegrationCleanup([
      () => owned?.close(),
      () => finishRFixture(child, finish, stderr, rPid),
      () =>
        cleanupDeadline(
          reader.cancel(),
          5_000,
          "Sequential R stdout did not close.",
        ),
      () => reader.releaseLock(),
      () =>
        phase("sequential HTTP server shutdown", () => server.close(), 5_000),
      () => assertServerReleased(server),
      () => removeCacheDirectory(work),
    ], originalFailure);
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
  name:
    "real R browser display eviction reveals and restores the earliest host page",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(false, true, { verifyEarlyEviction: true }),
});
Deno.test({
  name:
    "real R browser reports host FIFO eviction exactly and restores progress after reload",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(false, true, { hostCacheBytes: 1024 }),
});
Deno.test({
  name:
    "real R Arrow inspector recovers an evicted browser page from host cache without R requests",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(false, true, { verifyHostRecovery: true }),
});
Deno.test({
  name:
    "real R Arrow inspector reports unavailable pages without host cache or R requests",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(false, false, { verifyHostRecovery: true }),
});
Deno.test({
  name: "real R Arrow inspector reports host-evicted pages without R requests",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    sequentialBrowser(false, true, {
      verifyHostRecovery: true,
      hostCacheBytes: 1024,
    }),
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
Deno.test({
  name:
    "sequential view keeps legacy forward-only behavior when host cache is disabled",
  ignore: !executable || !rLibrary || !capabilities.arrow ||
    !capabilities.nanoarrow,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => sequentialBrowser(false, false),
});

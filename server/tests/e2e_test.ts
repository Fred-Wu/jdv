import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { ArfSession } from "./helpers/arf_session.ts";
import { type TestBrowser, TestServer } from "./helpers/test_server.ts";
import { bodyDeadline, phase } from "./bounded_browser.ts";
import {
  finishIntegrationCleanup,
  removeCacheDirectory,
} from "./integration_cleanup.ts";
import { querySnapshot } from "../web/jdv_query.js";

const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../../r-pkg/inst/spec/query-fixtures.json", import.meta.url),
  ),
);

interface Runtime {
  server: TestServer;
  arf: ArfSession;
  browser: TestBrowser;
}

interface TableOpen {
  session: string;
  message: Record<string, unknown>;
  params: Record<string, unknown>;
}

let rEvaluationSequence = 0;

function rEval(
  arf: ArfSession,
  code: string,
  timeoutMs = 30_000,
): Promise<Awaited<ReturnType<ArfSession["eval"]>>> {
  const sequence = ++rEvaluationSequence;
  return phase(
    `arf R evaluation ${sequence}`,
    () => arf.eval(code, timeoutMs),
    timeoutMs + 3_000,
  );
}

async function startRuntime(): Promise<Runtime> {
  const server = new TestServer();
  const arf = new ArfSession();
  let startedServer = false;
  let startedArf = false;
  let browser: TestBrowser | undefined;
  try {
    startedServer = true;
    await phase("R E2E server startup", () => server.start(), 30_000);
    startedArf = true;
    await phase(
      "R E2E arf startup",
      () => arf.start({ env: server.rEnv(testLibrary) }),
      60_000,
    );
    const libraryPath = rQuote(testLibrary!);
    const loadedPackage = await rEval(
      arf,
      `.libPaths(c(${libraryPath}, .libPaths())); ` +
        `library(jdv, lib.loc = ${libraryPath}); ` +
        `cat("JDV_TEST_R_LIB", normalizePath(getNamespaceInfo(asNamespace("jdv"), "path"), winslash = "/"), ` +
        `getLoadedDLLs()[["jdv"]][["path"]], sep = "\\t"); cat("\\n")`,
    );
    console.log(`Loaded E2E R package and DLL:\n${loadedPackage.stdout ?? ""}`);
    browser = await phase(
      "R E2E browser connection",
      () => server.connectBrowser(),
      30_000,
    );
    const welcome = await phase(
      "R E2E browser welcome",
      () => browser!.read(10_000),
      12_000,
    );
    assertEquals(welcome.type, "welcome");
    return { server, arf, browser };
  } catch (error) {
    await finishIntegrationCleanup([
      ...(browser
        ? [
          () =>
            phase(
              "R E2E startup browser cleanup",
              () => Promise.resolve(browser!.close()),
              10_000,
            ),
        ]
        : []),
      ...(startedArf
        ? [() => phase("R E2E startup arf cleanup", () => arf.close(), 50_000)]
        : []),
      ...(startedServer
        ? [
          () =>
            phase("R E2E startup server cleanup", () => server.close(), 10_000),
        ]
        : []),
    ], [error]);
    throw error;
  }
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  await finishIntegrationCleanup([
    () =>
      phase(
        "R E2E browser cleanup",
        () => Promise.resolve(runtime.browser.close()),
        10_000,
      ),
    () => phase("R E2E arf cleanup", () => runtime.arf.close(), 50_000),
    () => phase("R E2E server cleanup", () => runtime.server.close(), 10_000),
  ]);
}

async function nextMessage(
  browser: TestBrowser,
  predicate: (message: Record<string, unknown>) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    const message = await phase(
      `R E2E browser wait: ${description}`,
      () => browser.read(remaining),
      remaining + 500,
    );
    if (message.type === "error") {
      throw new Error(
        `Unexpected browser error while waiting for ${description}: ${
          JSON.stringify(message)
        }`,
      );
    }
    if (predicate(message)) return message;
  }
}

async function openedTable(
  browser: TestBrowser,
  title: string,
): Promise<TableOpen> {
  const event = await nextMessage(
    browser,
    (message) => {
      if (message.type !== "view/open") return false;
      const envelope = asRecord(message.message);
      const params = asRecord(envelope.params);
      return params.title === title;
    },
    `view/open for ${title}`,
  );
  const envelope = asRecord(event.message);
  return {
    session: String(event.session),
    message: envelope,
    params: asRecord(envelope.params),
  };
}

async function request(
  browser: TestBrowser,
  view: TableOpen,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  browser.send({
    type: "request",
    id,
    session: view.session,
    method,
    params: {
      view: view.params.view,
      generation: view.params.generation,
      ...params,
    },
  });
  return await nextMessage(
    browser,
    (message) => message.type === "response" && message.id === id,
    `response ${id}`,
  );
}

async function markerPath(): Promise<{ directory: string; path: string }> {
  const directory = await Deno.makeTempDir({ prefix: "jdv-e2e-marker-" });
  return { directory, path: join(directory, "entered") };
}

function rQuote(value: string): string {
  return `"${
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll(
      "\n",
      "\\n",
    ).replaceAll("\r", "\\r")
  }"`;
}

function rVector(column: Record<string, unknown>): string {
  const type = String(column.type);
  const values = column.values as unknown[];
  const special = Array.isArray(column.special) ? column.special : [];
  if (type === "int64") {
    const tokens = values.map((value) =>
      value === null ? "NA_character_" : rQuote(String(value))
    );
    return `bit64::as.integer64(c(${tokens.join(", ")}))`;
  }
  if (type === "date") {
    const tokens = values.map((value) =>
      value === null ? "NA_character_" : rQuote(String(value))
    );
    return `as.Date(c(${tokens.join(", ")}), format = "%Y-%m-%d")`;
  }
  if (type === "datetime") {
    const tokens = values.map((value) =>
      value === null ? "NA_character_" : rQuote(String(value))
    );
    const timezone = typeof column.tz === "string" ? column.tz : "UTC";
    return `as.POSIXct(c(${tokens.join(", ")}), tz = ${
      rQuote(timezone)
    }, tryFormats = c("%Y-%m-%dT%H:%M:%OS%z", "%Y-%m-%dT%H:%M:%OSZ", "%Y-%m-%dT%H:%M:%OS"))`;
  }
  if (type === "string") {
    const tokens = values.map((value) =>
      value === null ? "NA_character_" : rQuote(String(value))
    );
    return `c(${tokens.join(", ")})`;
  }
  if (type === "integer") {
    const tokens = values.map((value) =>
      value === null ? "NA_integer_" : `${Number(value)}L`
    );
    return `c(${tokens.join(", ")})`;
  }
  if (type === "boolean") {
    const tokens = values.map((value) =>
      value === null ? "NA" : value ? "TRUE" : "FALSE"
    );
    return `c(${tokens.join(", ")})`;
  }
  if (type === "categorical") {
    const tokens = values.map((value) =>
      value === null ? "NA_character_" : rQuote(String(value))
    );
    const levels = (column.levels as string[]).map(rQuote);
    return `factor(c(${tokens.join(", ")}), levels = c(${
      levels.join(", ")
    }), ordered = ${column.ordered === true ? "TRUE" : "FALSE"})`;
  }
  if (type === "other") {
    const tokens = values.map((value) =>
      value === null ? "NA_real_" : String(value)
    );
    return `structure(c(${tokens.join(", ")}), class = "query_record")`;
  }
  if (type === "number") {
    const tokens = values.map((value, index) => {
      switch (special[index]) {
        case "nan":
          return "NaN";
        case "na":
          return "NA_real_";
        case "pos_inf":
          return "Inf";
        case "neg_inf":
          return "-Inf";
        default:
          return value === null
            ? "NA_real_"
            : `jdv_e2e_json_number(${rQuote(String(value))})`;
      }
    });
    return `c(${tokens.join(", ")})`;
  }
  throw new Error(`Unsupported shared E2E fixture type: ${type}`);
}

function fixtureTableCode(
  caseName: string,
  mode: "snapshot" | "paged",
  title: string,
): string {
  const item = fixture.cases.find((candidate: Record<string, unknown>) =>
    candidate.name === caseName
  );
  assert(item, `Missing shared fixture case ${caseName}.`);
  const columns = item.columns as Array<Record<string, unknown>>;
  const vectors = columns.map((column) => rVector(column));
  const names = columns.map((column) => rQuote(String(column.name)));
  const rowCount = (columns[0].values as unknown[]).length;
  const rowNames = Array.from(
    { length: rowCount },
    (_, index) => rQuote(`fixture-row-${index + 1}`),
  );
  return [
    ...(columns.some((column) => column.type === "number")
      ? [
        'jdv_e2e_json_number <- function(value) unlist(getFromNamespace(".jdv_json_parse", "jdv")(paste0("[", value, "]")), use.names = FALSE)',
      ]
      : []),
    ...(columns.some((column) => column.type === "other")
      ? [
        'format.query_record <- function(x, ...) paste0("value:", as.numeric(x))',
        "xtfrm.query_record <- function(x, ...) as.numeric(x)",
      ]
      : []),
    `jdv_e2e_x <- data.frame(${vectors.join(", ")}, check.names = FALSE)`,
    `names(jdv_e2e_x) <- c(${names.join(", ")})`,
    `rownames(jdv_e2e_x) <- c(${rowNames.join(", ")})`,
    `jdv_view(jdv_e2e_x, title = ${rQuote(title)}, mode = ${rQuote(mode)})`,
  ].join("; ");
}

function fixtureCase(name: string): Record<string, unknown> {
  const result = fixture.cases.find((candidate: Record<string, unknown>) =>
    candidate.name === name
  );
  assert(result, `Missing shared query fixture ${name}.`);
  return result;
}

function assertFixtureQueryRows(
  actual: unknown,
  expected: unknown,
  caseName: string,
  query: Record<string, unknown>,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Paged query failed for ${caseName}/${String(query.name)}: ` +
        `expected ${JSON.stringify(expected)}, got ${
          JSON.stringify(actual)
        }; ` +
        `sort=${JSON.stringify(query.sort ?? [])}; ` +
        `filter=${JSON.stringify(query.filter ?? null)}.`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object.",
  );
  return value as Record<string, unknown>;
}

function responseResult(
  message: Record<string, unknown>,
): Record<string, unknown> {
  assert(
    !message.error,
    `Request returned an error: ${JSON.stringify(message.error)}`,
  );
  return asRecord(message.result);
}

function responseRowIndex(message: Record<string, unknown>): number[] {
  const result = responseResult(message);
  const data = asRecord(result.data);
  return data.source_row as number[];
}

async function assertNoCompletedEvaluation(
  pending: { result: Promise<unknown> },
): Promise<void> {
  let completed = false;
  void pending.result.then(() => completed = true, () => completed = true);
  await Promise.resolve();
  assert(
    !completed,
    "R completed the evaluation before the pending operation finished.",
  );
}

Deno.test({
  name:
    "real R end-to-end Snapshot, Paged, query, busy, and reconnect contracts",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let runtime: Runtime | undefined;
    const markerDirs: string[] = [];
    const releaseFiles: string[] = [];
    const extraBrowsers: TestBrowser[] = [];
    let primaryError: unknown;
    try {
      await bodyDeadline("R E2E overall body", async () => {
        runtime = await startRuntime();
        const { server, arf, browser } = runtime;

        // A Snapshot is complete at view/open, so the consumer can sort, filter,
        // and page it while the real R process is inside Sys.sleep().
        await rEval(
          arf,
          fixtureTableCode("numeric-special", "snapshot", "e2e-snapshot"),
        );
        const snapshot = await openedTable(browser, "e2e-snapshot");
        assertEquals(snapshot.params.access, "snapshot");
        const snapshotNumber = asRecord(
          (asRecord(snapshot.params.data).columns as Array<
            Record<string, unknown>
          >)[0],
        );
        assertEquals(snapshotNumber.na_rows, [0, 1, 3, 4]);
        assertEquals(snapshotNumber.special, {
          nan: [0, 4],
          pos_inf: [5],
          neg_inf: [6],
        });
        assert(!Object.hasOwn(snapshotNumber, "na"));
        const snapshotEnvelope = { params: snapshot.params };
        const rowsBeforeSnapshotQuery =
          server.wire.snapshot().tableRowsRequests.length;
        const sleepMarker = await markerPath();
        markerDirs.push(sleepMarker.directory);
        const sleeping = arf.send(
          `writeLines("sleep-entered", ${
            rQuote(sleepMarker.path)
          }, useBytes = TRUE); Sys.sleep(5)`,
          { timeoutMs: 10_000 },
        );
        await arf.waitForFile(sleepMarker.path, 10_000);
        const localResult = querySnapshot(snapshotEnvelope, {
          sort: [
            { col: 0, desc: true },
            { col: 1, desc: false },
          ],
          filter: { op: "is_na", col: 0 },
          offset: 1,
          limit: 3,
        });
        assertEquals(localResult.data.source_row, [3, 0, 4]);
        assertEquals(
          server.wire.snapshot().tableRowsRequests.length,
          rowsBeforeSnapshotQuery,
        );
        await assertNoCompletedEvaluation(sleeping);
        await phase(
          "R E2E Snapshot sleep completion",
          () => sleeping.wait(10_000),
          12_000,
        );

        // A live Paged request reaches the R transport during a C-level busy
        // computation, stays unanswered, then completes without manual polling.
        await rEval(
          arf,
          fixtureTableCode("numeric-special", "paged", "e2e-busy"),
        );
        const busyTable = await openedTable(browser, "e2e-busy");
        const busyMarker = await markerPath();
        const busyRelease = `${busyMarker.directory}/release`;
        markerDirs.push(busyMarker.directory);
        releaseFiles.push(busyRelease);
        const busy = arf.send(
          `writeLines("busy-entered", ${
            rQuote(busyMarker.path)
          }, useBytes = TRUE); jdv_e2e_spin <- 0L; while (!file.exists(${
            rQuote(busyRelease)
          })) jdv_e2e_spin <- jdv_e2e_spin + 1L`,
          { timeoutMs: 30_000 },
        );
        await arf.waitForFile(busyMarker.path, 10_000);
        const wireBeforeBusyRequest = server.wire.snapshot();
        browser.send({
          type: "request",
          id: "e2e-busy-page",
          session: busyTable.session,
          method: "grid/rows",
          params: {
            view: busyTable.params.view,
            generation: busyTable.params.generation,
            offset: 0,
            limit: 2,
            cols: [0],
          },
        });
        try {
          await server.wire.waitFor(
            (wire) =>
              wire.tableRowsRequests.length >
                wireBeforeBusyRequest.tableRowsRequests.length &&
              wire.tableRowsRequests.some((frame) =>
                frame.view === busyTable.params.view &&
                frame.generation === busyTable.params.generation &&
                frame.offset === 0 && frame.limit === 2
              ),
            5_000,
          );
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nWire: ${
              JSON.stringify(server.wire.snapshot())
            }`,
            { cause: error },
          );
        }
        const busyNotice = await nextMessage(
          browser,
          (message) =>
            message.type === "busy" && message.id === "e2e-busy-page",
          "busy state for the pending computation",
          5_000,
        );
        assertEquals(busyNotice.id, "e2e-busy-page");
        await assertNoCompletedEvaluation(busy);
        assertEquals(
          server.wire.snapshot().tableRowsResponses.length,
          wireBeforeBusyRequest.tableRowsResponses.length,
        );
        await Deno.writeTextFile(busyRelease, "release\n");
        await phase(
          "R E2E busy evaluation completion",
          () => busy.wait(30_000),
          33_000,
        );
        const busyResponse = await nextMessage(
          browser,
          (message) =>
            message.type === "response" && message.id === "e2e-busy-page",
          "automatic page response after the busy computation",
        );
        assertEquals(responseRowIndex(busyResponse), [0, 1]);

        // A large Paged descriptor and one selected page stay bounded. The R
        // class methods count formatting and subsetting over the full source.
        await rEval(
          arf,
          [
            "jdv_e2e_counter <- new.env(parent = emptyenv())",
            "jdv_e2e_counter$format <- 0L; jdv_e2e_counter$xtfrm <- 0L; jdv_e2e_counter$slice_input <- 0L; jdv_e2e_counter$slice_output <- 0L",
            "format.e2e_counter <- function(x, ...) { jdv_e2e_counter$format <- jdv_e2e_counter$format + length(x); as.character(unclass(x)) }",
            "xtfrm.e2e_counter <- function(x, ...) { jdv_e2e_counter$xtfrm <- jdv_e2e_counter$xtfrm + length(x); unclass(x) }",
            '`[.e2e_counter` <- function(x, i, ..., drop = TRUE) { jdv_e2e_counter$slice_input <- jdv_e2e_counter$slice_input + length(x); out <- NextMethod("["); jdv_e2e_counter$slice_output <- jdv_e2e_counter$slice_output + length(out); structure(out, class = "e2e_counter") }',
            'jdv_e2e_large <- data.frame(value = structure(seq_len(50000L), class = "e2e_counter"))',
            'rownames(jdv_e2e_large) <- paste0("row-", seq_len(nrow(jdv_e2e_large)))',
            'jdv_view(jdv_e2e_large, title = "e2e-paged-large", mode = "paged")',
          ].join("; "),
        );
        const largeTable = await openedTable(browser, "e2e-paged-large");
        assertEquals(largeTable.params.access, "random");
        assert(
          !("data" in largeTable.params),
          "Paged descriptor carried table data.",
        );
        const largeDescriptor = server.wire.snapshot().tableOpenDescriptors.at(
          -1,
        );
        assert(
          largeDescriptor && !largeDescriptor.hasData,
          "Wire descriptor included data.",
        );
        assert(
          largeDescriptor.bytes < 10_000,
          `Paged descriptor was unexpectedly large: ${largeDescriptor.bytes} bytes.`,
        );
        const registrationCounter = await markerPath();
        markerDirs.push(registrationCounter.directory);
        await rEval(
          arf,
          `writeLines(as.character(jdv_e2e_counter$format), ${
            rQuote(registrationCounter.path)
          })`,
        );
        const registrationCount = Number(
          (await Deno.readTextFile(registrationCounter.path)).trim(),
        );
        assert(
          registrationCount <= 64,
          `Paged registration formatted ${registrationCount} values instead of a bounded probe.`,
        );
        await rEval(
          arf,
          "jdv_e2e_counter$format <- 0L; jdv_e2e_counter$slice_input <- 0L; jdv_e2e_counter$slice_output <- 0L",
        );
        const largeResponse = await request(
          browser,
          largeTable,
          "e2e-large-page",
          "grid/rows",
          {
            offset: 49_997,
            limit: 3,
            cols: [0],
          },
        );
        const largeResult = responseResult(largeResponse);
        const largeData = asRecord(largeResult.data);
        assertEquals(largeData.source_row, [49_997, 49_998, 49_999]);
        assertEquals((largeData.columns as unknown[]).length, 1);
        const largeColumn = asRecord((largeData.columns as unknown[])[0]);
        assertEquals(asRecord(largeColumn.schema).position, 0);
        const pageCounter = await markerPath();
        markerDirs.push(pageCounter.directory);
        await rEval(
          arf,
          `writeLines(paste(jdv_e2e_counter$format, jdv_e2e_counter$slice_output), ${
            rQuote(pageCounter.path)
          })`,
        );
        const [formattedText, slicedText] = (await Deno.readTextFile(
          pageCounter.path,
        )).trim().split(" ");
        const formattedPage = Number(formattedText);
        const slicedPage = Number(slicedText);
        assertEquals(formattedPage, 3);
        assertEquals(slicedPage, 3);
        const largeWireResponse = server.wire.snapshot().tableRowsResponses
          .find((
            frame,
          ) =>
            frame.view === largeTable.params.view &&
            frame.generation === largeTable.params.generation &&
            frame.offset === 49_997
          );
        assert(
          largeWireResponse && largeWireResponse.bytes < 10_000,
          "Selected Paged response was not wire-bounded.",
        );

        // Use the same checked-in fixture cases to exercise real R Paged sorting,
        // stable ties, NA-last order, Unicode order, int64 precision, column
        // selection, row names, typed filters, and a terminal validation error.
        const semCases = [
          "numeric-special",
          "tiny-exact",
          "utf8-byte-order",
          "ascii-literal-text",
          "boolean-factor",
          "integer64",
          "date-datetime",
          "example-other",
        ];
        const semTables: Record<string, TableOpen> = {};
        for (const caseName of semCases) {
          const title = `e2e-paged-${caseName}`;
          await rEval(arf, fixtureTableCode(caseName, "paged", title));
          semTables[caseName] = await openedTable(browser, title);
        }
        const numericTable = semTables["numeric-special"];
        const numericCase = fixtureCase("numeric-special");
        const numericPage = await request(
          browser,
          numericTable,
          "e2e-sparse-special-page",
          "grid/rows",
          { offset: 0, limit: 8, cols: [0] },
        );
        const numericPageColumn = asRecord(
          (asRecord(responseResult(numericPage).data).columns as Array<
            Record<string, unknown>
          >)[0].data,
        );
        assertEquals(numericPageColumn.na_rows, [0, 1, 3, 4]);
        assertEquals(numericPageColumn.special, {
          nan: [0, 4],
          pos_inf: [5],
          neg_inf: [6],
        });
        assert(!Object.hasOwn(numericPageColumn, "na"));
        for (
          const query of numericCase.queries as Array<Record<string, unknown>>
        ) {
          const result = await request(
            browser,
            numericTable,
            `e2e-sem-${String(query.name)}`,
            "grid/rows",
            {
              offset: 0,
              limit: 200,
              sort: query.sort,
              filter: query.filter,
              cols: [0, 1],
            },
          );
          assertEquals(responseRowIndex(result), query.expected);
        }
        const selected = await request(
          browser,
          numericTable,
          "e2e-selected-columns",
          "grid/rows",
          {
            offset: 1,
            limit: 2,
            cols: [1],
          },
        );
        const selectedData = asRecord(responseResult(selected).data);
        assertEquals(selectedData.source_row, [1, 2]);
        assertEquals(selectedData.row_labels, [
          "fixture-row-2",
          "fixture-row-3",
        ]);
        const numericSchema =
          (selectedData.columns as Array<Record<string, unknown>>)[0]
            .schema as Record<string, unknown>;
        assertEquals(numericSchema.name, "k");
        const invalid = await request(
          browser,
          numericTable,
          "e2e-invalid-filter",
          "grid/rows",
          {
            filter: { op: "eq", col: 99, value: 1 },
          },
        );
        assertEquals(asRecord(invalid.error).code, "invalid_request");
        for (
          const caseName of semCases.filter((name) =>
            name !== "numeric-special"
          )
        ) {
          const testCase = fixtureCase(caseName);
          const table = semTables[caseName];
          for (
            const query of testCase.queries as Array<Record<string, unknown>>
          ) {
            const result = await request(
              browser,
              table,
              `e2e-${caseName}-${String(query.name)}`,
              "grid/rows",
              {
                offset: 0,
                limit: 200,
                sort: query.sort,
                filter: query.filter,
                cols: [0],
              },
            );
            assertFixtureQueryRows(
              responseRowIndex(result),
              query.expected,
              caseName,
              query,
            );
          }
        }

        await rEval(
          arf,
          [
            'jdv_e2e_compact <- structure(list(), class = "data.frame", row.names = c(NA_integer_, -800000000L))',
            'jdv_view(jdv_e2e_compact, title = "e2e-compact-altrep", mode = "paged")',
          ].join("; "),
        );
        const compactTable = await openedTable(browser, "e2e-compact-altrep");
        const compact = await request(
          browser,
          compactTable,
          "e2e-compact-tail",
          "grid/rows",
          { offset: 799_999_997, limit: 3 },
        );
        assertEquals(
          responseRowIndex(compact),
          [799_999_997, 799_999_998, 799_999_999],
        );

        // Snapshot's JavaScript consumer and the live Paged R engine agree on
        // the same wire sort/filter, including selected row names and channels.
        await rEval(
          arf,
          fixtureTableCode("numeric-special", "snapshot", "e2e-agree-snapshot"),
        );
        const agreeSnapshot = await openedTable(browser, "e2e-agree-snapshot");
        await rEval(
          arf,
          fixtureTableCode("numeric-special", "paged", "e2e-agree-paged"),
        );
        const agreePaged = await openedTable(browser, "e2e-agree-paged");
        const sharedSort = [
          { col: 0, desc: true },
          { col: 1, desc: false },
        ];
        const sharedFilter = { op: "not", arg: { op: "eq", col: 1, value: 2 } };
        const snapshotPage = querySnapshot({ params: agreeSnapshot.params }, {
          sort: sharedSort,
          filter: sharedFilter,
          offset: 1,
          limit: 4,
          cols: [1],
        });
        const pagedResponse = await request(
          browser,
          agreePaged,
          "e2e-snapshot-paged-agreement",
          "grid/rows",
          {
            sort: sharedSort,
            filter: sharedFilter,
            offset: 1,
            limit: 4,
            cols: [1],
          },
        );
        const pagedResult = responseResult(pagedResponse);
        const pagedData = asRecord(pagedResult.data);
        assertEquals(pagedData.source_row, snapshotPage.data.source_row);
        assertEquals(pagedData.row_labels, snapshotPage.data.row_labels);
        const pagedColumn =
          (pagedData.columns as Array<Record<string, unknown>>)[0];
        const snapshotColumn = snapshotPage.data.columns[0];
        assertEquals(pagedColumn.schema, snapshotColumn.schema);
        assertEquals(pagedColumn.data, snapshotColumn.data);

        // Early four-digit years, offset datetime filters, fractional seconds,
        // and missing values must agree across the browser and R query paths.
        const calendarSource = [
          'jdv_e2e_calendar_date <- as.Date(c("0000-01-01", "0001-01-01", "0099-12-31", "0100-02-03", "0999-02-03", "2024-02-29", NA), format = "%Y-%m-%d")',
          'jdv_e2e_calendar_time <- as.POSIXct(as.numeric(jdv_e2e_calendar_date) * 86400 + 10 * 3600 + 4 * 60 + 56.125, origin = "1970-01-01", tz = "UTC")',
          'jdv_e2e_calendar_time_decimal <- as.POSIXct(as.numeric(jdv_e2e_calendar_date) * 86400 + 10 * 3600 + 4 * 60 + 56.123456, origin = "1970-01-01", tz = "UTC")',
          "jdv_e2e_calendar <- data.frame(date = jdv_e2e_calendar_date, time = jdv_e2e_calendar_time, time_decimal = jdv_e2e_calendar_time_decimal)",
        ].join("; ");
        const calendarSnapshotTitle = "e2e-calendar-snapshot";
        await rEval(
          arf,
          `${calendarSource}; jdv_view(jdv_e2e_calendar, title = ${
            rQuote(calendarSnapshotTitle)
          }, mode = "snapshot")`,
        );
        const calendarSnapshot = await openedTable(
          browser,
          calendarSnapshotTitle,
        );
        const calendarSnapshotRows = querySnapshot({
          params: calendarSnapshot.params,
        });
        const calendarPagedTitle = "e2e-calendar-paged";
        await rEval(
          arf,
          `${calendarSource}; jdv_view(jdv_e2e_calendar, title = ${
            rQuote(calendarPagedTitle)
          }, mode = "paged")`,
        );
        const calendarPaged = await openedTable(browser, calendarPagedTitle);
        const calendarQueries = [
          {
            filter: { op: "lt", col: 0, value: "1000-01-01" },
            expected: [0, 1, 2, 3, 4],
          },
          {
            filter: {
              op: "eq",
              col: 1,
              value: "0001-01-01T12:34:56.125+02:30",
            },
            expected: [1],
          },
          {
            filter: {
              op: "eq",
              col: 2,
              value: "0001-01-01T12:34:56.123456+02:30",
            },
            expected: [1],
          },
          { filter: { op: "is_na", col: 0 }, expected: [6] },
        ];
        for (let index = 0; index < calendarQueries.length; index++) {
          const query = calendarQueries[index];
          const local = querySnapshot({ params: calendarSnapshot.params }, {
            filter: query.filter,
          });
          assertEquals(local.data.source_row, query.expected);
          const remote = await request(
            browser,
            calendarPaged,
            `e2e-calendar-filter-${index}`,
            "grid/rows",
            { offset: 0, limit: 20, filter: query.filter, cols: [0, 1, 2] },
          );
          assertEquals(responseRowIndex(remote), local.data.source_row);
        }
        const calendarRemoteAll = await request(
          browser,
          calendarPaged,
          "e2e-calendar-all-rows",
          "grid/rows",
          { offset: 0, limit: 20, cols: [0, 1, 2] },
        );
        assertEquals(
          responseRowIndex(calendarRemoteAll),
          calendarSnapshotRows.data.source_row,
        );

        const sharedRegistry = await rEval(
          arf,
          'jdv_e2e_shared_id <- jdv_register(data.frame(value = 99L), title = "e2e-shared-registry", mode = "paged")$id; jdv_e2e_shared_id',
        );
        const sharedRegistryId = String(sharedRegistry.value).trim();
        assert(sharedRegistryId.length > 0, "Shared registry ID was empty.");

        // Browser reconnect restores cached Snapshot data and still routes a
        // Paged query. Disconnecting R removes its session; a new R process opens
        // a distinct session against the still-running host.
        browser.close();
        const reconnect = await server.connectBrowser();
        extraBrowsers.push(reconnect);
        const welcome = await reconnect.read();
        assertEquals(welcome.type, "welcome");
        const sessions = welcome.sessions as Array<Record<string, unknown>>;
        const cachedSession = sessions.find((session) =>
          asRecord(asRecord(session.hello).params).session ===
            agreeSnapshot.session
        );
        assert(
          cachedSession,
          "Browser reconnect welcome omitted the R session.",
        );
        const cachedTables = cachedSession.views as Array<
          Record<string, unknown>
        >;
        const cachedSnapshot = cachedTables.find((entry) => {
          const envelope = asRecord(entry);
          return asRecord(envelope.params).view === agreeSnapshot.params.view;
        });
        assert(
          cachedSnapshot,
          "Browser reconnect welcome omitted the Snapshot table.",
        );
        assert(
          "data" in asRecord(asRecord(cachedSnapshot).params),
          "Cached Snapshot omitted its materialized data.",
        );
        const restoredRowsBefore =
          server.wire.snapshot().tableRowsRequests.length;
        const restoredQuery = querySnapshot(cachedSnapshot, {
          sort: sharedSort,
          filter: sharedFilter,
          offset: 0,
          limit: 2,
          cols: [1],
        });
        assertEquals(restoredQuery.data.source_row.length, 2);
        assertEquals(
          server.wire.snapshot().tableRowsRequests.length,
          restoredRowsBefore,
        );
        const reconnectPaged = await request(
          reconnect,
          agreePaged,
          "e2e-reconnect-paged",
          "grid/rows",
          {
            offset: 0,
            limit: 2,
            cols: [0],
          },
        );
        assertEquals(responseRowIndex(reconnectPaged), [0, 1]);
        server.dropR();
        await nextMessage(
          reconnect,
          (message) =>
            message.type === "session/closed" &&
            message.session === agreeSnapshot.session,
          "old R session cleanup",
        );
        const oldTableId = String(agreeSnapshot.params.view);
        const reopenedCode = fixtureTableCode(
          "numeric-special",
          "paged",
          "e2e-reconnected",
        );
        await rEval(arf, reopenedCode);
        const stateCheck = await rEval(
          arf,
          `!any(c(exists(${
            rQuote(oldTableId)
          }, envir = getFromNamespace(".jdv_state", "jdv")$entries, inherits = FALSE), ` +
            `exists(${
              rQuote(sharedRegistryId)
            }, envir = getFromNamespace(".jdv_state", "jdv")$entries, inherits = FALSE)))`,
        );
        assert(
          stateCheck.value?.trim().endsWith("TRUE"),
          `Disconnected registry entries remained: ${stateCheck.value}`,
        );
        const reopened = await openedTable(reconnect, "e2e-reconnected");
        assert(
          reopened.session !== agreeSnapshot.session,
          "R reused the disconnected session id.",
        );
        const oldCounter = Number(agreeSnapshot.session.split("-").at(-1));
        const newCounter = Number(reopened.session.split("-").at(-1));
        assertEquals(newCounter, oldCounter + 1);
        assertEquals(
          reopened.session.split("-")[1],
          agreeSnapshot.session.split("-")[1],
        );
        assertEquals(reopened.params.generation, 1);
        const reopenedPage = await request(
          reconnect,
          reopened,
          "e2e-reconnected-paged",
          "grid/rows",
          { offset: 0, limit: 2, cols: [0] },
        );
        assertEquals(responseRowIndex(reopenedPage), [0, 1]);
        for (const extra of extraBrowsers) extra.close();
        console.log(
          "Real R/arf E2E passed: Snapshot offline queries, busy-loop wake/resume, bounded Paged wire output, shared Paged semantics, Snapshot/Paged agreement, and reconnect cleanup.",
        );
      }, 300_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        ...releaseFiles.map((path) => () =>
          Deno.writeTextFile(path, "release\n")
        ),
        ...extraBrowsers.map((browser) => () =>
          phase(
            "R E2E extra browser cleanup",
            () => Promise.resolve(browser.close()),
            10_000,
          )
        ),
        ...markerDirs.map((directory) => () => removeCacheDirectory(directory)),
        ...(runtime
          ? [
            () =>
              phase(
                "R E2E runtime cleanup",
                () => closeRuntime(runtime!),
                75_000,
              ),
          ]
          : []),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

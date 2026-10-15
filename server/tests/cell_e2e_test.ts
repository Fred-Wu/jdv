import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { ArfSession } from "./helpers/arf_session.ts";
import {
  finishIntegrationCleanup,
  removeCacheDirectory,
} from "./integration_cleanup.ts";
import { type TestBrowser, TestServer } from "./helpers/test_server.ts";
import { bodyDeadline, launchOwnedBrowser, phase } from "./bounded_browser.ts";
import {
  click,
  clickButton,
  collectPageErrors,
  count,
  fillInput,
  inputValue,
  selectOption,
  text,
  waitFor,
} from "./astral_page.ts";

const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");

interface E2EDomElement {
  textContent: string | null;
}

declare const document: {
  querySelector(selector: string): E2EDomElement | null;
};

let rEvaluationSequence = 0;

function rEval(
  arf: ArfSession,
  code: string,
  timeoutMs = 30_000,
): Promise<Awaited<ReturnType<ArfSession["eval"]>>> {
  const sequence = ++rEvaluationSequence;
  return phase(
    `Cell E2E R evaluation ${sequence}`,
    () => arf.eval(code, timeoutMs),
    timeoutMs + 3_000,
  );
}

interface Runtime {
  server: TestServer;
  arf: ArfSession;
  browser: TestBrowser;
}

interface OpenedView {
  session: string;
  params: Record<string, unknown>;
}

const pendingMessages = new WeakMap<TestBrowser, Record<string, unknown>[]>();

function asRecord(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object.",
  );
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "Expected an array.");
  return value;
}

function rQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function nextMessage(
  browser: TestBrowser,
  predicate: (message: Record<string, unknown>) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const pending = pendingMessages.get(browser) ?? [];
  pendingMessages.set(browser, pending);
  const queued = pending.findIndex(predicate);
  if (queued >= 0) return pending.splice(queued, 1)[0];

  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    const message = await browser.read(remaining);
    if (predicate(message)) return message;
    if (message.type === "error") {
      throw new Error(
        `Unexpected browser error while waiting for ${description}: ${
          JSON.stringify(message)
        }`,
      );
    }
    pending.push(message);
  }
}

async function openedView(
  browser: TestBrowser,
  title: string,
): Promise<OpenedView> {
  const event = await nextMessage(
    browser,
    (message) => {
      if (message.type !== "view/open") return false;
      const params = asRecord(asRecord(message.message).params);
      return params.title === title;
    },
    `view/open for ${title}`,
  );
  return {
    session: String(event.session),
    params: asRecord(asRecord(event.message).params),
  };
}

async function request(
  browser: TestBrowser,
  view: OpenedView,
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
    (message) =>
      (message.type === "response" || message.type === "error") &&
      message.id === id,
    `response ${id}`,
  );
}

function responseResult(
  message: Record<string, unknown>,
): Record<string, unknown> {
  assert(
    message.type === "response" && !message.error,
    `Request failed: ${JSON.stringify(message.error ?? message)}`,
  );
  return asRecord(message.result);
}

function responseErrorCode(message: Record<string, unknown>): unknown {
  return asRecord(message.error ?? message).code;
}

async function startRuntime(): Promise<Runtime> {
  assert(testLibrary, "JDV_TEST_R_LIB must select the scratch library.");
  const server = new TestServer();
  const arf = new ArfSession();
  let startedServer = false;
  let startedArf = false;
  let browser: TestBrowser | undefined;
  try {
    startedServer = true;
    await phase("Cell E2E server startup", () => server.start(), 30_000);
    startedArf = true;
    await phase(
      "Cell E2E arf startup",
      () => arf.start({ env: server.rEnv(testLibrary) }),
      60_000,
    );
    const libraryPath = rQuote(testLibrary);
    const loaded = await rEval(
      arf,
      `.libPaths(c(${libraryPath}, .libPaths())); ` +
        `library(jdv, lib.loc = ${libraryPath}); ` +
        `cat("JDV_TEST_R_LIB", normalizePath(getNamespaceInfo(asNamespace("jdv"), "path"), winslash = "/"), ` +
        `getLoadedDLLs()[["jdv"]][["path"]], sep = "\\t"); cat("\\n")`,
    );
    console.log(`Loaded Cell E2E R package and DLL:\n${loaded.stdout ?? ""}`);
    browser = await phase(
      "Cell E2E browser connection",
      () => server.connectBrowser(),
      30_000,
    );
    assertEquals(
      (await phase(
        "Cell E2E browser welcome",
        () => browser!.read(10_000),
        12_000,
      ))
        .type,
      "welcome",
    );
    return { server, arf, browser };
  } catch (error) {
    await finishIntegrationCleanup([
      ...(browser
        ? [
          () =>
            phase(
              "Cell E2E startup browser cleanup",
              () => Promise.resolve(browser!.close()),
              10_000,
            ),
        ]
        : []),
      ...(startedArf
        ? [
          () =>
            phase("Cell E2E startup arf cleanup", () => arf.close(), 50_000),
        ]
        : []),
      ...(startedServer
        ? [
          () =>
            phase(
              "Cell E2E startup server cleanup",
              () => server.close(),
              10_000,
            ),
        ]
        : []),
    ], [error]);
    throw error;
  }
}

function cellFixtureCode(): string {
  return [
    "jdv_cell_values <- vector('list', 405L)",
    'jdv_cell_values[[1L]] <- list(marker = "list-cell-1", nested = list(value = "nested-list-cell"))',
    'jdv_cell_values[[2L]] <- data.frame(value = c("data-frame-cell", "frame-tail"), check.names = FALSE)',
    'jdv_cell_values[[3L]] <- matrix(c("matrix-cell", "matrix-tail"), ncol = 1L)',
    'for (i in 4L:405L) jdv_cell_values[[i]] <- list(marker = paste0("payload-", i), nested = list(value = paste0("nested-", i)))',
    'jdv_cell_values[[205L]] <- list(marker = "payload-205", `<img src=x onerror=alert(1)>` = "plain text", nested = list(value = "nested-205"))',
    'jdv_cell_table <- data.frame(rank = seq_len(405L), payload = I(jdv_cell_values), plain = paste0("row-", seq_len(405L)), check.names = FALSE)',
    'rownames(jdv_cell_table) <- paste0("source-row-", seq_len(nrow(jdv_cell_table)))',
    'jdv_cell_snapshot <- jdv_view(jdv_cell_table, title = "Cell Snapshot", mode = "snapshot")',
    'jdv_cell_paged <- jdv_view(jdv_cell_table, title = "Cell Paged", mode = "paged")',
    'jdv_cell_no_drill <- jdv_view(data.frame(rank = 1:3, plain = c("a", "b", "c")), title = "Cell No Drill", mode = "snapshot")',
    "jdv_cell_capture_backing <- new.env(parent = emptyenv())",
    "jdv_cell_capture_backing$payload <- list(data.frame(value = c(17L, 18L), check.names = FALSE))",
    '`[[.jdvCellProxy` <- function(x, i, ..., exact = TRUE) { if ((is.character(i) && length(i) == 1L && identical(i, "payload")) || (is.numeric(i) && length(i) == 1L && identical(as.integer(i), 2L))) return(jdv_cell_capture_backing$payload); NextMethod("[[") }',
    'jdv_cell_capture_proxy <- structure(list(rank = 1L, payload = NULL), class = c("jdvCellProxy", "data.frame"), row.names = c(NA_integer_, -1L))',
    'jdv_cell_capture_view <- jdv_view(jdv_cell_capture_proxy, title = "Cell Capture", mode = "snapshot")',
  ].join("; ");
}

function snapshotColumnValues(descriptor: Record<string, unknown>): unknown[] {
  const data = asRecord(descriptor.data);
  const columns = asArray(data.columns).map(asRecord);
  assertEquals(columns.length, 1);
  const values = columns[0].values ?? asRecord(columns[0].data).values;
  return asArray(values);
}

async function assertNoCompletedEvaluation(
  pending: { result: Promise<unknown> },
): Promise<void> {
  let completed = false;
  void pending.result.then(() => completed = true, () => completed = true);
  await Promise.resolve();
  assert(!completed, "The R evaluation completed before its release marker.");
}

Deno.test({
  name:
    "real R Cell Inspector opens original cells and stays responsive while R is busy",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtime = await startRuntime();
    const markerDir = await Deno.makeTempDir({ prefix: "jdv-cell-e2e-" });
    const marker = join(markerDir, "busy-entered");
    const release = join(markerDir, "release");
    let screenshotDir: string | undefined;
    let closeChromium: (() => Promise<void>) | undefined;
    let primaryError: unknown;
    let busy: {
      result: Promise<unknown>;
      wait(timeoutMs?: number): Promise<unknown>;
    } | undefined;
    try {
      await bodyDeadline("Cell E2E overall body", async () => {
        const { arf, browser, server } = runtime;
        await rEval(arf, cellFixtureCode());
        const snapshot = await openedView(browser, "Cell Snapshot");
        const paged = await openedView(browser, "Cell Paged");
        const noDrill = await openedView(browser, "Cell No Drill");
        const captureView = await openedView(browser, "Cell Capture");
        const snapshotColumns = asArray(snapshot.params.columns).map(asRecord);
        const pagedColumns = asArray(paged.params.columns).map(asRecord);
        const noDrillColumns = asArray(noDrill.params.columns).map(asRecord);
        assertEquals(snapshotColumns[0].drillable, false);
        assertEquals(snapshotColumns[1].drillable, true);
        assertEquals(pagedColumns[1].drillable, true);
        assertEquals(
          noDrillColumns.some((column) => column.drillable === true),
          false,
        );
        const sourceProbe = await rEval(
          arf,
          'state <- get(".jdv_state", envir = asNamespace("jdv")); ' +
            "snapshot <- get(as.character(jdv_cell_snapshot), envir = state$entries, inherits = FALSE); " +
            "plain <- get(as.character(jdv_cell_no_drill), envir = state$entries, inherits = FALSE); " +
            'cat("CELL_SOURCE", !is.null(snapshot$source), !is.null(plain$source), sep = "\\t"); cat("\\n")',
        );
        assert(
          sourceProbe.stdout?.includes("CELL_SOURCE\tTRUE\tFALSE"),
          `Expected only the drillable Snapshot to retain a source: ${sourceProbe.stdout}`,
        );

        const cellPath = (rowIndex: number, column: number) => [
          { kind: "cell", row_index: rowIndex, column },
        ];
        const listCell = responseResult(
          await request(
            browser,
            snapshot,
            "cell-list",
            "object/open",
            { path: cellPath(1, 1) },
          ),
        );
        assertEquals(listCell.kind, "tree");
        assertEquals(listCell.parent, snapshot.params.view);
        const suffix = responseResult(
          await request(
            browser,
            snapshot,
            "cell-suffix",
            "object/open",
            {
              path: [
                ...cellPath(205, 1),
                { type: "index", index: 2 },
              ],
            },
          ),
        );
        assertEquals(suffix.kind, "tree");
        assertEquals(suffix.parent, snapshot.params.view);
        const frameCell = responseResult(
          await request(
            browser,
            snapshot,
            "cell-frame",
            "object/open",
            { path: cellPath(2, 1) },
          ),
        );
        assertEquals(frameCell.kind, "grid");
        const matrixCell = responseResult(
          await request(
            browser,
            snapshot,
            "cell-matrix",
            "object/open",
            { path: cellPath(3, 1) },
          ),
        );
        assertEquals(matrixCell.kind, "grid");

        const invalidRequests = [
          { path: cellPath(0, 1) },
          { path: cellPath(406, 1) },
          { path: cellPath(1, -1) },
          { path: cellPath(1, 3) },
        ];
        for (const [index, params] of invalidRequests.entries()) {
          const failure = await request(
            browser,
            snapshot,
            `cell-invalid-${index}`,
            "object/open",
            params,
          );
          assert(
            typeof responseErrorCode(failure) === "string",
            `Invalid cell position ${index} should return a terminal error.`,
          );
        }
        const stale = await request(
          browser,
          snapshot,
          "cell-stale",
          "object/open",
          {
            generation: Number(snapshot.params.generation) + 1,
            path: cellPath(1, 1),
          },
        );
        assertEquals(responseErrorCode(stale), "stale_generation");
        const nonDrillable = await request(
          browser,
          snapshot,
          "cell-nondrillable",
          "object/open",
          { path: cellPath(1, 0) },
        );
        assertEquals(responseErrorCode(nonDrillable), "invalid_request");

        const pagedRows = await request(
          browser,
          paged,
          "cell-paged-rows",
          "table/rows",
          {
            offset: 200,
            limit: 5,
            cols: [0, 1],
            sort: [{ col: 0, desc: true }],
            filter: { op: "gt", col: 0, value: 100 },
          },
        );
        const pagedRowsData = asRecord(
          asRecord(responseResult(pagedRows).data),
        );
        assertEquals(pagedRowsData.row_index, [205, 204, 203, 202, 201]);
        const pagedCell = responseResult(
          await request(
            browser,
            paged,
            "cell-paged-open",
            "object/open",
            { path: cellPath(Number(asArray(pagedRowsData.row_index)[0]), 1) },
          ),
        );
        assertEquals(pagedCell.kind, "tree");
        assertEquals(pagedCell.parent, paged.params.view);

        const capturePath = cellPath(1, 1);
        await rEval(arf, "options(jdv.snapshot_max_cells = 0L)");
        const capturedChild = responseResult(
          await request(
            browser,
            captureView,
            "cell-capture-old",
            "object/open",
            {
              path: capturePath,
            },
          ),
        );
        assertEquals(capturedChild.kind, "grid");
        assertEquals(capturedChild.mode, "paged");
        await rEval(
          arf,
          "jdv_cell_capture_backing$payload[[1L]] <- " +
            "data.frame(value = c(99L, 100L), check.names = FALSE)",
        );
        const capturedChildView: OpenedView = {
          session: captureView.session,
          params: capturedChild,
        };
        const capturedRows = responseResult(
          await request(
            browser,
            capturedChildView,
            "cell-capture-old-rows",
            "table/rows",
            { offset: 0, limit: 10, cols: [0] },
          ),
        );
        assertEquals(snapshotColumnValues(capturedRows), [17, 18]);
        const replacementChild = responseResult(
          await request(
            browser,
            captureView,
            "cell-capture-new",
            "object/open",
            { path: capturePath },
          ),
        );
        assertEquals(replacementChild.mode, "paged");
        const replacementRows = responseResult(
          await request(
            browser,
            {
              session: captureView.session,
              params: replacementChild,
            },
            "cell-capture-new-rows",
            "table/rows",
            { offset: 0, limit: 10, cols: [0] },
          ),
        );
        assertEquals(snapshotColumnValues(replacementRows), [99, 100]);
        await rEval(arf, "options(jdv.snapshot_max_cells = 10000L)");

        const pagedChildView: OpenedView = {
          session: paged.session,
          params: pagedCell,
        };
        assertEquals(
          responseResult(
            await request(browser, paged, "cell-paged-close", "view/close", {}),
          ).closed,
          true,
        );
        await nextMessage(
          browser,
          (message) => {
            if (message.type !== "view/closed") return false;
            const params = asRecord(asRecord(message.message).params);
            return params.view === pagedCell.view &&
              params.reason === "parent_closed";
          },
          "cell child cascade close",
        );
        const closedChild = await request(
          browser,
          pagedChildView,
          "cell-paged-child-closed",
          "object/children",
          { path: [], offset: 0, limit: 10 },
        );
        assertEquals(responseErrorCode(closedChild), "view_not_found");

        const ownedBrowser = await launchOwnedBrowser({
          ...(browserExecutable ? { path: browserExecutable } : {}),
          args: ["--no-sandbox"],
          ...(browserLibraryPath
            ? {
              env: {
                ...Deno.env.toObject(),
                LD_LIBRARY_PATH: browserLibraryPath,
              },
            }
            : {}),
        });
        closeChromium = () => ownedBrowser.close();
        const chromiumBrowser = ownedBrowser.browser;
        const page = await phase(
          "Cell E2E new page",
          async () => {
            const page = await chromiumBrowser.newPage("about:blank", {
              waitUntil: "none",
            });
            await page.setViewportSize({ width: 1280, height: 1000 });
            return page;
          },
          20_000,
        );
        const pageErrors: string[] = [];
        collectPageErrors(page, pageErrors);
        await phase("Cell E2E navigation and session connection", async () => {
          await page.goto(server.url, { waitUntil: "load" });
          await page.waitForSelector('#status[data-state="connected"]');
        }, 30_000);
        await phase("Cell E2E open and query snapshot", async () => {
          await clickButton(
            page,
            "Open view",
            "#tables article",
            0,
            "Cell Snapshot",
          );
          await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
          await selectOption(page, "#sort-column", "0");
          await selectOption(page, "#sort-direction", "desc");
          await clickButton(page, "Add sort");
          await selectOption(page, "#filter-column", "0");
          await selectOption(page, "#filter-op", "gt");
          await fillInput(page, "#filter-value", "0");
          await clickButton(page, "Apply filter");
          await click(page, '.tabulator-page[data-page="next"]');
        }, 45_000);
        const sourceCellSelector =
          '[data-action="open-cell"][data-row-index="205"][data-column="1"]';
        await phase(
          "Cell E2E selected cell becomes visible",
          () => page.waitForSelector(sourceCellSelector),
          20_000,
        );

        const wireBeforeBusyOpen = server.wire.snapshot();
        busy = arf.send(
          `writeLines("busy-entered", ${rQuote(marker)}, useBytes = TRUE); ` +
            `while (!file.exists(${rQuote(release)})) jdv_cell_spin <- 1L`,
          { timeoutMs: 30_000 },
        );
        await phase(
          "Cell E2E wait for busy R marker",
          () => arf.waitForFile(marker),
          12_000,
        );
        await phase("Cell E2E open cell while R is busy", async () => {
          await click(page, sourceCellSelector);
          await page.waitForSelector(
            '#child-open-status[data-state="waiting"]',
          );
        }, 20_000);
        await phase(
          "Cell E2E object request reaches busy R",
          () =>
            server.wire.waitFor(
              (wire) =>
                wire.serverToRFrames.some((frame) =>
                  frame.method === "object/open" &&
                  frame.view === snapshot.params.view &&
                  frame.generation === snapshot.params.generation
                ) &&
                wire.serverToRFrames.length >
                  wireBeforeBusyOpen.serverToRFrames.length,
              5_000,
            ),
          7_000,
        );
        await assertNoCompletedEvaluation(busy);
        assert(
          server.wire.snapshot().tableRowsRequests.length ===
            wireBeforeBusyOpen.tableRowsRequests.length,
          "Snapshot query and cell opening must not request Paged rows from R.",
        );

        await phase(
          "Cell E2E viewer remains interactive while R waits",
          async () => {
            const reverseButtons = await page.$$("#sort-list button");
            let reverseIndex = -1;
            for (let index = 0; index < reverseButtons.length; index++) {
              if (
                (await reverseButtons[index].innerText()).includes("Reverse")
              ) {
                reverseIndex = index;
                break;
              }
            }
            assert(reverseIndex >= 0, "Missing Reverse sort button.");
            await reverseButtons[reverseIndex].scrollIntoView();
            await reverseButtons[reverseIndex].click();
            await fillInput(page, "#filter-value", "100");
            await clickButton(page, "Apply filter");
            await click(page, '.tabulator-page[data-page="next"]');
            await page.waitForSelector(
              '#child-open-status[data-state="waiting"]',
            );
          },
          35_000,
        );
        await assertNoCompletedEvaluation(busy);
        assert(
          await count(page, "#viewer:not([hidden]) .tabulator-row") > 0,
          "Snapshot sorting/filtering/paging should remain interactive while the child request waits.",
        );
        assert(
          server.wire.snapshot().tableRowsRequests.length ===
            wireBeforeBusyOpen.tableRowsRequests.length,
          "Snapshot queries during R busy must remain local.",
        );

        await Deno.writeTextFile(release, "release\n");
        await phase(
          "Cell E2E wait for busy R completion",
          () => busy!.wait(30_000),
          35_000,
        );
        await phase(
          "Cell E2E inspector displays the opened object",
          async () => {
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await waitFor(
              page,
              (needle: string) =>
                document.querySelector("#tree-child-list")?.textContent
                  ?.includes(needle) === true,
              "payload-205",
            );
          },
          35_000,
        );
        assertEquals(await count(page, "#tree-child-list img"), 0);
        assert(
          (await text(page, "#tree-child-list"))?.includes(
            "<img src=x onerror=alert(1)>",
          ),
          "Cell child labels containing HTML-like text must remain text.",
        );
        const screenshotPath = join(
          screenshotDir ??= await Deno.makeTempDir({
            prefix: "jdv-cell-screenshot-",
          }),
          "cell-inspector.png",
        );
        await Deno.writeFile(screenshotPath, await page.screenshot());
        await phase("Cell E2E return to parent view", async () => {
          await click(page, '#view-breadcrumb [data-view-depth="0"]');
          await page.waitForSelector("#viewer:not([hidden])");
        }, 20_000);
        assert(
          (await text(page, "#sort-list"))?.includes(
            "ascending",
          ),
          "Returning from the child should restore the parent sort state.",
        );
        assertEquals(await inputValue(page, "#filter-value"), "100");
        assertEquals(pageErrors, []);
      }, 300_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => Deno.writeTextFile(release, "release\n"),
        ...(closeChromium
          ? [() => phase("Cell E2E Chromium cleanup", closeChromium!, 50_000)]
          : []),
        () => runtime.browser.close(),
        () => phase("Cell E2E arf cleanup", () => runtime.arf.close(), 50_000),
        () =>
          phase(
            "Cell E2E server cleanup",
            () => runtime.server.close(),
            10_000,
          ),
        ...(screenshotDir ? [() => removeCacheDirectory(screenshotDir!)] : []),
        () => removeCacheDirectory(markerDir),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

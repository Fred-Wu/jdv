import type { Page } from "@astral/astral";
import {
  button,
  click,
  clickButton,
  collectPageErrors,
  count,
  evaluate,
  evaluateElement,
  evaluateElements,
  fillInput,
  inputValue,
  observeSocketFrames,
  operation,
  screenshot,
  selectOption,
  text,
  texts,
  waitFor,
  waitForSelector,
} from "./astral_page.ts";
import { launchOwnedBrowser, phase } from "./bounded_browser.ts";
import {
  assertServerReleased,
  cleanupDeadline,
  finishIntegrationCleanup,
  finishRFixture,
  fixtureFrames,
  fixturePid,
  pathWithin,
  ProcessLines,
  removeCacheDirectory,
} from "./integration_cleanup.ts";
import { assert, assertEquals } from "./assert.ts";
import { startServer } from "../main.ts";

type BrowserElement = {
  clientLeft: number;
  clientWidth: number;
  clientHeight: number;
  className: string;
  contains(element: BrowserElement): boolean;
  dispatchEvent(event: unknown): boolean;
  id: string;
  getBoundingClientRect(): {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
  getAttribute(name: string): string | null;
  hidden: boolean;
  parentElement: BrowserElement | null;
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): BrowserElement[];
  scrollLeft: number;
  scrollHeight: number;
  scrollTop: number;
  scrollWidth: number;
  style: {
    getPropertyValue(name: string): string;
    transform: string;
    width: string;
  };
  tagName: string;
  textContent: string | null;
};

type BrowserDocument = {
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): BrowserElement[];
};

type BrowserRuntime = {
  document: BrowserDocument;
  Event: new (type: string) => unknown;
  getComputedStyle(element: BrowserElement): {
    borderLeftWidth: string;
    left: string;
    overflowX: string;
    position: string;
    transform: string;
    zIndex: string;
    getPropertyValue(name: string): string;
  };
  requestAnimationFrame(callback: () => void): number;
};

const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");
const binaryRLibrary = Deno.env.get("JDV_TEST_BINARY_R_LIB")?.trim() ||
  Deno.env.get("JDV_TEST_R_LIB")?.trim() || "";

Deno.test({
  name: "browser smoke loads Paged data, queries it, and reaches wide columns",

  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-browser-smoke-" });
    const server = await phase("HTTP server startup", () =>
      startServer({
        mode: "tcp",
        httpPort: 0,
        cacheDir,
      }));
    const rConnection = await phase(
      "mock R connect",
      () => connectR(server.socketPath),
    );
    const columns = Array.from({ length: 300 }, (_, position) => ({
      position,
      name: position === 0 ? "key" : `column-${position}`,
      type: position === 1 ? "string" : "integer",
      sortable: position === 0,
      filterable: position < 2,
    }));
    const session = `smoke.session-${Deno.pid}-71`;
    await writeFrame(rConnection, {
      method: "hello",
      params: {
        protocol: 1,
        session,
        producer: {
          name: "fixture-producer",
          version: "2.1",
          runtime: { name: "fixture-runtime", version: "3.4" },
        },
        limits: {
          max_unacked_frames: 4096,
          max_unacked_bytes: 64 * 1024 * 1024,
          queue_messages: 256,
          queue_bytes: 16 * 1024 * 1024,
          max_request_bytes: 1024 * 1024,
          max_message_bytes: 10 * 1024 * 1024,
        },
      },
    });
    await writeFrame(rConnection, {
      method: "view/open",
      params: {
        view: "wide-paged",
        generation: 1,
        kind: "grid",
        access: "random",
        encoding: "r-json",
        mode: "paged",
        title: "Browser smoke",
        nrow: 249,
        ncol: columns.length,
        columns,
        capabilities: gridCapabilities(),
      },
    });
    await writeFrame(rConnection, {
      method: "view/open",
      params: {
        view: "tree-root",
        generation: 1,
        kind: "tree",
        access: "random",
        encoding: "r-json",
        title: "Object smoke",
        class: ["list"],
        capabilities: {
          seek: true,
          sort: false,
          filter: false,
          known_total: true,
          next: false,
          children: true,
        },
      },
    });
    const requests: Array<Record<string, unknown>> = [];
    const shutdown = { requested: false };
    const responder = respondToR(rConnection, columns, requests, shutdown);
    void responder.catch((error) => console.error("[mock R responder]", error));
    let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    const originalFailure: unknown[] = [];

    try {
      owned = await launchOwnedBrowser({
        path: browserExecutable,
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
      const browser = owned.browser;
      await phase("browser test body", async () => {
        const page = await phase(
          "new page",
          () => browser.newPage("about:blank", { waitUntil: "none" }),
        );

        await operation(
          "viewport",
          () => page.setViewportSize({ width: 1280, height: 1000 }),
        );
        const pageErrors: string[] = [];
        collectPageErrors(page, pageErrors);
        await phase(
          "navigation",
          () => page.goto(server.url, { waitUntil: "load" }),
          25_000,
        );
        assertEquals(
          await evaluate(
            page,
            async () => (await fetch("/favicon.ico")).status,
          ),
          204,
        );
        await waitForSelector(page, '#status[data-state="connected"]');
        assertEquals(
          await text(page, "#sessions article p"),
          "fixture-producer 2.1 · fixture-runtime 3.4",
        );
        await clickButton(page, "Open object", "#tables article", 1);
        await waitForSelector(page, "#tree-viewer:not([hidden])");
        await waitForSelector(
          page,
          '#tree-child-list li[data-child-index="1"]',
        );
        assert(
          (await text(page, "#tree-child-list"))?.includes(
            "nested <img src=x onerror=alert(1)>list · 1 item",
          ),
          "Tree labels, classes, and summaries should render as text.",
        );
        assertEquals(await count(page, "#tree-child-list img"), 0);
        await click(page, '#tree-child-list [data-action="open-child"]', 1);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#tree-title")?.textContent ===
            "Nested object";
        });
        await click(page, "#tree-parent-return");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#tree-title")?.textContent ===
            "Object smoke";
        });
        await click(page, '#tree-child-list [data-action="open-child"]');
        await waitForSelector(page, "#viewer:not([hidden])");
        await click(page, '[data-action="close-view"]', -1);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelectorAll(
                '#tables button[data-action="close-view"]',
              ).length === 1 &&
            document.querySelector("#tree-viewer")?.hidden === true;
        });
        await clickButton(page, "Open object", "#tables article", 1);
        await waitForSelector(page, "#tree-viewer:not([hidden])");
        await clickButton(page, "Open view", "#tables article", 0);
        await waitForSelector(page, "#viewer .tabulator-row");
        await selectOption(page, "#filter-column", "299");
        assertEquals(
          await texts(page, "#filter-op option"),
          ["Is missing"],
        );
        await selectOption(page, "#filter-column", "0");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "1";
        });
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="c1"]',
          )?.textContent === "<img src=x onerror=alert(1)>";
        });
        assertEquals(await count(page, "#column-window img"), 0);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#warnings")?.textContent?.includes(
            "<img src=x onerror=alert(1)>",
          ) === true;
        });
        assertEquals(await count(page, "#warnings img"), 0);
        await Deno.writeFile(
          `${cacheDir}/jdv-browser-smoke.png`,
          await screenshot(page),
        );

        assertEquals(
          requests.slice(0, 3).map((request) => request.offset),
          [0, 37, 49],
        );
        assertEquals(
          await count(page, "#column-window.tabulator"),
          1,
        );
        assertEquals(
          await count(
            page,
            '#column-window .tabulator-col[tabulator-field="c0"]',
          ),
          1,
        );
        assertEquals(
          await text(page, '.tabulator-row [tabulator-field="c0"]'),
          "1",
        );

        await selectOption(page, "#sort-column", "0");
        await selectOption(page, "#sort-direction", "desc");
        await clickButton(page, "Add sort");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        });
        assert(
          requests.some((request) =>
            Array.isArray(request.sort) &&
            (request.sort[0] as Record<string, unknown>)?.desc === true
          ),
          "The browser did not send the descending sort request.",
        );

        await clickNextPage(page);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "49";
        });
        const pagedRequestsBeforeHorizontalScroll = requests.length;
        const heldScrollGeometry = await evaluate(page, async () => {
          const runtime = globalThis as unknown as BrowserRuntime & {
            document: BrowserDocument;
          };
          const document = runtime.document;
          const viewport = document.querySelector("#column-viewport");
          if (!viewport) throw new Error("The column viewport was not found.");
          const initialRowHeader = viewport.querySelector(
            '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
          );
          const initialRowCell = viewport.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          );
          const table = viewport.querySelector("#column-window");
          if (!initialRowHeader || !initialRowCell || !table) {
            throw new Error("The row index column was not rendered.");
          }
          const initialViewportRect = viewport.getBoundingClientRect();
          const initialHeaderRect = initialRowHeader.getBoundingClientRect();
          const initialCellRect = initialRowCell.getBoundingClientRect();
          const initialTableBorderLeft = Number.parseFloat(
            runtime.getComputedStyle(table).borderLeftWidth,
          );
          const requestedScrollLeft = 86 + 290 * 180;
          for (const column of [80, 140, 200, 260, 290]) {
            viewport.scrollLeft = 86 + column * 180;
            viewport.dispatchEvent(new runtime.Event("scroll"));
            await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
          }
          for (let repeat = 0; repeat < 4; repeat++) {
            viewport.dispatchEvent(new runtime.Event("scroll"));
            await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
          }
          await new Promise<void>((resolve) => {
            runtime.requestAnimationFrame(() => resolve());
          });
          await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
          const rowHeader = viewport.querySelector(
            '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
          );
          const rowCell = viewport.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          );
          const viewportRect = viewport.getBoundingClientRect();
          const headerRect = rowHeader?.getBoundingClientRect();
          const cellRect = rowCell?.getBoundingClientRect();
          const describe = (node: BrowserElement | null) => {
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            const computed = runtime.getComputedStyle(node);
            const ancestors = [];
            let ancestor = node.parentElement;
            for (let depth = 0; ancestor && depth < 5; depth++) {
              const ancestorRect = ancestor.getBoundingClientRect();
              const ancestorComputed = runtime.getComputedStyle(ancestor);
              ancestors.push({
                id: ancestor.id,
                className: ancestor.className,
                field: ancestor.getAttribute("tabulator-field"),
                frozen: ancestor.getAttribute("frozen"),
                tabulatorFrozen: ancestor.className.split(/\s+/).includes(
                  "tabulator-frozen",
                ),
                left: ancestorRect.left,
                right: ancestorRect.right,
                position: ancestorComputed.position,
                leftStyle: ancestorComputed.left,
                transform: ancestorComputed.transform,
                scrollLeft: ancestor.scrollLeft,
                scrollWidth: ancestor.scrollWidth,
              });
              ancestor = ancestor.parentElement;
            }
            return {
              tagName: node.tagName,
              id: node.id,
              className: node.className,
              field: node.getAttribute("tabulator-field"),
              frozen: node.getAttribute("frozen"),
              tabulatorFrozen: node.className.split(/\s+/).includes(
                "tabulator-frozen",
              ),
              left: rect.left,
              right: rect.right,
              width: rect.right - rect.left,
              inlineTransform: node.style.transform,
              inlineLeft: node.style.getPropertyValue("left"),
              position: computed.position,
              computedLeft: computed.left,
              transform: computed.transform,
              zIndex: computed.zIndex,
              overflowX: computed.overflowX,
              scrollLeft: node.scrollLeft,
              scrollWidth: node.scrollWidth,
              ancestors,
            };
          };
          const headerHolder = viewport.querySelector(
            ".tabulator-header",
          );
          const tableHolder = viewport.querySelector(
            ".tabulator-tableholder",
          );
          const tabulatorColumns = [...viewport.querySelectorAll(
            ".tabulator-header .tabulator-col",
          )];
          const tabulatorRowIndexes = [...viewport.querySelectorAll(
            '.tabulator-row [tabulator-field="row_index"]',
          )];
          const scrollWidth = viewport.scrollWidth;
          const clientWidth = viewport.clientWidth;
          const maximumScrollLeft = Math.max(0, scrollWidth - clientWidth);
          const clampedRequestedScrollLeft = Math.min(
            requestedScrollLeft,
            maximumScrollLeft,
          );
          const alignedScrollLeft = maximumScrollLeft -
                clampedRequestedScrollLeft <= 180
            ? maximumScrollLeft
            : Math.floor(clampedRequestedScrollLeft / 180) * 180;
          const displayedColumnIndex = Math.floor(
            Math.max(0, viewport.scrollLeft - 86) / 180,
          );
          return {
            scrollLeft: viewport.scrollLeft,
            requestedScrollLeft,
            clampedRequestedScrollLeft,
            maximumScrollLeft,
            scrollWidth,
            clientWidth,
            alignedScrollLeft,
            displayedColumnIndex,
            requestedColumnIndex: 290,
            viewportLeft: viewportRect.left,
            viewportContentLeft: viewportRect.left + viewport.clientLeft,
            initialViewportContentLeft: initialViewportRect.left +
              viewport.clientLeft,
            initialHeaderLeft: initialHeaderRect.left,
            initialCellLeft: initialCellRect.left,
            tableBorderLeft: initialTableBorderLeft,
            headerLeft: headerRect?.left ?? Number.NaN,
            headerRight: headerRect?.right ?? Number.NaN,
            cellLeft: cellRect?.left ?? Number.NaN,
            cellRight: cellRect?.right ?? Number.NaN,
            viewportScrollLeft: viewport.scrollLeft,
            columnWindow: table
              ? {
                className: table.className,
                width: table.style.width,
                transform: table.style.transform,
                compensation: runtime.getComputedStyle(table).getPropertyValue(
                  "--row-horizontal-compensation",
                ),
              }
              : null,
            headerHolder: describe(headerHolder),
            tableHolder: describe(tableHolder),
            rowHeader: describe(rowHeader),
            rowIndexCount: tabulatorRowIndexes.length,
            rowIndexes: tabulatorRowIndexes.slice(0, 3).map(describe),
            columnFields: tabulatorColumns.map((node) =>
              node.getAttribute("tabulator-field")
            ),
          };
        });
        assert(
          requests.length === pagedRequestsBeforeHorizontalScroll,
          `Horizontal paging should wait for the scroll debounce while the user is still moving: before=${pagedRequestsBeforeHorizontalScroll}, after=${requests.length}, new=${
            JSON.stringify(requests.slice(pagedRequestsBeforeHorizontalScroll))
          }`,
        );
        console.log(
          "rapid-scroll-range",
          JSON.stringify(heldScrollGeometry),
        );
        assert(
          heldScrollGeometry.scrollLeft > 0 &&
            (heldScrollGeometry.scrollLeft ===
                heldScrollGeometry.clampedRequestedScrollLeft ||
              heldScrollGeometry.scrollLeft ===
                heldScrollGeometry.alignedScrollLeft) &&
            Math.abs(
                heldScrollGeometry.displayedColumnIndex -
                  heldScrollGeometry.requestedColumnIndex,
              ) <= 1 &&
            Math.abs(
                heldScrollGeometry.initialHeaderLeft -
                  heldScrollGeometry.initialViewportContentLeft -
                  heldScrollGeometry.tableBorderLeft,
              ) <= 1 &&
            Math.abs(
                heldScrollGeometry.initialCellLeft -
                  heldScrollGeometry.initialViewportContentLeft -
                  heldScrollGeometry.tableBorderLeft,
              ) <= 1 &&
            Math.abs(
                heldScrollGeometry.headerLeft -
                  heldScrollGeometry.viewportContentLeft -
                  (heldScrollGeometry.initialHeaderLeft -
                    heldScrollGeometry.initialViewportContentLeft),
              ) <= 1 &&
            Math.abs(
                heldScrollGeometry.cellLeft -
                  heldScrollGeometry.viewportContentLeft -
                  (heldScrollGeometry.initialCellLeft -
                    heldScrollGeometry.initialViewportContentLeft),
              ) <= 1 &&
            heldScrollGeometry.headerRight - heldScrollGeometry.headerLeft ===
              86 &&
            heldScrollGeometry.cellRight - heldScrollGeometry.cellLeft === 86,
          `The row index moved during rapid scroll/hold: ${
            JSON.stringify(heldScrollGeometry)
          }`,
        );
        const settledScrollLeft = await waitFor(
          page,
          (expectedScrollLeft: number) => {
            const document = (globalThis as unknown as {
              document: BrowserDocument;
            }).document;
            const actual = document.querySelector(
              "#column-viewport",
            )?.scrollLeft;
            return actual === expectedScrollLeft ? actual : false;
          },
          heldScrollGeometry.alignedScrollLeft,
          { timeout: 5_000 },
        ).catch(async (error: unknown) => {
          const actual = await evaluateElement(
            page,
            "#column-viewport",
            (viewport: BrowserElement) => viewport.scrollLeft,
          );
          throw new Error(
            `The scroll position did not settle on the virtual column grid: ${
              JSON.stringify({ heldScrollGeometry, actual })
            }`,
            { cause: error },
          );
        });
        assert(
          settledScrollLeft === heldScrollGeometry.alignedScrollLeft,
          `The scroll position should settle on the virtual column grid: ${
            JSON.stringify({ ...heldScrollGeometry, settledScrollLeft })
          }`,
        );
        const controlledAlignment = await evaluate(page, async () => {
          const runtime = globalThis as unknown as BrowserRuntime & {
            clearTimeout: (id: number) => void;
            document: BrowserDocument;
            setTimeout: (callback: () => void, delay?: number) => number;
          };
          const viewport = runtime.document.querySelector("#column-viewport");
          const table = runtime.document.querySelector("#column-window");
          if (!viewport || !table) {
            throw new Error("The column viewport was not found.");
          }
          const originalSetTimeout = runtime.setTimeout.bind(globalThis);
          const originalClearTimeout = runtime.clearTimeout.bind(globalThis);
          const originalRequestAnimationFrame = runtime.requestAnimationFrame
            .bind(globalThis);
          const capturedTimers = new Map<number, () => void>();
          let nextTimerId = -1;
          const deferredFrames: Array<() => void> = [];
          await new Promise<void>((resolve) =>
            originalSetTimeout(resolve, 100)
          );
          const beforeViewport = viewport.getBoundingClientRect();
          const beforeHeader = viewport.querySelector(
            '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
          );
          const beforeCell = viewport.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          );
          if (!beforeHeader || !beforeCell) {
            throw new Error("The row index column was not rendered.");
          }
          const beforeHeaderLeft = beforeHeader.getBoundingClientRect().left;
          const beforeCellLeft = beforeCell.getBoundingClientRect().left;

          runtime.setTimeout = ((callback: () => void, delay = 0) => {
            if (delay === 80) {
              const id = nextTimerId--;
              capturedTimers.set(id, callback);
              return id;
            }
            return originalSetTimeout(callback, delay);
          }) as typeof runtime.setTimeout;
          runtime.clearTimeout = ((id: number) => {
            if (capturedTimers.delete(id)) return;
            originalClearTimeout(id);
          }) as typeof runtime.clearTimeout;
          try {
            const requested = 86 + 290 * 180;
            viewport.scrollLeft = requested;
            viewport.dispatchEvent(new Event("scroll"));
            await new Promise<void>((resolve) =>
              originalRequestAnimationFrame(() => resolve())
            );
            if (capturedTimers.size === 0) {
              throw new Error(
                "The column-window debounce was not captured after scrolling.",
              );
            }
            runtime.requestAnimationFrame = (callback: () => void) => {
              deferredFrames.push(callback);
              return deferredFrames.length;
            };
            const scheduledPageRequest = [...capturedTimers.values()].at(-1);
            if (!scheduledPageRequest) {
              throw new Error("No scheduled column-window request was found.");
            }
            capturedTimers.clear();
            const beforeScrollLeft = viewport.scrollLeft;
            const scrollWidth = viewport.scrollWidth;
            const clientWidth = viewport.clientWidth;
            const maximumScrollLeft = Math.max(0, scrollWidth - clientWidth);
            const nearRightEdge = maximumScrollLeft - beforeScrollLeft <= 180;
            const alignedScrollLeft = nearRightEdge
              ? maximumScrollLeft
              : Math.floor(beforeScrollLeft / 180) * 180;
            scheduledPageRequest();

            const header = viewport.querySelector(
              '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
            );
            const cell = viewport.querySelector(
              '.tabulator-row [tabulator-field="row_index"]',
            );
            const viewportRect = viewport.getBoundingClientRect();
            const headerRect = header?.getBoundingClientRect();
            const cellRect = cell?.getBoundingClientRect();
            const describe = (node: BrowserElement | null) => {
              if (!node) return null;
              const rect = node.getBoundingClientRect();
              const computed = runtime.getComputedStyle(node);
              const ancestor = node.parentElement;
              const ancestorRect = ancestor?.getBoundingClientRect();
              const ancestorStyle = ancestor
                ? runtime.getComputedStyle(ancestor)
                : null;
              return {
                id: node.id,
                className: node.className,
                field: node.getAttribute("tabulator-field"),
                frozen: node.getAttribute("frozen"),
                tabulatorFrozen: node.className.split(/\s+/).includes(
                  "tabulator-frozen",
                ),
                left: rect.left,
                right: rect.right,
                transform: computed.transform,
                position: computed.position,
                zIndex: computed.zIndex,
                parentClass: ancestor?.className ?? null,
                parentLeft: ancestorRect?.left ?? null,
                parentTransform: ancestorStyle?.transform ?? null,
              };
            };
            return {
              beforeScrollLeft,
              afterScrollLeft: viewport.scrollLeft,
              requestedScrollLeft: requested,
              alignedScrollLeft,
              viewportContentLeft: viewportRect.left + viewport.clientLeft,
              beforeViewportContentLeft: beforeViewport.left +
                viewport.clientLeft,
              beforeHeaderLeft,
              beforeCellLeft,
              headerLeft: headerRect?.left ?? Number.NaN,
              cellLeft: cellRect?.left ?? Number.NaN,
              header: describe(header),
              cell: describe(cell),
              viewportScrollLeft: viewport.scrollLeft,
              headerScrollLeft: viewport.querySelector(
                ".tabulator-header",
              )?.scrollLeft,
              tableHolderScrollLeft: viewport.querySelector(
                ".tabulator-tableholder",
              )?.scrollLeft,
              columnWindow: {
                className: table.className,
                width: table.style.width,
                transform: table.style.transform,
                compensation: runtime.getComputedStyle(table).getPropertyValue(
                  "--row-horizontal-compensation",
                ),
                firstFields: [...viewport.querySelectorAll(
                  ".tabulator-header .tabulator-col",
                )].slice(0, 5).map((node) =>
                  node.getAttribute("tabulator-field")
                ),
              },
              deferredFrameCount: deferredFrames.length,
            };
          } finally {
            runtime.setTimeout =
              originalSetTimeout as typeof runtime.setTimeout;
            runtime.clearTimeout =
              originalClearTimeout as typeof runtime.clearTimeout;
            runtime.requestAnimationFrame = originalRequestAnimationFrame;
            for (const callback of deferredFrames) callback();
          }
        });
        console.log(
          "controlled-horizontal-alignment",
          JSON.stringify(controlledAlignment),
        );
        assert(
          controlledAlignment.beforeScrollLeft ===
              controlledAlignment.requestedScrollLeft &&
            controlledAlignment.afterScrollLeft ===
              controlledAlignment.alignedScrollLeft &&
            Math.abs(
                controlledAlignment.headerLeft -
                  controlledAlignment.viewportContentLeft -
                  (controlledAlignment.beforeHeaderLeft -
                    controlledAlignment.beforeViewportContentLeft),
              ) <= 1 &&
            Math.abs(
                controlledAlignment.cellLeft -
                  controlledAlignment.viewportContentLeft -
                  (controlledAlignment.beforeCellLeft -
                    controlledAlignment.beforeViewportContentLeft),
              ) <= 1,
          `The row index moved during controlled programmatic scroll alignment: ${
            JSON.stringify(controlledAlignment)
          }`,
        );
        console.log(
          "horizontal-column-diagnostic",
          await evaluateElement(
            page,
            "#column-viewport",
            (element: BrowserElement) => {
              const columns = [...element.querySelectorAll(".tabulator-col")];
              const runtime = globalThis as unknown as BrowserRuntime;
              const rowHeader = element.querySelector(
                '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
              );
              const rowCell = element.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              );
              const describe = (node: BrowserElement | null) => {
                if (!node) return null;
                const rect = node.getBoundingClientRect();
                const computed = runtime.getComputedStyle(node);
                const parentComputed = node.parentElement
                  ? runtime.getComputedStyle(node.parentElement)
                  : null;
                return {
                  className: node.className,
                  left: rect.left,
                  right: rect.right,
                  position: computed.position,
                  transform: computed.transform,
                  leftStyle: computed.left,
                  parentClassName: node.parentElement?.className ?? null,
                  parentPosition: parentComputed?.position ?? null,
                  parentTransform: parentComputed?.transform ?? null,
                };
              };
              return JSON.stringify({
                scrollLeft: element.scrollLeft,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                windowWidth: element.querySelector("#column-window")?.style
                  .width,
                transform: element.querySelector("#column-window")?.style
                  .transform,
                firstHeaders: columns.slice(0, 5).map((node) =>
                  node.getAttribute("tabulator-field")
                ),
                lastHeaders: columns.slice(-5).map((node) =>
                  node.getAttribute("tabulator-field")
                ),
                rowHeader: describe(rowHeader),
                rowCell: describe(rowCell),
              });
            },
          ),
        );
        await Deno.writeFile(
          `${cacheDir}/jdv-browser-scroll.png`,
          await screenshot(page),
        );
        await waitForSelector(
          page,
          '#column-window .tabulator-col[tabulator-field="c290"]',
          { timeout: 5_000 },
        );
        const pinnedRowGeometry = await evaluateElement(
          page,
          "#column-viewport",
          (viewport: BrowserElement) => {
            const viewportRect = viewport.getBoundingClientRect();
            const header = viewport.querySelector(
              '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
            );
            const cell = viewport.querySelector(
              '.tabulator-row [tabulator-field="row_index"]',
            );
            const headerRect = header?.getBoundingClientRect();
            const cellRect = cell?.getBoundingClientRect();
            return {
              viewportLeft: viewportRect.left,
              viewportContentLeft: viewportRect.left + viewport.clientLeft,
              headerLeft: headerRect?.left,
              headerRight: headerRect?.right,
              cellLeft: cellRect?.left,
              cellRight: cellRect?.right,
            };
          },
        );
        assert(
          pinnedRowGeometry.headerLeft !== undefined &&
            pinnedRowGeometry.headerRight !== undefined &&
            pinnedRowGeometry.cellLeft !== undefined &&
            pinnedRowGeometry.cellRight !== undefined &&
            Math.abs(
                pinnedRowGeometry.headerLeft -
                  pinnedRowGeometry.viewportContentLeft -
                  (heldScrollGeometry.initialHeaderLeft -
                    heldScrollGeometry.initialViewportContentLeft),
              ) <= 1 &&
            Math.abs(
                pinnedRowGeometry.cellLeft -
                  pinnedRowGeometry.viewportContentLeft -
                  (heldScrollGeometry.initialCellLeft -
                    heldScrollGeometry.initialViewportContentLeft),
              ) <= 1 &&
            pinnedRowGeometry.headerRight - pinnedRowGeometry.headerLeft ===
              86 &&
            pinnedRowGeometry.cellRight - pinnedRowGeometry.cellLeft === 86,
          `The frozen row index must remain pinned at the viewport left edge: ${
            JSON.stringify(pinnedRowGeometry)
          }`,
        );
        console.log(
          "right-column-paged-requests",
          JSON.stringify(requests.filter((request) => request.offset === 200)),
        );
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#sort-list")?.textContent?.includes(
            "#0",
          ) === true;
        });
        assert(
          requests.some((request) =>
            request.offset === 200 && Array.isArray(request.cols) &&
            request.cols.includes(290) && Array.isArray(request.sort) &&
            (request.sort[0] as Record<string, unknown>)?.col === 0 &&
            (request.sort[0] as Record<string, unknown>)?.desc === true
          ),
          "The right-column page request lost page offset or the column-0 sort.",
        );

        await selectOption(page, "#filter-column", "0");
        await selectOption(page, "#filter-op", "gt");
        await fillInput(page, "#filter-value", "247");
        await clickButton(page, "Apply filter");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const cells = [
            ...document.querySelectorAll(
              '.tabulator-row [tabulator-field="row_index"]',
            ),
          ];
          return cells.length === 2 && cells[0].textContent === "249" &&
            cells[1].textContent === "248";
        });
        assert(
          requests.some((request) =>
            (request.filter as Record<string, unknown> | null)?.op === "gt"
          ),
          "The browser did not send the filter request.",
        );
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-meta")?.textContent
            ?.startsWith(
              "2 of 249 rows · 300 columns · paged · ",
            ) === true;
        });
        assert(
          (await text(page, "#table-meta"))?.startsWith(
            "2 of 249 rows · 300 columns · paged · ",
          ),
          "The Paged heading should show the filtered and unfiltered totals.",
        );
        await Deno.writeFile(
          `${cacheDir}/jdv-20261014-ui-filtered-count.png`,
          await screenshot(page),
        );

        await clickButton(page, "Clear");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        });
        await selectOption(page, "#filter-column", "0");
        await selectOption(page, "#filter-op", "gt");
        await fillInput(page, "#filter-value", "999");
        await clickButton(page, "Apply filter");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector('#warnings li[data-state="error"]')
            ?.textContent?.includes(
              "producer_error: <img src=x onerror=alert(1)>",
            ) ===
            true;
        });
        assertEquals(await count(page, "#warnings img"), 0);
        await clickButton(page, "Clear");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        });
        await evaluate(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const viewport = document.querySelector("#column-viewport");
          if (viewport) viewport.scrollLeft = viewport.scrollWidth;
        });
        await waitForSelector(
          page,
          '#column-window .tabulator-col[tabulator-field="c299"]',
        );
        await waitForSelector(page, '.tabulator-row [tabulator-field="c299"]');
        await waitFor(
          page,
          () => {
            const document = (globalThis as unknown as {
              document: BrowserDocument;
            }).document;
            return document.querySelector(
              '.tabulator-row [tabulator-field="c299"]',
            )?.textContent?.startsWith("value-299-") === true;
          },
          undefined,
          { timeout: 5_000 },
        );
        await waitFor(
          page,
          () => {
            const document = (globalThis as unknown as {
              document: BrowserDocument;
            }).document;
            const viewport = document.querySelector("#column-viewport");
            if (!viewport) return false;
            const viewportRect = viewport.getBoundingClientRect();
            const header = viewport.querySelector(
              '.tabulator-header .tabulator-col[tabulator-field="c299"]',
            )?.getBoundingClientRect();
            const cell = viewport.querySelector(
              '.tabulator-row [tabulator-field="c299"]',
            )?.getBoundingClientRect();
            return header !== undefined && cell !== undefined &&
              header.left >= viewportRect.left - 1 &&
              header.right <= viewportRect.right + 1 &&
              cell.left >= viewportRect.left - 1 &&
              cell.right <= viewportRect.right + 1;
          },
          undefined,
          { timeout: 5_000 },
        );
        assert(
          (await text(page, '.tabulator-row [tabulator-field="c299"]'))
            ?.startsWith("value-299-"),
          "The rightmost data cell was not rendered.",
        );
        const rightEdgeGeometry = await evaluateElement(
          page,
          "#column-viewport",
          (element: BrowserElement) => {
            const viewportRect = element.getBoundingClientRect();
            const row = element.querySelector(
              '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
            );
            const rowRight = row?.getBoundingClientRect().right ?? Number.NaN;
            const firstVisible = [
              ...element.querySelectorAll(
                '.tabulator-header .tabulator-col[tabulator-field^="c"]',
              ),
            ].map((column) => column.getBoundingClientRect()).find((rect) =>
              rect.right > rowRight && rect.left >= rowRight - 1
            );
            const lastHeader = element.querySelector(
              '.tabulator-header .tabulator-col[tabulator-field="c299"]',
            );
            const lastCell = element.querySelector(
              '.tabulator-row [tabulator-field="c299"]',
            );
            const lastHeaderRect = lastHeader?.getBoundingClientRect();
            const lastCellRect = lastCell?.getBoundingClientRect();
            return {
              scrollLeft: element.scrollLeft,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              viewportLeft: viewportRect.left,
              viewportRight: viewportRect.right,
              rowRight,
              firstDataLeft: firstVisible?.left ?? Number.NaN,
              lastHeaderLeft: lastHeaderRect?.left ?? Number.NaN,
              lastHeaderRight: lastHeaderRect?.right ?? Number.NaN,
              lastCellLeft: lastCellRect?.left ?? Number.NaN,
              lastCellRight: lastCellRect?.right ?? Number.NaN,
            };
          },
        );
        assert(
          Math.abs(
            rightEdgeGeometry.firstDataLeft - rightEdgeGeometry.rowRight,
          ) <=
            1,
          `A horizontal gap appeared after the frozen Row column: ${
            JSON.stringify(rightEdgeGeometry)
          }`,
        );
        assert(
          rightEdgeGeometry.lastHeaderLeft >=
              rightEdgeGeometry.viewportLeft - 1 &&
            rightEdgeGeometry.lastHeaderRight <=
              rightEdgeGeometry.viewportRight + 1 &&
            rightEdgeGeometry.lastHeaderRight -
                  rightEdgeGeometry.lastHeaderLeft === 180 &&
            rightEdgeGeometry.lastCellLeft >=
              rightEdgeGeometry.viewportLeft - 1 &&
            rightEdgeGeometry.lastCellRight <=
              rightEdgeGeometry.viewportRight + 1 &&
            rightEdgeGeometry.lastCellRight - rightEdgeGeometry.lastCellLeft ===
              180,
          `The rightmost column must fit fully inside the viewport: ${
            JSON.stringify(rightEdgeGeometry)
          }`,
        );
        assertEquals(
          rightEdgeGeometry.scrollLeft,
          rightEdgeGeometry.scrollWidth - rightEdgeGeometry.clientWidth,
        );
        await Deno.writeFile(
          `${cacheDir}/wide-right-edge.png`,
          await screenshot(page),
        );
        console.log(
          "rightmost-column-paged-requests",
          JSON.stringify(
            requests.filter((request) =>
              Array.isArray(request.cols) && request.cols.includes(299)
            ),
          ),
        );
        await clickNextPage(page);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "49";
        });
        console.log(
          "vertical-layout-diagnostic",
          await evaluateElement(
            page,
            "#column-viewport",
            (viewport: BrowserElement) => {
              const runtime = globalThis as unknown as BrowserRuntime;
              const pagination = runtime.document.querySelector(
                "#table-pagination",
              );
              const paginationRect = pagination?.getBoundingClientRect();
              const describe = (selector: string) => {
                const element = viewport.querySelector(selector);
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                return {
                  className: element.className,
                  top: rect.top,
                  bottom: rect.bottom,
                  clientHeight: element.clientHeight,
                  scrollHeight: element.scrollHeight,
                  scrollTop: element.scrollTop,
                };
              };
              const outerRect = viewport.getBoundingClientRect();
              return JSON.stringify({
                outer: {
                  top: outerRect.top,
                  bottom: outerRect.bottom,
                  clientHeight: viewport.clientHeight,
                  scrollHeight: viewport.scrollHeight,
                  scrollTop: viewport.scrollTop,
                },
                tabulator: describe(".tabulator"),
                header: describe(".tabulator-header"),
                tableholder: describe(".tabulator-tableholder"),
                pagination: paginationRect
                  ? {
                    top: paginationRect.top,
                    bottom: paginationRect.bottom,
                    insideViewport: viewport.contains(
                      pagination as BrowserElement,
                    ),
                  }
                  : null,
              });
            },
          ),
        );
        const verticalLayoutBefore = await evaluateElement(
          page,
          "#column-viewport",
          (viewport: BrowserElement) => {
            const header = viewport.querySelector(".tabulator-header");
            const tableholder = viewport.querySelector(
              ".tabulator-tableholder",
            );
            const headerRect = header?.getBoundingClientRect();
            const viewportRect = viewport.getBoundingClientRect();
            const pagination = (globalThis as unknown as BrowserRuntime)
              .document
              .querySelector("#table-pagination");
            const paginationRect = pagination?.getBoundingClientRect();
            return {
              outerTop: viewportRect.top,
              outerBottom: viewportRect.bottom,
              outerScrollTop: viewport.scrollTop,
              outerScrollHeight: viewport.scrollHeight,
              outerClientHeight: viewport.clientHeight,
              headerTop: headerRect?.top,
              headerBottom: headerRect?.bottom,
              innerScrollTop: tableholder?.scrollTop,
              innerScrollHeight: tableholder?.scrollHeight,
              paginationTop: paginationRect?.top,
              paginationInsideViewport: pagination
                ? viewport.contains(pagination)
                : true,
            };
          },
        );
        assert(
          verticalLayoutBefore.outerScrollTop === 0 &&
            verticalLayoutBefore.headerTop !== undefined &&
            verticalLayoutBefore.headerBottom !== undefined &&
            verticalLayoutBefore.headerTop >= verticalLayoutBefore.outerTop &&
            verticalLayoutBefore.headerBottom <=
              verticalLayoutBefore.outerBottom &&
            verticalLayoutBefore.paginationTop !== undefined &&
            verticalLayoutBefore.paginationInsideViewport === false,
          `The table header must be fully visible at outer scrollTop zero, with pagination outside the scroller: ${
            JSON.stringify(verticalLayoutBefore)
          }`,
        );
        await evaluate(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const tableholder = document.querySelector(
            "#column-viewport .tabulator-tableholder",
          );
          if (tableholder) tableholder.scrollTop = tableholder.scrollHeight / 2;
        });
        await page.waitForTimeout(100);
        const verticalLayoutAfter = await evaluateElement(
          page,
          "#column-viewport",
          (viewport: BrowserElement) => {
            const header = viewport.querySelector(".tabulator-header");
            const tableholder = viewport.querySelector(
              ".tabulator-tableholder",
            );
            const headerRect = header?.getBoundingClientRect();
            const viewportRect = viewport.getBoundingClientRect();
            const pagination = (globalThis as unknown as BrowserRuntime)
              .document
              .querySelector("#table-pagination");
            const paginationRect = pagination?.getBoundingClientRect();
            return {
              outerTop: viewportRect.top,
              outerBottom: viewportRect.bottom,
              outerScrollTop: viewport.scrollTop,
              headerTop: headerRect?.top,
              headerBottom: headerRect?.bottom,
              innerScrollTop: tableholder?.scrollTop,
              paginationTop: paginationRect?.top,
              paginationInsideViewport: pagination
                ? viewport.contains(pagination)
                : true,
            };
          },
        );
        assert(
          verticalLayoutAfter.outerScrollTop === 0 &&
            verticalLayoutAfter.headerTop !== undefined &&
            verticalLayoutAfter.headerBottom !== undefined &&
            verticalLayoutAfter.headerTop >= verticalLayoutAfter.outerTop &&
            verticalLayoutAfter.headerBottom <=
              verticalLayoutAfter.outerBottom &&
            verticalLayoutAfter.innerScrollTop !== undefined &&
            verticalLayoutAfter.innerScrollTop > 0 &&
            verticalLayoutAfter.paginationTop ===
              verticalLayoutBefore.paginationTop &&
            verticalLayoutAfter.paginationInsideViewport === false,
          `Inner vertical scrolling must preserve the header, outer position, and separate pagination: ${
            JSON.stringify(verticalLayoutAfter)
          }`,
        );
        const rerenderedRowGeometry = await evaluateElement(
          page,
          "#column-viewport",
          (viewport: BrowserElement) => {
            const viewportLeft = viewport.getBoundingClientRect().left;
            const header = viewport.querySelector(
              '.tabulator-header .tabulator-col[tabulator-field="row_index"]',
            );
            const cell = viewport.querySelector(
              '.tabulator-row [tabulator-field="row_index"]',
            );
            const headerRect = header?.getBoundingClientRect();
            const cellRect = cell?.getBoundingClientRect();
            return {
              viewportLeft,
              headerLeft: headerRect?.left,
              headerRight: headerRect?.right,
              cellLeft: cellRect?.left,
              cellRight: cellRect?.right,
            };
          },
        );
        assert(
          rerenderedRowGeometry.headerLeft !== undefined &&
            rerenderedRowGeometry.headerRight !== undefined &&
            rerenderedRowGeometry.cellLeft !== undefined &&
            rerenderedRowGeometry.cellRight !== undefined &&
            rerenderedRowGeometry.headerLeft >=
              rerenderedRowGeometry.viewportLeft - 1 &&
            rerenderedRowGeometry.headerLeft <
              rerenderedRowGeometry.viewportLeft + 8 &&
            rerenderedRowGeometry.cellLeft >=
              rerenderedRowGeometry.viewportLeft - 1 &&
            rerenderedRowGeometry.cellLeft <
              rerenderedRowGeometry.viewportLeft + 8 &&
            rerenderedRowGeometry.headerRight -
                  rerenderedRowGeometry.headerLeft === 86 &&
            rerenderedRowGeometry.cellRight - rerenderedRowGeometry.cellLeft ===
              86,
          `The row index moved after vertical scrolling/page rendering: ${
            JSON.stringify(rerenderedRowGeometry)
          }`,
        );
        await evaluate(page, () =>
          new Promise<void>((resolve) => {
            const runtime = globalThis as unknown as BrowserRuntime;
            runtime.requestAnimationFrame(() => {
              runtime.requestAnimationFrame(() => resolve());
            });
          }));
        const renderedEdgeCells: {
          loading: boolean;
          columns: Array<{
            field: string;
            headerLeft: number | undefined;
            headerRight: number | undefined;
            cellLeft: number | undefined;
            cellRight: number | undefined;
            textLeft: number | undefined;
            textRight: number | undefined;
            text: string | null | undefined;
          }>;
        } = await evaluateElement(
          page,
          "#column-viewport",
          (viewport: BrowserElement) => {
            const rows = [...viewport.querySelectorAll(".tabulator-row")];
            const targetRow = rows.find((row) =>
              row.querySelector('[tabulator-field="row_index"]')
                ?.textContent ===
                "24"
            );
            const cellGeometry = (field: string) => {
              const header = viewport.querySelector(
                `.tabulator-header .tabulator-col[tabulator-field="${field}"]`,
              );
              const cell = targetRow?.querySelector(
                `[tabulator-field="${field}"]`,
              );
              const headerRect = header?.getBoundingClientRect();
              const cellRect = cell?.getBoundingClientRect();
              const textRect = cell?.querySelector("span")
                ?.getBoundingClientRect();
              return {
                headerLeft: headerRect?.left,
                headerRight: headerRect?.right,
                cellLeft: cellRect?.left,
                cellRight: cellRect?.right,
                textLeft: textRect?.left,
                textRight: textRect?.right,
                text: cell?.textContent,
              };
            };
            return {
              loading: viewport.querySelector("#column-window")?.className
                .includes("is-loading-window") ?? false,
              columns: [294, 295, 296, 297, 298, 299].map((position) => ({
                field: `c${position}`,
                ...cellGeometry(`c${position}`),
              })),
            };
          },
        );
        assert(
          !renderedEdgeCells.loading &&
            renderedEdgeCells.columns.length === 6 &&
            renderedEdgeCells.columns.every((column, index) => {
              const previous = renderedEdgeCells.columns[index - 1];
              return column.text === `value-${column.field.slice(1)}-24` &&
                column.headerLeft !== undefined &&
                column.headerRight !== undefined &&
                column.cellLeft !== undefined &&
                column.cellRight !== undefined &&
                column.textLeft !== undefined &&
                column.textRight !== undefined &&
                Math.abs(column.headerLeft - column.cellLeft) <= 1 &&
                Math.abs(column.headerRight - column.cellRight) <= 1 &&
                column.textLeft >= column.cellLeft - 1 &&
                column.textRight <= column.cellRight + 1 &&
                (!previous || (previous.cellRight ?? Infinity) <=
                    (column.cellLeft ?? -Infinity) + 1) &&
                (!previous || (previous.textRight ?? Infinity) <=
                    (column.textLeft ?? -Infinity) + 1);
            }),
          `Settled right-edge cells must have exact row 24 values and non-overlapping text/geometry: ${
            JSON.stringify(renderedEdgeCells)
          }`,
        );
        console.log(
          "settled-right-edge-row-24",
          JSON.stringify(renderedEdgeCells),
        );
        await Deno.writeFile(
          `${cacheDir}/jdv-20261014-ui-wide-right-edge-after-render.png`,
          await screenshot(page),
        );
        assertEquals(
          await count(page, "#column-window img"),
          0,
        );

        const pagedRequestsBeforeSnapshot = requests.length;
        await writeFrame(rConnection, {
          method: "view/open",
          params: snapshotDescriptor(columns.slice(0, 3)),
        });
        const snapshotCard = "Snapshot smoke";
        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          snapshotCard,
        );
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Snapshot smoke" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "1";
        });
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-meta")?.textContent
            ?.startsWith(
              "249 of 249 rows · 3 columns · snapshot · ",
            ) === true;
        });
        await selectOption(page, "#filter-column", "2");
        assertEquals(
          await texts(page, "#filter-op option"),
          ["Is missing"],
        );
        await selectOption(page, "#filter-column", "0");
        await selectOption(page, "#sort-column", "0");
        await selectOption(page, "#sort-direction", "desc");
        await clickButton(page, "Add sort");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        });
        await clickNextPage(page);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "49";
        });
        await selectOption(page, "#filter-column", "0");
        await selectOption(page, "#filter-op", "gt");
        await fillInput(page, "#filter-value", "247");
        await clickButton(page, "Apply filter");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const cells = [
            ...document.querySelectorAll(
              '.tabulator-row [tabulator-field="row_index"]',
            ),
          ];
          return cells.length === 2 && cells[0].textContent === "249" &&
            cells[1].textContent === "248";
        });
        assert(
          (await text(page, "#table-meta"))?.startsWith(
            "2 of 249 rows · 3 columns · snapshot · ",
          ),
          "Snapshot local filtering should update both row totals.",
        );
        assertEquals(requests.length, pagedRequestsBeforeSnapshot);

        // Duration columns offer comparisons and accept numbers or H:MM:SS.
        const durationValues = [3661.5, 59, -30];
        await writeFrame(rConnection, {
          method: "view/open",
          params: {
            view: "duration-snapshot",
            generation: 1,
            kind: "grid",
            access: "snapshot",
            encoding: "r-json",
            mode: "snapshot",
            title: "Duration smoke",
            nrow: durationValues.length,
            ncol: 2,
            columns: [
              {
                position: 0,
                name: "clock",
                type: "duration",
                class: ["hms", "difftime"],
                units: "secs",
                sortable: true,
                filterable: true,
              },
              {
                position: 1,
                name: "elapsed",
                type: "duration",
                class: "difftime",
                units: "mins",
                sortable: true,
                filterable: true,
              },
            ],
            capabilities: gridCapabilities(),
            data: {
              row_index: [1, 2, 3],
              columns: [0, 1].map(() => ({
                values: durationValues,
                display: durationValues.map(String),
                na: durationValues.map(() => false),
              })),
            },
          },
        });
        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          "Duration smoke",
        );
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
            "Duration smoke";
        });
        await selectOption(page, "#filter-column", "0");
        assertEquals(
          await texts(page, "#filter-op option"),
          [
            "Is missing",
            "Equals",
            "Does not equal",
            "Less than",
            "At most",
            "Greater than",
            "At least",
            "Between",
          ],
        );
        await selectOption(page, "#filter-op", "ge");
        const placeholder = (selector: string) =>
          evaluateElement(
            page,
            selector,
            (element: BrowserElement & { placeholder: string }) =>
              element.placeholder,
          );
        assertEquals(await placeholder("#filter-value"), "H:MM:SS");
        await fillInput(page, "#filter-value", "0:01:00");
        await clickButton(page, "Apply filter");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const cells = [
            ...document.querySelectorAll(
              '.tabulator-row [tabulator-field="row_index"]',
            ),
          ];
          return cells.length === 1 && cells[0].textContent === "1";
        });
        await selectOption(page, "#filter-column", "1");
        await selectOption(page, "#filter-op", "lt");
        assertEquals(await placeholder("#filter-value"), "mins");
        await fillInput(page, "#filter-value", "oops:1");
        await clickButton(page, "Apply filter");
        assert(
          ((await text(page, "#warnings")) ?? "").includes(
            "H:MM:SS or a number",
          ),
          "An invalid duration should be rejected before the query.",
        );

        const pagedCard = "Browser smoke";
        await clickButton(page, "Open view", "#tables article", 0, pagedCard);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Browser smoke" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "1";
        });
        await writeFrame(rConnection, {
          method: "view/open",
          params: {
            view: "wide-paged",
            generation: 2,
            kind: "grid",
            access: "random",
            encoding: "r-json",
            mode: "paged",
            title: "Generation 2",
            nrow: 3,
            ncol: 2,
            columns: columns.slice(0, 2),
            capabilities: gridCapabilities(),
          },
        });
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Generation 2" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "1001";
        });
        await writeFrame(rConnection, {
          method: "view/closed",
          params: { view: "wide-paged", generation: 1 },
        });
        await page.waitForTimeout(100);
        assertEquals(
          await evaluateElement(
            page,
            "#viewer",
            (element: BrowserElement) => element.hidden,
          ),
          false,
        );
        assertEquals(
          await text(page, "#table-title"),
          "Generation 2",
        );
        assertEquals(
          await text(page, '.tabulator-row [tabulator-field="row_index"]'),
          "1001",
        );

        const limitedView = snapshotDescriptor(columns.slice(0, 3));
        limitedView.view = "limited-grid";
        limitedView.title = "Limited capabilities";
        limitedView.nrow = null;
        limitedView.capabilities = {
          ...gridCapabilities(),
          sort: false,
          filter: false,
        };
        await writeFrame(rConnection, {
          method: "view/open",
          params: limitedView,
        });
        const limitedCard = "Limited capabilities";
        await clickButton(page, "Open view", "#tables article", 0, limitedCard);
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
            "Limited capabilities";
        });
        assert(
          (await texts(page, "#tables article")).find((content) =>
            content.includes(limitedCard)
          )?.includes("Unknown rows"),
          "A missing row count should be labeled unknown.",
        );
        assertEquals(
          await evaluateElements(
            page,
            ".query-tools fieldset",
            (elements: BrowserElement[]) =>
              elements.every((element) => element.hidden),
          ),
          true,
        );

        const unsupported = snapshotDescriptor(columns.slice(0, 3));
        unsupported.view = "unsupported-list";
        unsupported.title = "Unsupported list";
        unsupported.kind = "list";
        await writeFrame(rConnection, {
          method: "view/open",
          params: unsupported,
        });
        const unsupportedCard = "Unsupported list";
        await button(
          page,
          "Unsupported view",
          "#tables article",
          0,
          unsupportedCard,
        );
        await writeFrame(rConnection, {
          method: "view/open",
          params: {
            view: "binary-app-probe",
            generation: 1,
            kind: "grid",
            access: "random",
            encoding: "r-json",
            mode: "paged",
            title: "Binary response probe",
            nrow: 1,
            ncol: 1,
            columns: [{
              position: 0,
              name: "value",
              type: "integer",
              sortable: false,
              filterable: false,
            }],
            capabilities: gridCapabilities(),
          },
        });
        const binaryProbe = "Binary response probe";
        await clickButton(page, "Open view", "#tables article", 0, binaryProbe);
        const binaryRequestDeadline = Date.now() + 5_000;
        while (
          !requests.some((request) => request.view === "binary-app-probe") &&
          Date.now() < binaryRequestDeadline
        ) await new Promise((resolve) => setTimeout(resolve, 10));
        if (!requests.some((request) => request.view === "binary-app-probe")) {
          throw new Error(
            "The app did not send its binary probe table request.",
          );
        }
        await page.waitForTimeout(500);
        const probeState = await evaluate(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return {
            status: document.querySelector("#status")?.textContent,
            state: document.querySelector("#status")?.getAttribute(
              "data-state",
            ),
            warning: document.querySelector('#warnings li[data-state="error"]')
              ?.textContent,
          };
        });
        assert(
          probeState.warning === "The producer returned an invalid table page.",
          JSON.stringify(probeState),
        );
        assertEquals(probeState.state, "error");
        assertEquals(pageErrors, []);
      }, 120_000);
    } catch (error) {
      originalFailure.push(error);
      throw error;
    } finally {
      shutdown.requested = true;
      await finishIntegrationCleanup([
        () => owned?.close(),
        () => rConnection.close(),
        () =>
          cleanupDeadline(responder, 5_000, "Mock R responder did not stop."),
        () => phase("HTTP server shutdown", () => server.close(), 5_000),
        () => assertServerReleased(server),
        () => removeCacheDirectory(cacheDir),
      ], originalFailure);
    }
  },
});

Deno.test({
  name: "installed R binary responses reach the Chromium app transport",
  ignore: !binaryRLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const cacheRoot = await Deno.makeTempDir({
      prefix: "jdv-r-binary-browser-",
    });
    const cacheDir = `${cacheRoot}/jdv`;
    const scriptPath = `${cacheRoot}/binary-view.R`;
    const donePath = `${cacheRoot}/finish-r-loop`;
    const server = await phase(
      "HTTP server startup",
      () => startServer({ mode: "tcp", httpPort: 0, cacheDir }),
    );
    const rEnv = Deno.env.toObject();
    for (
      const name of [
        "JDV_DISCOVERY_PATH",
        "JDV_CACHE_DIR",
        "R_PROFILE_USER",
        "R_ENVIRON_USER",
      ]
    ) delete rEnv[name];
    rEnv.JDV_ADDRESS = server.socketPath;
    rEnv.XDG_CACHE_HOME = cacheRoot;
    rEnv.R_LIBS_USER = binaryRLibrary;
    const source = [
      "args <- commandArgs(trailingOnly = TRUE)",
      "done_path <- args[[1L]]",
      "library(jdv)",
      "ns <- asNamespace('jdv')",
      "original <- get('.jdv_process_request', envir = ns)",
      "unlockBinding('.jdv_process_request', ns)",
      "assign('.jdv_process_request', function(request, request_id) {",
      "  if (identical(request$method, 'table/rows')) {",
      "    return(jdv:::.jdv_binary_result(",
      "      list(view = request$params$view, generation = request$params$generation),",
      "      as.raw(c(0L, 10L, 255L))",
      "    ))",
      "  }",
      "  original(request, request_id)",
      "}, envir = ns)",
      "lockBinding('.jdv_process_request', ns)",
      "view_id <- jdv_view(data.frame(value = 1:3), title = 'Real R binary probe', mode = 'paged')",
      'cat("READY\\t", view_id, "\\t", normalizePath(find.package("jdv")), "\\t", getLoadedDLLs()[["jdv"]][["path"]], "\\t", getNamespaceInfo(ns, "path"), "\\t", Sys.getpid(), "\\n", sep = "")',
      "flush.console()",
      "repeat {",
      "  jdv_rpc(NULL)",
      "  if (file.exists(done_path)) break",
      "  Sys.sleep(0.01)",
      "}",
      "jdv_close(view_id)",
      'cat("CLOSED\\n")',
      "flush.console()",
    ].join("\n");
    await Deno.writeTextFile(scriptPath, source);
    let rChild: Deno.ChildProcess | undefined;
    let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    const originalFailure: unknown[] = [];
    let outputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stderrOutput: Promise<string> | undefined;
    let rPid: number | undefined;
    try {
      rChild = new Deno.Command("Rscript", {
        args: ["--vanilla", scriptPath, donePath],
        env: rEnv,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      outputReader = rChild.stdout.getReader();
      stderrOutput = new Response(rChild.stderr).text();
      const lines = new ProcessLines(outputReader);
      const readyLine = await lines.read(15_000);
      if (!readyLine?.startsWith("READY\t")) {
        throw new Error(
          `R binary fixture did not start. Output: ${readyLine ?? "<timeout>"}`,
        );
      }
      const readyParts = readyLine.split("\t");
      if (readyParts.length !== 6) {
        throw new Error(`Invalid R binary fixture ready line: ${readyLine}`);
      }
      const viewId = readyParts[1];
      rPid = fixturePid(readyParts[5]);
      console.log(
        `[binary R ready] ${
          JSON.stringify({ readyParts, launcherPid: rChild.pid, rPid })
        }`,
      );
      const packagePath = await Deno.realPath(readyParts[2]);
      const libraryPath = await Deno.realPath(binaryRLibrary);
      if (!pathWithin(packagePath, libraryPath)) {
        throw new Error(
          `R loaded jdv from ${packagePath}, outside ${libraryPath}.`,
        );
      }
      const dllPath = await Deno.realPath(readyParts[3]);
      const namespacePath = await Deno.realPath(readyParts[4]);
      if (
        !pathWithin(dllPath, packagePath) ||
        !pathWithin(namespacePath, packagePath)
      ) {
        throw new Error(
          `R DLL or namespace path does not match ${packagePath}: ${
            JSON.stringify(readyParts)
          }`,
        );
      }

      owned = await launchOwnedBrowser({
        path: browserExecutable,
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
      const browser = owned.browser;
      await phase("browser test body", async () => {
        const page = await phase(
          "new page",
          () => browser.newPage("about:blank", { waitUntil: "none" }),
        );

        await operation(
          "viewport",
          () => page.setViewportSize({ width: 1280, height: 1000 }),
        );
        const pageErrors: string[] = [];
        const websocketFrames: Array<{
          direction: "sent" | "received";
          payload: string | Uint8Array;
        }> = [];
        collectPageErrors(page, pageErrors);
        await observeSocketFrames(page, (frame) => websocketFrames.push(frame));
        await phase(
          "navigation",
          () => page.goto(server.url, { waitUntil: "load" }),
          25_000,
        );
        await waitForSelector(page, '#status[data-state="connected"]');
        const card = "Real R binary probe";
        await clickButton(page, "Open view", "#tables article", 0, card);
        await waitFor(
          page,
          () => {
            const document = (globalThis as unknown as {
              document: BrowserDocument;
            }).document;
            return document.querySelector('#warnings li[data-state="error"]')
                  ?.textContent ===
                "The producer returned an invalid table page." &&
              document.querySelector("#status")?.getAttribute("data-state") ===
                "error";
          },
          undefined,
          { timeout: 15_000 },
        );
        const requestEntry = websocketFrames.find((frame) => {
          if (frame.direction !== "sent" || typeof frame.payload !== "string") {
            return false;
          }
          const message = JSON.parse(frame.payload) as Record<string, unknown>;
          const params = message.params as Record<string, unknown> | undefined;
          return message.type === "request" && params?.view === viewId;
        });
        assert(
          requestEntry,
          "Chromium did not send the expected table request.",
        );
        const requestMessage = JSON.parse(requestEntry.payload as string) as {
          id: string;
          session: string;
        };
        const responseFrame = websocketFrames.find((frame) =>
          frame.direction === "received" && frame.payload instanceof Uint8Array
        );
        assert(responseFrame, "Chromium did not receive a binary response.");
        const responseBytes = responseFrame.payload as Uint8Array;
        assert(
          responseBytes.length >= 4,
          "Binary response prefix is truncated.",
        );
        const headerLength = new DataView(
          responseBytes.buffer,
          responseBytes.byteOffset,
          4,
        ).getUint32(0, true);
        assert(
          headerLength > 0 && 4 + headerLength <= responseBytes.length,
          "Binary response header length is invalid.",
        );
        const binaryEnvelope = JSON.parse(
          new TextDecoder().decode(responseBytes.subarray(4, 4 + headerLength)),
        ) as Record<string, unknown>;
        const result = binaryEnvelope.result as Record<string, unknown>;
        const transfer = result.transfer as Record<string, unknown>;
        assertEquals(binaryEnvelope.type, "response");
        assertEquals(binaryEnvelope.id, requestMessage.id);
        assertEquals(binaryEnvelope.session, requestMessage.session);
        assertEquals(result.view, viewId);
        assertEquals(result.generation, 1);
        assertEquals(transfer, { encoding: "arrow-ipc", byte_length: 3 });
        assertEquals(responseBytes.length - 4 - headerLength, 3);
        assertEquals(
          responseBytes.slice(4 + headerLength),
          new Uint8Array([0, 10, 255]),
        );
        const terminalFrames = websocketFrames.filter((frame) => {
          if (frame.direction !== "received") return false;
          const message = typeof frame.payload === "string"
            ? JSON.parse(frame.payload) as Record<string, unknown>
            : binaryEnvelope;
          return message.id === requestMessage.id &&
            (message.type === "response" || message.type === "error" ||
              message.type === "cancelled");
        });
        assertEquals(terminalFrames.length, 1);
        assertEquals(pageErrors, []);
      }, 120_000);
    } catch (error) {
      originalFailure.push(error);
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => owned?.close(),
        () =>
          rChild && stderrOutput
            ? finishRFixture(rChild, donePath, stderrOutput, rPid)
            : undefined,
        () =>
          outputReader
            ? cleanupDeadline(
              outputReader.cancel(),
              5_000,
              "R stdout cancellation timed out.",
            )
            : undefined,
        () => outputReader?.releaseLock(),
        () => phase("HTTP server shutdown", () => server.close(), 5_000),
        () => assertServerReleased(server),
        () => removeCacheDirectory(cacheRoot),
      ], originalFailure);
    }
  },
});

async function connectR(socketPath: string): Promise<Deno.Conn> {
  const address = new URL(socketPath);
  return await Deno.connect({
    hostname: address.hostname,
    port: Number(address.port),
  });
}

async function writeFrame(
  connection: Deno.Conn,
  value: Record<string, unknown>,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    offset += await connection.write(bytes.subarray(offset));
  }
}

async function writeRBinaryResponse(
  connection: Deno.Conn,
  header: Record<string, unknown>,
  body: Uint8Array,
): Promise<void> {
  const prefix = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
  const frame = new Uint8Array(prefix.length + body.length);
  frame.set(prefix);
  frame.set(body, prefix.length);
  let offset = 0;
  while (offset < frame.length) {
    offset += await connection.write(frame.subarray(offset));
  }
}

async function respondToR(
  connection: Deno.Conn,
  columns: Array<Record<string, unknown>>,
  requests: Array<Record<string, unknown>>,
  shutdown: { requested: boolean },
): Promise<void> {
  for await (const line of fixtureFrames(connection, shutdown)) {
    const request = JSON.parse(line) as Record<string, unknown>;
    if (typeof request.id !== "string") continue;
    const params = request.params as Record<string, unknown>;
    if (
      request.method === "table/rows" &&
      params.view === "binary-app-probe"
    ) {
      requests.push(params);
      const body = new Uint8Array([0x00, 0x0a, 0xff]);
      await writeRBinaryResponse(connection, {
        id: request.id,
        result: {
          view: "binary-app-probe",
          generation: 1,
          transfer: { encoding: "arrow-ipc", byte_length: body.length },
        },
        warnings: [],
      }, body);
      continue;
    }
    if (request.method === "object/children") {
      const path = params.path as Array<Record<string, unknown>>;
      const children = path.length === 0
        ? [{
          index: 1,
          label: "nested <img src=x onerror=alert(1)>",
          class: ["list"],
          summary: "1 item",
          has_children: true,
          viewable: false,
          path: [{ type: "index", index: 1 }],
        }, {
          index: 2,
          label: "data",
          class: ["data.frame"],
          summary: "1 × 1",
          has_children: false,
          viewable: true,
          path: [{ type: "index", index: 2 }],
        }, {
          index: 3,
          label: "nested object",
          class: ["list"],
          summary: "1 element",
          has_children: true,
          viewable: true,
          path: [{ type: "index", index: 3 }],
        }]
        : [{
          index: 1,
          label: "leaf",
          class: ["character"],
          summary: "text",
          has_children: false,
          viewable: false,
          path: [...path, { type: "index", index: 1 }],
        }];
      await writeFrame(connection, {
        id: request.id,
        result: {
          view: params.view,
          generation: params.generation,
          path,
          offset: params.offset,
          children,
          total_children: children.length,
        },
        warnings: [],
      });
      continue;
    }
    if (request.method === "object/open") {
      const path = params.path as Array<Record<string, unknown>>;
      const reply = async (result: Record<string, unknown>) => {
        await writeFrame(connection, { method: "view/open", params: result });
        await writeFrame(connection, {
          id: request.id,
          result,
          warnings: [],
        });
      };
      if (path[0]?.index === 3) {
        await reply({
          view: "nested-tree",
          generation: 1,
          kind: "tree",
          access: "random",
          encoding: "r-json",
          title: "Nested object",
          class: ["list"],
          path: [],
          parent: "tree-root",
          capabilities: {
            seek: true,
            sort: false,
            filter: false,
            known_total: true,
            next: false,
            children: true,
          },
        });
        continue;
      }
      await reply({
        view: "tree-child-grid",
        generation: 1,
        kind: "grid",
        access: "snapshot",
        encoding: "r-json",
        mode: "snapshot",
        title: "Child table",
        parent: "tree-root",
        nrow: 1,
        ncol: 1,
        columns: [{
          position: 0,
          name: "value",
          type: "integer",
          sortable: true,
          filterable: true,
        }],
        capabilities: gridCapabilities(),
        data: { columns: ["value"], rows: [[1]] },
      });
      continue;
    }
    if (request.method === "view/close") {
      await writeFrame(connection, {
        id: request.id,
        result: {
          view: params.view,
          generation: params.generation,
          closed: true,
        },
        warnings: [],
      });
      continue;
    }
    if (request.method !== "table/rows") {
      await writeFrame(connection, {
        id: request.id,
        error: { code: "unsupported", message: "Unexpected smoke request." },
        warnings: [],
      });
      continue;
    }

    requests.push(params);
    const generation = Number(params.generation);
    const rowBase = generation === 2 ? 1000 : 0;
    const rowCount = generation === 2 ? 3 : 249;
    const filter = params.filter as Record<string, unknown> | null;
    if (filter?.col === 0 && filter.op === "gt" && filter.value === 999) {
      await writeFrame(connection, {
        id: request.id,
        error: {
          code: "producer_error",
          message: "<img src=x onerror=alert(1)>",
        },
        warnings: [],
      });
      continue;
    }
    const sorted = Array.from(
      { length: rowCount },
      (_, index) => rowBase + index + 1,
    );
    const sort = Array.isArray(params.sort)
      ? params.sort as Array<Record<string, unknown>>
      : [];
    const selected = filter
      ? sorted.filter((rowIndex) => {
        if (filter.col !== 0 || typeof filter.value !== "number") return true;
        const value = rowIndex - rowBase;
        switch (filter.op) {
          case "gt":
            return value > filter.value;
          case "ge":
            return value >= filter.value;
          case "lt":
            return value < filter.value;
          case "le":
            return value <= filter.value;
          case "eq":
            return value === filter.value;
          default:
            return true;
        }
      })
      : sorted;
    if (sort[0]?.col === 0 && sort[0].desc === true) selected.reverse();
    const total = selected.length;
    const offset = Number(params.offset ?? 0);
    const limit = Number(params.limit ?? 200);
    const chunkLimit = generation === 1 && offset === 0 && total > 37
      ? 37
      : generation === 1 && offset === 37 && total > 49
      ? 12
      : limit;
    const rowIndices = selected.slice(
      offset,
      offset + Math.min(limit, chunkLimit),
    );
    const positions = Array.isArray(params.cols)
      ? params.cols as number[]
      : columns.map((column) => Number(column.position));
    await writeFrame(connection, {
      id: request.id,
      result: {
        view: "wide-paged",
        generation,
        total,
        total_unfiltered: rowCount,
        offset,
        limit: rowIndices.length,
        data: {
          row_index: rowIndices,
          row_names: rowIndices.map((rowIndex) => `row-${rowIndex}`),
          columns: positions.map((position) => ({
            schema: columns[position],
            data: {
              display: rowIndices.map((rowIndex) =>
                position === 0
                  ? String(rowIndex)
                  : position === 1 && rowIndex === 1
                  ? "<img src=x onerror=alert(1)>"
                  : `value-${position}-${rowIndex}`
              ),
              na: rowIndices.map(() => false),
            },
          })),
        },
      },
      warnings: offset === 0 ? ["<img src=x onerror=alert(1)>"] : [],
    });
  }
}

async function clickNextPage(
  page: Page,
): Promise<void> {
  await click(page, '.tabulator-page[data-page="next"]');
}

function snapshotDescriptor(
  columns: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const values = Array.from({ length: 249 }, (_, index) => index + 1);
  const strings = values.map((value) =>
    value === 1 ? "<img src=x onerror=alert(1)>" : `value-${value}`
  );
  return {
    view: "wide-snapshot",
    generation: 1,
    kind: "grid",
    access: "snapshot",
    encoding: "r-json",
    mode: "snapshot",
    title: "Snapshot smoke",
    nrow: values.length,
    ncol: columns.length,
    columns,
    capabilities: gridCapabilities(),
    row_names: values.map((value) => `row-${value}`),
    data: {
      row_index: values,
      row_names: values.map((value) => `row-${value}`),
      columns: [
        {
          values,
          display: values.map(String),
          sortKey: values,
          na: values.map(() => false),
        },
        {
          values: strings,
          display: strings,
          na: values.map(() => false),
        },
        {
          values: values.map((value) => value * 2),
          display: values.map((value) => String(value * 2)),
          na: values.map(() => false),
        },
      ],
    },
  };
}

function gridCapabilities() {
  return {
    seek: true,
    sort: true,
    filter: true,
    known_total: true,
    next: false,
    children: false,
  };
}

Deno.test({
  name: "cell open survives Snapshot queries and restores its parent state",

  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-cell-browser-" });
    const server = await phase(
      "HTTP server startup",
      () => startServer({ mode: "tcp", httpPort: 0, cacheDir }),
    );
    const connection = await phase(
      "cell mock R connect",
      () => connectR(server.socketPath),
    );
    const values = Array.from({ length: 449 }, (_, index) => index + 1);
    const columns = Array.from({ length: 12 }, (_, position) => ({
      position,
      name: position === 2
        ? "<img src=x onerror=alert(1)>"
        : `column-${position}`,
      type: position === 2 || position === 3 ? "list" : "integer",
      sortable: position === 0,
      filterable: position === 0,
      drillable: position === 2,
    }));
    await writeFrame(connection, {
      method: "hello",
      params: {
        protocol: 1,
        session: "r-86-1",
        producer: { name: "test", version: "1" },
        limits: {
          max_unacked_frames: 4096,
          max_unacked_bytes: 64 * 1024 * 1024,
          queue_messages: 256,
          queue_bytes: 16 * 1024 * 1024,
          max_request_bytes: 1024 * 1024,
          max_message_bytes: 10 * 1024 * 1024,
        },
      },
    });
    await writeFrame(connection, {
      method: "view/open",
      params: {
        view: "cell-parent",
        generation: 1,
        kind: "grid",
        access: "snapshot",
        encoding: "r-json",
        mode: "snapshot",
        title: "Cell parent",
        nrow: values.length,
        ncol: columns.length,
        columns,
        capabilities: { ...gridCapabilities(), children: true },
        data: {
          row_index: values,
          columns: columns.map((schema) => ({
            ...(schema.type === "integer" ? { values } : {}),
            display: values.map((value) =>
              schema.type === "list"
                ? `<img src=x> cell-${value}`
                : String(value)
            ),
            ...(schema.sortable ? { sortKey: values } : {}),
            na: values.map(() => false),
          })),
        },
      },
    });
    const frames: Array<Record<string, unknown>> = [];
    let resolveOpen!: (request: Record<string, unknown>) => void;
    const opened = new Promise<Record<string, unknown>>((resolve) =>
      resolveOpen = resolve
    );
    const shutdown = { requested: false };
    const responder = (async () => {
      for await (const line of fixtureFrames(connection, shutdown)) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        if (frame.method === "object/open") resolveOpen(frame);
        else if (frame.method === "object/children") {
          const params = frame.params as Record<string, unknown>;
          await writeFrame(connection, {
            id: frame.id,
            result: {
              ...params,
              total_children: 1,
              children: [{
                index: 1,
                label: "<img src=x> child",
                summary: "captured row 1",
                class: ["list"],
                has_children: false,
                viewable: false,
                path: [{ type: "index", index: 1 }],
              }],
            },
          });
        }
      }
    })();
    void responder.catch((error) =>
      console.error("[cell mock R responder]", error)
    );
    let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    const originalFailure: unknown[] = [];
    try {
      owned = await launchOwnedBrowser({
        path: browserExecutable,
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
      const browser = owned.browser;
      await phase("browser test body", async () => {
        const page = await phase(
          "new page",
          () => browser.newPage("about:blank", { waitUntil: "none" }),
        );

        await operation(
          "viewport",
          () => page.setViewportSize({ width: 1280, height: 1000 }),
        );
        const errors: string[] = [];
        collectPageErrors(page, errors);
        await phase(
          "navigation",
          () => page.goto(server.url, { waitUntil: "load" }),
          25_000,
        );
        await clickButton(page, "Open view");
        await waitForSelector(
          page,
          '[data-action="open-cell"][data-row-index="1"][data-column="2"]',
        );
        assertEquals(
          await count(page, '[data-action="open-cell"][data-column="3"]'),
          0,
        );
        assertEquals(await count(page, "#viewer img"), 0);
        await click(
          page,
          '[data-action="open-cell"][data-row-index="1"][data-column="2"]',
        );
        const open = await opened;
        assertEquals((open.params as Record<string, unknown>).path, [{
          kind: "cell",
          row_index: 1,
          column: 2,
        }]);
        await waitForSelector(
          page,
          '#child-open-status[data-state="waiting"]:not([hidden])',
        );
        await selectOption(page, "#sort-column", "0");
        await selectOption(page, "#sort-direction", "desc");
        await click(page, "#sort-add");
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelector('.tabulator-row [tabulator-field="row_index"]')
              ?.textContent === "449",
        );
        await selectOption(page, "#filter-column", "0");
        await selectOption(page, "#filter-op", "gt");
        await fillInput(page, "#filter-value", "10");
        await click(page, "#filter-apply");
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelector("#table-meta")?.textContent?.startsWith(
                "439 of 449 rows",
              ),
        );
        await clickNextPage(page);
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelector('.tabulator-row [tabulator-field="row_index"]')
              ?.textContent === "249",
        );
        await evaluateElement(
          page,
          "#column-viewport",
          (element: BrowserElement) => {
            element.scrollLeft = 540;
          },
        );
        await waitFor(
          page,
          () =>
            !(globalThis as unknown as { document: BrowserDocument }).document
              .querySelector("#column-window")?.className.includes(
                "is-loading-window",
              ),
        );
        const scrollLeft = await evaluateElement(page, "#column-viewport", (
          element: BrowserElement,
        ) => element.scrollLeft);
        assert(scrollLeft > 0);
        assertEquals(
          await count(
            page,
            '#child-open-status[data-state="waiting"]:not([hidden])',
          ),
          1,
        );
        assertEquals(
          frames.filter((frame) => frame.method === "table/rows").length,
          0,
        );
        assertEquals(
          frames.filter((frame) => frame.method === "cancel").length,
          0,
        );
        const childDescriptor = {
          view: "cell-child",
          generation: 1,
          parent: "cell-parent",
          kind: "tree",
          access: "random",
          encoding: "r-json",
          title: "Captured row 1",
          path: [],
          capabilities: {
            seek: true,
            sort: false,
            filter: false,
            known_total: true,
            next: false,
            children: true,
          },
        };
        await writeFrame(connection, {
          method: "view/open",
          params: childDescriptor,
        });
        await writeFrame(connection, {
          id: open.id,
          result: childDescriptor,
        });
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelector("#tree-title")?.textContent === "Captured row 1",
        );
        await waitForSelector(page, "#tree-child-list li");
        assertEquals(await count(page, "#tree-child-list img"), 0);
        await click(page, '#view-breadcrumb [data-view-depth="0"]');
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelector('.tabulator-row [tabulator-field="row_index"]')
              ?.textContent === "249",
        );
        assertEquals(await inputValue(page, "#filter-value"), "10");
        assertEquals(await inputValue(page, "#filter-op"), "gt");
        assert(
          (await text(page, "#sort-list"))?.includes(
            "descending",
          ),
        );
        assertEquals(
          await evaluateElement(page, "#column-viewport", (
            element: BrowserElement,
          ) => element.scrollLeft),
          scrollLeft,
        );
        assertEquals(
          frames.filter((frame) => frame.method === "object/open").length,
          1,
        );
        assertEquals(
          frames.filter((frame) => frame.method === "table/rows").length,
          0,
        );
        const sortedOpen = new Promise<Record<string, unknown>>((resolve) =>
          resolveOpen = resolve
        );
        await evaluateElement(
          page,
          "#column-viewport",
          (element: BrowserElement) => {
            element.scrollLeft = 0;
          },
        );
        await waitForSelector(
          page,
          '[data-action="open-cell"][data-row-index="249"][data-column="2"]',
        );
        await click(
          page,
          '[data-action="open-cell"][data-row-index="249"][data-column="2"]',
        );
        const secondOpen = await sortedOpen;
        assertEquals((secondOpen.params as Record<string, unknown>).path, [{
          kind: "cell",
          row_index: 249,
          column: 2,
        }]);
        await writeFrame(connection, {
          id: secondOpen.id,
          error: {
            code: "unavailable",
            message: "<img src=x> unavailable cell",
          },
        });
        await waitForSelector(
          page,
          '#child-open-status[data-state="error"]:not([hidden])',
        );
        assertEquals(await count(page, "#child-open-status img"), 0);
        assertEquals(errors, []);
      }, 120_000);
    } catch (error) {
      originalFailure.push(error);
      throw error;
    } finally {
      shutdown.requested = true;
      await finishIntegrationCleanup([
        () => owned?.close(),
        () => connection.close(),
        () =>
          cleanupDeadline(responder, 5_000, "Mock R responder did not stop."),
        () => phase("HTTP server shutdown", () => server.close(), 5_000),
        () => assertServerReleased(server),
        () => removeCacheDirectory(cacheDir),
      ], originalFailure);
    }
  },
});

function refreshCapabilities() {
  return { ...gridCapabilities(), refresh: true };
}

async function respondToRefresh(
  connection: Deno.Conn,
  requests: Array<Record<string, unknown>>,
  shutdown: { requested: boolean },
  columns: Array<Record<string, unknown>>,
): Promise<void> {
  for await (const line of fixtureFrames(connection, shutdown)) {
    const request = JSON.parse(line) as Record<string, unknown>;
    if (typeof request.id !== "string") continue;
    const params = request.params as Record<string, unknown>;
    requests.push({ method: request.method, ...params });
    if (request.method === "object/children") {
      await writeFrame(connection, {
        id: request.id,
        result: {
          view: params.view,
          generation: params.generation,
          path: params.path,
          offset: params.offset,
          children: [],
          total_children: 0,
        },
        warnings: [],
      });
      continue;
    }
    if (request.method === "view/refresh") {
      const generation = Number(params.generation) + 1;
      if (params.view === "refresh-tree") {
        // A tree becomes a grid; R sends the new view/open before the reply.
        await writeFrame(connection, {
          method: "view/open",
          params: {
            view: "refresh-tree",
            generation,
            kind: "grid",
            access: "snapshot",
            encoding: "r-json",
            mode: "snapshot",
            title: "Tree became grid",
            nrow: 1,
            ncol: 1,
            columns: [columns[0]],
            capabilities: refreshCapabilities(),
            row_names: null,
            data: {
              row_index: [1],
              row_names: null,
              columns: [{ values: [7], display: ["7"], na: [false] }],
            },
          },
        });
      } else {
        await writeFrame(connection, {
          method: "view/open",
          params: {
            view: "refresh-grid",
            generation,
            kind: "grid",
            access: "random",
            encoding: "r-json",
            mode: "paged",
            title: `Refreshed ${generation}`,
            nrow: 3,
            ncol: columns.length,
            columns,
            capabilities: refreshCapabilities(),
          },
        });
        if (generation === 3) {
          // A later update lands before the acknowledgement of this one.
          await writeFrame(connection, {
            method: "view/open",
            params: {
              view: "refresh-grid",
              generation: 4,
              kind: "grid",
              access: "random",
              encoding: "r-json",
              mode: "paged",
              title: "Refreshed 4",
              nrow: 3,
              ncol: columns.length,
              columns,
              capabilities: refreshCapabilities(),
            },
          });
        }
      }
      await writeFrame(connection, {
        id: request.id,
        result: {
          view: params.view,
          previous_generation: params.generation,
          generation,
          refreshed: true,
        },
        warnings: [],
      });
      continue;
    }
    if (request.method === "table/rows") {
      const generation = Number(params.generation);
      const base = generation * 1000;
      const sort = Array.isArray(params.sort)
        ? params.sort as Array<Record<string, unknown>>
        : [];
      const rows = [base + 1, base + 2, base + 3];
      if (sort[0]?.desc === true) rows.reverse();
      await writeFrame(connection, {
        id: request.id,
        result: {
          view: params.view,
          generation,
          total: 3,
          total_unfiltered: 3,
          offset: 0,
          limit: 3,
          data: {
            row_index: rows,
            row_names: null,
            columns: [{
              schema: columns[0],
              data: {
                display: rows.map(String),
                na: rows.map(() => false),
              },
            }],
          },
        },
        warnings: [],
      });
      continue;
    }
    await writeFrame(connection, {
      id: request.id,
      error: { code: "unsupported", message: "Unexpected refresh request." },
      warnings: [],
    });
  }
}

Deno.test({
  name: "refresh button reopens the view on the new generation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-refresh-browser-" });
    const server = await phase(
      "HTTP server startup",
      () => startServer({ mode: "tcp", httpPort: 0, cacheDir }),
    );
    const connection = await phase(
      "refresh mock R connect",
      () => connectR(server.socketPath),
    );
    const columns = [{
      position: 0,
      name: "key",
      type: "integer",
      sortable: true,
      filterable: true,
    }];
    await writeFrame(connection, {
      method: "hello",
      params: {
        protocol: 1,
        session: `r-${Deno.pid}-90`,
        producer: { name: "test", version: "1" },
        limits: {
          max_unacked_frames: 4096,
          max_unacked_bytes: 64 * 1024 * 1024,
          queue_messages: 256,
          queue_bytes: 16 * 1024 * 1024,
          max_request_bytes: 1024 * 1024,
          max_message_bytes: 10 * 1024 * 1024,
        },
      },
    });
    await writeFrame(connection, {
      method: "view/open",
      params: {
        view: "refresh-grid",
        generation: 1,
        kind: "grid",
        access: "random",
        encoding: "r-json",
        mode: "paged",
        title: "Refresh grid",
        nrow: 3,
        ncol: 1,
        columns,
        capabilities: refreshCapabilities(),
      },
    });
    await writeFrame(connection, {
      method: "view/open",
      params: {
        view: "refresh-tree",
        generation: 1,
        kind: "tree",
        access: "random",
        encoding: "r-json",
        title: "Refresh tree",
        class: ["list"],
        capabilities: {
          seek: true,
          sort: false,
          filter: false,
          known_total: true,
          next: false,
          children: true,
          refresh: true,
        },
      },
    });
    const requests: Array<Record<string, unknown>> = [];
    const shutdown = { requested: false };
    const responder = respondToRefresh(connection, requests, shutdown, columns);
    void responder.catch((error) => console.error("[mock R responder]", error));
    let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    const originalFailure: unknown[] = [];
    const rowIndex = '.tabulator-row [tabulator-field="row_index"]';
    const refreshes = () =>
      requests.filter((request) => request.method === "view/refresh");

    try {
      owned = await launchOwnedBrowser({
        path: browserExecutable,
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
      const browser = owned.browser;
      await phase("browser test body", async () => {
        const page = await browser.newPage("about:blank", {
          waitUntil: "none",
        });
        await page.setViewportSize({ width: 1280, height: 1000 });
        const pageErrors: string[] = [];
        collectPageErrors(page, pageErrors);
        await page.goto(server.url, { waitUntil: "load" });
        await waitForSelector(page, '#status[data-state="connected"]');

        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          "Refresh grid",
        );
        await waitForSelector(page, `#viewer ${rowIndex}`);
        assertEquals(await text(page, rowIndex), "1001");
        assertEquals(await count(page, "#refresh-view:not([hidden])"), 1);

        // Query state: a descending sort changes the first row.
        await selectOption(page, "#sort-column", "0");
        await selectOption(page, "#sort-direction", "desc");
        await clickButton(page, "Add sort");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "1003";
        });
        assertEquals(await count(page, "#sort-list li"), 1);

        await click(page, "#refresh-view");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Refreshed 2" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "2001";
        });
        assertEquals(refreshes().length, 1);
        assertEquals(refreshes()[0].view, "refresh-grid");
        assertEquals(refreshes()[0].generation, 1);
        // Sorting, scrolling, and the previous generation's rows are gone.
        assertEquals(await count(page, "#sort-list li"), 0);
        assertEquals(
          requests.filter((request) =>
            request.method === "table/rows" && request.generation === 2 &&
            Array.isArray(request.sort) && request.sort.length > 0
          ).length,
          0,
        );
        // The acknowledgement did not turn into an error or abort.
        assertEquals(
          await evaluateElement(
            page,
            "#status",
            (element: BrowserElement) => element.getAttribute("data-state"),
          ) === "error",
          false,
        );

        // A newer update arriving before the acknowledgement wins.
        await clickButton(
          page,
          "Refresh",
          "#tables article",
          0,
          "Refreshed 2",
        );
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Refreshed 4" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "4001";
        });
        await page.waitForTimeout(200);
        assertEquals(await text(page, "#table-title"), "Refreshed 4");
        assertEquals(refreshes().length, 2);
        assertEquals(refreshes()[1].generation, 2);
        assertEquals(await count(page, "#tables article"), 2);

        // A failed automatic update keeps the last display and says so.
        await writeFrame(connection, {
          method: "view/update_failed",
          params: {
            view: "refresh-grid",
            generation: 4,
            code: "limit_exceeded",
            message: "The new value is too large.",
          },
        });
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const status = document.querySelector("#status");
          return status?.getAttribute("data-state") === "error" &&
            (status.textContent ?? "").includes("Could not update") &&
            (status.textContent ?? "").includes("limit_exceeded");
        });
        assertEquals(await text(page, "#table-title"), "Refreshed 4");
        assertEquals(await text(page, rowIndex), "4001");
        // A report for a generation that is no longer current is ignored.
        await writeFrame(connection, {
          method: "view/update_failed",
          params: {
            view: "refresh-grid",
            generation: 3,
            code: "producer_error",
            message: "stale report",
          },
        });
        await page.waitForTimeout(200);
        assertEquals(
          ((await text(page, "#status")) ?? "").includes("stale report"),
          false,
        );

        // A tree refreshed into a grid follows the new descriptor.
        await clickButton(
          page,
          "Open object",
          "#tables article",
          0,
          "Refresh tree",
        );
        await waitForSelector(page, "#tree-viewer:not([hidden])");
        assertEquals(await count(page, "#tree-refresh:not([hidden])"), 1);
        await click(page, "#tree-refresh");
        await waitForSelector(page, "#viewer:not([hidden])");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Tree became grid" &&
            document.querySelector("#tree-viewer")?.hidden === true;
        });
        assertEquals(refreshes().length, 3);
        assertEquals(pageErrors, []);
      }, 90_000);
    } catch (error) {
      originalFailure.push(error);
      throw error;
    } finally {
      shutdown.requested = true;
      await finishIntegrationCleanup([
        () => owned?.close(),
        () => connection.close(),
        () =>
          cleanupDeadline(responder, 5_000, "Mock R responder did not stop."),
        () => phase("HTTP server shutdown", () => server.close(), 5_000),
        () => assertServerReleased(server),
        () => removeCacheDirectory(cacheDir),
      ], originalFailure);
    }
  },
});

async function respondToTrack(
  connection: Deno.Conn,
  requests: Array<Record<string, unknown>>,
  shutdown: { requested: boolean },
  columns: Array<Record<string, unknown>>,
): Promise<void> {
  const tracking = (state: string) => ({ name: "df", state });
  for await (const line of fixtureFrames(connection, shutdown)) {
    const request = JSON.parse(line) as Record<string, unknown>;
    if (typeof request.id !== "string") continue;
    const params = request.params as Record<string, unknown>;
    requests.push({ method: request.method, ...params });
    if (request.method !== "view/track") {
      await writeFrame(connection, {
        id: request.id,
        error: { code: "unsupported", message: "Unexpected request." },
        warnings: [],
      });
      continue;
    }
    let generation = Number(params.generation);
    const state = params.enabled === true ? "active" : "paused";
    if (params.enabled === true && generation === 2) {
      // Resuming found a changed variable: R rebuilds before the reply.
      generation += 1;
      await writeFrame(connection, {
        method: "view/open",
        params: {
          view: "track-grid",
          generation,
          reason: "tracked",
          kind: "grid",
          access: "random",
          encoding: "r-json",
          mode: "paged",
          title: `Tracked ${generation}`,
          nrow: 3,
          ncol: columns.length,
          columns,
          capabilities: { ...refreshCapabilities(), track: true },
          tracking: tracking("active"),
        },
      });
    } else {
      await writeFrame(connection, {
        method: "view/tracking",
        params: {
          view: params.view,
          generation,
          tracking: tracking(state),
        },
      });
    }
    await writeFrame(connection, {
      id: request.id,
      result: { view: params.view, generation, tracking: tracking(state) },
      warnings: [],
    });
  }
}

Deno.test({
  name: "tracking controls pause, resume, and report a lost variable",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-track-browser-" });
    const server = await phase(
      "HTTP server startup",
      () => startServer({ mode: "tcp", httpPort: 0, cacheDir }),
    );
    const connection = await phase(
      "track mock R connect",
      () => connectR(server.socketPath),
    );
    const columns = [{
      position: 0,
      name: "key",
      type: "integer",
      sortable: true,
      filterable: true,
    }];
    await writeFrame(connection, {
      method: "hello",
      params: {
        protocol: 1,
        session: `r-${Deno.pid}-91`,
        producer: { name: "test", version: "1" },
        limits: {
          max_unacked_frames: 4096,
          max_unacked_bytes: 64 * 1024 * 1024,
          queue_messages: 256,
          queue_bytes: 16 * 1024 * 1024,
          max_request_bytes: 1024 * 1024,
          max_message_bytes: 10 * 1024 * 1024,
        },
      },
    });
    await writeFrame(connection, {
      method: "view/open",
      params: {
        view: "track-grid",
        generation: 2,
        kind: "grid",
        access: "random",
        encoding: "r-json",
        mode: "paged",
        title: "Track grid",
        nrow: 3,
        ncol: 1,
        columns,
        capabilities: { ...refreshCapabilities(), track: true },
        tracking: { name: "df", state: "active" },
      },
    });
    await writeFrame(connection, {
      method: "view/open",
      params: {
        view: "plain-grid",
        generation: 1,
        kind: "grid",
        access: "random",
        encoding: "r-json",
        mode: "paged",
        title: "Plain grid",
        nrow: 3,
        ncol: 1,
        columns,
        capabilities: { ...refreshCapabilities(), track: false },
      },
    });
    const requests: Array<Record<string, unknown>> = [];
    const shutdown = { requested: false };
    const responder = respondToTrack(connection, requests, shutdown, columns);
    void responder.catch((error) => console.error("[mock R responder]", error));
    let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    const originalFailure: unknown[] = [];
    const tracks = () =>
      requests.filter((request) => request.method === "view/track");

    try {
      owned = await launchOwnedBrowser({
        path: browserExecutable,
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
      const browser = owned.browser;
      await phase("browser test body", async () => {
        const page = await browser.newPage("about:blank", {
          waitUntil: "none",
        });
        await page.setViewportSize({ width: 1280, height: 1000 });
        const pageErrors: string[] = [];
        collectPageErrors(page, pageErrors);
        await page.goto(server.url, { waitUntil: "load" });
        await waitForSelector(page, '#status[data-state="connected"]');

        // Only the tracked view has a state label and a toggle.
        assertEquals(await count(page, '#tables [data-role="track-state"]'), 1);
        assertEquals(
          await count(page, '#tables [data-action="track-view"]'),
          1,
        );
        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          "Track grid",
        );
        await waitForSelector(page, "#viewer:not([hidden])");
        assertEquals(await text(page, "#track-state"), "Following df");
        assertEquals(await text(page, "#track-view"), "Pause following");

        // Pausing: the label follows R's view/tracking notification.
        await click(page, "#track-view");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#track-state")?.textContent ===
            "Paused df";
        });
        assertEquals(await text(page, "#track-view"), "Resume following");
        assertEquals(tracks()[0].enabled, false);
        assertEquals(tracks()[0].generation, 2);

        // Resuming rebuilt the view: the new generation is shown and active.
        await click(page, "#track-view");
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Tracked 3" &&
            document.querySelector("#track-state")?.textContent ===
              "Following df";
        });
        assertEquals(tracks()[1].enabled, true);
        assertEquals(await text(page, "#track-view"), "Pause following");
        assertEquals(
          ((await text(page, "#status")) ?? "").includes("error"),
          false,
        );

        // A lost variable leaves the label and removes the toggle.
        await writeFrame(connection, {
          method: "view/tracking",
          params: {
            view: "track-grid",
            generation: 3,
            tracking: {
              name: "df",
              state: "lost",
              reason: "removed",
              message: "the binding was removed",
            },
          },
        });
        await waitFor(page, () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return (document.querySelector("#track-state")?.textContent ?? "")
            .startsWith("Lost df");
        });
        assertEquals(await count(page, "#track-view:not([hidden])"), 0);
        assertEquals(
          await count(page, '#tables [data-action="track-view"]'),
          0,
        );
        // A report for another generation is ignored.
        await writeFrame(connection, {
          method: "view/tracking",
          params: {
            view: "track-grid",
            generation: 2,
            tracking: { name: "df", state: "paused" },
          },
        });
        await page.waitForTimeout(200);
        assertEquals(
          ((await text(page, "#track-state")) ?? "").startsWith("Lost df"),
          true,
        );
        assertEquals(pageErrors, []);
      }, 90_000);
    } catch (error) {
      originalFailure.push(error);
      throw error;
    } finally {
      shutdown.requested = true;
      await finishIntegrationCleanup([
        () => owned?.close(),
        () => connection.close(),
        () =>
          cleanupDeadline(responder, 5_000, "Mock R responder did not stop."),
        () => phase("HTTP server shutdown", () => server.close(), 5_000),
        () => assertServerReleased(server),
        () => removeCacheDirectory(cacheDir),
      ], originalFailure);
    }
  },
});

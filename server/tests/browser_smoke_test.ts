import { assert, assertEquals } from "./assert.ts";
import { startServer } from "../main.ts";

type BrowserElement = {
  clientWidth: number;
  clientHeight: number;
  className: string;
  contains(element: BrowserElement): boolean;
  dispatchEvent(event: unknown): boolean;
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
  style: { transform: string; width: string };
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
    left: string;
    position: string;
    transform: string;
  };
  requestAnimationFrame(callback: () => void): number;
};

const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");

Deno.test({
  name: "browser smoke loads Paged data, queries it, and reaches wide columns",
  ignore: !browserExecutable,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const playwrightModule = "npm:playwright@1.56.1";
    const { chromium } = await import(playwrightModule);
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-browser-smoke-" });
    const server = await startServer({
      mode: "tcp",
      httpPort: 0,
      cacheDir,
    });
    const rConnection = await connectR(server.socketPath);
    const columns = Array.from({ length: 300 }, (_, position) => ({
      position,
      name: position === 0 ? "key" : `column-${position}`,
      type: position === 1 ? "string" : "integer",
      sortable: position === 0,
      filterable: position < 2,
    }));
    const session = `r-${Deno.pid}-71`;
    await writeFrame(rConnection, {
      method: "hello",
      params: {
        protocol: 1,
        session,
        pid: Deno.pid,
        r_version: "4.5.0",
        jdv_version: "0.0.0",
        limits: {
          max_receive_frames: 4096,
          max_receive_bytes: 64 * 1024 * 1024,
          queue_messages: 256,
          queue_bytes: 16 * 1024 * 1024,
          max_request_bytes: 1024 * 1024,
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
    const requests: Array<Record<string, unknown>> = [];
    const responder = respondToR(rConnection, columns, requests);
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    try {
      browser = await chromium.launch({
        executablePath: browserExecutable,
        headless: true,
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
      const page = await browser.newPage({
        viewport: { width: 1280, height: 1000 },
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error: Error) => pageErrors.push(error.message));
      await page.goto(server.url, { waitUntil: "networkidle" });
      assertEquals(
        await page.evaluate(async () => (await fetch("/favicon.ico")).status),
        204,
      );
      await page.waitForSelector('#status[data-state="connected"]');
      await page.getByRole("button", { name: "Open view" }).click();
      await page.waitForSelector("#viewer .tabulator-row");
      await page.selectOption("#filter-column", "299");
      assertEquals(
        await page.locator("#filter-op option").allTextContents(),
        ["Is missing"],
      );
      await page.selectOption("#filter-column", "0");
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "1";
        },
      );
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="c1"]',
          )?.textContent === "<img src=x onerror=alert(1)>";
        },
      );
      assertEquals(await page.locator("#column-window img").count(), 0);
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#warnings")?.textContent?.includes(
            "<img src=x onerror=alert(1)>",
          ) === true;
        },
      );
      assertEquals(await page.locator("#warnings img").count(), 0);
      await page.screenshot({
        path: "/tmp/jdv-phase7-browser-smoke.png",
        fullPage: true,
      });

      assertEquals(
        requests.slice(0, 3).map((request) => request.offset),
        [0, 37, 49],
      );
      assertEquals(
        await page.locator("#column-window.tabulator").count(),
        1,
      );
      assertEquals(
        await page.locator(
          '#column-window .tabulator-col[tabulator-field="c0"]',
        ).count(),
        1,
      );
      assertEquals(
        await page.locator('.tabulator-row [tabulator-field="c0"]').first()
          .textContent(),
        "1",
      );

      await page.selectOption("#sort-column", "0");
      await page.selectOption("#sort-direction", "desc");
      await page.getByRole("button", { name: "Add sort" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        },
      );
      assert(
        requests.some((request) =>
          Array.isArray(request.sort) &&
          (request.sort[0] as Record<string, unknown>)?.desc === true
        ),
        "The browser did not send the descending sort request.",
      );

      await clickNextPage(page);
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "49";
        },
      );
      const pagedRequestsBeforeHorizontalScroll = requests.length;
      const heldScrollGeometry = await page.evaluate(async () => {
        const runtime = globalThis as unknown as BrowserRuntime & {
          document: BrowserDocument;
        };
        const document = runtime.document;
        const viewport = document.querySelector("#column-viewport");
        if (!viewport) throw new Error("The column viewport was not found.");
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
        const viewportLeft = viewport.getBoundingClientRect().left;
        const headerRect = rowHeader?.getBoundingClientRect();
        const cellRect = rowCell?.getBoundingClientRect();
        return {
          scrollLeft: viewport.scrollLeft,
          viewportLeft,
          headerLeft: headerRect?.left ?? Number.NaN,
          headerRight: headerRect?.right ?? Number.NaN,
          cellLeft: cellRect?.left ?? Number.NaN,
          cellRight: cellRect?.right ?? Number.NaN,
        };
      });
      assert(
        requests.length === pagedRequestsBeforeHorizontalScroll,
        `Horizontal paging should wait for the scroll debounce while the user is still moving: before=${pagedRequestsBeforeHorizontalScroll}, after=${requests.length}, new=${
          JSON.stringify(requests.slice(pagedRequestsBeforeHorizontalScroll))
        }`,
      );
      assert(
        heldScrollGeometry.scrollLeft === 86 + 290 * 180 &&
          heldScrollGeometry.headerLeft >=
            heldScrollGeometry.viewportLeft - 1 &&
          heldScrollGeometry.headerLeft < heldScrollGeometry.viewportLeft + 8 &&
          heldScrollGeometry.cellLeft >= heldScrollGeometry.viewportLeft - 1 &&
          heldScrollGeometry.cellLeft < heldScrollGeometry.viewportLeft + 8 &&
          heldScrollGeometry.headerRight - heldScrollGeometry.headerLeft ===
            86 &&
          heldScrollGeometry.cellRight - heldScrollGeometry.cellLeft === 86,
        `The row index moved during rapid scroll/hold: ${
          JSON.stringify(heldScrollGeometry)
        }`,
      );
      await page.waitForTimeout(500);
      console.log(
        "horizontal-column-diagnostic",
        await page.locator("#column-viewport").evaluate(
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
              windowWidth: element.querySelector("#column-window")?.style.width,
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
      await page.screenshot({
        path: "/tmp/jdv-phase7-browser-scroll.png",
        fullPage: true,
      });
      await page.waitForSelector(
        '#column-window .tabulator-col[tabulator-field="c290"]',
        undefined,
        { timeout: 5_000 },
      );
      const pinnedRowGeometry = await page.locator("#column-viewport")
        .evaluate((viewport: BrowserElement) => {
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
            headerLeft: headerRect?.left,
            headerRight: headerRect?.right,
            cellLeft: cellRect?.left,
            cellRight: cellRect?.right,
          };
        });
      assert(
        pinnedRowGeometry.headerLeft !== undefined &&
          pinnedRowGeometry.headerRight !== undefined &&
          pinnedRowGeometry.cellLeft !== undefined &&
          pinnedRowGeometry.cellRight !== undefined &&
          pinnedRowGeometry.headerLeft >= pinnedRowGeometry.viewportLeft - 1 &&
          pinnedRowGeometry.headerLeft < pinnedRowGeometry.viewportLeft + 8 &&
          pinnedRowGeometry.cellLeft >= pinnedRowGeometry.viewportLeft - 1 &&
          pinnedRowGeometry.cellLeft < pinnedRowGeometry.viewportLeft + 8 &&
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
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#sort-list")?.textContent?.includes(
            "#0",
          ) === true;
        },
      );
      assert(
        requests.some((request) =>
          request.offset === 200 && Array.isArray(request.cols) &&
          request.cols.includes(290) && Array.isArray(request.sort) &&
          (request.sort[0] as Record<string, unknown>)?.col === 0 &&
          (request.sort[0] as Record<string, unknown>)?.desc === true
        ),
        "The right-column page request lost page offset or the column-0 sort.",
      );

      await page.selectOption("#filter-column", "0");
      await page.selectOption("#filter-op", "gt");
      await page.locator("#filter-value").fill("247");
      await page.getByRole("button", { name: "Apply filter" }).click();
      await page.waitForFunction(
        () => {
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
        },
      );
      assert(
        requests.some((request) =>
          (request.filter as Record<string, unknown> | null)?.op === "gt"
        ),
        "The browser did not send the filter request.",
      );
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-meta")?.textContent?.startsWith(
            "2 of 249 rows · 300 columns · paged · ",
          ) === true;
        },
      );
      assert(
        (await page.locator("#table-meta").textContent())?.startsWith(
          "2 of 249 rows · 300 columns · paged · ",
        ),
        "The Paged heading should show the filtered and unfiltered totals.",
      );
      await page.screenshot({
        path: "/tmp/jdv-20261014-ui-filtered-count.png",
        fullPage: true,
      });

      await page.getByRole("button", { name: "Clear" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        },
      );
      await page.selectOption("#filter-column", "0");
      await page.selectOption("#filter-op", "gt");
      await page.locator("#filter-value").fill("999");
      await page.getByRole("button", { name: "Apply filter" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector('#warnings li[data-state="error"]')
            ?.textContent?.includes("r_error: <img src=x onerror=alert(1)>") ===
            true;
        },
      );
      assertEquals(await page.locator("#warnings img").count(), 0);
      await page.getByRole("button", { name: "Clear" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        },
      );
      await page.evaluate(() => {
        const document = (globalThis as unknown as {
          document: BrowserDocument;
        }).document;
        const viewport = document.querySelector("#column-viewport");
        if (viewport) viewport.scrollLeft = viewport.scrollWidth;
      });
      await page.waitForSelector(
        '#column-window .tabulator-col[tabulator-field="c299"]',
      );
      await page.waitForSelector(
        '.tabulator-row [tabulator-field="c299"]',
      );
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="c299"]',
          )?.textContent?.startsWith("value-299-") === true;
        },
        { timeout: 5_000 },
      );
      await page.waitForFunction(() => {
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
      }, { timeout: 5_000 });
      assert(
        (await page.locator('.tabulator-row [tabulator-field="c299"]')
          .first().textContent())?.startsWith("value-299-"),
        "The rightmost data cell was not rendered.",
      );
      const rightEdgeGeometry = await page.locator("#column-viewport").evaluate(
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
      await page.screenshot({
        path: "/tmp/jdv-20261014-ui-wide-right-edge.png",
        fullPage: true,
      }, { timeout: 5_000 });
      console.log(
        "rightmost-column-paged-requests",
        JSON.stringify(
          requests.filter((request) =>
            Array.isArray(request.cols) && request.cols.includes(299)
          ),
        ),
      );
      await clickNextPage(page);
      await page.waitForFunction(() => {
        const document = (globalThis as unknown as {
          document: BrowserDocument;
        }).document;
        return document.querySelector(
          '.tabulator-row [tabulator-field="row_index"]',
        )?.textContent === "49";
      });
      console.log(
        "vertical-layout-diagnostic",
        await page.locator("#column-viewport").evaluate(
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
      const verticalLayoutBefore = await page.locator("#column-viewport")
        .evaluate((viewport: BrowserElement) => {
          const header = viewport.querySelector(".tabulator-header");
          const tableholder = viewport.querySelector(
            ".tabulator-tableholder",
          );
          const headerRect = header?.getBoundingClientRect();
          const viewportRect = viewport.getBoundingClientRect();
          const pagination = (globalThis as unknown as BrowserRuntime).document
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
        });
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
      await page.evaluate(() => {
        const document = (globalThis as unknown as {
          document: BrowserDocument;
        }).document;
        const tableholder = document.querySelector(
          "#column-viewport .tabulator-tableholder",
        );
        if (tableholder) tableholder.scrollTop = tableholder.scrollHeight / 2;
      });
      await page.waitForTimeout(100);
      const verticalLayoutAfter = await page.locator("#column-viewport")
        .evaluate((viewport: BrowserElement) => {
          const header = viewport.querySelector(".tabulator-header");
          const tableholder = viewport.querySelector(
            ".tabulator-tableholder",
          );
          const headerRect = header?.getBoundingClientRect();
          const viewportRect = viewport.getBoundingClientRect();
          const pagination = (globalThis as unknown as BrowserRuntime).document
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
        });
      assert(
        verticalLayoutAfter.outerScrollTop === 0 &&
          verticalLayoutAfter.headerTop !== undefined &&
          verticalLayoutAfter.headerBottom !== undefined &&
          verticalLayoutAfter.headerTop >= verticalLayoutAfter.outerTop &&
          verticalLayoutAfter.headerBottom <= verticalLayoutAfter.outerBottom &&
          verticalLayoutAfter.innerScrollTop !== undefined &&
          verticalLayoutAfter.innerScrollTop > 0 &&
          verticalLayoutAfter.paginationTop ===
            verticalLayoutBefore.paginationTop &&
          verticalLayoutAfter.paginationInsideViewport === false,
        `Inner vertical scrolling must preserve the header, outer position, and separate pagination: ${
          JSON.stringify(verticalLayoutAfter)
        }`,
      );
      const rerenderedRowGeometry = await page.locator("#column-viewport")
        .evaluate((viewport: BrowserElement) => {
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
        });
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
      await page.evaluate(() =>
        new Promise<void>((resolve) => {
          const runtime = globalThis as unknown as BrowserRuntime;
          runtime.requestAnimationFrame(() => {
            runtime.requestAnimationFrame(() => resolve());
          });
        })
      );
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
      } = await page.locator("#column-viewport")
        .evaluate((viewport: BrowserElement) => {
          const rows = [...viewport.querySelectorAll(".tabulator-row")];
          const targetRow = rows.find((row) =>
            row.querySelector('[tabulator-field="row_index"]')?.textContent ===
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
        });
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
              column.textLeft !== undefined && column.textRight !== undefined &&
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
      await page.screenshot({
        path: "/tmp/jdv-20261014-ui-wide-right-edge-after-render.png",
        fullPage: true,
      });
      assertEquals(
        await page.locator("#column-window img").count(),
        0,
      );

      const pagedRequestsBeforeSnapshot = requests.length;
      await writeFrame(rConnection, {
        method: "view/open",
        params: snapshotDescriptor(columns.slice(0, 3)),
      });
      const snapshotCard = page.locator("#tables article").filter({
        hasText: "Snapshot smoke",
      });
      await snapshotCard.getByRole("button", { name: "Open view" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Snapshot smoke" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "1";
        },
      );
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-meta")?.textContent?.startsWith(
            "249 of 249 rows · 3 columns · snapshot · ",
          ) === true;
        },
      );
      await page.selectOption("#filter-column", "2");
      assertEquals(
        await page.locator("#filter-op option").allTextContents(),
        ["Is missing"],
      );
      await page.selectOption("#filter-column", "0");
      await page.selectOption("#sort-column", "0");
      await page.selectOption("#sort-direction", "desc");
      await page.getByRole("button", { name: "Add sort" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "249";
        },
      );
      await clickNextPage(page);
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector(
            '.tabulator-row [tabulator-field="row_index"]',
          )?.textContent === "49";
        },
      );
      await page.selectOption("#filter-column", "0");
      await page.selectOption("#filter-op", "gt");
      await page.locator("#filter-value").fill("247");
      await page.getByRole("button", { name: "Apply filter" }).click();
      await page.waitForFunction(
        () => {
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
        },
      );
      assert(
        (await page.locator("#table-meta").textContent())?.startsWith(
          "2 of 249 rows · 3 columns · snapshot · ",
        ),
        "Snapshot local filtering should update both row totals.",
      );
      assertEquals(requests.length, pagedRequestsBeforeSnapshot);

      const pagedCard = page.locator("#tables article").filter({
        hasText: "Browser smoke",
      });
      await pagedCard.getByRole("button", { name: "Open view" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Browser smoke" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "1";
        },
      );
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
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
              "Generation 2" &&
            document.querySelector(
                '.tabulator-row [tabulator-field="row_index"]',
              )?.textContent === "1001";
        },
      );
      await writeFrame(rConnection, {
        method: "view/closed",
        params: { view: "wide-paged", generation: 1 },
      });
      await page.waitForTimeout(100);
      assertEquals(
        await page.locator("#viewer").evaluate((element: BrowserElement) =>
          element.hidden
        ),
        false,
      );
      assertEquals(
        await page.locator("#table-title").textContent(),
        "Generation 2",
      );
      assertEquals(
        await page.locator('.tabulator-row [tabulator-field="row_index"]')
          .first().textContent(),
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
      const limitedCard = page.locator("#tables article").filter({
        hasText: "Limited capabilities",
      });
      await limitedCard.getByRole("button", { name: "Open view" }).click();
      await page.waitForFunction(
        () => {
          const document = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          return document.querySelector("#table-title")?.textContent ===
            "Limited capabilities";
        },
      );
      assert(
        (await limitedCard.textContent())?.includes("Unknown rows"),
        "A missing row count should be labeled unknown.",
      );
      assertEquals(
        await page.locator(".query-tools fieldset").evaluateAll(
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
      const unsupportedCard = page.locator("#tables article").filter({
        hasText: "Unsupported list",
      });
      await unsupportedCard.getByRole("button", {
        name: "Unsupported view",
      }).waitFor();
      assertEquals(pageErrors, []);
    } finally {
      await browser?.close();
      await server.close();
      rConnection.close();
      await responder;
      await Deno.remove(cacheDir, { recursive: true });
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

async function* readFrames(connection: Deno.Conn): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const chunk = new Uint8Array(8192);
  let buffered = "";
  try {
    while (true) {
      const size = await connection.read(chunk);
      if (size === null) return;
      buffered += decoder.decode(chunk.subarray(0, size), { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.BadResource)) throw error;
  }
}

async function respondToR(
  connection: Deno.Conn,
  columns: Array<Record<string, unknown>>,
  requests: Array<Record<string, unknown>>,
): Promise<void> {
  for await (const line of readFrames(connection)) {
    const request = JSON.parse(line) as Record<string, unknown>;
    if (typeof request.id !== "string") continue;
    if (request.method !== "table/rows") {
      await writeFrame(connection, {
        id: request.id,
        error: { code: "unsupported", message: "Unexpected smoke request." },
        warnings: [],
      });
      continue;
    }

    const params = request.params as Record<string, unknown>;
    requests.push(params);
    const generation = Number(params.generation);
    const rowBase = generation === 2 ? 1000 : 0;
    const rowCount = generation === 2 ? 3 : 249;
    const filter = params.filter as Record<string, unknown> | null;
    if (filter?.col === 0 && filter.op === "gt" && filter.value === 999) {
      await writeFrame(connection, {
        id: request.id,
        error: {
          code: "r_error",
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
  page: { locator(selector: string): { click(): Promise<void> } },
): Promise<void> {
  await page.locator('.tabulator-page[data-page="next"]').click();
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

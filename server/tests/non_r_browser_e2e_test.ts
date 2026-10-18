import type { Page } from "@astral/astral";
import {
  clickButton,
  collectPageErrors,
  evaluateElement,
  text,
  texts,
  waitFor,
  waitForSelector,
} from "./astral_page.ts";
import { launchOwnedBrowser, phase } from "./bounded_browser.ts";
import { finishIntegrationCleanup } from "./integration_cleanup.ts";
import { assert, assertEquals } from "./assert.ts";
import { NonRProducerHarness } from "./fixtures/non_r_producer.ts";

const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");
type BrowserDocument = {
  querySelector(selector: string): {
    textContent: string | null;
    disabled?: boolean;
  } | null;
  querySelectorAll(selector: string): unknown[];
};

Deno.test({
  name:
    "non-R producer renders sequential Arrow and jdv-json grids in Chromium",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = await NonRProducerHarness.start();
    let owned: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];

    try {
      await harness.producer.openSequential();
      await harness.producer.openSnapshot();
      await harness.producer.openRandom();
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
      await phase("non-R browser test body", async () => {
        page = await browser.newPage("about:blank", { waitUntil: "none" });
        collectPageErrors(page, pageErrors);
        await phase(
          "navigate to non-R fixture",
          () => page!.goto(harness.url, { waitUntil: "load" }),
          25_000,
        );
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument })
              .document;
          return document.querySelectorAll("#tables article").length === 3;
        });

        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          "Sequential fixture",
        );
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument })
              .document;
          return document.querySelector("#table-title")?.textContent ===
            "Sequential fixture";
        });
        await clickButton(page, "Load next", "#sequential-controls");
        try {
          await waitForSelector(
            page,
            '.tabulator-row [tabulator-field="c0"]',
          );
        } catch (error) {
          throw new Error(
            `${error}\nstatus: ${await text(
              page,
              "#status",
            )}\nmeta: ${await text(
              page,
              "#table-meta",
            )}\nprogress: ${await text(
              page,
              "#sequential-progress",
            )}\nnotice: ${await text(
              page,
              "#sequential-notice",
            )}\nwarnings: ${await text(page, "#warnings")}\nrows: ${
              JSON.stringify(await texts(page, ".tabulator-row"))
            }\ncolumns: ${
              JSON.stringify(await texts(page, ".tabulator-col"))
            }` +
              `\npage errors: ${pageErrors.join("; ")}`,
          );
        }
        assertEquals(
          (await text(page, '.tabulator-row [tabulator-field="c0"]'))
            ?.replace("Inspect", ""),
          "1",
        );
        await clickButton(page, "Load next", "#sequential-controls");
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument })
              .document;
          return document.querySelectorAll(
            '.tabulator-row [tabulator-field="c0"]',
          ).length === 3;
        });
        assertEquals(
          (await texts(page, '.tabulator-row [tabulator-field="c0"]')).map(
            (value) => value.replace("Inspect", ""),
          ),
          ["1", "2", "3"],
        );
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument }).document;
          return document.querySelector("#sequential-next")?.disabled ===
            false;
        });
        await clickButton(page, "Load next", "#sequential-controls");
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument })
              .document;
          return document.querySelector("#sequential-progress")?.textContent
            ?.includes("end of stream") === true;
        });
        assert(
          (await text(page, "#sequential-progress"))?.includes("3 rows seen"),
          "The sequential grid should report all rows after reaching EOF.",
        );
        assert(
          (await text(page, "#sequential-progress"))?.includes("end of stream"),
          "The sequential grid should report EOF in its progress status.",
        );
        assertEquals(
          await evaluateElement(
            page,
            "#sequential-next",
            (element: { disabled: boolean }) => element.disabled,
          ),
          true,
        );

        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          "Snapshot fixture",
        );
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument })
              .document;
          return document.querySelector("#table-title")?.textContent ===
            "Snapshot fixture";
        });
        await waitForSelector(
          page,
          '.tabulator-row [tabulator-field="c0"]',
        );
        assertEquals(
          await text(page, '.tabulator-row [tabulator-field="c0"]'),
          "10",
        );

        await clickButton(
          page,
          "Open view",
          "#tables article",
          0,
          "Random fixture",
        );
        await waitFor(page, () => {
          const document =
            (globalThis as unknown as { document: BrowserDocument })
              .document;
          return document.querySelector("#table-title")?.textContent ===
            "Random fixture";
        });
        await waitForSelector(
          page,
          '.tabulator-row [tabulator-field="c0"]',
        );
        assertEquals(
          await text(page, '.tabulator-row [tabulator-field="c0"]'),
          "10",
        );
      });

      assertEquals(pageErrors, []);
    } finally {
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => harness.close(),
      ]);
    }
  },
});

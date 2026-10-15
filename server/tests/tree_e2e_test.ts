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
  text,
  texts,
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
  querySelectorAll(selector: string): { length: number };
};

let rEvaluationSequence = 0;

function rEval(
  arf: ArfSession,
  code: string,
  timeoutMs = 30_000,
): Promise<Awaited<ReturnType<ArfSession["eval"]>>> {
  const sequence = ++rEvaluationSequence;
  return phase(
    `Tree E2E R evaluation ${sequence}`,
    () => arf.eval(code, timeoutMs),
    timeoutMs + 3_000,
  );
}

interface Runtime {
  server: TestServer;
  arf: ArfSession;
  browser: TestBrowser;
  session: string;
  root: Record<string, unknown>;
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
  const pendingIndex = pending.findIndex(predicate);
  if (pendingIndex >= 0) return pending.splice(pendingIndex, 1)[0];

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
): Promise<Record<string, unknown>> {
  const event = await nextMessage(
    browser,
    (message) => {
      if (message.type !== "view/open") return false;
      const envelope = asRecord(message.message);
      return asRecord(envelope.params).title === title;
    },
    `view/open for ${title}`,
  );
  return {
    ...asRecord(asRecord(event.message).params),
    _session: String(event.session),
  };
}

async function request(
  browser: TestBrowser,
  session: string,
  view: string,
  generation: number,
  method: string,
  params: Record<string, unknown> = {},
  id = `tree-${crypto.randomUUID()}`,
): Promise<Record<string, unknown>> {
  browser.send({
    type: "request",
    id,
    session,
    method,
    params: { view, generation, ...params },
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

function lastStep(child: Record<string, unknown>): Record<string, unknown> {
  const path = asArray(child.path);
  assert(path.length > 0, "A non-root child path must contain a step.");
  return asRecord(path.at(-1));
}

function childByPath(
  children: unknown[],
  type: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const child = children.map(asRecord).find((entry) => {
    const step = lastStep(entry);
    return step.type === type && step[key] === value;
  });
  assert(child, `Missing ${type} child ${String(value)}.`);
  return child;
}

function treeFixtureCode(): string {
  return [
    "jdv_tree_counts <- new.env(parent = emptyenv())",
    "jdv_tree_counts$active <- 0L; jdv_tree_counts$promise <- 0L; jdv_tree_counts$dispatch <- 0L",
    "jdv_tree_active_env <- new.env(parent = emptyenv())",
    'makeActiveBinding("active", function(value) { if (missing(value)) { jdv_tree_counts$active <- jdv_tree_counts$active + 1L; "active-value" } else stop("read-only") }, jdv_tree_active_env)',
    'delayedAssign("deferred", { jdv_tree_counts$promise <- jdv_tree_counts$promise + 1L; "promise-value" }, assign.env = jdv_tree_active_env, eval.env = .GlobalEnv)',
    "jdv_tree_active_env$ordinary <- 42L",
    "jdv_tree_cycle_env <- new.env(parent = emptyenv()); jdv_tree_cycle_env$self <- jdv_tree_cycle_env",
    "jdv_tree_capture_env <- new.env(parent = emptyenv()); jdv_tree_capture_env$df <- data.frame(value = c(17L, 18L), check.names = FALSE)",
    'if (!methods::isClass("jdv_tree_fixture_s4")) methods::setClass("jdv_tree_fixture_s4", slots = c(items = "list"))',
    'jdv_tree_s4 <- methods::new("jdv_tree_fixture_s4", items = list(slot_value = 7L))',
    "jdv_tree_pair <- as.pairlist(list(left = 1L, right = 2L))",
    'jdv_tree_classed <- structure(list(one = 1L, two = 2L), class = "jdv_tree_classed_list")',
    '`[[.jdv_tree_classed_list` <- function(x, i, ...) { jdv_tree_counts$dispatch <- jdv_tree_counts$dispatch + 1L; stop("classed list dispatch must not run") }',
    "jdv_tree_captured <- data.frame(value = c(17L, 18L), check.names = FALSE)",
    'jdv_tree_root <- list("duplicate-first", "duplicate-second", unname(list("unnamed-one", "unnamed-two")), seq_len(1200L), data.frame(value = c(31L, 32L), check.names = FALSE), jdv_tree_active_env, jdv_tree_cycle_env, jdv_tree_s4, jdv_tree_pair, jdv_tree_captured, "html-label-value", jdv_tree_classed, "empty-name-value", jdv_tree_capture_env)',
    'names(jdv_tree_root) <- c("duplicate", "duplicate", "unnamed", "long atomic", "nested frame", "environment", "cycle", "S4 object", "pairlist", "captured", "<img src=x onerror=alert(1)>", "classed list", "", "capture environment")',
    'attr(jdv_tree_root, "inspect") <- list(note = "attribute-value")',
    'jdv_view(jdv_tree_root, title = "Tree E2E fixture")',
  ].join("; ");
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
    await phase("Tree E2E server startup", () => server.start(), 30_000);
    startedArf = true;
    await phase(
      "Tree E2E arf startup",
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
    console.log(`Loaded tree E2E R package and DLL:\n${loaded.stdout ?? ""}`);
    browser = await phase(
      "Tree E2E browser connection",
      () => server.connectBrowser(),
      30_000,
    );
    const welcome = await phase(
      "Tree E2E browser welcome",
      () => browser!.read(10_000),
      12_000,
    );
    assertEquals(welcome.type, "welcome");
    await rEval(arf, treeFixtureCode());
    const root = await openedView(browser, "Tree E2E fixture");
    return {
      server,
      arf,
      browser,
      session: String(root._session),
      root,
    };
  } catch (error) {
    await finishIntegrationCleanup([
      ...(browser
        ? [
          () =>
            phase(
              "Tree E2E startup browser cleanup",
              () => Promise.resolve(browser!.close()),
              10_000,
            ),
        ]
        : []),
      ...(startedArf
        ? [
          () =>
            phase("Tree E2E startup arf cleanup", () => arf.close(), 50_000),
        ]
        : []),
      ...(startedServer
        ? [
          () =>
            phase(
              "Tree E2E startup server cleanup",
              () => server.close(),
              10_000,
            ),
        ]
        : []),
    ], [error]);
    throw error;
  }
}

Deno.test({
  name: "real R tree viewer pages typed children and opens grid children",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtime = await startRuntime();
    let screenshotDir: string | undefined;
    let primaryError: unknown;
    let closeChromium: (() => Promise<void>) | undefined;
    try {
      await bodyDeadline("Tree E2E overall body", async () => {
        const { server, arf, browser, session, root } = runtime;
        assertEquals(root.kind, "tree");
        assertEquals(root.access, "random");
        const capabilities = asRecord(root.capabilities);
        assertEquals(capabilities.children, true);
        assertEquals(capabilities.sort, false);
        assertEquals(capabilities.filter, false);

        const rootPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: [], offset: 0, limit: 500 },
          ),
        );
        const rootChildren = asArray(rootPage.children);
        const firstDuplicate = childByPath(rootChildren, "index", "index", 1);
        const secondDuplicate = childByPath(rootChildren, "index", "index", 2);
        assertEquals(lastStep(firstDuplicate).index, 1);
        assertEquals(lastStep(secondDuplicate).index, 2);
        const emptyName = childByPath(rootChildren, "index", "index", 13);
        assertEquals(lastStep(emptyName).index, 13);

        const unnamed = childByPath(rootChildren, "index", "index", 3);
        const unnamedPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: unnamed.path, offset: 0, limit: 20 },
          ),
        );
        const unnamedChildren = asArray(unnamedPage.children);
        assertEquals(lastStep(asRecord(unnamedChildren[0])).type, "index");
        assertEquals(lastStep(asRecord(unnamedChildren[0])).index, 1);

        const longAtomic = childByPath(rootChildren, "index", "index", 4);
        const longPages = [];
        for (const offset of [0, 500, 1000]) {
          const page = responseResult(
            await request(
              browser,
              session,
              String(root.view),
              Number(root.generation),
              "object/children",
              { path: longAtomic.path, offset, limit: 500 },
            ),
          );
          assertEquals(page.total_children, 1200);
          const children = asArray(page.children);
          assertEquals(children.length, offset === 1000 ? 200 : 500);
          longPages.push(children);
        }
        assertEquals(lastStep(asRecord(longPages[0][0])).index, 1);
        assertEquals(lastStep(asRecord(longPages[1][0])).index, 501);
        assertEquals(lastStep(asRecord(longPages[2][199])).index, 1200);

        const envChild = childByPath(rootChildren, "index", "index", 6);
        const environmentPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: envChild.path, offset: 0, limit: 20 },
          ),
        );
        const environmentChildren = asArray(environmentPage.children).map(
          asRecord,
        );
        const active = environmentChildren.find((child) =>
          child.label === "active"
        );
        const deferred = environmentChildren.find((child) =>
          child.label === "deferred"
        );
        assert(active, "Active binding was omitted from the child list.");
        assert(deferred, "Promise binding was omitted from the child list.");
        assertEquals(active.viewable, false);
        assertEquals(deferred.viewable, false);

        const cycleEnv = childByPath(rootChildren, "index", "index", 7);
        let cyclePath = cycleEnv.path;
        let cycleStopped = false;
        for (let depth = 0; depth < 8; depth++) {
          const cyclePage = responseResult(
            await request(
              browser,
              session,
              String(root.view),
              Number(root.generation),
              "object/children",
              { path: cyclePath, offset: 0, limit: 10 },
            ),
          );
          const cycleChildren = asArray(cyclePage.children).map(asRecord);
          const self = cycleChildren.find((child) =>
            lastStep(child).type === "binding" &&
            lastStep(child).name === "self"
          );
          if (!self || self.has_children !== true) {
            cycleStopped = true;
            break;
          }
          cyclePath = self.path;
        }
        assert(
          cycleStopped,
          "A self-referential environment did not stop expanding.",
        );

        const s4 = childByPath(rootChildren, "index", "index", 8);
        const s4Page = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: s4.path, offset: 0, limit: 10 },
          ),
        );
        const slot = childByPath(
          asArray(s4Page.children),
          "slot",
          "name",
          "items",
        );
        const slotPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: slot.path, offset: 0, limit: 10 },
          ),
        );
        assert(asArray(slotPage.children).length > 0);

        const pair = childByPath(rootChildren, "index", "index", 9);
        const pairPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: pair.path, offset: 0, limit: 10 },
          ),
        );
        assertEquals(
          asArray(pairPage.children).map(asRecord).filter((child) =>
            lastStep(child).type === "index"
          ).length,
          2,
        );

        const classed = childByPath(rootChildren, "index", "index", 12);
        const classedPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: classed.path, offset: 0, limit: 10 },
          ),
        );
        assertEquals(
          asArray(classedPage.children).map(asRecord).filter((child) =>
            lastStep(child).type === "index"
          ).length,
          2,
        );

        const attr = childByPath(rootChildren, "attr", "name", "inspect");
        assertEquals(lastStep(attr).name, "inspect");

        const captured = childByPath(rootChildren, "index", "index", 10);
        const opened = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: captured.path },
          ),
        );
        assertEquals(opened.kind, "grid");
        assertEquals(opened.parent, root.view);
        const childView = String(opened.view);
        const openedEvent = await nextMessage(
          browser,
          (message) => {
            if (message.type !== "view/open") return false;
            return asRecord(asRecord(message.message).params).view ===
              childView;
          },
          "child grid view/open event",
        );
        assertEquals(
          asRecord(asRecord(openedEvent.message).params).parent,
          root.view,
        );

        const captureEnv = childByPath(rootChildren, "index", "index", 14);
        const captureEnvPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: captureEnv.path, offset: 0, limit: 10 },
          ),
        );
        const captureBinding = childByPath(
          asArray(captureEnvPage.children),
          "binding",
          "name",
          "df",
        );
        const capturePath = captureBinding.path;
        const oldChild = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: capturePath },
          ),
        );
        assertEquals(oldChild.kind, "grid");
        await rEval(
          arf,
          "jdv_tree_capture_env$df <- data.frame(value = c(99L, 100L), check.names = FALSE)",
        );
        const newChild = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: capturePath },
          ),
        );
        assertEquals(newChild.kind, "grid");
        assert(
          oldChild.view !== newChild.view,
          "Reopening a replaced environment binding should capture a new child view.",
        );

        const counterResult = await rEval(
          arf,
          "c(jdv_tree_counts$active, jdv_tree_counts$promise, jdv_tree_counts$dispatch)",
        );
        assert(
          counterResult.value?.trim().endsWith("0 0 0"),
          `Tree enumeration evaluated guarded values or dispatched [[ : ${counterResult.value}`,
        );

        const stale = await request(
          browser,
          session,
          String(root.view),
          Number(root.generation) + 1,
          "object/children",
          { path: [], offset: 0, limit: 10 },
        );
        assertEquals(responseErrorCode(stale), "stale_generation");

        const closeResult = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "view/close",
          ),
        );
        assertEquals(closeResult.closed, true);
        await nextMessage(
          browser,
          (message) =>
            message.type === "view/closed" &&
            asRecord(message.message).params !== undefined &&
            asRecord(asRecord(message.message).params).view === childView &&
            asRecord(asRecord(message.message).params).reason ===
              "parent_closed",
          "cascaded child close",
        );
        const missing = await request(
          browser,
          session,
          String(root.view),
          Number(root.generation),
          "object/children",
          { path: [], offset: 0, limit: 10 },
        );
        assertEquals(responseErrorCode(missing), "view_not_found");

        {
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
            "Tree E2E new page",
            async () => {
              const page = await chromiumBrowser.newPage("about:blank", {
                waitUntil: "none",
              });
              await page.setViewportSize({ width: 1200, height: 850 });
              return page;
            },
            20_000,
          );
          const pageErrors: string[] = [];
          collectPageErrors(page, pageErrors);
          await phase(
            "Tree E2E navigation and session connection",
            async () => {
              await page.goto(server.url, { waitUntil: "load" });
              await page.waitForSelector('#status[data-state="connected"]');
              await rEval(arf, treeFixtureCode());
              await openedView(browser, "Tree E2E fixture");
            },
            40_000,
          );
          await phase("Tree E2E browser inspection actions", async () => {
            await clickButton(page, "Open object");
            await page.waitForSelector(
              "#tree-viewer:not([hidden]) li[data-child-index]",
            );
            await Deno.writeFile(
              join(
                screenshotDir ??= await Deno.makeTempDir({
                  prefix: "jdv-tree-screenshot-",
                }),
                "tree-root.png",
              ),
              await page.screenshot(),
            );
            assertEquals(await count(page, "#tree-child-list img"), 0);
            assert(
              (await text(page, '#tree-child-list li[data-child-index="11"]'))
                ?.includes("<img src=x onerror=alert(1)>"),
              "HTML-like child label must remain visible as text.",
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="14"] [data-action="expand-child"]',
            );
            await waitFor(
              page,
              () =>
                document.querySelector(
                  '#tree-child-list li[data-child-index="1"]',
                )?.textContent?.includes("df") === true,
            );
            assert(
              (await text(page, "#tree-breadcrumb"))
                ?.includes("capture environment"),
              "The expanded environment should appear in the breadcrumb.",
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="1"] [data-action="open-child"]',
            );
            await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
            const capturedCells = await texts(page, "#viewer .tabulator-cell");
            assert(
              capturedCells.includes("17") && capturedCells.includes("18"),
              `Expected the opened child to show its captured values: ${capturedCells}`,
            );
            await rEval(
              arf,
              "jdv_tree_capture_env$df <- data.frame(value = c(99L, 100L), check.names = FALSE)",
            );
            const cellsAfterParentChange = await texts(
              page,
              "#viewer .tabulator-cell",
            );
            assert(
              cellsAfterParentChange.includes("17") &&
                cellsAfterParentChange.includes("18") &&
                !cellsAfterParentChange.includes("99") &&
                !cellsAfterParentChange.includes("100"),
              `The opened child changed after its parent binding changed: ${cellsAfterParentChange}`,
            );
            await click(page, "#tree-return");
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await waitFor(
              page,
              () =>
                document.querySelector(
                  '#tree-child-list li[data-child-index="1"]',
                )?.textContent?.includes("df") === true,
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="1"] [data-action="open-child"]',
            );
            await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
            const reopenedCells = await texts(page, "#viewer .tabulator-cell");
            assert(
              reopenedCells.includes("99") && reopenedCells.includes("100"),
              `A newly opened child should show the replacement binding: ${reopenedCells}`,
            );
            await click(page, "#tree-return");
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await click(page, '#tree-breadcrumb [data-tree-depth="0"]');
            await waitFor(
              page,
              () =>
                document.querySelector(
                  '#tree-child-list li[data-child-index="3"]',
                )?.textContent?.includes("unnamed") === true,
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="3"] [data-action="expand-child"]',
            );
            await waitFor(
              page,
              () =>
                document.querySelector("#tree-breadcrumb")?.textContent
                  ?.includes("unnamed") === true,
            );
            await click(page, '#tree-breadcrumb [data-tree-depth="0"]');
            await waitFor(
              page,
              () =>
                document.querySelectorAll(
                  '#tree-breadcrumb [data-tree-depth="1"]',
                ).length === 0,
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="5"] [data-action="open-child"]',
            );
            await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
            await Deno.writeFile(
              join(screenshotDir!, "tree-nested-grid.png"),
              await page.screenshot(),
            );
            await click(page, "#tree-return");
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await waitFor(
              page,
              () =>
                document.querySelectorAll(
                  '#tree-breadcrumb [data-tree-depth="1"]',
                ).length === 0,
            );
            assertEquals(pageErrors, []);
          }, 150_000);
        }
      }, 300_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        ...(closeChromium
          ? [() => phase("Tree E2E Chromium cleanup", closeChromium!, 50_000)]
          : []),
        () => runtime.browser.close(),
        () => phase("Tree E2E arf cleanup", () => runtime.arf.close(), 50_000),
        () =>
          phase(
            "Tree E2E server cleanup",
            () => runtime.server.close(),
            10_000,
          ),
        ...(screenshotDir ? [() => removeCacheDirectory(screenshotDir!)] : []),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

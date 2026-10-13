import { assert, assertEquals } from "./assert.ts";
import { decodeRows, querySnapshot } from "../web/jdv_query.js";
import {
  columnWindow,
  createBrowserTransport,
  fillRemotePage,
} from "../web/client.js";

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  take(): Record<string, unknown> {
    const value = this.sent.shift();
    if (!value) throw new Error("Expected an outgoing WebSocket message.");
    return JSON.parse(value);
  }
}

type QueryColumn = {
  schema: Record<string, unknown>;
  data: Record<string, unknown>;
};

type QueryPage = {
  total: number;
  offset: number;
  data: {
    row_index: number[];
    row_names?: string[];
    columns: QueryColumn[];
  };
};

Deno.test("page chunks fill by actual returned rows without gaps or duplicates", async () => {
  const descriptor = snapshot(249);
  const offsets: number[] = [];
  const rows: number[] = [];
  const firstPageCaps = [37, 12];

  for (const [offset, limit] of [[0, 200], [200, 200]]) {
    const page = await fillRemotePage({
      offset,
      limit,
      fetchPage: ({ offset: nextOffset, limit: nextLimit }: {
        offset: number;
        limit: number;
      }) => {
        offsets.push(nextOffset);
        const source = querySnapshot(descriptor, {
          offset: nextOffset,
          limit: nextLimit,
        }) as QueryPage;
        const cap = nextOffset === 0
          ? firstPageCaps.shift() ?? 200
          : nextOffset === 37
          ? firstPageCaps.shift() ?? 200
          : 200;
        const count = Math.min(cap, source.data.row_index.length);
        return Promise.resolve({
          result: {
            ...source,
            data: {
              ...source.data,
              row_index: source.data.row_index.slice(0, count),
              columns: source.data.columns.map((column) => ({
                ...column,
                data: Object.fromEntries(
                  Object.entries(column.data).map(([key, value]) => [
                    key,
                    Array.isArray(value) &&
                      value.length === source.data.row_index.length
                      ? value.slice(0, count)
                      : value,
                  ]),
                ),
              })),
            },
          },
          warnings: [],
        });
      },
      decode: (result: QueryPage) =>
        decodeRows(
          result.data.columns.map((column) => column.schema),
          result.data.columns.map((column) => column.data),
          result.data.row_index,
          result.data.row_names,
        ),
    });
    rows.push(
      ...page.rows.map((row: { row_index?: number }) =>
        row.row_index as number
      ),
    );
  }

  assertEquals(offsets, [0, 37, 49, 200]);
  assertEquals(rows, Array.from({ length: 249 }, (_, index) => index + 1));
});

Deno.test("Snapshot query applies sort and filter before paging", () => {
  const descriptor = snapshot(8);
  const page = querySnapshot(descriptor, {
    sort: [{ col: 1, desc: true }],
    filter: { op: "gt", col: 0, value: 2 },
    offset: 1,
    limit: 2,
  });

  assertEquals(page.total, 6);
  assertEquals(page.data.row_index, [4, 5]);
});

Deno.test("browser transport ignores stale responses after table replacement", async () => {
  const socket = new FakeSocket();
  const transport = createBrowserTransport(socket);
  const oldRequest = transport.request("r-1-1", "table/page", {
    table: "t1",
    generation: 1,
    offset: 0,
    limit: 200,
  });
  const oldFrame = socket.take();

  transport.cancelTable("r-1-1", "t1", 1);
  await assertRejectsAbort(oldRequest);
  const cancellation = socket.take();
  assertEquals(cancellation.type, "cancel");
  assertEquals(cancellation.id, oldFrame.id);

  transport.handleMessage({
    type: "response",
    id: oldFrame.id,
    session: "r-1-1",
    result: { data: { row_index: [1] } },
  });

  const currentRequest = transport.request("r-1-1", "table/page", {
    table: "t1",
    generation: 2,
    offset: 0,
    limit: 200,
  });
  const currentFrame = socket.take();
  const currentResponse = {
    type: "response",
    id: currentFrame.id,
    session: "r-1-1",
    result: { data: { row_index: [7] } },
  };
  transport.handleMessage(currentResponse);
  assertEquals(await currentRequest, currentResponse);
});

Deno.test("transport settles pending requests on clear and disconnect", async () => {
  const socket = new FakeSocket();
  let disconnects = 0;
  const transport = createBrowserTransport(socket, {
    onDisconnect() {
      disconnects++;
    },
  });
  const cleared = transport.request("r-1-1", "table/page", {
    table: "t1",
    generation: 1,
  });
  const clearedFrame = socket.take();
  transport.cancelAll("The query was cleared.");
  await assertRejectsAbort(cleared);
  assertEquals(socket.take(), {
    type: "cancel",
    id: clearedFrame.id,
    session: "r-1-1",
  });

  const sessionRequest = transport.request("r-2-1", "table/page", {
    table: "t2",
    generation: 1,
  });
  const sessionFrame = socket.take();
  transport.cancelSession("r-2-1");
  await assertRejectsAbort(sessionRequest);
  assertEquals(socket.take(), {
    type: "cancel",
    id: sessionFrame.id,
    session: "r-2-1",
  });

  const disconnected = transport.request("r-1-1", "table/page", {
    table: "t1",
    generation: 1,
  });
  socket.take();
  transport.close();
  await assertRejectsAbort(disconnected);
  assertEquals(disconnects, 1);
});

Deno.test("transport settles server cancellation and ignores a late reply", async () => {
  const socket = new FakeSocket();
  const transport = createBrowserTransport(socket);
  const request = transport.request("r-1-1", "table/page", {
    table: "t1",
    generation: 1,
  });
  const frame = socket.take();
  transport.handleMessage({
    type: "cancelled",
    id: frame.id,
    session: "r-1-1",
  });
  await assertRejectsAbort(request);
  transport.handleMessage({
    type: "response",
    id: frame.id,
    session: "r-1-1",
    result: { data: { row_index: [1] } },
  });
  assertEquals(socket.sent, []);
});

Deno.test("page fill stops when its epoch changes during a response", async () => {
  let current = true;
  let release!: (value: unknown) => void;
  const pending = fillRemotePage({
    offset: 0,
    limit: 2,
    fetchPage: () => new Promise((resolve) => release = resolve),
    decode: () => [{ row_index: 1 }],
    isCurrent: () => current,
  });
  current = false;
  release({
    result: {
      offset: 0,
      total: 2,
      data: { row_index: [1], columns: [] },
    },
  });
  await assertRejectsAbort(pending);
});

Deno.test("page fill rejects an empty response before the requested total", async () => {
  let rejected = false;
  try {
    await fillRemotePage({
      offset: 0,
      limit: 2,
      fetchPage: () =>
        Promise.resolve({
          result: { offset: 0, total: 2, data: { row_index: [], columns: [] } },
        }),
      decode: () => [],
    });
  } catch (error) {
    rejected = error instanceof Error &&
      error.message.includes("empty page before");
  }
  assert(rejected, "An empty response should not silently truncate a page.");
});

Deno.test("column windows reach the last columns and preserve the requested position", () => {
  const viewport = 540;
  const options = { columnWidth: 180, overscan: 2, leadingWidth: 86 };
  const left = columnWindow(300, 0, viewport, options);
  const middle = columnWindow(300, 86 + 290 * 180, viewport, options);
  const right = columnWindow(300, 86 + 299 * 180, viewport, options);

  assertEquals(left.start, 0);
  assertEquals(left.offsetPx, 0);
  assertEquals(left.totalWidth, 54_086);
  assert(left.columns.includes(0));
  assert(middle.columns.includes(290));
  assert(right.columns.includes(299));
  assertEquals(right.end, 300);
  assertEquals(right.offsetPx, right.start * 180);
  assertEquals(right.offsetPx + 86, 86 + right.start * 180);
  assertEquals(right.totalWidth, 86 + 300 * 180);
  for (let position = 0; position < 300; position++) {
    const window = columnWindow(300, 86 + position * 180, viewport, options);
    assert(
      window.columns.includes(position),
      `Column ${position} was unreachable.`,
    );
    assertEquals(window.offsetPx + 86, 86 + window.start * 180);
  }
});

Deno.test("decoded cell and row labels remain plain text", () => {
  const decoded = decodeRows(
    { position: 0, type: "string" },
    { display: ["<img src=x onerror=alert(1)>"] },
    [42],
    ["<script>bad()</script>"],
  );
  assertEquals(decoded, [{
    row_index: 42,
    row_name: "<script>bad()</script>",
    c0: "<img src=x onerror=alert(1)>",
  }]);
  assert(typeof decoded[0].c0 === "string");
});

function snapshot(nrow: number) {
  const values = Array.from({ length: nrow }, (_, index) => index + 1);
  return {
    params: {
      nrow,
      ncol: 2,
      columns: [
        {
          position: 0,
          name: "value",
          type: "integer",
          sortable: true,
          filterable: true,
        },
        {
          position: 1,
          name: "reverse",
          type: "integer",
          sortable: true,
          filterable: true,
        },
      ],
      data: {
        row_index: values,
        row_names: values.map((value) => `row-${value}`),
        columns: [
          {
            values,
            sortKey: values,
            na: values.map(() => false),
          },
          {
            values: values.map((value) => nrow + 1 - value),
            sortKey: values.map((value) => nrow + 1 - value),
            na: values.map(() => false),
          },
        ],
      },
    },
  };
}

async function assertRejectsAbort(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.name, "AbortError");
    return;
  }
  throw new Error("Expected the request to reject with AbortError.");
}

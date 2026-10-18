import { assert, assertEquals } from "./assert.ts";
// Tests use the same pinned version as the browser vendor bundle.
const arrowModule = "npm:apache-arrow@21.2.0";
const Arrow = await import(arrowModule);
import {
  CELL_TEXT_LIMIT,
  createSequentialCache,
  decodeArrowPage,
  formatArrowValue,
  formatScaled,
  formatTimestamp,
  formatUnavailableRowRanges,
  mergeSequentialCacheInfo,
  recordSequentialProgress,
  sequentialPageRows,
  trimSequentialCaches,
} from "../web/sequential.js";

function words(values: bigint[], width: number): Uint32Array {
  return Uint32Array.from(values.flatMap((value) => {
    const unsigned = BigInt.asUintN(width, value);
    return Array.from(
      { length: width / 32 },
      (_, i) => Number((unsigned >> BigInt(i * 32)) & 0xffffffffn),
    );
  }));
}

Deno.test("decimal physical words preserve signs, scales, slices, chunks, and nulls", () => {
  for (const width of [128, 256]) {
    const values = [0n, -123456789012345678901234567890n, 7n, 9n];
    const data = Arrow.makeData({
      type: new Arrow.Decimal(10, width === 128 ? 38 : 76, width),
      data: words(values, width),
      length: 4,
      nullBitmap: new Uint8Array([0b1011]),
      nullCount: 1,
    });
    const vector = Arrow.makeVector(data);
    assertEquals(
      formatArrowValue(vector, 1),
      "-12345678901234567890.1234567890",
    );
    assertEquals(formatArrowValue(vector, 2), "NA");
    const slice = vector.slice(1, 4);
    assertEquals([0, 1, 2].map((i) => formatArrowValue(slice, i)), [
      "-12345678901234567890.1234567890",
      "NA",
      "0.0000000009",
    ]);
    const chunks = vector.slice(0, 1).concat(slice);
    assertEquals(
      formatArrowValue(chunks, 1),
      "-12345678901234567890.1234567890",
    );
  }
  assertEquals(formatScaled(-12n, -3), "-12000");
  assertEquals(formatScaled(1n, 3), "0.001");
  assertEquals(formatScaled(0n, 0), "0");
});

Deno.test("timestamps use exact raw ticks including negative fractions and time zones", () => {
  const vector = Arrow.makeVector(Arrow.makeData({
    type: new Arrow.TimestampNanosecond("Asia/Kolkata"),
    data: new BigInt64Array([0n, -1n, 1735689600123456789n]),
    length: 3,
  }));
  assertEquals(
    formatArrowValue(vector, 1),
    "1970-01-01T05:29:59.999999999+05:30 [Asia/Kolkata]",
  );
  assertEquals(
    formatArrowValue(vector.slice(1), 1),
    "2025-01-01T05:30:00.123456789+05:30 [Asia/Kolkata]",
  );
  assertEquals(
    formatTimestamp(-1n, 3, "UTC"),
    "1969-12-31T23:59:59.999999999Z",
  );
  assertEquals(formatTimestamp(-1n, 2), "1969-12-31T23:59:59.999999");
  assertEquals(formatTimestamp(1n, 0, "UTC"), "1970-01-01T00:00:01Z");
  assertEquals(
    formatTimestamp(9223372036854775807n, 0, "UTC"),
    "9223372036854775807 s [UTC]",
  );
});

Deno.test("IPC mapping preserves duplicate names, int64/uint64, binary, nested summaries, and unsupported columns", () => {
  const table = new Arrow.Table({
    signed: Arrow.vectorFromArray(
      [-9223372036854775807n, null],
      new Arrow.Int64(),
    ),
    unsigned: Arrow.vectorFromArray(
      [18446744073709551615n, 0n],
      new Arrow.Uint64(),
    ),
    binary: Arrow.vectorFromArray(
      [new Uint8Array([0, 10, 255]), null],
      new Arrow.Binary(),
    ),
    nested: Arrow.vectorFromArray(
      [[1, 2], []],
      new Arrow.List(new Arrow.Field("item", new Arrow.Int32(), true)),
    ),
  });
  const descriptor = {
    columns: [
      { name: "duplicate", index: 0, ipc_index: 1 },
      { name: "duplicate", index: 1, ipc_index: 0 },
      { name: "binary", index: 2, ipc_index: 2 },
      { name: "nested", index: 3, ipc_index: 3 },
      {
        name: "union",
        index: 4,
        ipc_index: null,
        unsupported: "union is unsupported",
      },
    ],
  };
  const decoded = decodeArrowPage(
    Arrow.tableToIPC(table, "stream"),
    descriptor,
    { first_row: 5, rows_fetched: 2 },
    Arrow,
  );
  assertEquals(decoded.rows, [
    {
      source_row: 5,
      c0: "18446744073709551615",
      c1: "-9223372036854775807",
      c2: "000aff",
      c3: "<list: 2 items>",
      c4: "Unsupported: union is unsupported",
    },
    {
      source_row: 6,
      c0: "0",
      c1: "NA",
      c2: "NA",
      c3: "<list: 0 items>",
      c4: "Unsupported: union is unsupported",
    },
  ]);
});

Deno.test("display cache is bounded and progress survives eviction and selection changes", () => {
  const cache = createSequentialCache(220, 2);
  cache.append([{ source_row: 0, c0: "first" }, {
    source_row: 1,
    c0: "second",
  }]);
  assert(cache.bytes <= 220);
  cache.append([{ source_row: 2, c0: "third" }]);
  assert(cache.bytes <= 220);
  assert(cache.evictedThrough >= 0);
  const progress = { watermark: 0, received: 0, done: false, gap: null };
  assertEquals(
    recordSequentialProgress(progress, {
      first_row: 0,
      rows_fetched: 3,
      rows_seen: 3,
      done: false,
    }),
    null,
  );
  cache.clear();
  // Reselecting the same generation keeps progress although its row cache is gone.
  assertEquals(
    recordSequentialProgress(progress, {
      first_row: 3,
      rows_fetched: 0,
      rows_seen: 3,
      done: false,
    }),
    null,
  );
  assertEquals(progress.watermark, 3);
  assertEquals(
    recordSequentialProgress(progress, {
      first_row: 6,
      rows_fetched: 0,
      rows_seen: 6,
      done: false,
    }),
    [4, 6],
  );
  assertEquals(progress.watermark, 3);
  assertEquals(
    recordSequentialProgress(progress, {
      first_row: 6,
      rows_fetched: 0,
      rows_seen: 6,
      done: true,
    }),
    [4, 6],
  );
  assertEquals(progress.received, 3);
  const newBrowser = { watermark: 0, received: 0, done: false, gap: null };
  assertEquals(
    recordSequentialProgress(newBrowser, {
      first_row: 6,
      rows_fetched: 2,
      rows_seen: 8,
      done: false,
    }),
    [1, 6],
  );
});

Deno.test("evicting source row zero records a real eviction", () => {
  const cache = createSequentialCache(100, 1);
  cache.setPage(0, [{ source_row: 0, c0: "x".repeat(100) }]);
  assertEquals(cache.evictedThrough, 0);
});

Deno.test("display cache inserts host pages in order and replaces a cached page", () => {
  const cache = createSequentialCache(4096, 3);
  cache.setPage(4, [{ source_row: 4, c0: "five" }]);
  cache.setPage(2, [{ source_row: 2, c0: "three" }]);
  cache.setPage(3, [{ source_row: 3, c0: "four" }]);
  assertEquals(cache.pageIds(), [2, 3, 4]);
  assertEquals(cache.rows().map((row) => row.source_row), [2, 3, 4]);
  cache.setPage(3, [{ source_row: 3, c0: "replaced" }]);
  assertEquals(cache.rows().map((row) => row.c0), [
    "three",
    "replaced",
    "five",
  ]);
  cache.setPage(5, [{ source_row: 5, c0: "six" }]);
  assertEquals(cache.pageIds(), [3, 4, 5]);
  assertEquals(cache.evictOldestPage(), true);
  assertEquals(cache.pageIds(), [4, 5]);
});

Deno.test("aggregate display budget trims caches even when host caching is disabled", () => {
  const records = [1, 2, 3].map((cacheUse) => ({
    cacheEnabled: false,
    cache: createSequentialCache(4096),
    cacheUse,
  }));
  for (const record of records) {
    record.cache.setPage(0, [{ source_row: 0, c0: "x".repeat(100) }]);
  }
  const bytes = trimSequentialCaches(records, 500);
  assert(bytes <= 500);
  assertEquals(records[0].cache.pageIds(), []);
  assertEquals(records[1].cache.pageIds(), []);
  assertEquals(records[2].cache.pageIds(), [0]);
});

Deno.test("host eviction ranges use zero-based half-open coordinates", () => {
  assertEquals(formatUnavailableRowRanges([[0, 10], [4, 10], [20, 30]]), [
    "Rows 1–10 are no longer retained by the host.",
    "Rows 21–30 are not retained by the host.",
  ]);
  assertEquals(formatUnavailableRowRanges([[5, 5], [30, 20]]), []);
});

Deno.test("late cache info cannot move the unavailable prefix backwards", () => {
  const merged = mergeSequentialCacheInfo({
    last_page: 8,
    rows_seen: 1600,
    done: false,
    unavailable_before: 400,
  }, {
    last_page: 7,
    rows_seen: 1400,
    done: false,
    unavailable_before: 200,
  });
  assertEquals(merged, {
    last_page: 8,
    rows_seen: 1600,
    done: false,
    unavailable_before: 400,
  });
});

Deno.test("dictionary decimals and timestamps recurse through physical values with slices and nulls", () => {
  const decimal = Arrow.makeVector(Arrow.makeData({
    type: new Arrow.Decimal(10, 38, 128),
    data: words([-123456789012345678901234567890n, 7n], 128),
    length: 2,
  }));
  const timestamp = Arrow.makeVector(Arrow.makeData({
    type: new Arrow.TimestampNanosecond("Asia/Kolkata"),
    data: new BigInt64Array([-1n, 1n]),
    length: 2,
  }));
  for (const [id, dictionary] of [decimal, timestamp].entries()) {
    const data = Arrow.makeData({
      type: new Arrow.Dictionary(dictionary.type, new Arrow.Int8(), id),
      data: new Int8Array([1, 0, 1]),
      length: 3,
      dictionary,
      nullBitmap: new Uint8Array([0b011]),
      nullCount: 1,
    });
    const vector = Arrow.makeVector(data).slice(1);
    assertEquals(
      formatArrowValue(vector, 0),
      id === 0
        ? "-12345678901234567890.1234567890"
        : "1970-01-01T05:29:59.999999999+05:30 [Asia/Kolkata]",
    );
    assertEquals(formatArrowValue(vector, 1), "NA");
  }
});

Deno.test("sequential page requests honor captured caps and legacy descriptors", () => {
  assertEquals(sequentialPageRows({ max_page_rows: 1 }), 1);
  assertEquals(sequentialPageRows({ max_page_rows: 2000 }), 200);
  assertEquals(sequentialPageRows({ max_page_rows: 2000 }, 2000), 2000);
  assertEquals(sequentialPageRows({}), 200);
});

Deno.test("decimal display bounds expansion before allocating fixed-point text", () => {
  for (const scale of [-2147483648, 2147483647]) {
    for (const coefficient of [123n, -123n, 0n]) {
      const text = formatScaled(coefficient, scale);
      assertEquals(text, `${coefficient}e${-scale}`);
      assert(text.length < 32);
    }
    for (const width of [128, 256]) {
      const vector = Arrow.makeVector(Arrow.makeData({
        type: new Arrow.Decimal(scale, width === 128 ? 38 : 76, width),
        data: words([123n, -123n, 0n], width),
        length: 3,
      }));
      assertEquals([0, 1, 2].map((row) => formatArrowValue(vector, row)), [
        `123e${-scale}`,
        `-123e${-scale}`,
        `0e${-scale}`,
      ]);
    }
  }
  assertEquals(
    formatScaled(1n, -(CELL_TEXT_LIMIT - 1)).length,
    CELL_TEXT_LIMIT,
  );
  assertEquals(formatScaled(1n, -CELL_TEXT_LIMIT), `1e${CELL_TEXT_LIMIT}`);
  assertEquals(formatScaled(1n, CELL_TEXT_LIMIT - 2).length, CELL_TEXT_LIMIT);
  assertEquals(
    formatScaled(1n, CELL_TEXT_LIMIT - 1),
    `1e-${CELL_TEXT_LIMIT - 1}`,
  );
  assertEquals(formatScaled(-1n, CELL_TEXT_LIMIT - 3).length, CELL_TEXT_LIMIT);
  assertEquals(
    formatScaled(-1n, CELL_TEXT_LIMIT - 2),
    `-1e-${CELL_TEXT_LIMIT - 2}`,
  );
  assertEquals(formatScaled(-12n, -3), "-12000");
  assertEquals(formatScaled(123n, 2), "1.23");
  assertEquals(formatScaled(0n, 3), "0.000");
  for (
    const scale of [
      NaN,
      Infinity,
      -Infinity,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      "3",
    ]
  ) {
    let failure: unknown;
    try {
      formatScaled(1n, scale);
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error && failure.message.includes("decimal scale"),
    );
  }
});

Deno.test("list slices use already-sliced value offsets without adding data.offset", () => {
  for (const ListType of [Arrow.List, Arrow.LargeList]) {
    const vector = Arrow.vectorFromArray(
      [[1, 2], [3], []],
      new ListType(new Arrow.Field("item", new Arrow.Int32(), true)),
    ).slice(1);
    assertEquals(vector.data[0].offset, 1);
    assertEquals(Number(vector.data[0].valueOffsets[0]), 2);
    assertEquals(formatArrowValue(vector, 0), "<list: 1 items>");
    assertEquals(formatArrowValue(vector, 1), "<list: 0 items>");
  }
});

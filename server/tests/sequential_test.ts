import { assert, assertEquals } from "./assert.ts";
// Tests use the same pinned version as the browser vendor bundle.
const arrowModule = "npm:apache-arrow@21.2.0";
const Arrow = await import(arrowModule);
import {
  createSequentialCache,
  decodeArrowPage,
  formatArrowValue,
  formatScaled,
  formatTimestamp,
  recordSequentialProgress,
  sequentialPageRows,
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
      row_index: 6,
      c0: "18446744073709551615",
      c1: "-9223372036854775807",
      c2: "000aff",
      c3: "<list: 2 items>",
      c4: "Unsupported: union is unsupported",
    },
    {
      row_index: 7,
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
  cache.append([{ row_index: 1, c0: "first" }, { row_index: 2, c0: "second" }]);
  assert(cache.bytes <= 220);
  cache.append([{ row_index: 3, c0: "third" }]);
  assert(cache.bytes <= 220);
  assert(cache.evictedThrough >= 1);
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

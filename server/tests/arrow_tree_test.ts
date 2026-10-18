import { assert, assertEquals } from "./assert.ts";
import {
  arrowTreeChildren,
  arrowTreeNode,
  createArrowCellRoot,
  createArrowTreePage,
  openArrowChild,
} from "../web/arrow_tree.js";
import { formatArrowValue } from "../web/sequential.js";
const arrowModule = "npm:apache-arrow@21.2.0";
const Arrow = await import(arrowModule);
type Vector = ReturnType<typeof Arrow.makeVector>;

function fromVector(vector: Vector, physical = false, exactOnly = false) {
  const table = new Arrow.Table({ x: vector });
  const arrow = {
    ...Arrow,
    tableFromIPC: physical
      ? () => ({ numRows: vector.length, numCols: 1, getChildAt: () => vector })
      : Arrow.tableFromIPC,
    makeVector(data: Parameters<typeof Arrow.makeVector>[0]) {
      const result = Arrow.makeVector(data);
      if (exactOnly) {
        result.get = () => {
          throw new Error("Lossy getter used");
        };
      }
      return result;
    },
  };
  const page = createArrowTreePage(
    physical ? new Uint8Array() : Arrow.tableToIPC(table, "stream"),
    { columns: [{ position: 4, name: "x", ipc_index: 0 }] },
    { first_row: 10, rows_fetched: vector.length },
    arrow,
  );
  return (row = 0) => createArrowCellRoot(page, row + 10, 4);
}
function failure(action: () => unknown) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error);
  return error;
}
function words(value: bigint, width: number) {
  const unsigned = BigInt.asUintN(width, value);
  return Uint32Array.from(
    { length: width / 32 },
    (_, i) => Number((unsigned >> BigInt(i * 32)) & 0xffffffffn),
  );
}

Deno.test("Arrow tree IPC lists and large lists page children with original row mapping", () => {
  for (const List of [Arrow.List, Arrow.LargeList]) {
    const vector = Arrow.vectorFromArray(
      [[1n, 9007199254740993n], null, [], [-1n]],
      new List(new Arrow.Field("item", new Arrow.Int64(), true)),
    );
    const root = fromVector(vector)(0);
    assertEquals(arrowTreeNode(root).total_children, 2);
    const first = arrowTreeChildren(root, [], 0, 1);
    assertEquals(first.children.map((c) => [c.label, c.summary, c.path]), [[
      "[1]",
      "1",
      [0],
    ]]);
    assertEquals(
      arrowTreeChildren(root, [], 1).children[0].summary,
      "9007199254740993",
    );
    assertEquals(openArrowChild(root, [], 1), [1]);
    assertEquals(arrowTreeNode(root, [1]).summary, "9007199254740993");
    assertEquals(arrowTreeNode(fromVector(vector)(1)).summary, "NA");
    assertEquals(arrowTreeChildren(fromVector(vector)(1)).children, []);
    assertEquals(arrowTreeChildren(fromVector(vector)(2)).total_children, 0);
  }
});

Deno.test("Arrow tree physical slices and chunks preserve list fixed-list and struct children", () => {
  for (const List of [Arrow.List, Arrow.LargeList]) {
    const vector = Arrow.vectorFromArray(
      [[1, 2], [3], [4, 5]],
      new List(new Arrow.Field("i", new Arrow.Int32(), true)),
    );
    const sliced = vector.slice(1);
    assert(sliced.data[0].offset > 0);
    const chunked = sliced.slice(0, 1).concat(sliced.slice(1));
    const root = fromVector(chunked, true);
    assertEquals(arrowTreeChildren(root(0)).children.map((c) => c.summary), [
      "3",
    ]);
    assertEquals(arrowTreeChildren(root(1)).children.map((c) => c.summary), [
      "4",
      "5",
    ]);
  }
  const fixed = Arrow.vectorFromArray(
    [[1n, 2n], [3n, 4n]],
    new Arrow.FixedSizeList(2, new Arrow.Field("i", new Arrow.Int64(), true)),
  ).slice(1);
  assertEquals(
    arrowTreeChildren(fromVector(fixed, true)()).children.map((c) => c.summary),
    ["3", "4"],
  );
  const type = new Arrow.Struct([
    new Arrow.Field("a", new Arrow.Int64(), true),
    new Arrow.Field("b", new Arrow.Utf8(), true),
  ]);
  const struct = Arrow.vectorFromArray([{ a: 1n, b: "first" }, {
    a: 9007199254740993n,
    b: "second",
  }, null], type).slice(1);
  assertEquals(
    arrowTreeChildren(fromVector(struct, true)()).children.map((c) =>
      c.summary
    ),
    ["9007199254740993", "second"],
  );
  assertEquals(arrowTreeChildren(fromVector(struct, true)(1)).children, []);
});

Deno.test("Arrow tree map entry paths expose key and value without Map getter conversion", () => {
  const type = new Arrow.Map_(
    new Arrow.Field(
      "entries",
      new Arrow.Struct([
        new Arrow.Field("key", new Arrow.Utf8(), false),
        new Arrow.Field(
          "value",
          new Arrow.List(new Arrow.Field("i", new Arrow.Uint64(), true)),
          true,
        ),
      ]),
      false,
    ),
    false,
  );
  const vector = Arrow.vectorFromArray([
    new Map([["old", [1n]]]),
    new Map([["red", [18446744073709551615n]], ["blue", []]]),
  ], type).slice(1);
  const root = fromVector(vector, true)();
  assertEquals(arrowTreeChildren(root).children.map((c) => c.label), [
    "Entry 1",
    "Entry 2",
  ]);
  assertEquals(arrowTreeChildren(root, [0]).children.map((c) => c.label), [
    "key",
    "value",
  ]);
  assertEquals(arrowTreeNode(root, [0, 0]).summary, "red");
  assertEquals(arrowTreeNode(root, [0, 1, 0]).summary, "18446744073709551615");
});

Deno.test("Arrow tree exact scalar and dictionary leaves never call numeric getters", () => {
  const exact = [
    [
      Arrow.vectorFromArray([-9223372036854775807n], new Arrow.Int64()),
      "-9223372036854775807",
    ],
    [
      Arrow.vectorFromArray([18446744073709551615n], new Arrow.Uint64()),
      "18446744073709551615",
    ],
    [
      Arrow.makeVector(
        Arrow.makeData({
          type: new Arrow.Decimal(10, 38, 128),
          length: 1,
          data: words(-123456789012345678901234567890n, 128),
        }),
      ),
      "-12345678901234567890.1234567890",
    ],
    [
      Arrow.makeVector(
        Arrow.makeData({
          type: new Arrow.Decimal(-3, 76, 256),
          length: 1,
          data: words(
            -999999999999999999999999999999999999999999999999999999n,
            256,
          ),
        }),
      ),
      "-999999999999999999999999999999999999999999999999999999000",
    ],
    [
      Arrow.makeVector(
        Arrow.makeData({
          type: new Arrow.TimestampNanosecond("Asia/Kolkata"),
          length: 1,
          data: new BigInt64Array([-1n]),
        }),
      ),
      "1970-01-01T05:29:59.999999999+05:30 [Asia/Kolkata]",
    ],
  ];
  for (const [vector, expected] of exact) {
    vector.get = () => {
      throw new Error("Lossy getter used");
    };
    assertEquals(formatArrowValue(vector, 0), expected);
    assertEquals(
      arrowTreeNode(fromVector(vector, true, true)()).summary,
      expected,
    );
    const dictionary = Arrow.makeVector(Arrow.makeData({
      type: new Arrow.Dictionary(vector.type, new Arrow.Int8(), 1),
      dictionary: vector,
      data: new Int8Array([0, 0, 0]),
      length: 3,
      nullBitmap: new Uint8Array([0b011]),
      nullCount: 1,
    })).slice(1);
    const root = fromVector(dictionary, true, true);
    assertEquals(arrowTreeNode(root()).summary, expected);
    assertEquals(arrowTreeNode(root(1)).summary, "NA");
  }
});

Deno.test("Arrow tree inner dictionary lists and duplicate struct fields use index paths", () => {
  const values = Arrow.vectorFromArray(
    [[7n, 9007199254740993n]],
    new Arrow.List(new Arrow.Field("i", new Arrow.Int64(), true)),
  );
  const dictionary = Arrow.makeData({
    type: new Arrow.Dictionary(values.type, new Arrow.Int8(), 2),
    dictionary: values,
    data: new Int8Array([0]),
    length: 1,
  });
  const type = new Arrow.Struct([
    new Arrow.Field("same", dictionary.type, true),
    new Arrow.Field("same", new Arrow.Int64(), true),
  ]);
  const data = Arrow.makeData({
    type,
    length: 1,
    children: [
      dictionary,
      Arrow.vectorFromArray([99n], new Arrow.Int64()).data[0],
    ],
  });
  const root = fromVector(Arrow.makeVector(data), true)();
  assertEquals(arrowTreeChildren(root).children.map((c) => [c.label, c.path]), [
    ["same", [0]],
    ["same", [1]],
  ]);
  assertEquals(arrowTreeNode(root, [0, 1]).summary, "9007199254740993");
  assertEquals(arrowTreeNode(root, [1]).summary, "99");
});

Deno.test("Arrow tree bounds huge child pages depth text and cyclic dictionaries", () => {
  const child = Arrow.makeData({ type: new Arrow.Null(), length: 1000000000 });
  const list = Arrow.makeVector(
    Arrow.makeData({
      type: new Arrow.List(new Arrow.Field("i", new Arrow.Null(), true)),
      length: 1,
      valueOffsets: new Int32Array([0, 1000000000]),
      child,
    }),
  );
  const root = fromVector(list, true)();
  assertEquals(arrowTreeChildren(root, [], 999999999, 200).children.length, 1);
  assertEquals(arrowTreeChildren(root).children.length, 200);
  assert(
    failure(() => arrowTreeChildren(root, [], 0, 201)).message.includes(
      "page size",
    ),
  );
  assert(
    failure(() => arrowTreeNode(root, [-1])).message.includes("child index"),
  );
  assert(
    failure(() => openArrowChild(root, [], 1000000000)).message.includes(
      "outside",
    ),
  );
  let nested = Arrow.makeData({
    type: new Arrow.Int32(),
    data: new Int32Array([7]),
    length: 1,
  });
  for (let i = 0; i < 40; i++) {
    nested = Arrow.makeData({
      type: new Arrow.List(new Arrow.Field("i", nested.type, true)),
      length: 1,
      valueOffsets: new Int32Array([0, 1]),
      child: nested,
    });
  }
  const deep = fromVector(Arrow.makeVector(nested), true)();
  const node = arrowTreeNode(deep, Array(32).fill(0));
  assertEquals(node.has_children, false);
  assert(node.summary.includes("depth limit"));
  assert(
    failure(() => arrowTreeNode(deep, Array(33).fill(0))).message.includes(
      "depth",
    ),
  );
  const text = fromVector(Arrow.vectorFromArray(["x".repeat(9000)]), true)();
  assertEquals(arrowTreeNode(text).summary.length, 4096);
  assert(arrowTreeNode(text).summary.endsWith("… [truncated]"));
  const dictionary = Arrow.makeVector(
    Arrow.makeData({
      type: new Arrow.Dictionary(new Arrow.Int32(), new Arrow.Int8(), 3),
      data: new Int8Array([0]),
      length: 1,
      dictionary: Arrow.vectorFromArray([1], new Arrow.Int32()),
    }),
  );
  dictionary.data[0].dictionary = dictionary;
  const cyclic = fromVector(dictionary, true)();
  assert(arrowTreeNode(cyclic).summary.includes("cyclic"));
  assertEquals(arrowTreeChildren(cyclic).children, []);
});

Deno.test("Arrow tree validates numeric selectors and exposes unsupported mappings locally", () => {
  const table = new Arrow.Table({ x: Arrow.vectorFromArray([1, 2]) });
  const page = createArrowTreePage(
    Arrow.tableToIPC(table),
    {
      columns: [
        {
          index: 0,
          name: "not supported",
          ipc_index: null,
          unsupported: "union",
        },
        { index: 1, name: "real", ipc_index: 0 },
        { index: 2, name: "bad mapping", ipc_index: 4 },
      ],
    },
    { first_row: 5, rows_fetched: 2 },
    Arrow,
  );
  assertEquals(
    arrowTreeNode(createArrowCellRoot(page, 5, 0)).summary,
    "Unsupported: union",
  );
  assertEquals(arrowTreeNode(createArrowCellRoot(page, 6, 1)).summary, "2");
  const zeroPage = createArrowTreePage(
    Arrow.tableToIPC(table),
    { columns: [{ index: 0, name: "real", ipc_index: 0 }] },
    { first_row: 0, rows_fetched: 2 },
    Arrow,
  );
  assertEquals(arrowTreeNode(createArrowCellRoot(zeroPage, 0, 0)).summary, "1");
  for (
    const [row, col] of [[4, 1], [7, 1], [5, -1], [5, 1.5], [5, 99], [5, 2]]
  ) {
    assert(
      failure(() => createArrowCellRoot(page, row, col)).message.length > 0,
    );
  }
  assert(
    failure(() =>
      createArrowTreePage(Arrow.tableToIPC(table), { columns: [] }, {
        first_row: 0,
        rows_fetched: 3,
      }, Arrow)
    ).message.includes("row count"),
  );
  const union = Arrow.makeData({
    type: new Arrow.DenseUnion([1], [
      new Arrow.Field("x", new Arrow.Int32(), true),
    ]),
    length: 1,
    typeIds: new Int8Array([1]),
    valueOffsets: new Int32Array([0]),
    children: [Arrow.vectorFromArray([1], new Arrow.Int32()).data[0]],
  });
  const unsupported = fromVector(Arrow.makeVector(union), true)();
  assert(arrowTreeNode(unsupported).summary.includes("Unsupported"));
});

Deno.test("Arrow tree map dictionary decimal values retain precise leaves after slices", () => {
  const decimal = Arrow.makeVector(Arrow.makeData({
    type: new Arrow.Decimal(2, 38, 128),
    length: 1,
    data: words(-900719925474099301n, 128),
  }));
  const dictionary = Arrow.makeData({
    type: new Arrow.Dictionary(decimal.type, new Arrow.Int8(), 7),
    dictionary: decimal,
    data: new Int8Array([0, 0]),
    length: 2,
  });
  const entryType = new Arrow.Struct([
    new Arrow.Field("key", new Arrow.Utf8(), false),
    new Arrow.Field("value", dictionary.type, true),
  ]);
  const entries = Arrow.makeData({
    type: entryType,
    length: 2,
    children: [
      Arrow.vectorFromArray(["old", "exact"], new Arrow.Utf8()).data[0],
      dictionary,
    ],
  });
  const map = Arrow.makeVector(Arrow.makeData({
    type: new Arrow.Map_(new Arrow.Field("entries", entryType, false), false),
    length: 2,
    valueOffsets: new Int32Array([0, 1, 2]),
    child: entries,
  })).slice(1);
  for (const physical of [false, true]) {
    const root = fromVector(map, physical)();
    assertEquals(arrowTreeNode(root, [0, 0]).summary, "exact");
    assertEquals(arrowTreeNode(root, [0, 1]).summary, "-9007199254740993.01");
  }
});

Deno.test("Arrow tree unsupported nested nodes and malformed paths stay local", () => {
  const child = Arrow.makeData({
    type: new Arrow.DenseUnion([1], [
      new Arrow.Field("x", new Arrow.Int32(), true),
    ]),
    length: 1,
    typeIds: new Int8Array([1]),
    valueOffsets: new Int32Array([0]),
    children: [Arrow.vectorFromArray([7], new Arrow.Int32()).data[0]],
  });
  const data = Arrow.makeData({
    type: new Arrow.List(new Arrow.Field("i", child.type, true)),
    length: 1,
    valueOffsets: new Int32Array([0, 1]),
    child,
  });
  const root = fromVector(Arrow.makeVector(data), true)();
  assertEquals(arrowTreeNode(root).has_children, true);
  assertEquals(arrowTreeChildren(root).children[0].type, "unsupported");
  assertEquals(arrowTreeChildren(root).children[0].has_children, false);
  assertEquals(arrowTreeNode(root, [0]).summary, "Unsupported: Arrow type 14");
  assertEquals(arrowTreeChildren(root, [0]).children, []);
  for (const path of [null, "0", [0.5], [NaN]]) {
    assert(
      failure(() => openArrowChild(root, path, 0)).message.includes("Invalid"),
    );
  }
});

Deno.test("Arrow tree unnamed struct fields have stable positional labels", () => {
  const vector = Arrow.makeVector(Arrow.makeData({
    type: new Arrow.Struct([
      new Arrow.Field("", new Arrow.Int32(), true),
      new Arrow.Field("", new Arrow.Int32(), true),
    ]),
    length: 1,
    children: [
      Arrow.vectorFromArray([7], new Arrow.Int32()).data[0],
      Arrow.vectorFromArray([9], new Arrow.Int32()).data[0],
    ],
  }));
  const root = fromVector(vector, true)();
  assertEquals(
    arrowTreeChildren(root).children.map((c) => [c.label, c.summary]),
    [
      ["[1] (unnamed)", "7"],
      ["[2] (unnamed)", "9"],
    ],
  );
});

Deno.test("null dictionaries retain shallow types and unnamed columns use positions", () => {
  const vector = Arrow.vectorFromArray(
    [null, "value"],
    new Arrow.Dictionary(new Arrow.Utf8(), new Arrow.Int8(), 8),
  );
  const table = new Arrow.Table({ x: vector });
  const bytes = Arrow.tableToIPC(table, "stream");
  const page = createArrowTreePage(
    bytes,
    {
      columns: [{ position: 4, name: "", ipc_index: 0 }],
    },
    { first_row: 0, rows_fetched: 2 },
    Arrow,
  );
  const node = arrowTreeNode(createArrowCellRoot(page, 0, 4));
  assertEquals(node.type, "dictionary");
  assertEquals(node.summary, "NA");
  assertEquals(node.label, "[5] (unnamed)");
  assertEquals(node.has_children, false);
  assertEquals(node.total_children, 0);
  const longLabelPage = createArrowTreePage(
    bytes,
    {
      columns: [{ index: 0, name: "x".repeat(9000), ipc_index: 0 }],
    },
    { first_row: 0, rows_fetched: 2 },
    Arrow,
  );
  const longLabel =
    arrowTreeNode(createArrowCellRoot(longLabelPage, 0, 0)).label;
  assertEquals(longLabel.length, 4096);
  assert(longLabel.endsWith("… [truncated]"));
});

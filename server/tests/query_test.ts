import { assert, assertEquals } from "./assert.ts";
import { asciiFold, decodeRows, querySnapshot } from "../web/jdv_query.js";

const fixturePath = new URL("../../spec/query-fixtures.json", import.meta.url);
const exporterPath = new URL("./fixtures/export-query.R", import.meta.url);
const fixture = JSON.parse(await Deno.readTextFile(fixturePath));
const temp = await Deno.makeTempDir({ prefix: "jdv-query-fixtures-" });
const outputPath = `${temp}/snapshots.json`;
const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
const child = new Deno.Command("Rscript", {
  args: ["--vanilla", exporterPath.pathname, fixturePath.pathname, outputPath],
  env: testLibrary ? { R_LIBS_USER: testLibrary } : {},
  stdout: "piped",
  stderr: "piped",
}).outputSync();
if (!child.success) {
  throw new Error(
    `R snapshot exporter failed: ${new TextDecoder().decode(child.stderr)}`,
  );
}
const exported = JSON.parse(await Deno.readTextFile(outputPath));
await Deno.remove(temp, { recursive: true });

Deno.test("ASCII folding changes only A through Z", () => {
  for (const item of fixture.fold) {
    assertEquals(asciiFold(item.input), item.expected);
  }
});

Deno.test("Snapshot consumer matches independent expected rows for every shared query", () => {
  for (const testCase of fixture.cases) {
    const snapshot = exported.cases[testCase.name];
    assert(snapshot, `Missing actual R snapshot for ${testCase.name}.`);
    for (const query of testCase.queries) {
      const result = querySnapshot(snapshot, {
        sort: query.sort ?? [],
        filter: query.filter ?? null,
      });
      assertEquals(result.data.row_index, query.expected);
      assertEquals(result.total, query.expected.length);
    }
  }
});

Deno.test("real R snapshots preserve array channels, omitted displays, zero rows, and duplicate names", () => {
  const one = exported.extras.one_row;
  assert(Array.isArray(one.params.data.row_index));
  assert(Array.isArray(one.params.data.columns[0].values));
  const oneDecoded = decodeRows(
    one.params.columns[0],
    one.params.data.columns[0],
    one.params.data.row_index,
  );
  assertEquals(oneDecoded, [{ row_index: 1, c0: "one" }]);

  const zero = exported.extras.zero_row;
  assertEquals(zero.params.nrow, 0);
  assertEquals(zero.params.data.row_index, []);
  assertEquals(
    zero.params.data.columns.map((column: Record<string, unknown>) =>
      Array.isArray(column.values)
    ),
    [true, true],
  );
  const zeroPage = querySnapshot(zero, { limit: 10 });
  assertEquals(zeroPage.total, 0);
  assertEquals(zeroPage.data.columns.length, 2);

  const dup = exported.extras.duplicates;
  assertEquals(
    dup.params.columns.map((column: Record<string, unknown>) => column.name),
    ["same", "same"],
  );
  const selected = querySnapshot(dup, { cols: [1], limit: 1 });
  assertEquals(selected.data.columns.length, 1);
  assertEquals(selected.data.columns[0].schema.position, 1);
  assertEquals(selected.data.row_names, ["r1"]);
});

Deno.test("display reconstruction handles omitted semantic channels and NA-last descending", () => {
  const stringSnapshot = exported.cases["utf8-byte-order"];
  const stringSchema = stringSnapshot.params.columns[0];
  const stringData = stringSnapshot.params.data.columns[0];
  assertEquals(stringData.display, undefined);
  const decoded = decodeRows(stringSchema, stringData, [
    20,
    21,
    22,
    23,
    24,
    25,
  ]);
  assertEquals(decoded[0], { row_index: 20, c0: "😀" });
  assertEquals(decoded[4], { row_index: 24, c0: "NA" });

  const numbers = exported.cases["numeric-special"];
  const desc = querySnapshot(numbers, { sort: [{ col: 0, desc: true }] });
  assertEquals(desc.data.row_index, [6, 3, 8, 7, 1, 2, 4, 5]);
  const page = querySnapshot(numbers, { offset: 1, limit: 2, cols: [1] });
  assertEquals(page.data.row_index, [2, 3]);
  assertEquals(page.data.columns[0].schema.name, "k");
  assertEquals(page.data.columns[0].data.display, ["1", "1"]);
});

Deno.test("provided primitive sort keys take precedence and missing rows stay last", () => {
  const supplied = structuredClone(exported.cases["numeric-special"]);
  supplied.params.data.columns[0].sortKey = [
    null,
    null,
    20,
    null,
    null,
    1,
    2,
    10,
  ];
  const result = querySnapshot(supplied, {
    sort: [{ col: 0, desc: true }],
  });
  assertEquals(result.data.row_index, [3, 8, 7, 6, 1, 2, 4, 5]);
});

Deno.test("R custom numeric sort keys agree with the independent Paged result", () => {
  const snapshot = exported.extras.reverse_numeric;
  const rows = querySnapshot(snapshot, {
    sort: [{ col: 0, desc: false }],
  }).data.row_index;
  assertEquals(rows, exported.extras.reverse_numeric_paged);
  assertEquals(rows, [2, 4, 3, 1]);
  assertEquals(snapshot.params.columns[0].type, "other");
  assert(Array.isArray(snapshot.params.data.columns[0].sortKey));
});

Deno.test("integer64 sort ranks and exact decimal fallback use matching key types", () => {
  const snapshot = structuredClone(exported.cases.integer64);
  const ranked = querySnapshot(snapshot, {
    sort: [{ col: 0, desc: false }],
  }).data.row_index;
  assertEquals(ranked, [4, 5, 6, 8, 2, 3, 1, 7]);
  delete snapshot.params.data.columns[0].sortKey;
  const decimal = querySnapshot(snapshot, {
    sort: [{ col: 0, desc: false }],
  }).data.row_index;
  assertEquals(decimal, ranked);
});

Deno.test("datetime without offset requires an available named timezone", () => {
  const snapshot = exported.cases["date-datetime"];
  const schema = snapshot.params.columns[1];
  const explicit = querySnapshot(snapshot, {
    filter: { op: "eq", col: 1, value: "2019-12-31T13:00:00Z" },
  });
  assertEquals(explicit.data.row_index, [1]);
  const naive = querySnapshot(snapshot, {
    filter: { op: "eq", col: 1, value: "2020-01-01T00:00:00.5" },
  });
  assertEquals(naive.data.row_index, [2]);
  const emptyTimezone = structuredClone(snapshot);
  emptyTimezone.params.columns[1].tz = "";
  let code = "";
  try {
    querySnapshot(emptyTimezone, {
      filter: { op: "eq", col: 1, value: "2020-01-01T00:00:00" },
    });
  } catch (error) {
    code = (error as Error & { code?: string }).code ?? "";
  }
  assertEquals(code, "unsupported");
  assert(schema.tz === "Australia/Sydney");
});

Deno.test("R datetime snapshots compare fractional seconds below millisecond precision", () => {
  const snapshot = exported.extras.submillisecond;
  const values = snapshot.params.data.columns[0].values;
  assertEquals(values.length, 2);
  assert(values[0].includes("."));
  assert(values[0].split(".")[1].replace(/[^0-9].*$/, "").length > 3);
  const result = querySnapshot(snapshot, {
    filter: { op: "eq", col: 0, value: values[0] },
  });
  assertEquals(result.data.row_index, [1]);
});

Deno.test("early-year datetime operands match actual R wire values", () => {
  const snapshot = exported.extras.early_year_times;
  assertEquals(filterTime(snapshot, "0000-01-01T00:00:00Z"), [1]);
  assertEquals(filterTime(snapshot, "0000-01-01T00:00:00"), [1]);
  assertEquals(filterTime(snapshot, "0001-01-01T00:00:00Z"), [2]);
  assertEquals(
    filterTime(snapshot, "0001-01-01T01:00:00+01:00"),
    [2],
  );
  assertEquals(
    filterTime(snapshot, "0001-01-01T00:00:00"),
    [2],
  );
  assertEquals(filterTime(snapshot, "0099-12-31T00:00:00Z"), [3]);
  const yearForms = [
    [
      "0-01-01T00:00:00+00:00",
      "1-01-01T00:00:00+00:00",
      "99-12-31T00:00:00+00:00",
    ],
    [
      "0000-01-01T00:00:00+00:00",
      "0001-01-01T00:00:00+00:00",
      "0099-12-31T00:00:00+00:00",
    ],
  ];
  for (const values of yearForms) {
    const variant = structuredClone(snapshot);
    variant.params.data.columns[0].values = values;
    assertEquals(filterTime(variant, "0000-01-01T00:00:00Z"), [1]);
    assertEquals(filterTime(variant, "0001-01-01T00:00:00Z"), [2]);
    assertEquals(filterTime(variant, "0099-12-31T00:00:00Z"), [3]);
  }
  for (
    const invalid of [
      "0001-02-30T00:00:00Z",
      "0001-01-01T24:00:00Z",
      "0001-01-01T00:00:00+01:60",
      "0001-01-01T00:00:00+24:00",
    ]
  ) {
    let code = "";
    try {
      filterTime(snapshot, invalid);
    } catch (error) {
      code = (error as Error & { code?: string }).code ?? "";
    }
    assertEquals(code, "invalid_request");
  }
});

Deno.test("R unpadded early-year Date source values match the independent Paged result", () => {
  const snapshot = exported.extras.ancient_dates;
  const result = querySnapshot(snapshot, {
    filter: { op: "lt", col: 0, value: "1970-01-01" },
  }).data.row_index;
  assertEquals(result, exported.extras.ancient_dates_paged);
  assertEquals(result, [1, 2, 3, 4]);
  const yearForms = [
    ["0-01-01", "1-01-01", "99-12-31"],
    ["0000-01-01", "0001-01-01", "0099-12-31"],
  ];
  for (const earlyYears of yearForms) {
    const variant = structuredClone(snapshot);
    variant.params.data.columns[0].values = [
      ...earlyYears,
      "1969-12-31",
      "1970-01-01",
      "1971-01-01",
    ];
    assertEquals(
      querySnapshot(variant, {
        filter: { op: "lt", col: 0, value: "1970-01-01" },
      }).data.row_index,
      result,
    );
  }
});

function filterTime(snapshot: unknown, value: string): number[] {
  return querySnapshot(snapshot, {
    filter: { op: "eq", col: 0, value },
  }).data.row_index;
}

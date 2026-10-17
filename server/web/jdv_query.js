// Snapshot query and row decoding helpers shared by the local viewer.
const SORT_LIMIT = 16;
const AST_DEPTH_LIMIT = 32;
const AST_NODE_LIMIT = 256;
const TEXT_BYTE_LIMIT = 4096;
const FILTER_BYTE_LIMIT = 65536;

export function asciiFold(value) {
  return String(value).replace(
    /[A-Z]/g,
    (letter) => String.fromCharCode(letter.charCodeAt(0) + 32),
  );
}

/** @param {any} descriptor @param {{sort?: Array<{col:number,desc:boolean}>, filter?: any, offset?:number, limit?:number, cols?:number[]|null}} options */
export function querySnapshot(descriptor, {
  sort = [],
  filter = null,
  offset = 0,
  limit = 200,
  cols = null,
} = {}) {
  const table = descriptor?.params ?? descriptor;
  const schemaColumns = table?.schema?.columns ?? table?.columns;
  const payloadColumns = table?.data?.columns;
  const rowCount = snapshotRowCount(table);
  if (
    rowCount === null ||
    !Number.isSafeInteger(table?.ncol) || table.ncol < 0 ||
    !Array.isArray(schemaColumns) || !Array.isArray(payloadColumns) ||
    schemaColumns.length !== table.ncol || payloadColumns.length !== table.ncol
  ) {
    throw queryError("invalid_request", "Malformed Snapshot descriptor.");
  }
  if (
    (table.data.row_index !== undefined &&
      (!Array.isArray(table.data.row_index) ||
        table.data.row_index.length !== rowCount)) ||
    (table.data.row_names !== undefined && table.data.row_names !== null &&
      (!Array.isArray(table.data.row_names) ||
        table.data.row_names.length !== rowCount))
  ) {
    throw queryError("schema_changed", "Invalid row metadata channels.");
  }
  if (
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(limit) || limit < 0
  ) {
    throw queryError("invalid_request", "Invalid page offset or limit.");
  }
  const effectiveLimit = Math.min(limit, 2000);
  const columns = schemaColumns.map((schema, index) => {
    const raw = payloadColumns[index];
    const { errors = [], ...data } = raw ?? {};
    return { schema, data, errors };
  });
  validateChannels(rowCount, columns);
  const request = validateRequest(columns, sort, filter, cols);
  const allRows = Array.from({ length: rowCount }, (_, i) => i);
  const selected = filter === null
    ? allRows
    : allRows.filter((row) => testFilter(columns, request.filter, row));
  const total = selected.length;
  if (request.sort.length) {
    selected.sort((a, b) => compareRows(columns, request.sort, a, b));
  }
  const pageIndices = selected.slice(offset, offset + effectiveLimit);
  const rowIndex = pageIndices.map((row) =>
    table.data.row_index?.[row] ?? row + 1
  );
  const rowNames = table.data.row_names;
  const pageColumns = request.cols.map((position) => {
    const source = columns[position];
    const data = {};
    for (const [key, value] of Object.entries(source.data)) {
      if (Array.isArray(value) && value.length === rowCount) {
        data[key] = pageIndices.map((row) => value[row]);
      } else if (key !== "errors") {
        data[key] = value;
      }
    }
    return {
      schema: source.schema,
      data,
      errors: source.errors,
    };
  });
  return {
    total,
    total_unfiltered: rowCount,
    offset,
    limit: effectiveLimit,
    data: {
      row_index: rowIndex,
      row_names: Array.isArray(rowNames)
        ? pageIndices.map((row) => rowNames[row])
        : null,
      columns: pageColumns,
    },
  };
}

function snapshotRowCount(table) {
  if (Number.isSafeInteger(table?.nrow) && table.nrow >= 0) {
    return table.nrow;
  }
  if (table?.nrow !== null) return null;

  const lengths = [];
  if (Array.isArray(table.data?.row_index)) {
    lengths.push(table.data.row_index.length);
  }
  if (Array.isArray(table.data?.row_names)) {
    lengths.push(table.data.row_names.length);
  }
  for (const column of table.data?.columns ?? []) {
    for (const name of ["values", "display", "sortKey", "special", "na"]) {
      if (Array.isArray(column?.[name])) lengths.push(column[name].length);
    }
  }
  if (lengths.length === 0 || lengths.some((length) => length !== lengths[0])) {
    return null;
  }
  return lengths[0];
}

/** @param {any|any[]} schema @param {any|any[]} data @param {number[]|null} rowIndex @param {string[]|null} rowNames */
export function decodeRows(schema, data, rowIndex = null, rowNames = null) {
  if (Array.isArray(schema) && Array.isArray(data)) {
    if (schema.length !== data.length) {
      throw queryError("schema_changed", "Schema and column counts differ.");
    }
    const decoded = schema.map((columnSchema, i) =>
      decodeRows(columnSchema, data[i], rowIndex, rowNames)
    );
    const count = rowIndex?.length ?? decoded[0]?.length ?? 0;
    return Array.from({ length: count }, (_, index) => {
      const row = {
        row_index: rowIndex?.[index] ?? decoded[0]?.[index]?.row_index ??
          index + 1,
      };
      if (Array.isArray(rowNames)) row.row_name = safeDisplay(rowNames[index]);
      for (const columnRows of decoded) {
        Object.assign(row, columnRows[index]);
      }
      return row;
    });
  }
  const values = data?.values;
  const display = data?.display;
  const na = data?.na;
  const count = [values, display, na].find(Array.isArray)?.length ?? 0;
  for (const channel of [values, display, na, data?.special]) {
    if (Array.isArray(channel) && channel.length !== count) {
      throw queryError("schema_changed", "Snapshot channel lengths differ.");
    }
  }
  if (
    na !== undefined &&
    (!Array.isArray(na) || na.some((v) => typeof v !== "boolean"))
  ) {
    throw queryError("schema_changed", "Invalid missingness channel.");
  }
  return Array.from({ length: count }, (_, index) => {
    const missing = Array.isArray(na) ? na[index] : false;
    let text;
    if (Array.isArray(display)) {
      text = display[index];
    } else if (missing) {
      text = "NA";
    } else if (Array.isArray(values)) {
      text = values[index];
      if (schema?.type === "number" && data.special?.[index] === "nan") {
        text = "NaN";
      }
      if (schema?.type === "number" && data.special?.[index] === "pos_inf") {
        text = "Inf";
      }
      if (schema?.type === "number" && data.special?.[index] === "neg_inf") {
        text = "-Inf";
      }
    } else {
      text = "";
    }
    const row = {};
    row.row_index = Array.isArray(rowIndex) ? rowIndex[index] : index + 1;
    if (Array.isArray(rowNames)) row.row_name = safeDisplay(rowNames[index]);
    row[`c${schema.position}`] = safeDisplay(text);
    return row;
  });
}

function safeDisplay(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function queryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateChannels(nrow, columns) {
  for (let i = 0; i < columns.length; i++) {
    const { schema, data } = columns[i];
    if (!schema || schema.position !== i || typeof schema.type !== "string") {
      throw queryError("invalid_request", "Malformed Snapshot schema.");
    }
    for (const name of ["values", "display", "sortKey", "special", "na"]) {
      const channel = data[name];
      if (
        channel !== undefined &&
        (!Array.isArray(channel) || channel.length !== nrow)
      ) {
        throw queryError("schema_changed", `Invalid ${name} channel.`);
      }
    }
    if (data.na?.some((value) => typeof value !== "boolean")) {
      throw queryError("schema_changed", "Invalid missingness channel.");
    }
    if (data.display?.some((value) => typeof value !== "string")) {
      throw queryError("schema_changed", "Invalid display channel.");
    }
    if (
      data.sortKey?.some((value) =>
        value !== null && (typeof value !== "number" || !Number.isFinite(value))
      )
    ) {
      throw queryError("schema_changed", "Invalid sort key channel.");
    }
    if (
      data.special?.some((value) =>
        value !== null && !["na", "nan", "pos_inf", "neg_inf"].includes(value)
      )
    ) {
      throw queryError("schema_changed", "Invalid special-value channel.");
    }
  }
}

function validateRequest(columns, sort, filter, cols) {
  if (!Array.isArray(sort) || sort.length > SORT_LIMIT) {
    throw queryError(
      sort?.length > SORT_LIMIT ? "limit_exceeded" : "invalid_request",
      "Invalid sort request.",
    );
  }
  const seen = new Set();
  const validatedSort = sort.map((term) => {
    exactKeys(term, ["col", "desc"]);
    const col = selector(term.col, columns.length);
    if (seen.has(col) || typeof term.desc !== "boolean") {
      throw queryError("invalid_request", "Invalid or repeated sort term.");
    }
    seen.add(col);
    const schema = columns[col].schema;
    if (!schema.sortable || !columns[col].data.na) {
      throw queryError("unsupported", "Column cannot be sorted.");
    }
    if (!hasSortKey(schema, columns[col].data)) {
      throw queryError(
        "schema_changed",
        "Sortable column has no valid sort key.",
      );
    }
    return { col, desc: term.desc };
  });
  const context = { nodes: 0, bytes: 0 };
  const validFilter = filter === null
    ? null
    : validateFilter(columns, filter, context, 1);
  if (context.bytes > FILTER_BYTE_LIMIT) {
    throw queryError("limit_exceeded", "Filter text budget exceeded.");
  }
  const selectedCols = columnsForPage(columns, cols);
  return { sort: validatedSort, filter: validFilter, cols: selectedCols };
}

function columnsForPage(columns, cols) {
  if (cols === undefined || cols === null) {
    if (columns.length > 256) {
      throw queryError("limit_exceeded", "Too many page columns.");
    }
    return columns.map((_, i) => i);
  }
  if (!Array.isArray(cols)) {
    throw queryError("invalid_request", "Invalid column selection.");
  }
  if (cols.length > 256) {
    throw queryError("limit_exceeded", "Too many page columns.");
  }
  const seen = new Set();
  return cols.map((value) => {
    const col = selector(value, columns.length);
    if (seen.has(col)) {
      throw queryError("invalid_request", "Repeated page column.");
    }
    seen.add(col);
    return col;
  });
}

function selector(value, count) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= count) {
    throw queryError("invalid_request", "Invalid column position.");
  }
  return value;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw queryError("invalid_request", "Expected an object.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw queryError(
      "invalid_request",
      "Object fields do not match the query schema.",
    );
  }
}

function validateFilter(columns, node, context, depth) {
  context.nodes++;
  if (depth > AST_DEPTH_LIMIT || context.nodes > AST_NODE_LIMIT) {
    throw queryError("limit_exceeded", "Filter AST limit exceeded.");
  }
  if (
    !node || typeof node !== "object" || Array.isArray(node) ||
    typeof node.op !== "string"
  ) {
    throw queryError("invalid_request", "Malformed filter node.");
  }
  const op = node.op;
  if (op === "and" || op === "or") {
    exactKeys(node, ["op", "args"]);
    if (!Array.isArray(node.args)) {
      throw queryError("invalid_request", "Expected filter arguments.");
    }
    return {
      op,
      args: node.args.map((arg) =>
        validateFilter(columns, arg, context, depth + 1)
      ),
    };
  }
  if (op === "not") {
    exactKeys(node, ["op", "arg"]);
    return { op, arg: validateFilter(columns, node.arg, context, depth + 1) };
  }
  const noValue = ["is_na", "is_true", "is_false"].includes(op);
  const stringOps = ["contains", "starts_with", "ends_with", "text_equals"];
  const compareOps = ["eq", "ne", "lt", "le", "gt", "ge"];
  if (noValue) exactKeys(node, ["op", "col"]);
  else if (stringOps.includes(op) || compareOps.includes(op)) {
    exactKeys(node, ["op", "col", "value"]);
  } else if (op === "between") exactKeys(node, ["op", "col", "lower", "upper"]);
  else if (op === "in") exactKeys(node, ["op", "col", "values"]);
  else throw queryError("invalid_request", "Unknown filter operator.");
  const col = selector(node.col, columns.length);
  const { schema, data } = columns[col];
  if (!data.na) {
    throw queryError(
      "schema_changed",
      "Filter column has no missingness channel.",
    );
  }
  if (op === "is_na") return { op, col };
  if (!schema.filterable) {
    throw queryError("unsupported", "Column is not filterable.");
  }
  if (op === "is_true" || op === "is_false") {
    if (schema.type !== "boolean") {
      throw queryError("unsupported", "Boolean filter is unavailable.");
    }
    return { op, col };
  }
  if (stringOps.includes(op)) {
    if (!["string", "factor"].includes(schema.type)) {
      throw queryError("unsupported", "Text filter is unavailable.");
    }
    if (typeof node.value !== "string") {
      throw queryError("invalid_request", "Text operand must be a string.");
    }
    addStringBudget(context, node.value);
    return { op, col, value: asciiFold(node.value) };
  }
  if (op === "in") {
    if (
      schema.type !== "factor" || !Array.isArray(node.values)
    ) {
      throw queryError(
        "unsupported",
        "Factor membership filter is unavailable.",
      );
    }
    if (node.values.length > AST_NODE_LIMIT) {
      throw queryError("limit_exceeded", "Too many factor labels.");
    }
    for (const label of node.values) {
      if (typeof label !== "string") {
        throw queryError("invalid_request", "Factor labels must be strings.");
      }
      addStringBudget(context, label);
    }
    return { op, col, values: new Set(node.values) };
  }
  const allowed = schema.type === "int64"
    ? ["eq", "between"]
    : ["integer", "number", "date", "datetime"].includes(schema.type)
    ? [...compareOps, "between"]
    : [];
  if (!allowed.includes(op)) {
    throw queryError("unsupported", "Comparison filter is unavailable.");
  }
  if (op === "between") {
    const lower = operand(schema, node.lower, context);
    const upper = operand(schema, node.upper, context);
    if (compareValues(schema.type, lower, upper) > 0) {
      throw queryError("invalid_request", "Reversed between bounds.");
    }
    return { op, col, lower, upper };
  }
  return { op, col, value: operand(schema, node.value, context) };
}

function addStringBudget(context, value) {
  const length = new TextEncoder().encode(value).length;
  if (length > TEXT_BYTE_LIMIT) {
    throw queryError("limit_exceeded", "Filter string is too long.");
  }
  context.bytes += length;
}

function operand(schema, value, context) {
  if (schema.type === "int64") {
    if (
      typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value) ||
      value === "-9223372036854775808" ||
      compareDecimal(value, "-9223372036854775807") < 0 ||
      compareDecimal(value, "9223372036854775807") > 0
    ) {
      throw queryError("invalid_request", "Invalid integer64 operand.");
    }
    addStringBudget(context, value);
    return value;
  }
  if (schema.type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw queryError("invalid_request", "Invalid date operand.");
    }
    const time = Date.parse(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== value
    ) throw queryError("invalid_request", "Invalid date operand.");
    addStringBudget(context, value);
    return time / 86400000;
  }
  if (schema.type === "datetime") {
    if (typeof value !== "string") {
      throw queryError("invalid_request", "Invalid datetime operand.");
    }
    addStringBudget(context, value);
    const timestamp = parseDatetime(value, schema.tz ?? "");
    if (!Number.isFinite(timestamp)) {
      throw queryError("invalid_request", "Invalid datetime operand.");
    }
    return timestamp;
  }
  if (
    schema.type === "number" && value && typeof value === "object" &&
    !Array.isArray(value)
  ) {
    exactKeys(value, ["special"]);
    if (value.special === "pos_inf") return Infinity;
    if (value.special === "neg_inf") return -Infinity;
    throw queryError("invalid_request", "Invalid special numeric operand.");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw queryError("invalid_request", "Invalid numeric operand.");
  }
  return value;
}

function parseDatetime(value, timezone, allowUnpaddedYear = false) {
  const yearPattern = allowUnpaddedYear ? "\\d{1,4}" : "\\d{4}";
  const match = new RegExp(
    `^(${yearPattern})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$`,
  ).exec(value);
  if (!match) return NaN;
  const [, ys, mos, ds, hs, mis, ss, fraction = "", zone = ""] = match;
  const parts = [
    Number(ys),
    Number(mos),
    Number(ds),
    Number(hs),
    Number(mis),
    Number(ss),
  ];
  const [y, mo, d, h, mi, s] = parts;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return NaN;
  const whole = utcMillis(y, mo - 1, d, h, mi, s);
  const date = new Date(whole);
  if (
    date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) return NaN;
  const fractionalSeconds = fraction ? Number(fraction) : 0;
  if (zone === "Z") return whole / 1000 + fractionalSeconds;
  if (zone) {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return NaN;
    const delta = (zh * 60 + zm) * 60 * (zone[0] === "+" ? 1 : -1);
    return whole / 1000 + fractionalSeconds - delta;
  }
  if (!timezone) {
    throw queryError(
      "unsupported",
      "Datetime operands without an offset require a named column timezone.",
    );
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw queryError(
      "unsupported",
      "The column timezone is unavailable in this runtime.",
    );
  }
  const target = { year: y, month: mo, day: d, hour: h, minute: mi, second: s };
  let guess = whole + fractionalSeconds * 1000;
  for (let i = 0; i < 4; i++) {
    const actual = zonedParts(guess, timezone);
    if (!actual) return NaN;
    const local = utcMillis(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const desired = utcMillis(y, mo - 1, d, h, mi, s);
    const correction = desired - local;
    guess += correction;
    if (!correction) break;
  }
  const final = zonedParts(guess, timezone);
  return final && sameParts(final, target) ? guess / 1000 : NaN;
}

function utcMillis(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function zonedParts(time, timezone) {
  try {
    const values = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      era: "short",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(time));
    const out = Object.fromEntries(
      values.map((part) => [part.type, part.value]),
    );
    return {
      year: out.era === "BC" ? 1 - Number(out.year) : +out.year,
      month: +out.month,
      day: +out.day,
      hour: +out.hour,
      minute: +out.minute,
      second: +out.second,
    };
  } catch {
    return null;
  }
}

function sameParts(a, b) {
  return ["year", "month", "day", "hour", "minute", "second"].every((key) =>
    a[key] === b[key]
  );
}

function compareDecimal(left, right) {
  const lneg = left[0] === "-";
  const rneg = right[0] === "-";
  if (lneg !== rneg) return lneg ? -1 : 1;
  const l = lneg ? left.slice(1) : left;
  const r = rneg ? right.slice(1) : right;
  const cmp = l.length !== r.length
    ? Math.sign(l.length - r.length)
    : l === r
    ? 0
    : l < r
    ? -1
    : 1;
  return lneg ? -cmp : cmp;
}

function compareValues(type, left, right) {
  if (type === "int64") return compareDecimal(left, right);
  return left === right ? 0 : left < right ? -1 : 1;
}

function hasSortKey(schema, data) {
  if (Array.isArray(data.sortKey)) return true;
  if (["boolean", "integer", "number", "int64"].includes(schema.type)) {
    return Array.isArray(data.values);
  }
  return false;
}

function keyAt(column, row) {
  const { schema, data } = column;
  if (data.na[row] || data.sortKey?.[row] === null) {
    return { missing: true, value: null };
  }
  if (Array.isArray(data.sortKey)) {
    return { kind: "rank", missing: false, value: data.sortKey[row] };
  }
  if (schema.type === "int64") {
    return { kind: "decimal", missing: false, value: data.values[row] };
  }
  if (["boolean", "integer", "number"].includes(schema.type)) {
    const special = data.special?.[row];
    if (special === "pos_inf") {
      return { kind: "numeric", missing: false, value: Infinity };
    }
    if (special === "neg_inf") {
      return { kind: "numeric", missing: false, value: -Infinity };
    }
    if (special === "nan" || special === "na") {
      return { missing: true, value: null };
    }
    return { kind: "numeric", missing: false, value: data.values[row] };
  }
  return { kind: "rank", missing: false, value: data.sortKey[row] };
}

function compareRows(columns, sort, a, b) {
  for (const term of sort) {
    const left = keyAt(columns[term.col], a);
    const right = keyAt(columns[term.col], b);
    if (left.missing || right.missing) {
      if (left.missing !== right.missing) return left.missing ? 1 : -1;
      continue;
    }
    let cmp;
    if (left.kind === "decimal") {
      cmp = compareDecimal(left.value, right.value);
    } else {
      cmp = left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
    }
    if (cmp) return term.desc ? -cmp : cmp;
  }
  return a - b;
}

function testFilter(columns, node, row) {
  if (node.op === "and") {
    return node.args.every((arg) => testFilter(columns, arg, row));
  }
  if (node.op === "or") {
    return node.args.some((arg) => testFilter(columns, arg, row));
  }
  if (node.op === "not") return !testFilter(columns, node.arg, row);
  const column = columns[node.col];
  const { schema, data } = column;
  const missing = data.na[row];
  if (node.op === "is_na") return missing;
  if (node.op === "is_true") return !missing && data.values[row] === true;
  if (node.op === "is_false") return !missing && data.values[row] === false;
  if (missing) return false;
  if (
    ["contains", "starts_with", "ends_with", "text_equals"].includes(node.op)
  ) {
    const source = data.values?.[row];
    if (typeof source !== "string") return false;
    const folded = asciiFold(source);
    if (node.op === "contains") return folded.includes(node.value);
    if (node.op === "starts_with") return folded.startsWith(node.value);
    if (node.op === "ends_with") return folded.endsWith(node.value);
    return folded === node.value;
  }
  if (node.op === "in") return node.values.has(data.values?.[row]);
  let value = data.values?.[row];
  if (schema.type === "number") {
    const special = data.special?.[row];
    if (special === "pos_inf") value = Infinity;
    else if (special === "neg_inf") value = -Infinity;
    else if (special === "nan" || special === "na") return false;
  } else if (schema.type === "date") {
    value = parseDateValue(value, true);
  } else if (schema.type === "datetime") {
    value = parseDatetime(value, schema.tz ?? "", true);
  }
  if (value === null || value === undefined || Number.isNaN(value)) {
    return false;
  }
  if (node.op === "between") {
    return compareValues(schema.type, value, node.lower) >= 0 &&
      compareValues(schema.type, value, node.upper) <= 0;
  }
  const cmp = compareValues(schema.type, value, node.value);
  return ({
    eq: cmp === 0,
    ne: cmp !== 0,
    lt: cmp < 0,
    le: cmp <= 0,
    gt: cmp > 0,
    ge: cmp >= 0,
  })[node.op] ?? false;
}

function parseDateValue(value, allowUnpaddedYear = false) {
  if (typeof value !== "string") return NaN;
  const yearPattern = allowUnpaddedYear ? "\\d{1,4}" : "\\d{4}";
  const match = new RegExp(`^(${yearPattern})-(\\d{2})-(\\d{2})$`).exec(value);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return NaN;
  const time = utcMillis(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return NaN;
  return time / 86400000;
}

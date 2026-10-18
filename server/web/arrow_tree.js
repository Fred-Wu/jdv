import { CELL_TEXT_LIMIT, formatArrowValue } from "./sequential.js";

export const ARROW_TREE_PAGE_SIZE = 200;
export const ARROW_TREE_MAX_DEPTH = 32;
const pages = new WeakMap();
const roots = new WeakMap();
const names = {
  [-1]: "dictionary",
  1: "null",
  2: "integer",
  3: "float",
  4: "binary",
  5: "string",
  6: "boolean",
  7: "decimal",
  8: "date",
  9: "time",
  10: "timestamp",
  12: "list",
  13: "struct",
  15: "binary",
  16: "fixed_size_list",
  17: "map",
  18: "duration",
  19: "large_binary",
  20: "large_string",
  21: "large_list",
  23: "binary_view",
  24: "string_view",
};
const bounded = (text) => {
  const value = String(text);
  return value.length <= CELL_TEXT_LIMIT
    ? value
    : value.slice(0, CELL_TEXT_LIMIT - "… [truncated]".length) +
      "… [truncated]";
};
function invalid(message) {
  throw Object.assign(new Error(message), { code: "invalid_request" });
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`Invalid ${label}.`);
  }
  return value;
}
function location(vector, row, arrow) {
  integer(row, "Arrow row");
  if (row >= vector.length) invalid("Arrow row is outside its buffers.");
  for (const data of vector.data) {
    if (row < data.length) return { data, row, arrow };
    row -= data.length;
  }
  invalid("Arrow row is outside its buffers.");
}

// Handles retain only their page's decoded vectors. Their owner controls cache lifetime.
export function createArrowTreePage(
  bytes,
  descriptor,
  metadata,
  arrow = globalThis.Arrow,
) {
  if (!arrow?.tableFromIPC || !arrow?.makeVector) {
    invalid("The Arrow decoder is unavailable.");
  }
  if (!(bytes instanceof Uint8Array) || !Array.isArray(descriptor?.columns)) {
    invalid("Invalid Arrow page or column descriptor.");
  }
  const first = integer(metadata?.first_row, "first row");
  const count = integer(metadata?.rows_fetched, "row count");
  integer(first + count, "row range");
  const table = arrow.tableFromIPC(bytes);
  if (table.numCols !== 0 && table.numRows !== count) {
    invalid("Arrow page row count mismatch.");
  }
  const columns = new Map();
  for (const [i, column] of descriptor.columns.entries()) {
    const index = integer(
      column.position ?? column.index ?? i,
      "column selector",
    );
    if (columns.has(index)) invalid("Duplicate Arrow column selector.");
    columns.set(index, {
      label: bounded(
        column.name === ""
          ? `[${index + 1}] (unnamed)`
          : column.name ?? `Column ${index + 1}`,
      ),
      ipc: column.ipc_index,
      unsupported: column.unsupported,
    });
  }
  const page = Object.freeze({});
  pages.set(page, { table, columns, first, count, arrow });
  return page;
}

export function createArrowCellRoot(page, rowIndex, column) {
  const state = pages.get(page);
  if (!state) invalid("Unknown Arrow page handle.");
  integer(rowIndex, "source row", 0);
  integer(column, "column selector");
  const row = rowIndex - state.first;
  if (row < 0 || row >= state.count) {
    invalid("The source row is outside this page.");
  }
  const selected = state.columns.get(column);
  if (!selected) invalid("Unknown Arrow column selector.");
  const root = Object.freeze({});
  if (
    selected.unsupported || selected.ipc === null || selected.ipc === undefined
  ) {
    roots.set(root, {
      label: selected.label,
      unsupported: bounded(selected.unsupported ?? "no IPC mapping"),
    });
  } else {
    integer(selected.ipc, "IPC column mapping");
    const vector = state.table.getChildAt(selected.ipc);
    if (!vector) invalid("Arrow column mapping is outside the IPC schema.");
    roots.set(root, {
      label: selected.label,
      ...location(vector, row, state.arrow),
    });
  }
  return root;
}

function resolve(input) {
  let current = input;
  const seen = new Set();
  while (!current.unsupported) {
    const { data, row, arrow } = current;
    const id = data.type.typeId;
    if (!Object.hasOwn(names, id) && id !== -1) {
      return { ...current, unsupported: `Arrow type ${id}` };
    }
    if (id === 1 || !data.getValid(row)) return { ...current, missing: true };
    if (id !== -1) return current;
    if (seen.has(data) || seen.size >= ARROW_TREE_MAX_DEPTH) {
      return {
        ...current,
        unsupported: "cyclic or excessive dictionary nesting",
      };
    }
    seen.add(data);
    const index = Number(data.values[row * data.stride]);
    if (
      !data.dictionary || !Number.isSafeInteger(index) || index < 0 ||
      index >= data.dictionary.length
    ) {
      return { ...current, unsupported: "invalid dictionary index" };
    }
    current = {
      label: current.label,
      ...location(data.dictionary, index, arrow),
    };
  }
  return current;
}
// ArrowJS 21.2 Data.slice adjusts struct/fixed-list children and list offsets.
// Variable-list offsets still address the unsliced child; do not add data.offset.
function childLayout(input) {
  const node = resolve(input);
  if (node.unsupported || node.missing) return { node, count: 0 };
  const { data, row, arrow } = node;
  const id = data.type.typeId;
  if (id === 13) {
    return {
      node,
      count: data.type.children.length,
      child(index) {
        const child = data.children[index];
        if (!child || row >= child.length) {
          invalid("Invalid Arrow struct child buffers.");
        }
        return {
          data: child,
          row,
          arrow,
          label: bounded(
            data.type.children[index].name || `[${index + 1}] (unnamed)`,
          ),
        };
      },
    };
  }
  if ([12, 16, 17, 21].includes(id)) {
    const first = id === 16
      ? row * data.type.listSize
      : Number(data.valueOffsets[row]);
    const end = id === 16
      ? first + data.type.listSize
      : Number(data.valueOffsets[row + 1]);
    const child = data.children[0];
    if (
      ![first, end].every(Number.isSafeInteger) || first < 0 || end < first ||
      !child || end > child.length
    ) {
      invalid("Invalid Arrow list child offsets.");
    }
    return {
      node,
      count: end - first,
      child(index) {
        return {
          data: child,
          row: first + index,
          arrow,
          label: id === 17 ? `Entry ${index + 1}` : `[${index + 1}]`,
        };
      },
    };
  }
  return { node, count: 0 };
}
function pathNode(root, path) {
  if (!Array.isArray(path) || path.length > ARROW_TREE_MAX_DEPTH) {
    invalid("Invalid Arrow child path depth.");
  }
  let node = roots.get(root);
  if (!node) invalid("Unknown Arrow cell handle.");
  for (const index of path) {
    integer(index, "child index");
    const layout = childLayout(node);
    if (index >= layout.count) {
      invalid("Arrow child path is outside the value.");
    }
    node = layout.child(index);
  }
  return node;
}
function describe(input, path) {
  const { node, count } = childLayout(input);
  const limited = path.length === ARROW_TREE_MAX_DEPTH && count > 0;
  const type = node.unsupported ? "unsupported" : names[node.data.type.typeId];
  let summary;
  if (node.unsupported) summary = `Unsupported: ${node.unsupported}`;
  else if (node.missing) summary = "NA";
  else if (count || [12, 13, 16, 17, 21].includes(node.data.type.typeId)) {
    summary = `<${type}: ${count} ${
      node.data.type.typeId === 13 ? "fields" : "items"
    }>`;
  } else summary = formatArrowValue(node.arrow.makeVector(node.data), node.row);
  if (limited) summary += " [depth limit]";
  return {
    label: bounded(node.label),
    type,
    summary: bounded(summary),
    has_children: count > 0 && !limited,
    total_children: count,
    path: path.slice(),
  };
}
export function arrowTreeNode(root, path = []) {
  return describe(pathNode(root, path), path);
}
export function arrowTreeChildren(
  root,
  path = [],
  offset = 0,
  limit = ARROW_TREE_PAGE_SIZE,
) {
  integer(offset, "child offset");
  integer(limit, "child page size", 1);
  if (limit > ARROW_TREE_PAGE_SIZE) {
    invalid("Arrow child page size exceeds 200.");
  }
  const input = pathNode(root, path);
  const layout = childLayout(input);
  const children = [];
  if (path.length < ARROW_TREE_MAX_DEPTH) {
    for (
      let index = offset;
      index < Math.min(layout.count, offset + limit);
      index++
    ) {
      children.push({
        index,
        ...describe(layout.child(index), [...path, index]),
      });
    }
  }
  return { path: path.slice(), offset, total_children: layout.count, children };
}
export function openArrowChild(root, path, index) {
  pathNode(root, path);
  integer(index, "child index");
  const next = [...path, index];
  pathNode(root, next);
  return next;
}

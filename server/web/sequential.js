// Arrow values are formatted from physical buffers where numeric getters lose precision.
const NANOSECONDS = [1_000_000_000n, 1_000_000n, 1_000n, 1n];
const UNIT_NAMES = ["s", "ms", "us", "ns"];
export const SEQUENTIAL_CACHE_BYTES = 8 * 1024 * 1024;
export const CELL_TEXT_LIMIT = 4096;

export function sequentialPageRows(descriptor, preferredRows = 200) {
  const cap = descriptor.max_page_rows === undefined
    ? 200
    : descriptor.max_page_rows;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 2000) {
    throw new Error("Invalid sequential max_page_rows descriptor.");
  }
  return Math.min(preferredRows, cap);
}

export function formatScaled(coefficient, scale) {
  if (!Number.isSafeInteger(scale)) {
    throw new Error("Invalid Arrow decimal scale: expected a safe integer.");
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  const sign = negative ? "-" : "";
  const fixedLength = sign.length +
    (scale <= 0
      ? digits.length - scale
      : Math.max(digits.length, scale + 1) + 1);
  // Arrow decimal coefficients have at most 76 digits; never expand a huge scale.
  if (fixedLength > CELL_TEXT_LIMIT) return `${sign}${digits}e${-scale}`;
  if (scale <= 0) return sign + digits + "0".repeat(-scale);
  const padded = digits.padStart(scale + 1, "0");
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function signedWords(values, start, width) {
  let result = 0n;
  for (let word = 0; word < width; word++) {
    result |= BigInt(values[start + word] >>> 0) << BigInt(word * 32);
  }
  return BigInt.asIntN(width * 32, result);
}

function floorDiv(value, divisor) {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

/** @param {bigint} ticks @param {number} unit @param {string|null} timezone */
export function formatTimestamp(ticks, unit, timezone = null) {
  const nanoseconds = ticks * NANOSECONDS[unit];
  const seconds = floorDiv(nanoseconds, 1_000_000_000n);
  const fraction = nanoseconds - seconds * 1_000_000_000n;
  const date = new Date(Number(seconds) * 1000);
  if (
    !Number.isSafeInteger(Number(seconds)) || !Number.isFinite(date.getTime())
  ) {
    return `${ticks} ${UNIT_NAMES[unit]}${timezone ? ` [${timezone}]` : ""}`;
  }
  const digits = [0, 3, 6, 9][unit];
  const suffix = digits
    ? `.${fraction.toString().padStart(9, "0").slice(0, digits)}`
    : "";
  if (!timezone || timezone === "UTC" || timezone === "Etc/UTC") {
    return date.toISOString().replace(
      /\.\d{3}Z$/,
      suffix + (timezone ? "Z" : ""),
    );
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    const offset = parts.timeZoneName.replace(/^GMT/, "") || "+00:00";
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${suffix}${offset} [${timezone}]`;
  } catch {
    return `${
      date.toISOString().replace(/\.\d{3}Z$/, suffix + "Z")
    } [${timezone}]`;
  }
}

function chunkAt(vector, row) {
  for (const data of vector.data) {
    if (row < data.length) return { data, row };
    row -= data.length;
  }
  throw new Error("Arrow row is outside its buffers.");
}

export function formatArrowValue(vector, row) {
  if (!vector.isValid(row)) return "NA";
  const type = vector.type;
  const { data, row: local } = chunkAt(vector, row);
  // Arrow Data slices already adjust values; offset belongs to the validity bitmap.
  const start = local * data.stride;
  if (type.typeId === -1) {
    const index = Number(data.values[start]);
    if (
      !Number.isSafeInteger(index) || index < 0 ||
      index >= data.dictionary.length
    ) {
      throw new Error("Invalid Arrow dictionary index.");
    }
    return formatArrowValue(data.dictionary, index);
  }
  if (type.typeId === 7) {
    return formatScaled(
      signedWords(data.values, start, type.bitWidth / 32),
      type.scale,
    );
  }
  if (type.typeId === 10) {
    return formatTimestamp(
      BigInt(data.values[start]),
      type.unit,
      type.timezone,
    );
  }
  if (type.typeId === 9 || type.typeId === 18) {
    return `${data.values[start]} ${UNIT_NAMES[type.unit]}`;
  }
  if ([12, 16, 21].includes(type.typeId)) {
    const size = type.listSize ??
      Number(data.valueOffsets[local + 1] - data.valueOffsets[local]);
    return `<list: ${size} items>`;
  }
  if (type.typeId === 13) return `<struct: ${type.children.length} fields>`;
  if (type.typeId === 17) return "<map>";
  const value = vector.get(row);
  if (value instanceof Uint8Array) {
    const shown = value.subarray(0, CELL_TEXT_LIMIT / 2);
    return Array.from(shown, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ) +
      (shown.length < value.length ? "… [truncated]" : "");
  }
  if (type.typeId === 8) {
    return new Date(Number(value)).toISOString().slice(0, 10);
  }
  return String(value);
}

function boundedText(value) {
  return value.length > CELL_TEXT_LIMIT
    ? value.slice(0, CELL_TEXT_LIMIT) + "… [truncated]"
    : value;
}

// The cache counts UTF-16 cell text bytes, plus 64 per row and 16 per cell.
// It never retains IPC bytes or Arrow vectors. This is not a JS heap size guarantee.
export function createSequentialCache(
  maxBytes = SEQUENTIAL_CACHE_BYTES,
  maxPages = 32,
) {
  if (
    !Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
    !Number.isSafeInteger(maxPages) || maxPages < 1
  ) {
    throw new Error("Invalid sequential cache capacity.");
  }
  const pages = [];
  let bytes = 0;
  let evictedThrough = 0;
  return {
    append(rows) {
      const items = rows.map((row) => ({
        row,
        bytes: 64 +
          Object.values(row).reduce(
            (sum, value) => sum + 16 + String(value).length * 2,
            0,
          ),
      }));
      let size = items.reduce((sum, item) => sum + item.bytes, 0);
      while (items.length && size > maxBytes) {
        const removed = items.shift();
        size -= removed.bytes;
        evictedThrough = Math.max(evictedThrough, removed.row.row_index);
      }
      pages.push({ items, bytes: size });
      bytes += size;
      while (pages.length > maxPages || bytes > maxBytes) {
        const removed = pages.shift();
        bytes -= removed.bytes;
        for (const item of removed.items) {
          evictedThrough = Math.max(evictedThrough, item.row.row_index);
        }
      }
    },
    rows() {
      return pages.flatMap((page) => page.items.map((item) => item.row));
    },
    get bytes() {
      return bytes;
    },
    get evictedThrough() {
      return evictedThrough;
    },
    discard(through) {
      evictedThrough = Math.max(evictedThrough, through);
    },
    clear() {
      pages.length = 0;
      bytes = 0;
    },
  };
}

export function decodeArrowPage(
  bytes,
  descriptor,
  metadata,
  arrow = globalThis.Arrow,
) {
  if (!arrow?.tableFromIPC) {
    throw new Error("The Arrow decoder is unavailable.");
  }
  const table = arrow.tableFromIPC(bytes);
  if (table.numRows !== metadata.rows_fetched && table.numCols !== 0) {
    throw new Error("Arrow rows do not match the stream page metadata.");
  }
  const rows = [];
  let displayBytes = 0;
  let discardedThrough = 0;
  for (let row = 0; row < metadata.rows_fetched; row++) {
    /** @type {Record<string, string|number>} */
    const output = { row_index: metadata.first_row + row + 1 };
    for (const column of descriptor.columns) {
      const ipc = column.ipc_index;
      if (column.unsupported || ipc === null || ipc === undefined) {
        output[`c${column.position ?? column.index}`] = `Unsupported: ${
          column.unsupported ?? "no IPC mapping"
        }`;
      } else {
        const vector = table.getChildAt(ipc);
        if (!vector) {
          throw new Error("Arrow column mapping is outside the IPC schema.");
        }
        output[`c${column.position ?? column.index}`] = boundedText(
          formatArrowValue(vector, row),
        );
      }
    }
    for (const key of Object.keys(output)) {
      if (key !== "row_index") output[key] = boundedText(output[key]);
    }
    const size = 64 +
      Object.values(output).reduce(
        (sum, value) => sum + 16 + String(value).length * 2,
        0,
      );
    if (size > SEQUENTIAL_CACHE_BYTES) {
      throw new Error("One row exceeds the display cache capacity.");
    }
    rows.push(output);
    displayBytes += size;
    while (displayBytes > SEQUENTIAL_CACHE_BYTES) {
      const removed = rows.shift();
      discardedThrough = removed.row_index;
      displayBytes -= 64 +
        Object.values(removed).reduce(
          (sum, value) => sum + 16 + String(value).length * 2,
          0,
        );
    }
  }
  return { rows, discardedThrough };
}

// Progress survives display-cache eviction and view selection changes.
export function recordSequentialProgress(progress, metadata) {
  const { first_row: first, rows_fetched: count, rows_seen: seen, done } =
    metadata;
  if (
    ![first, count, seen].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    seen !== first + count || typeof done !== "boolean" ||
    first < progress.watermark
  ) {
    throw new Error(
      "The stream page has invalid or regressing progress metadata.",
    );
  }
  const gap = first > progress.watermark
    ? [progress.watermark + 1, first]
    : null;
  if (count > 0 || done) progress.watermark = seen;
  progress.received += count;
  progress.done = done;
  if (gap) progress.gap = gap;
  return gap;
}

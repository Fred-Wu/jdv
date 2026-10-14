const DEFAULT_TIMEOUT_MS = 30_000;

export function createBrowserTransport(socket, handlers = {}) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();

  function request(session, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (closed || socket.readyState !== 1) {
      return Promise.reject(new Error("The viewer is disconnected."));
    }
    const id = `viewer-${Date.now().toString(36)}-${(++nextId).toString(36)}`;
    const operation = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(id, new Error("The request timed out."), undefined, true);
      }, timeoutMs);
      pending.set(id, { id, session, method, params, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({
          type: "request",
          id,
          session,
          method,
          params,
          timeoutMs,
        }));
      } catch (error) {
        finish(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
    Object.defineProperty(operation, "id", { value: id });
    return operation;
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "busy") {
      handlers.onBusy?.(message.id, message.session, message.reason);
      return;
    }
    if (message.type === "response") {
      const item = typeof message.id === "string"
        ? pending.get(message.id)
        : null;
      if (!item || item.session !== message.session) return;
      if (message.error) {
        const error = new Error(
          message.error.message ?? "The R request failed.",
        );
        error.code = message.error.code ?? "r_error";
        error.details = message.error.details;
        finish(item.id, error);
      } else {
        finish(item.id, null, message);
      }
      return;
    }
    if (message.type === "error" || message.type === "cancelled") {
      const item = typeof message.id === "string"
        ? pending.get(message.id)
        : null;
      if (!item || (message.session && item.session !== message.session)) {
        return;
      }
      const error = message.type === "cancelled"
        ? abortError("The request was cancelled.")
        : Object.assign(
          new Error(message.message ?? "The request failed."),
          { code: message.code ?? "request_failed" },
        );
      finish(item.id, error);
    }
  }

  function cancel(id, reason = "The request is obsolete.") {
    const item = pending.get(id);
    if (!item) return false;
    if (!closed && socket.readyState === 1) {
      try {
        socket.send(
          JSON.stringify({ type: "cancel", id, session: item.session }),
        );
      } catch {
        // The pending request is still settled locally if the socket is closing.
      }
    }
    finish(id, abortError(reason));
    return true;
  }

  function cancelTable(session, table, generation, reason) {
    for (const item of [...pending.values()]) {
      if (
        item.session === session && item.params?.view === table &&
        item.params?.generation === generation
      ) cancel(item.id, reason ?? "The table is no longer available.");
    }
  }

  function cancelSession(session, reason = "The R session disconnected.") {
    for (const item of [...pending.values()]) {
      if (item.session === session) cancel(item.id, reason);
    }
  }

  function cancelAll(reason = "The viewer disconnected.") {
    for (const item of [...pending.values()]) cancel(item.id, reason);
  }

  function close(reason = "The viewer disconnected.") {
    if (closed) return;
    closed = true;
    for (const item of [...pending.values()]) {
      finish(item.id, abortError(reason));
    }
    handlers.onDisconnect?.();
  }

  function finish(id, error, value, sendCancel = false) {
    const item = pending.get(id);
    if (!item) return;
    if (sendCancel) {
      try {
        socket.send(JSON.stringify({
          type: "cancel",
          id,
          session: item.session,
        }));
      } catch {
        // Local timeout remains authoritative if the socket is unavailable.
      }
    }
    clearTimeout(item.timer);
    pending.delete(id);
    if (error) item.reject(error);
    else item.resolve(value);
  }

  return {
    request,
    handleMessage,
    cancel,
    cancelTable,
    cancelSession,
    cancelAll,
    close,
  };
}

export function columnWindow(
  totalCols,
  scrollLeft,
  viewportWidth,
  { columnWidth = 180, overscan = 2, maxColumns = 256, leadingWidth = 0 } = {},
) {
  const count = Number.isSafeInteger(totalCols) ? Math.max(0, totalCols) : 0;
  const width = Math.max(1, Number.isFinite(columnWidth) ? columnWidth : 180);
  const viewport = Math.max(
    1,
    Number.isFinite(viewportWidth) ? viewportWidth : width,
  );
  const extra = Math.max(0, Number.isSafeInteger(overscan) ? overscan : 2);
  const cap = Math.max(
    1,
    Math.min(256, Number.isSafeInteger(maxColumns) ? maxColumns : 256),
  );
  const visible = Math.max(1, Math.ceil(viewport / width));
  const size = count === 0 ? 0 : Math.min(count, cap, visible + 2 * extra);
  const fixed = Math.max(0, Number.isFinite(leadingWidth) ? leadingWidth : 0);
  const firstVisible = Math.min(
    count,
    Math.floor(Math.max(0, scrollLeft - fixed) / width),
  );
  const start = count === 0
    ? 0
    : Math.max(0, Math.min(count - size, firstVisible - extra));
  const end = start + size;
  return {
    start,
    end,
    columns: Array.from({ length: size }, (_, index) => start + index),
    offsetPx: start * width,
    totalWidth: fixed + count * width,
  };
}

function abortError(message) {
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  return Object.assign(new Error(message), { name: "AbortError" });
}

export async function fillRemotePage({
  offset,
  limit,
  fetchPage,
  decode,
  isCurrent = () => true,
}) {
  const rows = [];
  const warnings = [];
  let cursor = offset;
  let total = 0;
  let queryTotal = null;
  let totalUnfiltered = null;
  let remaining = limit;
  while (remaining > 0) {
    if (!isCurrent()) throw abortError("The query was replaced.");
    const response = await fetchPage({ offset: cursor, limit: remaining });
    if (!isCurrent()) throw abortError("The query was replaced.");
    const result = response?.result;
    if (!result || !result.data || !Array.isArray(result.data.row_index)) {
      throw new Error("R returned an invalid table page.");
    }
    total = result.total;
    if (
      !Number.isSafeInteger(total) || total < 0 ||
      !Number.isSafeInteger(result.total_unfiltered) ||
      result.total_unfiltered < 0 || total > result.total_unfiltered
    ) {
      throw new Error("R returned invalid query totals.");
    }
    if (queryTotal !== null && queryTotal !== total) {
      throw new Error("R changed the filtered row count between pages.");
    }
    queryTotal = total;
    if (
      totalUnfiltered !== null && totalUnfiltered !== result.total_unfiltered
    ) {
      throw new Error("R changed the unfiltered row count between pages.");
    }
    totalUnfiltered = result.total_unfiltered;
    const count = result.data.row_index.length;
    if (!Number.isSafeInteger(result.offset) || result.offset < 0) {
      throw new Error("R returned invalid page bounds.");
    }
    if (count === 0) {
      if (cursor >= total) break;
      throw new Error(
        "R returned an empty page before the requested rows were complete.",
      );
    }
    const part = decode(result);
    if (!Array.isArray(part) || part.length !== count) {
      throw new Error(
        "The decoded page row count does not match R's response.",
      );
    }
    rows.push(...part);
    warnings.push(...(response.warnings ?? []));
    cursor = result.offset + count;
    remaining -= count;
    if (cursor >= total) break;
  }
  return { total, total_unfiltered: totalUnfiltered, rows, warnings };
}

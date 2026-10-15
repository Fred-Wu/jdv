// Retain only a small browser-local set of Arrow IPC pages for value inspection.
export const ARROW_PAGE_CACHE_BYTES = 32 * 1024 * 1024;
export const ARROW_PAGE_CACHE_PAGES = 8;

export function createArrowPageCache(
  maxBytes = ARROW_PAGE_CACHE_BYTES,
  maxPages = ARROW_PAGE_CACHE_PAGES,
) {
  if (
    !Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
    !Number.isSafeInteger(maxPages) || maxPages < 1
  ) throw new Error("Invalid Arrow page cache capacity.");

  const pages = new Map();
  let bytes = 0;
  let clock = 0;

  function remove(key) {
    const entry = pages.get(key);
    if (!entry) return false;
    pages.delete(key);
    bytes -= entry.payload.byteLength;
    return true;
  }

  function trim() {
    while (bytes > maxBytes || pages.size > maxPages) {
      let oldestKey;
      let oldestUse = Infinity;
      for (const [key, entry] of pages) {
        if (entry.lastUsed < oldestUse) {
          oldestKey = key;
          oldestUse = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) break;
      remove(oldestKey);
    }
  }

  function copyPayload(payload) {
    if (payload instanceof ArrayBuffer) return payload.slice(0);
    if (
      ArrayBuffer.isView(payload) && payload.BYTES_PER_ELEMENT === 1 &&
      payload.buffer instanceof ArrayBuffer
    ) {
      return payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      );
    }
    return null;
  }

  return {
    set(key, payload, metadata, scope) {
      const body = copyPayload(payload);
      if (
        typeof key !== "string" || key.length === 0 || !body ||
        !scope || typeof scope.session !== "string" ||
        typeof scope.view !== "string" ||
        !Number.isSafeInteger(scope.generation) ||
        !Number.isSafeInteger(metadata?.page)
      ) throw new Error("Invalid Arrow page cache entry.");
      if (body.byteLength > maxBytes) {
        remove(key);
        return false;
      }
      remove(key);
      pages.set(key, {
        payload: body,
        metadata: { ...metadata },
        scope: { ...scope },
        lastUsed: ++clock,
      });
      bytes += body.byteLength;
      trim();
      return pages.has(key);
    },
    get(key) {
      const entry = pages.get(key);
      if (!entry) return null;
      entry.lastUsed = ++clock;
      return { payload: entry.payload, metadata: { ...entry.metadata } };
    },
    deleteView(session, view) {
      for (const [key, entry] of pages) {
        if (entry.scope.session === session && entry.scope.view === view) {
          remove(key);
        }
      }
    },
    clear() {
      pages.clear();
      bytes = 0;
    },
    get bytes() {
      return bytes;
    },
    get size() {
      return pages.size;
    },
    keys() {
      return [...pages.keys()];
    },
  };
}

// Host-owned opaque IPC pages. No Arrow parsing is performed here.
export const DEFAULT_STREAM_CACHE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_STREAM_CACHE_VIEW_BYTES = 64 * 1024 * 1024;
export const STREAM_CACHE_PAGE_OVERHEAD = 1024;
export const STREAM_CACHE_INFO_LIMIT = 128;

export interface StreamCacheOptions {
  streamCacheBytes?: number;
  streamCacheViewBytes?: number;
}

export interface StreamProgress {
  first_row: number;
  rows_fetched: number;
  rows_seen: number;
  done: boolean;
}

export interface StreamCachePage extends StreamProgress {
  page: number;
  byte_length: number;
  unavailable_before_range?: [number, number];
}

interface StoredPage {
  metadata: StreamCachePage;
  body: Uint8Array;
  charge: number;
}
interface CachedView {
  pages: Map<number, StoredPage>;
  bytes: number;
  last_page: number;
  rows_seen: number;
  done: boolean;
}

function byteLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(
      "Stream cache limits must be non-negative safe integer byte counts.",
    );
  }
  return result;
}

export class StreamPageCache {
  readonly totalLimit: number;
  readonly viewLimit: number;
  readonly #views = new Map<object, CachedView>();
  readonly #fifo = new Map<StoredPage, CachedView>();
  #bytes = 0;

  constructor(options: StreamCacheOptions = {}) {
    this.totalLimit = byteLimit(
      options.streamCacheBytes,
      DEFAULT_STREAM_CACHE_BYTES,
    );
    this.viewLimit = Math.min(
      this.totalLimit,
      byteLimit(options.streamCacheViewBytes, DEFAULT_STREAM_CACHE_VIEW_BYTES),
    );
  }

  get enabled(): boolean {
    return this.totalLimit > 0 && this.viewLimit > 0;
  }
  get bytes(): number {
    return this.#bytes;
  }

  capability() {
    return this.enabled
      ? {
        version: 1,
        max_total_bytes: this.totalLimit,
        max_view_bytes: this.viewLimit,
        page_overhead_bytes: STREAM_CACHE_PAGE_OVERHEAD,
      }
      : false;
  }

  #view(key: object): CachedView {
    let view = this.#views.get(key);
    if (!view) {
      view = {
        pages: new Map(),
        bytes: 0,
        last_page: -1,
        rows_seen: 0,
        done: false,
      };
      this.#views.set(key, view);
    }
    return view;
  }

  tail(key: object) {
    const view = this.#views.get(key);
    return {
      last_page: view?.last_page ?? -1,
      rows_seen: view?.rows_seen ?? 0,
      done: view?.done ?? false,
    };
  }

  record(
    key: object,
    progress: StreamProgress,
    bytes: Uint8Array,
  ): StreamCachePage | null {
    if (!this.enabled) return null;
    const view = this.#view(key);
    if (
      (view.done &&
        !(progress.done && progress.rows_fetched === 0 &&
          progress.first_row === view.rows_seen)) ||
      progress.first_row < view.rows_seen ||
      !Number.isSafeInteger(view.last_page + 1)
    ) {
      return null;
    }
    const metadata: StreamCachePage = {
      page: view.last_page + 1,
      first_row: progress.first_row,
      rows_fetched: progress.rows_fetched,
      rows_seen: progress.rows_seen,
      done: progress.done,
      byte_length: bytes.byteLength,
    };
    if (progress.first_row > view.rows_seen) {
      metadata.unavailable_before_range = [view.rows_seen, progress.first_row];
    }
    view.last_page = metadata.page;
    view.rows_seen = progress.rows_seen;
    view.done = progress.done;
    // Charge even empty pages. Slice detaches from potentially huge receive buffers.
    const stored = {
      metadata,
      body: bytes.slice(),
      charge: bytes.byteLength + STREAM_CACHE_PAGE_OVERHEAD,
    };
    view.pages.set(metadata.page, stored);
    view.bytes += stored.charge;
    this.#fifo.set(stored, view);
    this.#bytes += stored.charge;
    while (view.bytes > this.viewLimit) {
      this.#remove(view.pages.values().next().value!, view);
    }
    while (this.#bytes > this.totalLimit) {
      const [oldest, owner] = this.#fifo.entries().next().value!;
      this.#remove(oldest, owner);
    }
    return this.#metadata(metadata);
  }

  #metadata(value: StreamCachePage): StreamCachePage {
    const result = { ...value };
    if (value.unavailable_before_range) {
      result.unavailable_before_range = [...value.unavailable_before_range];
    }
    return result;
  }

  info(key: object, afterPage = -1, limit = 64) {
    const view = this.#views.get(key);
    const selected: StreamCachePage[] = [];
    let more = false;
    if (view) {
      for (const stored of view.pages.values()) {
        if (stored.metadata.page <= afterPage) continue;
        if (selected.length === limit) {
          more = true;
          break;
        }
        selected.push(this.#metadata(stored.metadata));
      }
    }
    const first = view?.pages.values().next().value as StoredPage | undefined;
    return {
      pages: selected,
      next_after: more ? selected.at(-1)!.page : null,
      ...this.tail(key),
      unavailable_before: first?.metadata.first_row ?? view?.rows_seen ?? 0,
    };
  }

  get(key: object, page: number) {
    const stored = this.#views.get(key)?.pages.get(page);
    return stored
      ? { metadata: this.#metadata(stored.metadata), body: stored.body }
      : null;
  }

  #remove(page: StoredPage, owner: CachedView) {
    owner.pages.delete(page.metadata.page);
    owner.bytes -= page.charge;
    this.#fifo.delete(page);
    this.#bytes -= page.charge;
  }

  drop(key: object) {
    const view = this.#views.get(key);
    if (!view) return;
    for (const stored of view.pages.values()) this.#remove(stored, view);
    this.#views.delete(key);
  }

  clear() {
    this.#views.clear();
    this.#fifo.clear();
    this.#bytes = 0;
  }
}

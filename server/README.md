# jdv reference server

The Deno reference server connects to R over a local JSON Lines (JSONL)
transport and serves the browser viewer from `web/`. Project files are
distributed under [LICENSE.md](LICENSE.md). The viewer also vendors Tabulator
6.5.0 under its MIT license; see `web/vendor/TABULATOR-LICENSE.txt`. Apache
Arrow JS 21.2.0 is vendored under Apache-2.0 for planned binary decoding, with
notices and provenance in `web/vendor/`; it is not yet loaded by the viewer.

## Start from a URL

Deno 2.8 or newer is required for stable text imports. Run the server directly
from its hosted module URL; its relative imports load the listener and viewer
assets from the same URL tree.

```sh
deno run -A --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
```

The command prints one JSON line to standard output with `url` and `socketPath`.
Open the printed URL in a browser, then call `jdv::jdv_view(x)` in R. Data
frames and matrices open as tables; other R objects open in the tree viewer. The
server listens for browser traffic on `127.0.0.1` only. Its R listener uses a
Unix-domain socket on Unix systems and a Windows named pipe on Windows. The
cache directory and discovery file are private to the current user on Unix; the
socket has mode `0600`. Windows named-pipe access follows the OS default ACL,
which Deno does not let this server harden.

`-A` is used in this portable example because Unix socket and Windows named pipe
permissions differ across platforms. When using TCP for the R connection, select
it explicitly with `--tcp`; the ready line then reports a loopback `tcp://`
`socketPath`. TCP is unauthenticated and may be reachable by other users on the
same machine. `--token VALUE` optionally protects the browser WebSocket
connection; the token is included in the printed URL and discovery file. Static
viewer assets remain available on loopback without the token.

The discovery file is written atomically to the standard jdv user cache
directory. `--cache-dir PATH` or `JDV_CACHE_DIR` selects a different directory.
When using a custom host cache directory, configure R with the matching
`options(jdv.discovery_path = ...)` or `JDV_ADDRESS` setting so it connects to
the same discovery address. On shutdown the server removes the discovery file
only when it still contains that server's process id and private instance id.

## Sequential page cache

The host retains opaque Arrow IPC pages per R session, view, and generation, so
switching views, reloading, or opening another tab can restore received rows
without another R request. Valid late replies after cancellation, timeout, or
browser detachment are also retained. Reading cached pages does not take the
stream's owner lease; advancing the R stream still does.

The default memory budget is 256 MiB total and 64 MiB per view. Each page costs
its raw byte length plus 1,024 bytes for bounded metadata, including zero-row
pages. Oldest pages are evicted first. This is accounting for retained pages,
not a JavaScript process-heap guarantee. An oversized page can be evicted
immediately; its page index, row watermark, and EOF state remain available so
the viewer can identify rows no longer retained. Closing a view, replacing its
generation, cascading a parent close, or disconnecting R clears its cache.

Set byte counts with `--stream-cache-bytes` and `--stream-cache-view-bytes`; a
zero value disables the feature. For example:

```sh
deno run -A server/main.ts --stream-cache-bytes 134217728 --stream-cache-view-bytes 33554432
```

Embedders can use `streamCacheBytes` and `streamCacheViewBytes` in
`startServer()` options. The viewer detects `welcome.capabilities.stream_cache`
and uses the host-only `stream/cache/info` and `stream/cache/get` methods.
Catalogs default to 64 pages, are capped at 128, and paginate with a monotonic
page cursor. The catalog reports lost prefixes and gaps. Cache gets use the
ordinary bounded binary frame and carry their page metadata in
`result.cache_page`. A new append sends `after_page`; a stale cursor returns
`cache_changed` before R is contacted. Older hosts without the capability keep
the existing forward-only behavior. See
[the protocol](../spec/protocol.md#host-cache-for-sequential-pages) for
parameters and response fields.

The browser retains formatted display pages separately, with 8 MiB and 32 pages
per view and 32 MiB across views. Host-retained pages can be decoded again after
display eviction. Cache replies have a separate 32 MiB WebSocket queue admission
limit; exceeding it closes and detaches that browser without clearing the R
session or host page cache. Existing welcome messages, notifications, and live R
replies retain their delivery behavior. A send failure detaches the browser on
any output path. Once a range is no longer retained by the host, the
forward-only R source cannot fetch it again.

## Nested Arrow cells

The sequential viewer can inspect list, large-list, fixed-size-list, struct,
map, and nested dictionary values directly from retained IPC pages. It uses
browser-only breadcrumbs and child pages of at most 200 entries; it does not
request R object navigation or convert the stream to an R data frame. Exact
64-bit integers, decimals, and timestamps keep their physical-buffer precision
inside nested values as well.

Paths stop at 32 steps, dictionary resolution rejects cycles or more than 32
hops, and labels and summaries are limited to 4,096 code units, including any
truncation marker. Null and unsupported values are leaves. Columns omitted from
IPC show their existing unsupported reason; the browser cannot reconstruct them.
A missing local IPC page can be restored from the host cache without consuming
more stream rows. If neither cache retains it, inspection reports that the page
is unavailable. The separate raw IPC cache retains at most eight pages and 32
MiB in aggregate, plus the single active inspector page.

## Browser WebSocket protocol

The WebSocket endpoint is `/ws`. It accepts frames only when `Host` names the
server's loopback host and port and `Origin` exactly matches the advertised HTTP
origin. The UI and endpoint use the advertised `127.0.0.1` origin; other origins
and DNS-rebound host names are rejected. This checks browser origin; it is not
authentication against other local processes.

On connect, a client receives a `welcome` object containing protocol version 1
and the current R sessions and cached view descriptors. Later server events use
`session/open`, `session/closed`, `view/open`, `view/closed`, and `notification`
message types. A `view/open` message preserves the original R protocol message,
including the complete `data` payload for Snapshot views.

Send requests with a unique string id per WebSocket client and session:

```json
{
  "type": "request",
  "id": "page-1",
  "session": "r-1234-1",
  "method": "table/rows",
  "params": { "view": "v-1", "generation": 1, "offset": 0, "limit": 200 }
}
```

The server accepts `table/rows`, `view/schema`, `object/children`,
`object/open`, `view/close`, `stream/next`, `stream/cache/info`, and
`stream/cache/get`. Object requests carry the view generation and a typed path
rooted at that view. `object/children` is tree-only. Grid `object/open` paths
start with `{"kind":"cell","row_index":205,"column":2}`: the row is the original
one-based R index and the column is its zero-based schema position. Optional
suffix steps use tree path forms. The column must have `drillable: true`, and
the grid's `capabilities.children` must be true. Object child pages are capped
at 500 entries; paths are capped at 32 steps. Opening a child registers a
captured value as a new view. Closing a child releases that view without closing
its parent. Responses use `type: "response"` and carry the original client id. A
`busy` event is informational and does not cancel the request. A client may send
`{"type":"cancel","id":"page-1","session":"r-1234-1"}`; it is forwarded as an R
`cancel` notification when the request was already sent. Unsent `table/rows` and
`object/children` requests use separate coalescing rules. For the same client,
session, view, and generation, an unsent `table/rows` request is replaced by the
latest page request. An unsent `object/children` request is replaced only by a
new request with the same full typed path; a different path stays in its own
lane. A request already sent to R is allowed to finish; later requests in the
same lane wait behind it.

Browser WebSocket input frames are limited to 64 KiB. Incoming R JSONL frames
are limited to 10 MiB.

Each R hello must include positive integer limits for received frames and bytes,
queued messages and bytes, and a single request size. The host clamps its wire
window to 128 frames and 512 KiB, with up to 32 frames and 16 KiB reserved for
cancellation while preserving ordinary capacity under smaller negotiated limits.
It also clamps active requests to 32 and retained request bytes to 16 MiB. A
request stays in the retained queue until its terminal R reply, even if the
browser cancels it or its deadline expires.

R acknowledges complete host frames with
`{"method":"ack","params":{"frames":N}}`, where `N` is the cumulative frame
count for that connection. A valid ACK releases wire frame and byte credit
through `N`; repeated ACKs are harmless, and invalid or future counts do not
release credit. A terminal request reply releases only that request's slot and
retained queue bytes. This separation lets the server continue sending `wake`
every 50 ms while R is inside an ordinary top-level wait, even when R cannot
dispatch requests until it returns to the prompt. Frames are serialized, limited
to 128 per second and 16 per send batch. The host pauses wakes and new requests
when negotiated credit is exhausted, surfaces a busy event, and does not retry
requests.

## Development

The server uses only Deno APIs and Node's built-in `node:net` adapter for named
pipes. No repository checkout, import map, or project configuration is needed
when started by URL.

```sh
deno fmt --check server
deno lint --ignore=server/web/vendor/tabulator.min.js,server/web/vendor/tabulator.min.css,server/web/vendor/arrow-21.2.0.min.js server
deno check server/main.ts
deno test -A server/tests
```

The repository `deno.json` excludes the vendored Tabulator minified JavaScript
and CSS and Arrow JavaScript bundle from formatting. It contains no imports or
dependencies; the URL startup command uses `--no-config` and remains
self-contained.

The Hub, platform, and R framing unit tests need only Deno. The full suite also
includes R numeric fixtures and an interactive transport regression that runs an
interactive R process with `--no-readline` against a real TCP server. It holds R
in `Sys.sleep(10)`, checks that browser requests finish without manual polling,
and repeats wire cancellation while verifying one terminal reply per request.
Select the installed package explicitly with
`JDV_TEST_R_LIB=/path/to/scratch-library deno test -A server/tests`.

The Unix socket, HTTP origin checks, discovery, and R relay tests run on Linux.
The Windows named-pipe listener uses the built-in Node compatibility API but has
not been exercised on a Windows host. The viewer lists active R sessions, grid
views, and object trees. Tree child values and drillable grid cells can be
opened as independent grid or tree views; closing a child releases it while
keeping its parent available. Grid Open buttons are shown only for columns
marked `drillable`: unclassed, `AsIs`, or `vctrs_list_of` list columns,
data-frame columns, and matrix columns. Record columns, `POSIXlt`, other classed
lists, and atomic columns do not expose cell controls. The UI always sends the
original R row index after sorting, filtering, or paging. The view breadcrumb
restores the parent's query, page, and horizontal scroll, or its object path and
child-page offset.

A child open waiting for R is shown separately from page loading. Snapshot sort,
filter, and page changes keep working without canceling that original cell
request. Its child opens automatically when R handles it at the prompt, provided
the same parent view and generation remain selected. Snapshot queries run in the
browser from the cached payload; Paged queries use the WebSocket request path.
Sorting and filtering are translated to the shared query semantics, and remote
pagination fills a requested page if R reduces an individual response to fit its
output budget. Wide tables keep all schema entries but request only a fixed
width viewport column window (up to 256 columns) as the user scrolls. The viewer
requires datetime filter values to include `Z` or a numeric timezone offset in
both modes. The R request contract can interpret offset-free datetimes using the
session timezone, but the viewer applies the same explicit input rule to
Snapshot and Paged tables because it cannot infer that timezone from a cached
Snapshot.

## Real R end-to-end tests

The real-session viewer regressions use `arf` to control a headless R process.
They run the installed `jdv` package against the real Deno server and route R
traffic through a test-only TCP relay that records compact JSON frame metadata.
The relay is outside the production server and lets tests check request counts,
Snapshot descriptors, and Paged responses without changing server behavior.

Build or install `jdv` into a scratch library with `devtools`, then run the
focused E2E file with that library selected:

```sh
JDV_TEST_R_LIB=/path/to/scratch-library deno test -A --no-config server/tests/e2e_test.ts
```

The `arf` executable must be on `PATH`. The test process prepends the selected
scratch library to `.libPaths()`, loads `jdv` from that exact library, and logs
the package and DLL paths once. These tests cover Snapshot queries without R
requests, Paged queries without serializing the full table at registration,
request handling while R is in a top-level wait, immediate same-process
reconnection after host disconnect, and agreement between the two query modes.
The reconnect case also checks that the old table and shared registry entries
are released before the new Paged request succeeds. The tests do not use the
`jdv_rpc(NULL)` polling loop from the unit integration fixture.

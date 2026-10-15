# jdv Protocol v1

This document defines the JSON protocol implemented by `jdv_register()`,
`jdv_rpc()`, and the local transport. It describes the R view registry, JSON
Lines (JSONL) messages, optional Arrow IPC binary response bodies, and request
and response messages shared by the package, reference server, and viewer,
including object-tree navigation.

The envelope is JSON-RPC-like, but it is not JSON-RPC 2.0: messages use a
`method` and `params`, while successful responses use `id`, `result`, and
`warnings`. A request that expects a response has an `id`. Notifications such as
`wake`, `cancel`, and `ack` omit the id and have no response.

## Compatibility and encoding

- Each JSON transport message is one UTF-8 JSON value framed as one complete
  JSON value per line with a trailing LF. A partial line is retained only up to
  the configured request byte limit. An Arrow IPC response may be followed by an
  opaque binary body as described below.
- The only supported envelope encoding is `json`; the only supported compression
  is `none`. Both fields may be omitted to select those defaults. Unknown values
  produce an `unsupported` error.
- A view id is a string. Column positions and sequential `first_row` offsets are
  zero-based. `row_index` is the original one-based R row number, including
  after filtering and sorting.
- Request ids are either strings of at most 128 UTF-8 bytes or JSON integer
  literal tokens from 0 through `2^53 - 1`. Fractional and exponent-form numeric
  ids are rejected, even when their mathematical value is integral. The same
  rule applies to `cancel.params.id`. When a response echoes a valid numeric id,
  its JSON encoder may use exponent notation as long as the exact safe-integer
  value is preserved.
- Envelope and method-parameter objects ignore unknown fields for forward
  compatibility. Filter, sort, and `stream/next` parameter objects remain
  strict. Duplicate object keys are rejected. Unknown methods return
  `method_not_found`.
- The page request method remains `table/rows` and identifies its owner with
  `params.view`. Lifecycle methods use the view names listed below; the former
  `table/open`, `table/closed`, `table/schema`, and `table/close` names are not
  aliases.
- Unknown optional schema fields must be ignored by clients. Protocol v1 defines
  child views opened from tree objects; it does not define cell inspection.
- The parser rejects malformed JSON number grammar, invalid UTF-8, decoded
  U+0000, trailing non-whitespace data, nesting deeper than 128, more than
  100,000 JSON nodes, or an object with more than 1,024 members. The literal
  six-character content `\u0000` is valid when represented in JSON as
  `"\\u0000"`; a JSON escape that decodes to U+0000 is rejected. These
  structural limits apply to inbound requests. Generated R messages are bounded
  by the outbound byte limit and are not revalidated with the request parser's
  node or object-member limits.

The R package uses base R and its bundled cJSON implementation at runtime. It
does not require jsonlite. Consumers can parse and construct JSON with their own
tooling and pass the resulting JSON string to `jdv_rpc()`.

## Registration API

```r
jdv_register(
  x,
  title = NULL,
  mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale")
)

jdv_rpc(request = NULL)

jdv_view(x, title = NULL, mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale"))

jdv_close(id = NULL)
```

`x` may be a data frame, matrix, or another R object. Data frames and matrices
register as grid views. Arrow Table and RecordBatchReader objects,
`nanoarrow_array_stream` pointers, and Polars DataFrame objects register as
forward-only Arrow grid views through the optional nanoarrow producer adapter.
Their `mode` and `collation` arguments do not change sequential access. Other
objects use the tree view by default. `jdv_register()` returns
`list(id, open, notifications)`. `open` is a `view/open` JSON message.
`notifications` is a character vector of pending notification JSON messages, or
`character()` when there are none. The embedding host must deliver each
notification in vector order before delivering `open`. Registration does not
open a socket.

`jdv_view()` registers the view, opens the local connection on first use, sends
`hello`, pending `view/closed` notifications, then `view/open`, and returns the
view id invisibly. The R API keeps the return-list key `id` and generates opaque
view id strings such as `v-1`; consumers must not interpret the id format. Its
default title is the deparsed expression passed as `x`; an explicit
`title = NULL` creates a new slot. `jdv_close(id)` closes one view, and
`jdv_close()` closes every view. Closing the last view stops the connection.
`jdv_rpc()` with no argument or `NULL` explicitly polls the active connection
and drains at most eight requests. This recovery path bypasses the normal event
gate and is non-reentrant. Passing a JSON string to `jdv_rpc()` remains a
synchronous, transport-independent embedding call.

The address is selected from `options(jdv.address = ...)`, then `JDV_ADDRESS`,
then `discovery.json` under the user cache directory. On Linux and other Unix
systems, the directory is `$XDG_CACHE_HOME/jdv` or `~/.cache/jdv`; on macOS it
is `~/Library/Caches/jdv`; on Windows it is `%LOCALAPPDATA%/jdv` or
`%USERPROFILE%/AppData/Local/jdv`. The discovery file is at most 64 KiB and
contains a string field named `socketPath`. Unix-domain socket paths may be raw
absolute paths or `unix:///absolute/path`; Windows named-pipe addresses use
`npipe:////./pipe/NAME`. A `tcp://localhost:port`, `tcp://127.0.0.1:port`, or
`tcp://[::1]:port` address is accepted only when explicitly configured. TCP has
no authentication, and named-pipe ACLs are not hardened. Windows named pipes
must use byte-type mode; message-type pipes are unsupported. The Windows
transport has not yet been exercised on a Windows host.

A non-`NULL` title identifies one active display slot. Registering that active
title again replaces its contents, reuses its view id, and increments its
generation. The new view is prepared before the prior view is replaced, so a
failed registration leaves the prior registration intact. Closing or evicting a
title removes its title mapping; registering it later creates a new id at
generation 1. `NULL` titles always create independent registrations. A new slot
starts at generation 1. If `jdv.max_tables` is lowered below the active count,
registration evicts as many oldest entries as needed to satisfy it.

Snapshot registration materializes and encodes its data in the `open` message.
After successful message construction, a Snapshot with drillable columns retains
its source and registration fingerprint in R for cell inspection. Other
Snapshots retain only table metadata. The host is responsible for caching the
snapshot data in both cases, and neither has a `table/rows` endpoint. Paged
registration retains the source and its initial schema in R and returns schema
and dimensions in `open`; rows are computed on demand.

For Paged tables, dimensions, column names, and column classes are checked
against the registration fingerprint on requests. Mutation of values through a
shared reference cannot be detected reliably. Register the table again whenever
values, schema, methods, or options that affect extracted channels change.
Re-registration creates a fresh holder and cache. Changing a class method while
continuing to use already cached channels does not guarantee refresh.

The default collation is `getOption("jdv.collation", "C")`. Current options
include `jdv.max_message_bytes` (default 10 MiB, minimum 1,024),
`jdv.max_request_bytes` (default 1 MiB, minimum 128), `jdv.max_tables` (default
64), `jdv.max_page_rows` (default 2,000), `jdv.snapshot_max_cells` (default
10,000), `jdv.snapshot_max_bytes` (default 10 MiB), `jdv.max_work_bytes`
(default `Inf`), `jdv.max_cache_bytes` (default 32 MiB), and
`jdv.max_query_rows` (default `Inf`). The work and row limits apply to full
sort/filter operations; setting either option to a finite value restores the
corresponding `limit_exceeded` guard. Page, work, cache, and query-row settings
are captured when a Paged holder is registered; re-register the table to apply
changed options.

`mode = "auto"` selects Snapshot only when both the cell estimate
`nrow * max(1, ncol)` and a deterministic byte estimate fit their thresholds.
The byte threshold is `min(jdv.snapshot_max_bytes, jdv.max_message_bytes)`. The
cell estimate counts `row_index` even for a zero-column table. Byte estimation
samples at most 256 evenly spaced rows; snapshot construction then checks actual
source string lengths and generated channel sizes. A sampled estimate can
therefore miss a large value, in which case automatic mode discards the
incomplete Snapshot attempt and registers a Paged holder. Forced Snapshot mode
returns `limit_exceeded` instead.

## Message envelopes

A view descriptor is sent as a notification:

```json
{
  "method": "view/open",
  "params": {
    "view": "v-1",
    "generation": 1,
    "title": "example",
    "mode": "paged",
    "kind": "grid",
    "access": "random",
    "encoding": "r-json",
    "capabilities": {
      "seek": true,
      "sort": true,
      "filter": true,
      "known_total": true,
      "next": false,
      "children": false
    },
    "collation": "C",
    "nrow": 100,
    "ncol": 2,
    "row_names": null,
    "columns": []
  }
}
```

The example omits schema entries for brevity. `view/open` has no request id and
is not passed to `jdv_rpc()`; it is returned by `jdv_register()` for the host to
deliver. `kind` is `grid`; `access` is `snapshot` or `random` for Snapshot or
Paged mode, respectively; and `encoding` is `r-json`. Every descriptor includes
all six `capabilities` fields shown for a grid: `seek`, `sort`, `filter`, and
`known_total` are `true`; `next` is `false`. Grid `children` is `true` if and
only if at least one column has `drillable: true`. Tree descriptors use
`kind: "tree"`, `access: "random"`, `encoding: "r-json"`, and capabilities
`seek: true`, `sort: false`, `filter: false`, `known_total: true`,
`next: false`, and `children: true`. Tree descriptors omit grid-only fields
(`mode`, `nrow`, `ncol`, `row_names`, `columns`, and `data`). A tree descriptor
includes an empty `path` at its root. A child descriptor may include `parent`,
the parent view id. `title` and `class` are optional; when present, `class` is
an array of strings.

| Descriptor field                                                   | Grid                                     | Tree                         |
| ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------- |
| `view`, `generation`, `kind`, `access`, `encoding`, `capabilities` | Required                                 | Required                     |
| `title`                                                            | Optional                                 | Optional                     |
| `mode`, `collation`, `nrow`, `ncol`, `row_names`, `columns`        | Required                                 | Omitted                      |
| `data`                                                             | Required for Snapshot; omitted for Paged | Omitted                      |
| `path`                                                             | Omitted                                  | Required; empty for the root |
| `class`                                                            | Omitted                                  | Optional string array        |
| `parent`                                                           | Optional on child views                  | Optional on child views      |

Grid-level flags declare the operations available in protocol v1; each column's
`sortable` field constrains sorting, and `filterable` constrains value-based
filter operators. `is_na` remains valid when a valid missingness mask is
available, even when `filterable` is false. Clients must accept `nrow: null`
when a grid row count is unknown; the protocol does not define `total_rows`. The
descriptor's `encoding` field does not change the envelope's `encoding: "json"`
setting. Snapshot mode's `params.data` contains the full data payload as
described under [Column payloads](#column-payloads).

A tree descriptor has no grid fields:

```json
{
  "method": "view/open",
  "params": {
    "view": "v-2",
    "generation": 1,
    "title": "object",
    "path": [],
    "kind": "tree",
    "access": "random",
    "encoding": "r-json",
    "class": ["list"],
    "capabilities": {
      "seek": true,
      "sort": false,
      "filter": false,
      "known_total": true,
      "next": false,
      "children": true
    }
  }
}
```

A request envelope has this shape:

```json
{
  "id": 1,
  "method": "table/rows",
  "params": {
    "view": "v-1",
    "generation": 1,
    "offset": 0,
    "limit": 200
  },
  "encoding": "json",
  "compression": "none",
  "deadline": 1791849600.0
}
```

Only `method` is required at the envelope level. `id` is required for methods
that return a result. `params` is required by view methods and `cancel`. Unknown
envelope and method-parameter fields are ignored. `encoding`, `compression`, and
`deadline` are optional. `deadline`, when provided, must be a finite JSON number
containing an absolute Unix timestamp in seconds. A synchronous or queued
request that is past its deadline before execution begins receives an `expired`
error response.

The configured request byte limit applies to the entire JSON text. The parser
also validates strict JSON number syntax and rejects duplicate object keys.

Warnings are collected up to 100 messages, each truncated to 512 characters. If
more warnings occur, the array ends with `"Additional warnings were omitted."`.

A successful response is:

```json
{
  "id": 1,
  "result": {},
  "warnings": []
}
```

Every response includes a `warnings` array, including an empty array when no
warnings were raised. Warnings from R methods invoked while handling the request
are collected and muffled at the request boundary. An error response is:

```json
{
  "id": 1,
  "error": {
    "code": "invalid_request",
    "message": "Invalid request."
  },
  "warnings": []
}
```

Errors raised after request processing begins, including user method errors and
interrupts, are returned to the request caller. Their `code` distinguishes the
failure class; `message` is bounded text and must not be used as a stable
machine-readable discriminator. An error may also include `details`. Every
accepted request receives exactly one terminal response. Work cancelled,
expired, or stale before it begins receives an error response with code
`cancelled`, `expired`, or `stale_generation`; a closed view receives
`view_not_found`. A synchronous `jdv_rpc()` call is an embedding path and does
not apply the local transport execution gate. It treats `wake` and `cancel` as
no-op notifications and returns `NULL` for them; the transport queue matches
cancellation ids to pending work before execution. `ack` is transport-owned and
flows only from R to the host; it is not passed to `jdv_rpc()`.

### Arrow IPC binary responses

An Arrow IPC body is reserved for a successful, id-bearing response. Its JSONL
header has the ordinary response envelope and a `result.transfer` descriptor:

```json
{
  "id": "jdv-request-id",
  "result": {
    "view": "v-1",
    "generation": 1,
    "transfer": { "encoding": "arrow-ipc", "byte_length": 1234 }
  },
  "warnings": []
}
```

The header line is followed immediately by exactly `byte_length` opaque bytes,
then by the next JSONL message. The receiver must not decode the body as UTF-8,
scan it for LF, or call the response handler before all bytes arrive. The
descriptor is not valid on notifications, errors, or `ack`. `byte_length` is a
non-negative safe integer. The response `id` is the host-issued request id and
must be a string. The UTF-8 JSON header is limited to 64 KiB, and the header,
its LF, and body together are limited to 10 MiB. The body has an absolute
30-second receive timeout; fragments do not extend it. Invalid lengths,
oversized frames, EOF, or timeout close the R connection and fail pending
requests as disconnected. Cancellation, expiry, and stale or unknown response
ids still drain a valid body before the next JSONL message is read.

There is no checksum or delimiter after the raw body. A sender that declares a
shorter length may be detected when the remaining bytes cannot form a valid
JSONL frame, but framing alone cannot detect a remainder that happens to be a
valid JSONL message.

The host forwards a response to the browser as one WebSocket binary message:
four bytes containing the UTF-8 JSON header length as an unsigned little-endian
integer, followed by the JSON header, followed by the unchanged raw body. The
header is rewritten with the browser request id and session. The rewritten
header remains limited to 64 KiB, and the complete WebSocket message to 10 MiB.
If either limit or the request's `max_bytes` is exceeded, the host returns one
`limit_exceeded` error after draining the R body and continues with the next
JSONL frame.

For a request that can return a binary body, `params.max_bytes` is optional.
When present it must be a non-negative safe integer; zero is valid. Its default
is the effective binary body cap. R caps a response at
`min(params.max_bytes, max(0, min(jdv.max_message_bytes, 10 MiB) - (64 KiB + 4)))`.
The `max_message_bytes` member of the R hello limits is optional for
compatibility with older peers; when omitted, the host uses 10 MiB. If present,
it must be a positive safe integer. The host applies the negotiated R cap and
checks the returned byte length against the request before forwarding it. After
draining the body, the host checks that the response view and generation match
the pending request; a mismatch returns one `invalid_request` or
`stale_generation` terminal error.

Internally, page encoding is isolated behind one private encoder boundary. It
accepts an already-owned Arrow stream and the page budgets, and returns a
self-contained IPC byte sequence with the metadata needed for the response.
Codec-specific work stays inside this boundary; stream movement and release,
view registration, binary framing and sending, and viewer behavior stay outside
it. This keeps the codec replaceable without changing those surrounding
responsibilities. The function signature and encoder implementation are
specified separately.

### Sequential Arrow views

Sequential descriptors have `kind: "grid"`, `access: "sequential"`,
`encoding: "arrow-ipc"`, `mode: "sequential"`, `nrow: null`, and a known `ncol`.
Only the `next` capability is true; `seek`, `sort`, `filter`, `known_total`, and
`children` are false. Registration calls the producer's `get_schema` but never
`get_next`. It moves one exported Arrow stream into native ownership. Close,
replacement, eviction, parent cascade, namespace unload, and R disconnection
release the stream and any carried batch exactly once. A release callback may
execute R code; registry identity and generation are rechecked before publishing
its result. Releases requested inside an active producer callback are deferred
until that callback has finished.

`schema` contains the original logical Arrow schema recursively: `format`,
`name`, `flags`, `metadata`, `metadata_encoding`, `children`, and `dictionary`.
Metadata is represented as hexadecimal bytes with `metadata_encoding: "hex"`.
Each original top-level column has `index`, `name`, `type`, `unsupported`, and
`ipc_index`; the added viewer fields `position`, `sortable`, `filterable`, and
`drillable` preserve the ordinary grid shape. Both index fields are zero-based.
`unsupported` is null for supported columns and otherwise explains why that
column was omitted from IPC. Its `ipc_index` is null. The parallel `mapping`
array maps original positions to IPC positions or null. Names may repeat and
must never be used to recover the mapping. Even a page with no supported columns
reports its row count in metadata.

`stream/next` accepts only `view`, `generation`, `max_rows`, and `max_bytes`.
`max_page_rows` is an optional descriptor field containing the positive safe
integer row cap captured at registration, clamped to 2,000. Changing the R
option later does not change an existing view's cap. `max_rows` defaults to
`min(200, captured cap)` and must be a positive safe integer no larger than that
cap. The viewer requests `min(200, descriptor.max_page_rows)` rows and validates
returned row counts against that request. For older descriptors without this
field it requests 200 rows; the host uses the legacy 2,000-row ceiling. When the
field is valid, the host rejects requests above it before granting a lease.
`max_bytes` uses the shared binary response budget above. Zero is a valid budget
but returns `limit_exceeded` before fetching because it cannot hold an IPC
stream. Offset, sorting, filtering, and count requests are rejected. The public
synchronous `jdv_rpc(JSON)` entry rejects `stream/next` before consuming the
producer; only the transport's private binary-capable entry can execute it.
Random `table/rows` and object navigation are unavailable for sequential views.

A successful binary response carries `view`, `generation`, `first_row`,
`rows_fetched`, `rows_seen`, `done`, and the reserved `transfer` object.
`first_row` is the zero-based source cursor before this page;
`rows_seen = first_row + rows_fetched`. Each page is a self-contained IPC stream
and never crosses an input batch boundary. `done` becomes true only after the
producer's end-of-stream sentinel has been observed. A data page can therefore
have `done: false` even when it contains the last rows. A following schema-only
zero-row page can report `done: true`. Empty batches are skipped with bounded
work; reaching that bound yields zero rows and `done: false`, which clients must
not treat as EOF.

The host leases a view generation to the first attached browser whose next
request is accepted. Other browsers receive `in_use` while that owner remains
attached, including between pages. At most one next request is pending per view
generation. Cancellation, timeout, or owner detachment does not fail the R
stream and does not rewind a sent request. Its slot remains reserved until the
late terminal response is drained and discarded. Detachment releases the lease;
a new owner then starts at the current source cursor. No additional host-to-R
failure control is sent. The host validates current generation and budgets
before granting a lease. An R connection loss closes all its views.

Producer schema/array/next failures and a single row exceeding the page budget
make the R stream terminally failed and release its resources. Later next
requests return `stream_failed`. Ordinary encoder/allocation failures retain the
carry and uncommitted offset for retry, as reported by the native boundary.
Request cancellation and host timeout are separate from these producer failures.

The viewer exposes Load next and an unknown total, without random navigation,
sorting, or filtering. It displays gaps between the last received cursor and a
new `first_row` as rows advanced but not displayed, including a skipped prefix
when a new browser takes over. Per-view-generation progress survives selecting
another view and display-cache eviction; zero-row non-EOF pages do not advance
that cursor. EOF pages still report any skipped prefix. The display cache counts
UTF-16 text bytes plus 64 bytes per row and 16 per cell, capped at 8 MiB and 32
pages. It retains formatted rows rather than both raw IPC and decoded vectors.
This accounting is not a JavaScript heap guarantee. Cell strings and binary hex
are visibly truncated beyond 4,096 code units; exact decimal and timestamp
formatting is unaffected. Evicted ranges cannot be fetched again. Decimal
coefficients and signed/unsigned 64-bit integers are formatted exactly;
timestamps use raw integer ticks, including negative fractions and declared time
zones, rather than rounded millisecond getters. Nested values show a summary,
and omitted columns display their unsupported reason.

## Methods

| Method            | Direction        | Kind         | Result                                                                              |
| ----------------- | ---------------- | ------------ | ----------------------------------------------------------------------------------- |
| `view/open`       | R/host to viewer | Notification | Descriptor and, for Snapshot, all column payloads. Returned by `jdv_register()`.    |
| `view/schema`     | Host to R        | Request      | Current dimensions and schema.                                                      |
| `stream/next`     | Host to R        | Request      | One forward-only Arrow IPC page and cursor metadata.                                |
| `table/rows`      | Host to R        | Request      | One selected page from a Paged view.                                                |
| `object/children` | Host to R        | Request      | One page of children at a typed object path.                                        |
| `object/open`     | Host to R        | Request      | Registers the captured value at a typed path as a child view.                       |
| `view/close`      | Host to R        | Request      | Closes one view generation.                                                         |
| `view/closed`     | R to host        | Notification | Removes a closed, replaced, or evicted generation from the host cache.              |
| `hello`           | R to host        | Notification | Announces protocol and runtime versions for a new connection.                       |
| `wake`            | Host to R        | Notification | No result; asks the event loop to check its execution gate again.                   |
| `cancel`          | Host to R        | Notification | Names pending work for the local queue to cancel.                                   |
| `ack`             | R to host        | Notification | Cumulatively acknowledges complete host-to-R NDJSON frames read on this connection. |

### `view/schema`

Parameters are `view` and `generation`. The result contains `view`,
`generation`, `nrow`, `ncol`, and `columns`. A generation that is no longer
current produces `stale_generation` when handled synchronously. A missing or
closed view produces `view_not_found`.

### `object/children`

This method is available only on tree views. A grid with `children: true` uses
`object/open` to capture a cell; it does not expose `object/children`.

Parameters are `view`, `generation`, `path`, and optionally `offset` and
`limit`. The path is a full typed path from the root value held by the named
tree view; an empty path selects that root. `offset` is zero-based and defaults
to 0; `limit` defaults to 200 and must be between 1 and 500. A path contains at
most 32 steps. Each step is one of:

| Step `type` | Fields  | Meaning                                                |
| ----------- | ------- | ------------------------------------------------------ |
| `index`     | `index` | One-based position in an unnamed or positional object. |
| `binding`   | `name`  | Environment binding name.                              |
| `slot`      | `name`  | S4 slot name.                                          |
| `attr`      | `name`  | Attribute name.                                        |

The result contains the same `view`, `generation`, full `path`, and `offset`,
plus `children` and `total_children`. Each child has its one-based `index`,
bounded `label`, string-array `class`, bounded `summary`, `has_children`,
`viewable`, and its full typed `path` when the child is addressable. A child
whose binding, slot, or attribute name exceeds 1,000 characters is not
addressable: it has `viewable: false`, `has_children: false`,
`unavailable: "path_limit"`, and may omit `path`. Other children include the
full typed path. When a value cannot safely be read, the child carries a bounded
`unavailable` reason. Child text, each class string, and each summary are at
most 1,000 characters. Summaries inspect at most five values or children and at
most three levels deep. Environment names are enumerated locally and paged;
active and delayed bindings are reported as unavailable without reading their
values.

Tree navigation never evaluates a promise, active binding, classed `[[`, `$`, or
`names` method. Paths are resolved again for each `object/children` request.

### `object/open`

Parameters are `view`, `generation`, and a non-empty `path`. On a tree view,
every step uses the `type` discriminant from the table above. On a grid view,
the first step must select a drillable cell:

```json
{
  "view": "v-1",
  "generation": 1,
  "path": [{ "kind": "cell", "row_index": 205, "column": 2 }]
}
```

`row_index` is the original, one-based R row index, independent of sorting,
filtering, and pagination. `column` is the zero-based schema position, including
when column names are duplicated. `kind: "cell"` is allowed only at the start of
a grid path. Remaining steps, if any, use the tree `type` forms above and are
resolved within the captured cell value. The complete path, including its cell
step, contains at most 32 steps. Grid `object/open` requires
`capabilities.children: true` and `columns[column].drillable: true`; malformed
selectors or non-drillable columns return `invalid_request`.

Each grid column schema includes the Boolean `drillable`. It is true only for
unclassed list, `AsIs` list, `vctrs_list_of`, data-frame, and matrix columns. It
is false for record columns, `POSIXlt`, other classed lists, and atomic columns.
This metadata is independent of `sortable` and `filterable`; clients must not
infer drillability from display text. Snapshot views retain the R source only
when a drillable column needs subsequent cell capture. Retained source
references are released when the view closes.

`object/open` resolves the selected value once, holding that captured value in
the new view. A path that cannot be resolved returns `unavailable`; malformed
paths return `invalid_request`, missing views return `view_not_found`, and old
generations return `stale_generation`. The returned child descriptor is the
direct `view/open.params` descriptor. A tree child starts a new root with an
empty path; the descriptor may identify its parent with `parent`. The limit is
32 live descendant views total per root, counting nested tree and grid views
across all levels. Closing a child releases its slot for a later child view.
Closing, replacing, or evicting a parent closes its descendants; each cascaded
child emits `view/closed` with `reason: "parent_closed"`.

The browser uses the same child-view navigation for tree and grid parents.
Opening controls appear only in drillable cells and use the displayed row's
original `row_index`. View breadcrumbs restore the parent's sort, filter, page,
horizontal scroll, or tree path and child-page offset. A pending child open is
tied to the active parent view and generation, separately from page query
epochs: Snapshot sort, filter, and page operations remain local and do not
cancel the captured cell request. Returning to the R prompt lets that original
request complete without another browser request. Selecting a different view,
replacing its generation, or closing it cancels its pending browser requests.
Display text and navigation labels are inserted as DOM text.

R 4.6 and newer use the public experimental `R_GetBindingType()` and
`R_getVarEx()` APIs to distinguish `Value`, `Forced`, `Delayed`, `Unbound`,
`Missing`, and `Active` bindings. Only `Value` and `Forced` bindings are read;
`Delayed`, `Unbound`, `Missing`, and `Active` bindings are opaque, and delayed
expressions are never deparsed. On older R versions only active bindings can be
identified; other environment bindings are treated as opaque. For ALTREP values,
bounded element or region access may call the class's representation callbacks
to read values needed for a page or summary. This does not force delayed
promises or invoke active bindings. Tree access does not request `DATAPTR`; the
protocol does not guarantee total memory use by an ALTREP implementation. If
reading an individual child fails, that child is returned with an `unavailable`
reason and sibling children remain available. S4 `.Data` is opaque; slots are
inspected as stored values.

### `table/rows`

Parameters are:

| Field        | Required | Meaning                                                                                   |
| ------------ | -------- | ----------------------------------------------------------------------------------------- |
| `view`       | Yes      | Registered view id.                                                                       |
| `generation` | Yes      | Generation returned by `view/open`.                                                       |
| `offset`     | No       | Zero-based offset after filtering and sorting; defaults to 0.                             |
| `limit`      | No       | Requested page size; defaults to 200 and is clamped to the query engine's page row limit. |
| `sort`       | No       | Array of `{ "col": zeroBasedPosition, "desc": boolean }` objects; defaults to no sort.    |
| `filter`     | No       | Filter AST defined by [`query.md`](query.md); defaults to no filter.                      |
| `cols`       | No       | Array of zero-based column positions; omitted or `null` selects all columns.              |

The result contains `view`, `generation`, `total`, `total_unfiltered`, `offset`,
`limit`, and `data`. `data` contains `row_index`, optional `row_names`, and
`columns`. The effective `limit` is clamped to the query engine's row limit and
may be reduced further to fit the JSON output budget. For an empty page,
`row_index` and explicit `row_names` are empty arrays; `columns` still contains
one schema/data/errors wrapper per selected column, with empty channel arrays.
Only `cols: []` produces an empty `columns` array.

Column selectors are positions rather than names, so duplicate or unusual column
names are safe. `cols: []` requests only the row metadata. If the implicit
all-column selection exceeds the page column limit, the request fails with
`limit_exceeded`; columns are never silently dropped. Snapshot registrations
reject row requests with `unsupported` because their payload is host-cached.

### `view/close` and `view/closed`

A `view/close` request has `view` and `generation` parameters. The result
contains the same view id and generation with `closed: true`. The entry is
removed from the active registry immediately. If a request is already using its
entry, source and holder cleanup is deferred until that request releases it.

When the registry evicts its oldest active table to satisfy `jdv.max_tables`, it
queues a `view/closed` notification with the evicted `view` and `generation`.
`jdv_register()` drains pending notifications into its `notifications` return
value. An embedding host delivers them in order before the associated new
`view/open`. Explicit host-initiated `view/close` returns a successful close
result without a separate `view/closed` notification. `jdv_close()` sends
`view/closed` for views it closes. Re-registering an active title replaces the
same id with a newer generation; after close or eviction, a later registration
uses a new id and generation 1.

Closing a tree view removes its child views recursively. A `view/closed`
notification for a child closed by its parent includes
`reason: "parent_closed"`; the explicitly closed root has no such reason.
Replacing or evicting a parent has the same descendant-close effect.

### `hello`

At the start of each R-to-host connection, the transport sends a `hello`
notification with no request id:

```json
{
  "method": "hello",
  "params": {
    "protocol": 1,
    "session": "r-1234-1",
    "pid": 1234,
    "r_version": "4.6.1",
    "jdv_version": "0.1.0",
    "limits": {
      "max_receive_frames": 264,
      "max_receive_bytes": 1048577,
      "queue_messages": 256,
      "queue_bytes": 16777216,
      "max_request_bytes": 1048576,
      "max_message_bytes": 10485760
    }
  }
}
```

`session` is `r-<pid>-<connection counter>`. The counter advances for each
connection from that R process. The session id does not use random numbers and
must not change R's random state. `r_version` and `jdv_version` are version
strings. Protocol major version 1 is the v1 contract in this document. A peer
that does not support the announced major version rejects the handshake with
`unsupported`; it must not continue with incompatible message semantics.

The transport emits `hello` as part of connection setup. It is not a method
handled by `jdv_rpc()` and is not returned by `jdv_register()`. The R process
does not retry a failed request or automatically reconnect after disconnect; the
next `jdv_view()` call starts a new session. A disconnect closes every active
registry entry and releases its retained table data. Entries created with
`jdv_register()` share this process-wide registry and are cleared by a viewer
disconnect as well.

`params.limits` reports the effective limits captured for this connection: the
maximum complete frames and bytes read in one receive callback, pending queue
message and byte limits, and maximum request and response bytes. Hosts use the
smaller of each reported value and their own configured bound.

### `wake` and `cancel`

`wake` has no response and no parameters. In the synchronous API it is a no-op
returning `NULL`. On the local transport it asks the R receiver to check whether
queued requests can run; receiving a wake does not itself dispatch a request. A
normal package API-entry preflight is receive-only and does not dispatch
requests. While R is executing a function frame, the receive callback can read
and queue a request but cannot dispatch it. Hosts must send wakes repeatedly at
a regular interval while one or more requests are awaiting terminal responses. A
single wake is not guaranteed to cause a pending request to run because it may
arrive during either receive-only preflight or function-frame execution. A 50 ms
interval is a valid host implementation choice, but that exact interval is not
required of every host. Hosts must keep wakes within applicable frame, byte, and
send-rate limits.

`cancel` has no response and takes `{ "id": requestId }` in `params`. It
identifies a request by the same string-or-safe-integer rules as envelope ids.
Ids retain their JSON type, so the string `"1"` does not match numeric id `1`.
The synchronous API validates this id and returns `NULL`; it has no pending
queue and creates no cancellation tombstone for an unknown or completed id. The
local queue removes a matching request that has not begun and sends one
`cancelled` terminal error for that request. A running R method is not forcibly
interrupted by this notification and produces its ordinary terminal response.
The adapter validates the full control envelope, including encoding,
compression, and deadline, before it changes pending work. Unsupported encoding
or compression and an expired recognized cancel have no effect and produce no
notification response. Malformed JSON, an invalid raw id token, or an invalid
deadline type can be rejected during native request validation with a
best-effort `invalid_request` response whose id is `null`; these errors do not
change pending work.

### `ack`

The R transport sends `{"method":"ack","params":{"frames":N}}` at the end of a
receive callback after it has read at least one complete frame. `N` is the
cumulative number of complete host-to-R NDJSON frames read on that connection,
including `wake`, `cancel`, malformed, and rejected frames. It is a safe integer
and never decreases. The host releases frame and byte credit through that
cumulative frame boundary. The acknowledgement is sent after the receive loop,
so frames sent in response to an acknowledgement are read in a later callback.

## Column payloads

Column identity is its zero-based `position`; `name` is display metadata and may
be empty, duplicated, or otherwise unusual. A schema entry includes `position`,
`name`, `type`, `class`, `sortable`, and `filterable`. Factor schemas also
include `levels` and `ordered`; datetime schemas include `tz`. Unknown optional
schema fields must be ignored by clients so future schema extensions remain
compatible.

A Snapshot column payload is columnar. Channel arrays are omitted when absent:

```json
{
  "values": [1, null, null],
  "display": ["1", "NaN", "NA"],
  "special": [null, "nan", "na"],
  "na": [false, true, true]
}
```

`values`, `display`, `sortKey`, `special`, and `na`, when present, have one
entry for each row in the payload. `na` is sent whenever its extraction succeeds
and is the authoritative missingness mask; clients must not infer missingness
from display text. If a channel fails, that channel may be absent while other
channels remain usable. Channel failures are recorded in `errors` and reflected
in the schema's capability flags. For a Paged column, `errors` is an empty array
when no channel failed and a named object of channel-specific messages when
errors are present. Snapshot columns include `errors` only when a channel
failed.

Snapshot `data.columns` entries are bare channel objects. In a Paged response,
each selected column is wrapped as
`{ "schema": ..., "data": ..., "errors":
... }`, preserving the page-time schema
and channel diagnostics. The `data` object inside that wrapper uses the same
channel format as a Snapshot column. Paged responses never include `sortKey`;
sorting remains on the R side.

The following encoding rules apply:

- `boolean`, `integer`, and finite `number` values use JSON booleans or numbers.
  Missing values use JSON `null` and are identified by `na`.
- Non-finite doubles use JSON `null` in `values`; the parallel `special` entry
  distinguishes `na`, `nan`, `pos_inf`, and `neg_inf`. Numeric comparisons and
  Snapshot sorting restore infinities from `special`; `na` controls missingness
  and NA-last placement.
- `int64` values are canonical base-10 JSON strings, never JSON numbers, to
  preserve exact integer precision. `na` identifies missing entries. The
  `display` channel may be omitted only when its nonmissing labels equal
  `values` and every missing label is `"NA"`. The client reconstructs display
  from values, using `"NA"` for missing entries. A class-specific format method
  may produce different display text, including a different missing label, in
  which case the channel is retained.
- `string` and `factor` values are strings. The `display` channel may be omitted
  under the same equality and missing-label rule. Factor order and labels come
  from `levels` and `ordered` in the schema.
- `date` values are ISO `YYYY-MM-DD` strings. `datetime` values are ISO
  timestamp strings; the schema's `tz` records the source time-zone setting.
- Snapshot `sortKey` is present for sortable non-primitive types and encodes the
  R ordering semantics agreed in [`query.md`](query.md), including collation,
  factor level order, and `integer64` order. It may be omitted for plain
  boolean, integer, and number columns whose ordering is recovered from `values`
  and `special`. A `null` sortKey is ordered after every non-null key,
  regardless of the `na` mask. Paged rows never include sort keys.
- `row_index` always reports original one-based R row numbers. Snapshot
  `row_names` and Paged page `row_names` contain values only for explicit row
  names; otherwise the field is `null`. Automatic row names are not materialized
  as a separate channel. A Paged `view/open` descriptor has `row_names: null`;
  requested explicit names arrive with the page.

The cJSON writer first tries a 15-significant-digit representation for a finite
double and accepts it only when its own double read-back equals the source;
otherwise it falls back to 17 significant digits. The emitted text round-trips
to the original finite double with correctly rounded parsers such as JavaScript
`JSON.parse`, C `strtod`, and `jsonlite::fromJSON`. R's `as.numeric()` and
`scan()` do not guarantee rounding to the nearest representable value, so a
15-digit token can read back one ULP away across a wide exponent range. Negative
zero is written as `0`, without its sign.

Snapshot payloads contain all table rows in one `data` object. Paged payloads
contain only the requested row slice. Paged display formatting is performed on
the requested slice, so text labels may differ from a Snapshot formatted across
the whole column. The protocol guarantees matching sort and filter semantics,
not identical display strings. For data frames, row slicing is performed per
column using `x[[j]]` followed by that column's `[` method. It does not call
table-level `[`. For matrices, slicing uses `x[rows, j]`. Source classes are
preserved through slicing; jdv does not `unclass()` or coerce a column before
its subset method runs. Filtering and sorting use full column semantics before
the requested rows are sliced. See [`query.md`](query.md) for the detailed
source and query contract.

## Filter and sort request shape

The filter is the neutral AST defined by `query.md`, not a UI library's filter
model. Objects contain exactly the fields required by their operator. Sort is an
array of objects with exactly `col` and `desc`; `desc` is a required scalar
Boolean. Duplicate sort and page columns are invalid. See the shared query
fixtures in [`query-fixtures.json`](query-fixtures.json) for cross-consumer
examples of filters, values, and expected original row indices.

Numeric filter special values use an explicit object, never a non-JSON number:

```json
{ "op": "eq", "col": 0, "value": { "special": "pos_inf" } }
```

`integer64` filter values are canonical decimal strings. Query evaluation and
R's handling of missing and special values follow `query.md`.

## Errors and limits

Error codes are stable machine-readable values. The `error` object contains
`code` and `message`, with optional `details`. The current codes include:

| Code               | Meaning                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`  | Malformed JSON, missing required fields, strict filter/sort field errors, or invalid parameters.                                                                |
| `unsupported`      | A known operation or encoding is not supported for this table or protocol version.                                                                              |
| `limit_exceeded`   | A configured request, page, or JSON byte limit was exceeded.                                                                                                    |
| `schema_changed`   | A retained grid source (Paged or a drillable Snapshot) no longer matches its registered dimensions, names, or classes, or a required channel no longer matches. |
| `r_error`          | An R method or other request computation failed.                                                                                                                |
| `interrupted`      | Request processing began and was interrupted.                                                                                                                   |
| `cancelled`        | The accepted request was cancelled before processing began.                                                                                                     |
| `expired`          | The request deadline elapsed before processing began.                                                                                                           |
| `unavailable`      | A well-formed object path no longer resolves or cannot be read safely.                                                                                          |
| `stale_generation` | The request names a generation that is no longer active.                                                                                                        |
| `view_not_found`   | The view id is missing or closed.                                                                                                                               |
| `in_use`           | Another browser owns the sequential lease, a next request is still pending, or a reentrant operation cannot proceed.                                            |
| `stream_failed`    | A sequential producer encountered a terminal failure; close or register a new stream to continue.                                                               |
| `method_not_found` | No implementation exists for the requested method.                                                                                                              |

Per-column channel failures are represented in the page payload and do not
necessarily fail the whole request. The request and response byte limits are
`jdv.max_request_bytes` (default 1 MiB, minimum 128 bytes) and
`jdv.max_message_bytes` (default 10 MiB, minimum 1,024 bytes). The JSON output
limit applies to final JSON text, not peak allocation; Arrow IPC bodies use the
separate binary-transfer limits above. For finite doubles, the cJSON writer
first tries a 15-significant-digit representation and accepts it only when its
own double read-back is exactly equal to the source value; otherwise it falls
back to 17 significant digits. It releases each completed column tree while
appending it to the output.

If a Paged response exceeds the output limit, the already-computed result is
retried as progressively shorter row prefixes; the R query and user methods are
not run again. If even one row cannot fit, `limit_exceeded` is returned with a
`warnings` array, which may be empty.

Full sort and filter operations have no work or row limit by default because
they are explicit user requests. An explicitly finite `jdv.max_work_bytes` or
`jdv.max_query_rows` caps that work. Interrupt delivery in the event-loop path
depends on the suspension state at callback entry: an interrupt caught during a
started request returns `interrupted`, while R may defer delivery if the
callback began with interrupts already suspended. The viewer UI should show that
R is busy while a request runs.

Snapshot construction, Paged registration probes, page extraction, and JSON
encoding use separate finite budgets. Each derived budget is the smaller of
`INT_MAX`, six times the applicable output allowance plus 4 MiB, and an
explicitly configured `jdv.max_work_bytes`. For Snapshot, the output allowance
is `min(jdv.snapshot_max_bytes, jdv.max_message_bytes)`; for page work it is
`jdv.max_message_bytes`. This preserves a 64 MiB work allowance with the 10 MiB
defaults while allowing Snapshot construction to scale with its configured
threshold. When `jdv.max_work_bytes` is finite, query work, page extraction, and
response encoding draw from the same per-operation allowance. The cache budget
limits the combined estimated bytes across column, channel, and index caches;
oversized entries are skipped and old entries are evicted. The cache allowance
is held by the registered table and is separate from per-operation work.
Unfiltered page requests do not materialize a complete row index and are limited
by page size.

These are conservative engine-work estimates, not process-memory or RSS limits:
source storage, arbitrary user method allocations, R allocator and GC overhead,
and transient R-internal string conversion or sorting scratch are outside the
guarantee. Snapshot checks raw source strings before formatting and checks
returned channel sizes before further encoding; Paged registration avoids
scanning the full source and charges requested pages and queries. Oversized
common metadata is rejected at registration, while explicit Paged row names are
checked only for requested rows. If Auto selects Snapshot but full explicit row
names exceed Snapshot's metadata budget, registration retries as Paged; forced
Snapshot registration returns `limit_exceeded`. Packed matrix columns are
summarized by shape for display when copying a wide row would exceed the cell
preview bound, and missingness scans are budgeted before allocating masks.
Minimal control and error responses have a separate fixed 64 KiB encoder-work
allowance, so a depleted request budget can still report its failure.

## Local transport and execution gate

The R transport bounds the pending queue to 256 messages and 16 MiB by default.
Each inbound JSON line is limited by `jdv.max_request_bytes` (1 MiB by default),
and each outbound line by `jdv.max_message_bytes` (10 MiB by default). A read
callback processes at most `max(64 KiB, request limit + 1)` bytes. One native
poll or event callback drains at most eight queued requests; each request in
that batch passes through its own execution-gate check. Sends have a one-second
timeout. Limits can be adjusted with `jdv.transport.queue_messages`,
`jdv.transport.queue_bytes`, `jdv.transport.max_drain_requests`, and
`jdv.transport.send_timeout_ms`.

The event source reads and validates framed input into a bounded C queue. It
does not leave a readable descriptor active after hitting its receive quota. If
the pending queue is full by message count or bytes, the transport returns
`limit_exceeded` for that request alone and keeps the connection and already
queued work when the error response is sent successfully. A failed error send
still disconnects the host and closes registered tables. Each receive callback
is also bounded to
`jdv.transport.queue_messages + jdv.transport.max_drain_requests` frames and
`max(64 KiB, request limit + 1)` bytes. `cancel` and `wake` notifications count
toward the frame limit. A host that exceeds either callback quota is
disconnected. Each receive callback acknowledges the cumulative number of
complete frames read, including malformed or rejected frames; the host releases
frame and byte credit through that boundary. While at least one request is
awaiting a terminal response, hosts must send `wake` notifications repeatedly at
a regular interval until no live requests remain. A single wake is insufficient:
a normal package API-entry preflight is receive-only and does not dispatch work,
and receiving a wake while R is in a function frame only allows requests to be
queued for later dispatch. A 50 ms interval is a valid implementation choice,
but the protocol does not require every host to use that interval. Wake frames
remain subject to the same applicable credit and rate limits as other traffic.
Hosts must keep at most 32 view requests awaiting a response. Before sending a
page request that makes an unsent page request obsolete, hosts must replace the
unsent request with the newer page. Hosts must bound the cumulative unconfirmed
output prefix to the receive callback's frame and byte quotas so multiple writes
cannot exceed one callback's budget when coalesced. Each `cancel` and `wake`
frame consumes the same frame and byte credit as a request. Before dispatch, the
transport removes cancelled and expired queued requests and sends their terminal
errors, including while another R method is running. The R adapter returns
`view_not_found` for a closed or missing view and `stale_generation` for an
obsolete generation. For each request, dispatch requires native `busy == 0` and
a single `sys.nframe()` evaluation in `R_BaseEnv` to return zero. If the queue
is empty, the gate skips that evaluation. A started request that fails,
including an interrupt, is terminal and is never retried. A synchronous or
queued stale generation returns `stale_generation`. A second live pending
request with the same typed id is rejected as `invalid_request` on a best-effort
basis and closes the connection to avoid ambiguous responses. Cancelled requests
no longer reserve their ids.

The gate temporarily saves `R_interrupts_suspended`, sets it to `TRUE` for the
single frame-count evaluation, and restores the prior value with unwind-safe
cleanup. It does not use `END_SUSPEND_INTERRUPTS`, call `onintr`, or inspect or
change private pending-interrupt state. This practical function-frame check is
not a guarantee that R is idle: on Windows, a timer can run during top-level
computation while `sys.nframe()` is zero. The Windows timer interval is about
200 ms. If the request callback begins with interrupts enabled, an interrupt
after dequeue becomes an `interrupted` error. If R entered the callback with
interrupts already suspended, R may defer delivery; long sort or filter work may
therefore not stop promptly. The viewer should show a busy state and offer a
retry after a terminal failure.

`jdv_rpc(NULL)` is a non-reentrant recovery path that bypasses the normal gate
and drains at most the configured batch under `R_UnwindProtect`; it does not use
a background `R_ToplevelExec`. Disconnect cleanup is deferred until the callback
stack is safe. A public R `addTaskCallback()` performs cleanup after a
successful top-level task, while explicit polling and later public package
entries also check for pending cleanup. This task callback is cleanup-only and
does not dispatch requests. It is an event-driven cleanup opportunity, not a
general timer. A disconnect closes every registered table, and the next
`jdv_view()` call starts a new connection; no in-flight request is retried.

On namespace unload, the transport source is stopped, queued requests and
registry entries are closed, and the housekeeping callback is removed. If a
native callback is still active, the package namespace may unload while the
native library remains loaded while native calls are active; an idle reload or
unload can release it later. Forced DLL unload while native callbacks are active
is unsupported; reloading is rejected while the previous native owner is still
active.

R evaluation, condition handling, and interrupt state use installed public R
APIs. The POSIX input handler uses the installed `R_ext/eventloop.h` external
interface, which is not a stable API. No GPL R source or `later` implementation
is copied.

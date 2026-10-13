# jdv Protocol v1

This document defines the transport-independent JSON protocol implemented by
`jdv_register()` and `jdv_rpc()`. It describes the R table registry and the
request and response messages shared by the package, reference server, and
future clients. It does not define the Phase 5 byte transport, message queue,
or browser-to-server protocol.

The envelope is JSON-RPC-like, but it is not JSON-RPC 2.0: messages use a
`method` and `params`, while successful responses use `id`, `result`, and
`warnings`. A request that expects a response has an `id`. Notifications such
as `wake` and `cancel` omit the id and have no response.

## Compatibility and encoding

- Each transport message is one UTF-8 JSON value. The Phase 5 reference
  transport will frame messages as newline-delimited JSON (NDJSON).
- The only supported envelope encoding is `json`; the only supported
  compression is `none`. Both fields may be omitted to select those defaults.
  Unknown values produce an `unsupported` error.
- A table id is a string. Only column positions are zero-based. `row_index` is
  the original one-based R row number, including after filtering and sorting.
- Request ids are either strings of at most 128 UTF-8 bytes or JSON integer
  literal tokens from 0 through `2^53 - 1`. Fractional and exponent-form
  numeric ids are rejected, even when their mathematical value is integral.
- Envelope and method-parameter objects ignore unknown fields for forward
  compatibility. Filter and sort objects remain strict. Duplicate object
  keys are rejected. Unknown methods return `method_not_found`.
- Unknown optional schema fields must be ignored by clients. Protocol v1
  allows a future optional `parent` field on a table descriptor for nested
  child tables; `open_cell` is not defined in v1.
- The parser rejects malformed JSON number grammar, invalid UTF-8, decoded
  U+0000, trailing non-whitespace data, nesting deeper than 128, more than
  100,000 JSON nodes, or an object with more than 1,024 members. The literal
  six-character content `\u0000` is valid when represented in JSON as
  `"\\u0000"`; a JSON escape that decodes to U+0000 is rejected.

The R package uses base R and its bundled cJSON implementation at runtime. It
does not require jsonlite. Consumers can parse and construct JSON with their
own tooling and pass the resulting JSON string to `jdv_rpc()`.

## Registration API

```r
jdv_register(
  x,
  title = NULL,
  mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale")
)

jdv_rpc(request)
```

`x` must be a data frame or matrix. `jdv_register()` returns
`list(id, open, notifications)`. `open` is a `table/open` JSON message.
`notifications` is a character vector of pending
notification JSON messages, or `character()` when there are none. The embedding
host must deliver each notification in vector order before delivering `open`.
Registration does not open a socket.

A non-`NULL` title identifies one active display slot. Registering that active
title again replaces its contents, reuses its table id, and increments its
generation. The new table is prepared before the prior table is replaced, so a
failed registration leaves the prior registration intact. Closing or evicting
a title removes its title mapping; registering it later creates a new id at
generation 1. `NULL` titles always create independent registrations. A new
slot starts at generation 1. If `jdv.max_tables` is lowered below the active
count, registration evicts as many oldest entries as needed to satisfy it.

Snapshot registration materializes and encodes its data in the `open` message.
After successful message construction, the R registry retains only table
metadata; the host is responsible for caching the snapshot. A Snapshot table
has no `table/rows` endpoint. Paged registration retains the source and its
initial schema in R and returns schema and dimensions in `open`; rows are
computed on demand.

For Paged tables, dimensions, column names, and column classes are checked
against the registration fingerprint on requests. Mutation of values through
a shared reference cannot be detected reliably. Register the table again
whenever values, schema, methods, or options that affect extracted channels
change. Re-registration creates a fresh holder and cache. Changing a class
method while continuing to use already cached channels does not guarantee
refresh.

The default collation is `getOption("jdv.collation", "C")`. Current options
include `jdv.max_message_bytes` (default 10 MiB, minimum 1,024),
`jdv.max_request_bytes` (default 1 MiB, minimum 128), `jdv.max_tables`
(default 64), `jdv.max_page_rows` (default 2,000),
`jdv.snapshot_max_cells` (default 10,000), `jdv.snapshot_max_bytes` (default
10 MiB), `jdv.max_work_bytes` (default `Inf`), `jdv.max_cache_bytes` (default
32 MiB), and `jdv.max_query_rows` (default `Inf`). The work and row limits apply
to full sort/filter operations; setting either option to a finite value restores
the corresponding `limit_exceeded` guard. Page, work, cache, and query-row
settings are captured when a Paged holder is registered; re-register the table
to apply changed options.

`mode = "auto"` selects Snapshot only when both the cell estimate
`nrow * max(1, ncol)` and a deterministic byte estimate fit their thresholds.
The byte threshold is `min(jdv.snapshot_max_bytes, jdv.max_message_bytes)`.
The cell estimate counts `row_index` even for a zero-column table. Byte
estimation samples at most 256 evenly spaced rows; snapshot construction then
checks actual source string lengths and generated channel sizes. A sampled
estimate can therefore miss a large value, in which case automatic mode
discards the incomplete Snapshot attempt and registers a Paged holder. Forced
Snapshot mode returns `limit_exceeded` instead.

## Message envelopes

A table descriptor is sent as a notification:

```json
{
  "method": "table/open",
  "params": {
    "table": "t-1",
    "generation": 1,
    "title": "example",
    "mode": "paged",
    "collation": "C",
    "nrow": 100,
    "ncol": 2,
    "row_names": null,
    "columns": []
  }
}
```

The example omits schema entries for brevity. `table/open` has no request id
and is not passed to `jdv_rpc()`; it is returned by `jdv_register()` for the
host to deliver. In Snapshot mode, `params.data` contains the full data payload
as described under [Column payloads](#column-payloads).

A request envelope has this shape:

```json
{
  "id": 1,
  "method": "table/rows",
  "params": {
    "table": "t-1",
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
that return a result. `params` is required by table methods and `cancel`.
Unknown envelope and method-parameter fields are ignored. `encoding`,
`compression`, and `deadline` are optional. `deadline`, when provided, must be
a finite JSON number containing an absolute Unix timestamp in seconds. A
synchronous request already past its deadline returns `NULL`. A queued request
that expires before execution begins is discarded without a response.

The configured request byte limit applies to the entire JSON text. The parser
also validates strict JSON number syntax and rejects duplicate object keys.

Warnings are collected up to 100 messages, each truncated to 512 characters.
If more warnings occur, the array ends with
`"Additional warnings were omitted."`.

A successful response is:

```json
{
  "id": 1,
  "result": {},
  "warnings": []
}
```

Every response includes a `warnings` array, including an empty array when no
warnings were raised. Warnings from R methods invoked while handling the
request are collected and muffled at the request boundary. An error response
is:

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

Errors raised after request processing begins, including user method errors
and interrupts, are returned to the request caller. Their `code` distinguishes
the failure class; `message` is bounded text and must not be used as a stable
machine-readable discriminator. An error may also include `details`. Work
cancelled, expired, or stale before it begins receives no response. A
synchronous `jdv_rpc()` call is an embedding path and does not apply the Phase
5 execution gate. It treats `wake` and `cancel` as no-op notifications and
returns `NULL` for them; the Phase 5 queue adapter will match cancellation ids
to pending work before execution.

## Methods

| Method | Direction | Kind | Result |
| --- | --- | --- | --- |
| `table/open` | R/host to viewer | Notification | Descriptor and, for Snapshot, all column payloads. Returned by `jdv_register()`. |
| `table/schema` | Host to R | Request | Current dimensions and schema. |
| `table/rows` | Host to R | Request | One selected page from a Paged table. |
| `table/close` | Host to R | Request | Closes one table generation. |
| `table/closed` | R to host | Notification | Removes an evicted generation from the host cache. |
| `hello` | R to host | Notification | Announces protocol and runtime versions for a new connection. |
| `wake` | Host to R | Notification | No result; asks the event loop to check its execution gate again. |
| `cancel` | Host to R | Notification | Names pending work for the Phase 5 queue to cancel. |

### `table/schema`

Parameters are `table` and `generation`. The result contains `table`,
`generation`, `nrow`, `ncol`, and `columns`. A generation that is no longer
current produces `stale_generation` when handled synchronously. A missing or
closed table produces `table_not_found`.

### `table/rows`

Parameters are:

| Field | Required | Meaning |
| --- | --- | --- |
| `table` | Yes | Registered table id. |
| `generation` | Yes | Generation returned by `table/open`. |
| `offset` | No | Zero-based offset after filtering and sorting; defaults to 0. |
| `limit` | No | Requested page size; defaults to 200 and is clamped to the query engine's page row limit. |
| `sort` | No | Array of `{ "col": zeroBasedPosition, "desc": boolean }` objects; defaults to no sort. |
| `filter` | No | Filter AST defined by [`query.md`](query.md); defaults to no filter. |
| `cols` | No | Array of zero-based column positions; omitted or `null` selects all columns. |

The result contains `table`, `generation`, `total`, `total_unfiltered`,
`offset`, `limit`, and `data`. `data` contains `row_index`, optional
`row_names`, and `columns`. The effective `limit` is clamped to the query
engine's row limit and may be reduced further to fit the JSON output budget.
For an empty page, `row_index` and explicit `row_names` are empty arrays;
`columns` still contains one schema/data/errors wrapper per selected column,
with empty channel arrays. Only `cols: []` produces an empty `columns` array.

Column selectors are positions rather than names, so duplicate or unusual
column names are safe. `cols: []` requests only the row metadata. If the
implicit all-column selection exceeds the page column limit, the request
fails with `limit_exceeded`; columns are never silently dropped. Snapshot
registrations reject row requests with `unsupported` because their payload is
host-cached.

### `table/close` and `table/closed`

A `table/close` request has `table` and `generation` parameters. The result
contains the same table id and generation with `closed: true`. The entry is
removed from the active registry immediately. If a request is already using
its entry, source and holder cleanup is deferred until that request releases
it.

When the registry evicts its oldest active table to satisfy `jdv.max_tables`,
it queues a `table/closed` notification with the evicted `table` and
`generation`. `jdv_register()` drains pending notifications into its
`notifications` return value. An embedding host delivers them in order before
the associated new `table/open`. Explicit `table/close` is already initiated
by the host and returns a successful close result without a separate
`table/closed` notification. Re-registering an active title replaces the same
id with a newer generation; after close or eviction, a later registration
uses a new id and generation 1.

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
    "jdv_version": "0.1.0"
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
handled by `jdv_rpc()` and is not returned by `jdv_register()`. Emission and
connection lifecycle are implemented in Phase 5.

### `wake` and `cancel`

`wake` has no response and no parameters. In the synchronous API it is a
no-op returning `NULL`. The Phase 5 host uses it to ask the receiver to
recheck its execution gate; it does not poll or resubmit a request itself.

`cancel` has no response and takes `{ "id": requestId }` in `params`. It
identifies a request by the same string-or-safe-integer rules as envelope ids.
The synchronous API validates this id and returns `NULL`; it has no pending
queue and creates no cancellation tombstone for an unknown or completed id.
The Phase 5 queue adapter matches the id to pending work and marks that
request cancelled so it is discarded before execution. A running R method is
not forcibly interrupted by this notification.

## Column payloads

Column identity is its zero-based `position`; `name` is display metadata and
may be empty, duplicated, or otherwise unusual. A schema entry includes
`position`, `name`, `type`, `class`, `sortable`, and `filterable`. Factor
schemas also include `levels` and `ordered`; datetime schemas include `tz`.
Future optional schema fields, including a possible `drillable`, must be
ignored when unknown. This permits adding nested-table metadata without
changing v1 clients.

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
entry for each row in the payload. `na` is sent whenever its extraction
succeeds and is the authoritative missingness mask; clients must not infer
missingness from display text. If a channel fails, that channel may be absent
while other channels remain usable. Channel failures are recorded in `errors`
and reflected in the schema's capability flags. For a Paged column,
`errors` is an empty array when no channel failed and a named object of
channel-specific messages when errors are present. Snapshot columns include
`errors` only when a channel failed.

Snapshot `data.columns` entries are bare channel objects. In a Paged response,
each selected column is wrapped as `{ "schema": ..., "data": ..., "errors":
... }`, preserving the page-time schema and channel diagnostics. The `data`
object inside that wrapper uses the same channel format as a Snapshot column.
Paged responses never include `sortKey`; sorting remains on the R side.

The following encoding rules apply:

- `boolean`, `integer`, and finite `number` values use JSON booleans or
  numbers. Missing values use JSON `null` and are identified by `na`.
- Non-finite doubles use JSON `null` in `values`; the parallel `special`
  entry distinguishes `na`, `nan`, `pos_inf`, and `neg_inf`. Numeric
  comparisons and Snapshot sorting restore infinities from `special`; `na`
  controls missingness and NA-last placement.
- `int64` values are canonical base-10 JSON strings, never JSON numbers, to
  preserve exact integer precision. `na` identifies missing entries. The
  `display` channel may be omitted only when its nonmissing labels equal
  `values` and every missing label is `"NA"`. The client reconstructs display
  from values, using `"NA"` for missing entries. A class-specific format
  method may produce different display text, including a different missing
  label, in which case the channel is retained.
- `string` and `factor` values are strings. The `display` channel may be
  omitted under the same equality and missing-label rule. Factor order and
  labels come from `levels` and `ordered` in the schema.
- `date` values are ISO `YYYY-MM-DD` strings. `datetime` values are ISO
  timestamp strings; the schema's `tz` records the source time-zone setting.
- Snapshot `sortKey` is present for sortable non-primitive types and encodes
  the R ordering semantics agreed in [`query.md`](query.md), including
  collation, factor level order, and `integer64` order. It may be omitted for
  plain boolean, integer, and number columns whose ordering is recovered from
  `values` and `special`. Paged rows never include sort keys.
- `row_index` always reports original one-based R row numbers. Snapshot
  `row_names` and Paged page `row_names` contain values only for explicit row
  names; otherwise the field is `null`. Automatic row names are not
  materialized as a separate channel. A Paged `table/open` descriptor has
  `row_names: null`; requested explicit names arrive with the page.

The cJSON writer first tries a 15-significant-digit representation for a finite
double and accepts it only when its own double read-back equals the source;
otherwise it falls back to 17 significant digits. The emitted text round-trips
to the original finite double with correctly rounded parsers such as JavaScript
`JSON.parse`, C `strtod`, and `jsonlite::fromJSON`. R's `as.numeric()` and
`scan()` do not guarantee rounding to the nearest representable value, so a
15-digit token can read back one ULP away across a wide exponent range. Negative
zero is written as `0`, without its sign.

Snapshot payloads contain all table rows in one `data` object. Paged payloads
contain only the requested row slice. Paged display formatting is performed
on the requested slice, so text labels may differ from a Snapshot formatted
across the whole column. The protocol guarantees matching sort and filter
semantics, not identical display strings. For data frames, row slicing is
performed per column using `x[[j]]` followed by that column's `[` method. It
does not call table-level `[`. For matrices, slicing uses `x[rows, j]`.
Source classes are preserved through slicing; jdv does not `unclass()` or
coerce a column before its subset method runs. Filtering and sorting use full
column semantics before the requested rows are sliced. See [`query.md`](query.md)
for the detailed source and query contract.

## Filter and sort request shape

The filter is the neutral AST defined by `query.md`, not a UI library's filter
model. Objects contain exactly the fields required by their operator. Sort is
an array of objects with exactly `col` and `desc`; `desc` is a required scalar
Boolean. Duplicate sort and page columns are invalid. See the shared query
fixtures in [`query-fixtures.json`](query-fixtures.json) for cross-consumer
examples of filters, values, and expected original row indices.

Numeric filter special values use an explicit object, never a non-JSON number:

```json
{"op":"eq","col":0,"value":{"special":"pos_inf"}}
```

`integer64` filter values are canonical decimal strings. Query evaluation and
R's handling of missing and special values follow `query.md`.

## Errors and limits

Error codes are stable machine-readable values. The `error` object contains
`code` and `message`, with optional `details`. The current codes include:

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed JSON, missing required fields, strict filter/sort field errors, or invalid parameters. |
| `unsupported` | A known operation or encoding is not supported for this table or protocol version. |
| `limit_exceeded` | A configured request, page, or JSON byte limit was exceeded. |
| `schema_changed` | A Paged source no longer matches its registered dimensions, names, or classes, or a required channel no longer matches. |
| `r_error` | An R method or other request computation failed. |
| `interrupted` | Request processing began and was interrupted. |
| `stale_generation` | The request names a generation that is no longer active. |
| `table_not_found` | The table id is missing or closed. |
| `method_not_found` | No implementation exists for the requested method. |

Per-column channel failures are represented in the page payload and do not
necessarily fail the whole request. The request and response byte limits are
`jdv.max_request_bytes` (default 1 MiB, minimum 128 bytes) and
`jdv.max_message_bytes` (default 10 MiB, minimum 1,024 bytes). The output limit
applies to final JSON text, not peak allocation. For finite doubles, the cJSON
writer first tries a 15-significant-digit representation and accepts it only
when its own double read-back is exactly equal to the source value; otherwise
it falls back to 17 significant digits. It releases each completed column
tree while appending it to the output.

If a Paged response exceeds the output limit, the already-computed result is
retried as progressively shorter row prefixes; the R query and user methods
are not run again. If even one row cannot fit, `limit_exceeded` is returned
with a `warnings` array, which may be empty.

Full sort and filter operations have no work or row limit by default because
they are explicit user requests. An explicitly finite `jdv.max_work_bytes` or
`jdv.max_query_rows` caps that work. In the event-loop request path, R defers
user interrupts while a sort or filter runs; the viewer UI should show that R
is busy.

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
Unfiltered page requests do not materialize a complete row index and are
limited by page size.

These are conservative engine-work estimates, not process-memory or RSS limits:
source storage, arbitrary user method allocations, R allocator and GC overhead,
and transient R-internal string conversion or sorting scratch are outside the
guarantee. Snapshot checks raw source strings before formatting and checks
returned channel sizes before further encoding; Paged registration avoids
scanning the full source and charges requested pages and queries. Oversized
common metadata is rejected at registration, while explicit Paged row names are
checked only for requested rows. If Auto selects Snapshot
but full explicit row names exceed Snapshot's metadata budget, registration
retries as Paged; forced Snapshot registration returns `limit_exceeded`. Packed matrix columns are
summarized by shape for display when copying a wide row would exceed the cell
preview bound, and missingness scans are budgeted before allocating masks.
Minimal control and error responses have a separate fixed 64 KiB encoder-work
allowance, so a depleted request budget can still report its failure.

## Phase boundaries and unresolved transport details

Protocol v1 defines the synchronous registry API and the messages that the
future transport must carry. It does not implement a message queue, transport
retries, the event-loop timer, `jdv_view()`, or the public `jdv_close()` API;
those belong to later phases. The Phase 5 transport must preserve request ids
and generations, deliver `wake` and `cancel` notifications, discard expired or
stale queued work before it begins, and return errors for failures after work
starts. It must treat an interrupt as terminal for that request and must not
retry the interrupted work automatically.

The event-loop request path defers user interrupts while a sort or filter is
running. The viewer UI should expose that R is busy; users cannot rely on
Ctrl-C to stop a long-running query through that path.

The following are Phase 5 implementation details, not protocol ambiguities:

- Integrating the pending-request queue with socket transport and draining
  `notifications` to the host.
- The host's R-busy display timeout and wake/nudge timer. This is separate
  from each request's deadline. Nudge only while work remains live, and stop
  nudging on completion, cancellation, expiry, close, or disconnect.
- Delivering queued work only when the event gate allows it; discard cancelled,
  expired, or old-generation work before execution. A stale generation passed
  directly to synchronous `jdv_rpc()` returns `stale_generation`; the queued
  transport discards stale work before it starts.

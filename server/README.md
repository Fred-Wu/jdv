# jdv reference server

The Deno reference server connects to R over a local newline-delimited JSON
transport and serves the browser viewer from `web/`. The server and its web
assets are distributed under the project license in [LICENSE.md](LICENSE.md).

## Start from a URL

Deno 2.8 or newer is required for stable text imports. Run the server directly
from its hosted module URL; its relative imports load the listener and viewer
assets from the same URL tree.

```sh
deno run -A --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
```

The command prints one JSON line to standard output with `url` and `socketPath`.
Open the printed URL in a browser, then call `jdv::jdv_view(x)` in R. The server
listens for browser traffic on `127.0.0.1` only. Its R listener uses a
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

## Browser WebSocket protocol

The WebSocket endpoint is `/ws`. It accepts frames only when `Host` names the
server's loopback host and port and `Origin` exactly matches the advertised HTTP
origin. The UI and endpoint use the advertised `127.0.0.1` origin; other origins
and DNS-rebound host names are rejected. This checks browser origin; it is not
authentication against other local processes.

On connect, a client receives a `welcome` object containing protocol version 1
and the current R sessions and cached table descriptors. Later server events use
`session/open`, `session/closed`, `table/open`, `table/closed`, and
`notification` message types. A `table/open` message preserves the original R
protocol message, including the complete `data` payload for Snapshot tables.

Send requests with a unique string id per WebSocket client and session:

```json
{
  "type": "request",
  "id": "page-1",
  "session": "r-1234-1",
  "method": "table/rows",
  "params": { "table": "t-1", "generation": 1, "offset": 0, "limit": 200 }
}
```

The server currently accepts `table/rows`, `table/schema`, and `table/close`.
Responses use `type: "response"` and carry the original client id. A `busy`
event is informational and does not cancel the request. A client may send
`{"type":"cancel","id":"page-1","session":"r-1234-1"}`; it is forwarded as an R
`cancel` notification when the request was already sent. Unsent `table/rows`
requests for the same client, session, table, and generation are coalesced to
the latest page. A request already sent to R is allowed to finish; later scroll
requests wait behind it.

Browser WebSocket input frames are limited to 64 KiB. Incoming R NDJSON frames
are limited to 10 MiB.

Each R session has at most 32 live requests and 32 sent-request ledger slots
awaiting an actual terminal R reply or a later prefix proof. An actual terminal
reply, including `limit_exceeded`, releases only its matching request slot; it
does not release cumulative wire credit unless it proves R dispatch. The wire
window is limited to 128 frames and 512 KiB, with 32 frames and 16 KiB reserved
for cancellation. The ordinary budget is 96 frames and 496 KiB. Frames are
serialized, limited to 128 per second and 16 per send batch. While requests are
live, the host schedules one `wake` about every 50 ms when ordinary credit is
available. It pauses wakes and new requests when the bounded credit is
exhausted, surfaces a busy event, and does not retry requests. Only a successful
response or a response known to follow R dispatch acknowledges the sent prefix;
local timeout or cancellation releases neither the request slot nor wire credit.
If R never returns a dispatching response, the server cannot guarantee automatic
recovery of that connection. Close the R viewer registrations and start a new R
connection to recover; requests are never transparently replayed. The window is
designed for R's default transport limits; the host does not negotiate custom
lower limits configured in R, and cannot guarantee the connection remains usable
with those settings.

## Development

The server uses only Deno APIs and Node's built-in `node:net` adapter for named
pipes. No repository checkout, import map, or project configuration is needed
when started by URL.

```sh
deno fmt --check server
deno lint server
deno check server/main.ts
deno test -A server/tests
```

The Hub, platform, and R framing unit tests need only Deno. The full suite also
includes a numeric fixture test that invokes `Rscript` and an installed `jdv`
encoder. If using a scratch R library, select it explicitly with
`JDV_TEST_R_LIB=/path/to/scratch-library deno test -A server/tests`.

The Unix socket, HTTP origin checks, discovery, and R relay tests run on Linux.
The Windows named-pipe listener uses the built-in Node compatibility API but has
not been exercised on a Windows host. The page in this phase lists sessions and
tables; the full Tabulator viewer is implemented in the following phase.

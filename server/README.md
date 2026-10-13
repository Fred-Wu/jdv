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
deno lint server
deno check server/main.ts
deno test -A server/tests
```

The Hub, platform, and R framing unit tests need only Deno. The full suite also
includes R numeric fixtures and an interactive transport regression that runs an
interactive R process with `--no-readline` against a real TCP server. It holds R
in `Sys.sleep(10)`, checks that browser requests finish without manual polling,
and repeats wire cancellation while verifying one terminal reply per request.
Select the installed package explicitly with
`JDV_TEST_R_LIB=/path/to/scratch-library deno test -A server/tests`.

The Unix socket, HTTP origin checks, discovery, and R relay tests run on Linux.
The Windows named-pipe listener uses the built-in Node compatibility API but has
not been exercised on a Windows host. The page in this phase lists sessions and
tables; the full Tabulator viewer is implemented in the following phase.

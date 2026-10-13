# jdv

JSON Data Viewer is under development. The package provides a local viewer
transport for a separately running viewer host and a dependency-free table
registry and query API; the server and browser viewer are still under
development. See the
repository README for local development commands and
[`../spec/protocol.md`](../spec/protocol.md) for the protocol contract.

## Open a table in the viewer

With the local viewer server running, open a table with `jdv_view()`. The
connection is discovered from `options(jdv.address)`, `JDV_ADDRESS`, or the
server's `discovery.json` file. Reusing a title replaces that table in the
viewer.

```r
data <- data.frame(name = c("Ada", "Grace"), score = c(10, 20))
jdv_view(data)

# Update the same viewer slot after changing the data.
data$score <- c(11, 21)
jdv_view(data)

# Close one table by its returned id, or close all active tables.
jdv_close()
```

The event-loop gate is a practical function-frame check rather than a guarantee
that R is idle. On Windows a timer may run during top-level computation. A
request interrupted after it starts fails without automatic retry. Interrupt
delivery also depends on the state R had when the callback began; if R entered
with interrupts suspended, a long sort or filter may not stop promptly. In a
bare browser or some frontends, call `jdv_rpc(NULL)` to poll explicitly.
Named-pipe ACLs are not hardened, and an explicitly configured TCP address has
no authentication. Windows named pipes must use byte-type mode; message-type
pipes are unsupported, and Windows transport behavior has not yet been tested
on a Windows host.

## Register and query a table

`jdv_register()` registers a data frame or matrix and returns `id`, `open`,
and `notifications`. Each notification is a JSON string. An embedding host
must deliver notifications in order before it delivers the `open` message, so
an evicted table is removed from the host cache before the replacement opens.
These functions do not open a socket or launch a viewer.

```r
registered <- jdv_register(
  data.frame(name = c("Ada", "Grace"), score = c(10, 20)),
  title = NULL,
  mode = "paged"
)

# host_send() is supplied by an embedding application.
# Deliver pending notifications before opening the newly registered table.
for (message in registered$notifications) {
  host_send(message)
}
host_send(registered$open)

# Request a page. The generated id is safe to interpolate as a JSON string.
request <- sprintf(
  paste0(
    '{"id":1,"method":"table/rows","params":',
    '{"table":"%s","generation":1,"offset":0,"limit":20}}'
  ),
  registered$id
)
response <- jdv_rpc(request)
cat(response, "\n")

# Close this table generation when the host no longer needs it.
close_request <- sprintf(
  paste0(
    '{"id":2,"method":"table/close","params":',
    '{"table":"%s","generation":1}}'
  ),
  registered$id
)
close_response <- jdv_rpc(close_request)
cat(close_response, "\n")
```

The request and response values are JSON strings. The package does not depend
on jsonlite at runtime; an embedding application may use its own JSON parser
to inspect `open`, notifications, and RPC responses. For Snapshot mode, `open`
contains the complete table payload and the host caches it. Snapshot tables do
not accept `table/rows` requests. Re-registering the same active non-`NULL`
title reuses its id and increments its generation. Closing or evicting that
title removes the mapping; registering it later creates a new id at generation
1. Clients should use the generation from the latest `open` message in every
subsequent request.

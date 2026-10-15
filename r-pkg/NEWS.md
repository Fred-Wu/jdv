# jdv 0.1.0

## New features

- Added `jdv_view()` and `jdv_close()` for opening and closing local viewer
  views from R, with reusable titles and explicit close behavior.
- Added Snapshot and Paged R table views with interactive sorting, filtering,
  and pagination, plus a browsable R object tree and a cell inspector for
  supported captured values.
- Added forward-only Arrow IPC views for Arrow tables and record batch readers,
  nanoarrow streams, and Polars data frames when their optional R packages are
  installed. The browser can load bounded pages and inspect supported nested
  values without converting the stream to an R data frame.
- Added bounded host and browser caches for sequential Arrow pages. The host
  exposes startup options for total and per-view cache budgets; evicted ranges
  are reported and cannot be recovered from a forward-only source.
- Added binary Arrow IPC framing between R, the reference host, and the browser,
  while keeping the host opaque to Arrow payload contents.
- Added separate manual workflows for Deno unit checks and R/browser end-to-end
  tests on Ubuntu, Windows, and macOS. The E2E workflow includes Windows
  named-pipe and explicit TCP connections, Chromium, and all three
  arf-controlled regression files.
- Pinned Deno and arf in `mise.toml` and added explicit unit/E2E task lists so
  Deno unit tests do not load R fixtures or optional-producer probes.

## Platform notes

- Windows named pipes use byte-type mode and the default operating-system ACL;
  the package does not harden those ACLs. Explicit TCP has no authentication.
- A Windows top-level `for` loop has been observed to dispatch callbacks while
  the loop is running because the function-frame count is zero. Rgui, RStudio,
  R.app, Esc/Ctrl-C delivery, and other true top-level behavior still require
  manual validation. A configured workflow is not evidence that a platform run
  has passed; consult the Actions results before treating Windows or macOS
  behavior as verified.

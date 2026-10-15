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
- Added a manual cross-platform server test workflow for Ubuntu, Windows, and
  macOS. Browser-driven end-to-end tests run on Linux; Windows named-pipe and
  explicit TCP R connections are included in the server test suite.
- The server workflow excludes `e2e_test.ts`, `cell_e2e_test.ts`, and
  `tree_e2e_test.ts`, which require the separate `arf` headless R controller.
  Rscript-based binary, Arrow, and sequential browser tests remain enabled.

## Platform notes

- Windows named pipes use byte-type mode and the default operating-system ACL;
  the package does not harden those ACLs. Explicit TCP has no authentication.
- A Windows top-level `for` loop has been observed to dispatch callbacks while
  the loop is running because the function-frame count is zero. RGui, RStudio,
  R.app, Esc/Ctrl-C delivery, and other true top-level behavior still require
  manual validation. A configured workflow is not evidence that a platform run
  has passed; consult the Actions results before treating Windows or macOS
  behavior as verified.

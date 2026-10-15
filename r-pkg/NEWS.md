# jdv 0.1.0

- Initial release.
- `jdv_view()` sends an object to an external viewer over a local connection,
  and `jdv_close()` closes views.
- Data frames and matrices open as grids. The viewer can sort, filter, and page
  them; large tables stay in R and are queried page by page.
- Lists and other R objects open as trees. List-column cells in a grid can be
  opened as their own views.
- Arrow tables and record batch readers (arrow), nanoarrow array streams, and
  data frames from polars open as grids that load pages from the start of the
  stream. Pages are sent as Arrow IPC without conversion to R vectors.
- `jdv_register()` and `jdv_rpc()` let other host applications use the viewer
  protocol, documented in `?jdv_spec` and `?jdv_query_spec`.

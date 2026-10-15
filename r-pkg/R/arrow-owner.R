# Ownership APIs are private; the optional producer adapter is loaded on demand.
# Registry ownership lasts until explicit close or unload, including after token GC.
.jdv_stream_move <- function(stream) {
  .jdv_assert_active()
  if (
    !inherits(stream, "nanoarrow_array_stream") ||
      typeof(stream) != "externalptr"
  ) {
    stop("Expected a nanoarrow_array_stream pointer.", call. = FALSE)
  }
  if (!requireNamespace("nanoarrow", quietly = TRUE)) {
    stop(
      "Stream export requires the optional nanoarrow package.",
      call. = FALSE
    )
  }
  if (.Call(C_jdv_arrow_status)[["busy"]] != 0L) {
    stop(
      "Arrow stream registration is unavailable during a producer callback.",
      call. = FALSE
    )
  }
  allocate <- getExportedValue("nanoarrow", "nanoarrow_allocate_array_stream")
  export <- getExportedValue("nanoarrow", "nanoarrow_pointer_export")
  exported <- allocate()
  export(stream, exported)
  .jdv_assert_active()
  token <- .Call(C_jdv_arrow_move, exported)
  .jdv_assert_active()
  token
}

.jdv_stream_schema <- function(token) {
  .jdv_assert_active()
  value <- .Call(C_jdv_arrow_schema, token)
  .jdv_assert_active()
  value
}

.jdv_stream_next <- function(token) {
  .jdv_assert_active()
  value <- .Call(C_jdv_arrow_next, token)
  .jdv_assert_active()
  value
}

.jdv_stream_close <- function(token) {
  .jdv_assert_active()
  value <- .Call(C_jdv_arrow_close, token)
  .jdv_assert_active()
  value
}

.jdv_stream_info <- function(token) {
  .jdv_assert_active()
  value <- .Call(C_jdv_arrow_info, token)
  .jdv_assert_active()
  value
}

# Low-level cleanup remains callable by namespace teardown.
.jdv_stream_cleanup <- function() invisible(.Call(C_jdv_arrow_cleanup))

.jdv_stream_status <- function() {
  .jdv_assert_active()
  value <- .Call(C_jdv_arrow_status)
  .jdv_assert_active()
  value
}

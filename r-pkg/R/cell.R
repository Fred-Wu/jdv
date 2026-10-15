# Explicit structural classes only: adding AsIs to an unknown class grants no access.
column_drillable <- function(x) {
  if (isS4(x)) {
    return(FALSE)
  }
  if (is.data.frame(x) || is.matrix(x)) {
    return(TRUE)
  }
  if (typeof(x) != "list" || !is.null(dim(x))) {
    return(FALSE)
  }
  klass <- attr(x, "class", exact = TRUE)
  is.null(klass) ||
    identical(klass, "AsIs") ||
    identical(klass, c("vctrs_list_of", "vctrs_vctr", "list")) ||
    identical(klass, c("AsIs", "vctrs_list_of", "vctrs_vctr", "list"))
}

.jdv_cell_path <- function(path) {
  if (
    !is.list(path) ||
      (is.object(path) && !inherits(path, "jdv_json_array")) ||
      !is.null(names(path)) ||
      !length(path) ||
      length(path) > .jdv_tree_path_limit
  ) {
    query_error(
      "invalid_request",
      "Cell path must be a non-empty bounded array."
    )
  }
  first <- path[[1L]]
  .jdv_fields(
    first,
    c("kind", "row_index", "column"),
    c("kind", "row_index", "column")
  )
  if (
    !identical(first$kind, "cell") ||
      any(!names(first) %in% c("kind", "row_index", "column"))
  ) {
    query_error("invalid_request", "Grid paths must begin with a cell step.")
  }
  cell <- list(
    kind = "cell",
    row_index = query_integer(first$row_index, "row_index", 1),
    column = query_integer(first$column, "column")
  )
  c(list(cell), lapply(path[-1L], .jdv_tree_step))
}

.jdv_cell_value <- function(entry, step) {
  if (
    step$row_index > entry$nrow ||
      step$column >= entry$ncol ||
      !isTRUE(entry$schema[[step$column + 1L]]$drillable)
  ) {
    query_error(
      "invalid_request",
      "The cell selector is out of range or not drillable."
    )
  }
  .jdv_check_fingerprint(entry)
  if (is.null(entry$source)) {
    query_error("unavailable", "The source cell is no longer available.")
  }
  tryCatch(
    {
      source <- entry$source
      column <- if (is.data.frame(source)) {
        source[[step$column + 1L]]
      } else {
        source[, step$column + 1L]
      }
      if (!column_drillable(column) || step$row_index > column_size(column)) {
        query_error("unavailable", "The source cell is no longer available.")
      }
      if (is.data.frame(column) || is.matrix(column)) {
        if (ncol(column) > query_limits()$max_columns) {
          query_error("limit_exceeded", "The cell grid exceeds the column cap.")
        }
        tryCatch(
          query_slice(column, step$row_index),
          error = function(error) {
            query_error("unavailable", "The source cell row could not be read.")
          }
        )
      } else {
        .subset2(column, step$row_index)
      }
    },
    error = function(error) {
      if (inherits(error, "jdv_query_error")) {
        stop(error)
      }
      query_error("unavailable", "The source cell could not be read.")
    }
  )
}

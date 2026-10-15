#' @noRd
jdv_source <- function(x, ...) {
  dispatch <- x
  if (is.matrix(x) && !inherits(x, "matrix")) {
    dispatch <- structure(list(), class = c(class(x), "matrix"))
  } else if (is.data.frame(x) && !inherits(x, "data.frame")) {
    dispatch <- structure(list(), class = c(class(x), "data.frame"))
  }
  UseMethod("jdv_source", dispatch)
}

# Keep the original object intact. The grid adapter gives registration a stable
# source boundary without changing column extraction or subsetting behavior.
.jdv_grid_source <- function(x) {
  structure(list(kind = "grid", data = x), class = "jdv_grid_source")
}

#' @exportS3Method jdv_source data.frame
jdv_source.data.frame <- function(x, ...) .jdv_grid_source(x)

#' @exportS3Method jdv_source matrix
jdv_source.matrix <- function(x, ...) .jdv_grid_source(x)

.jdv_stream_source <- function(x) {
  structure(
    list(kind = "grid", access = "sequential", data = x),
    class = "jdv_sequential_source"
  )
}

#' @exportS3Method jdv_source Table
jdv_source.Table <- function(x, ...) .jdv_stream_source(x)

#' @exportS3Method jdv_source RecordBatchReader
jdv_source.RecordBatchReader <- function(x, ...) .jdv_stream_source(x)

#' @exportS3Method jdv_source nanoarrow_array_stream
jdv_source.nanoarrow_array_stream <- function(x, ...) .jdv_stream_source(x)

#' @exportS3Method jdv_source polars_data_frame
jdv_source.polars_data_frame <- function(x, ...) .jdv_stream_source(x)

#' @exportS3Method jdv_source default
jdv_source.default <- function(x, ...) {
  structure(list(kind = "tree", data = x), class = "jdv_tree_source")
}

#' @export
#' @noRd
col_values.integer64 <- function(x, ...) .Call(C_jdv_int64_values, x)

#' @export
#' @noRd
col_display.integer64 <- function(x, ...) {
  subclasses <- class(x)[seq_len(match("integer64", class(x)) - 1L)]
  if (
    any(vapply(
      subclasses,
      function(class) {
        !is.null(utils::getS3method("format", class, optional = TRUE))
      },
      logical(1L)
    ))
  ) {
    return(format(x, trim = TRUE, justify = "none"))
  }
  values <- col_values.integer64(x)
  values[is.na(values)] <- "NA"
  values
}

#' @export
#' @noRd
col_is_na.integer64 <- function(x, ...) .Call(C_jdv_int64_is_na, x)

#' @export
#' @noRd
col_sort_key.integer64 <- function(x, collation = "C", ...) {
  .Call(C_jdv_int64_rank, x)
}

# Internal orders are one-based, stable, and always put missing rows last.
int64_order <- function(x, decreasing = FALSE) {
  .Call(C_jdv_int64_order, x, decreasing)
}

# Queries accept only plain scalar strings matching 0 or -?[1-9][0-9]*.
# The finite range is [-9223372036854775807, 9223372036854775807];
# -9223372036854775808 is reserved for NA and cannot be queried.
# Numeric coercion, missing queries, and reversed bounds are errors.
# Both bounds are inclusive; missing rows never match.
int64_eq <- function(x, value) .Call(C_jdv_int64_eq, x, value)

int64_between <- function(x, lower, upper) {
  .Call(C_jdv_int64_between, x, lower, upper)
}

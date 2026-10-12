# A reference consumer of materialized channels, independent of Paged order and
# filter evaluation. It deliberately uses scalar comparison and a merge sort.
snapshot_table <- function(x, collation = "C", limits = list()) {
  limits <- query_limits(limits)
  if (!is.data.frame(x) && !is.matrix(x)) {
    query_error("invalid_request", "Expected a data frame or matrix.")
  }
  if (ncol(x) > limits$max_columns) {
    query_error("limit_exceeded", "Too many columns.")
  }
  if (!identical(collation, "C") && !identical(collation, "locale")) {
    query_error("invalid_request", "Invalid collation.")
  }
  model <- query_try(function() table_model(x), "invalid_request")
  columns <- lapply(
    seq_along(model$columns),
    function(j) {
      column_extract(
        model$columns[[j]],
        c("display", "na", "values", "sortKey", "text"),
        collation,
        model$schema[[j]]
      )
    }
  )
  list(
    nrow = model$nrow,
    ncol = model$ncol,
    schema = lapply(columns, `[[`, "schema"),
    columns = columns,
    limits = limits,
    collation = collation
  )
}

snapshot_value <- function(snapshot, j, i) {
  column <- snapshot$columns[[j]]
  type <- column$schema$type
  value <- unname(column$data$values[i])
  if (type == "number" && !is.null(column$data$special)) {
    special <- column$data$special[i]
    if (!is.na(special)) {
      return(switch(
        special,
        pos_inf = Inf,
        neg_inf = -Inf,
        na = NA_real_,
        nan = NA_real_
      ))
    }
  }
  if (type == "date") {
    return(as.numeric(as.Date(value)))
  }
  if (type == "datetime") return(query_iso_time(value, column$schema$tz))
  value
}

snapshot_key <- function(snapshot, j, i) {
  column <- snapshot$columns[[j]]
  mask <- column$data$na
  if (is.null(mask)) {
    query_error("schema_changed", "Snapshot has no valid missingness channel.")
  }
  if (mask[i]) {
    return(NA_real_)
  }
  if (column$schema$type %in% c("boolean", "integer", "number")) {
    return(snapshot_value(snapshot, j, i))
  }
  key <- column$data$sortKey
  if (is.null(key)) {
    query_error("schema_changed", "Snapshot has no sort key.")
  }
  key[i]
}

snapshot_compare <- function(a, b) {
  if (is.na(a) && is.na(b)) {
    return(0L)
  }
  if (is.na(a)) {
    return(1L)
  }
  if (is.na(b)) {
    return(-1L)
  }
  if (a < b) {
    -1L
  } else if (a > b) {
    1L
  } else {
    0L
  }
}

# Canonical strings can be ordered by sign, digit count, and ASCII digits.
snapshot_decimal_compare <- function(a, b) {
  negative_a <- startsWith(a, "-")
  negative_b <- startsWith(b, "-")
  if (negative_a != negative_b) {
    return(if (negative_a) -1L else 1L)
  }
  aa <- if (negative_a) substring(a, 2L) else a
  bb <- if (negative_b) substring(b, 2L) else b
  result <- if (nchar(aa) != nchar(bb)) {
    if (nchar(aa) < nchar(bb)) -1L else 1L
  } else {
    left <- utf8ToInt(aa)
    right <- utf8ToInt(bb)
    different <- which(left != right)
    if (!length(different)) {
      0L
    } else if (left[different[1L]] < right[different[1L]]) {
      -1L
    } else {
      1L
    }
  }
  if (negative_a) -result else result
}

snapshot_filter <- function(snapshot, node, i) {
  op <- node$op
  if (op == "and") {
    return(all(vapply(
      node$args,
      function(arg) snapshot_filter(snapshot, arg, i),
      logical(1L)
    )))
  }
  if (op == "or") {
    return(any(vapply(
      node$args,
      function(arg) snapshot_filter(snapshot, arg, i),
      logical(1L)
    )))
  }
  if (op == "not") {
    return(!snapshot_filter(snapshot, node$arg, i))
  }
  j <- node$col + 1L
  column <- snapshot$columns[[j]]
  missing <- column$data$na
  if (is.null(missing)) {
    query_error("schema_changed", "Snapshot has no valid missingness channel.")
  }
  if (op == "is_na") {
    return(missing[i])
  }
  if (missing[i]) {
    return(FALSE)
  }
  if (op %in% c("contains", "starts_with", "ends_with", "text_equals")) {
    if (is.null(column$data$text)) {
      query_error("schema_changed", "Snapshot has no filter text.")
    }
    text <- query_fold(unname(column$data$text[i]))
    target <- query_fold(node$value)
    if (is.na(text)) {
      return(FALSE)
    }
    size <- nchar(text)
    width <- nchar(target)
    if (op == "text_equals") {
      return(identical(text, target))
    }
    if (width > size) {
      return(FALSE)
    }
    if (op == "starts_with") {
      return(substr(text, 1L, width) == target)
    }
    if (op == "ends_with") {
      return(substr(text, size - width + 1L, size) == target)
    }
    return(any(vapply(
      seq_len(size - width + 1L),
      function(start) substr(text, start, start + width - 1L) == target,
      logical(1L)
    )))
  }
  value <- snapshot_value(snapshot, j, i)
  if (length(value) != 1L || is.na(value)) {
    return(FALSE)
  }
  if (op == "is_true") {
    return(isTRUE(value))
  }
  if (op == "is_false") {
    return(identical(value, FALSE))
  }
  if (op == "in") {
    return(value %in% node$values)
  }
  compare <- if (column$schema$type == "int64") {
    snapshot_decimal_compare
  } else {
    snapshot_compare
  }
  if (op == "between") {
    return(compare(value, node$lower) >= 0L && compare(value, node$upper) <= 0L)
  }
  comparison <- compare(value, node$value)
  switch(
    op,
    eq = comparison == 0L,
    ne = comparison != 0L,
    lt = comparison < 0L,
    le = comparison <= 0L,
    gt = comparison > 0L,
    ge = comparison >= 0L
  )
}

snapshot_indices <- function(snapshot, sort = list(), filter = NULL) {
  sort <- query_sort(snapshot, sort)
  filter <- query_filter_validate(snapshot, filter)
  rows <- seq_len(snapshot$nrow)
  if (!is.null(filter)) {
    rows <- rows[
      vapply(
        rows,
        function(i) snapshot_filter(snapshot, filter, i),
        logical(1L)
      )
    ]
  }
  before <- function(a, b) {
    for (item in sort) {
      left <- snapshot_key(snapshot, item$col + 1L, a)
      right <- snapshot_key(snapshot, item$col + 1L, b)
      comparison <- snapshot_compare(left, right)
      if (comparison) {
        if (!is.na(left) && !is.na(right) && item$desc) {
          comparison <- -comparison
        }
        return(comparison < 0L)
      }
    }
    a < b
  }
  merge <- function(rows) {
    n <- length(rows)
    if (n < 2L) {
      return(rows)
    }
    mid <- n %/% 2L
    left <- merge(rows[seq_len(mid)])
    right <- merge(rows[seq.int(mid + 1L, n)])
    output <- rows
    a <- b <- 1L
    for (i in seq_len(n)) {
      if (
        b > length(right) || (a <= length(left) && before(left[a], right[b]))
      ) {
        output[i] <- left[a]
        a <- a + 1L
      } else {
        output[i] <- right[b]
        b <- b + 1L
      }
    }
    output
  }
  if (length(sort)) merge(rows) else rows
}

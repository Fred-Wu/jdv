# Internal query state owns references and bounded entry caches, not a registry.
query_error <- function(code, message, details = NULL) {
  stop(structure(
    list(message = message, call = NULL, code = code, details = details),
    class = c("jdv_query_error", "error", "condition")
  ))
}

query_try <- function(fun, code = "r_error") {
  tryCatch(
    fun(),
    error = function(e) {
      if (inherits(e, "jdv_query_error")) {
        stop(e)
      }
      query_error(code, conditionMessage(e))
    }
  )
}

query_integer <- function(x, name, minimum = 0) {
  if (
    !typeof(x) %in% c("integer", "double") ||
      is.object(x) ||
      !is.null(dim(x)) ||
      length(x) != 1L ||
      is.na(x) ||
      !is.finite(x) ||
      x != floor(x) ||
      x < minimum ||
      x > 2^53
  ) {
    query_error("invalid_request", paste0(name, " must be one finite integer."))
  }
  unname(x)
}

query_limits <- function(limits = list()) {
  defaults <- list(
    probe_rows = 32L,
    max_columns = 4096L,
    page_rows = 2000L,
    page_columns = 256L,
    sort_columns = 16L,
    ast_depth = 32L,
    ast_nodes = 256L,
    text_bytes = 4096L,
    filter_bytes = 65536L,
    column_cache = 32L,
    channel_cache = 32L,
    index_cache = 8L
  )
  if (
    !is.list(limits) ||
      is.object(limits) ||
      (length(limits) &&
        (is.null(names(limits)) || anyDuplicated(names(limits)))) ||
      any(!names(limits) %in% names(defaults))
  ) {
    query_error("invalid_request", "Invalid query limits.")
  }
  for (name in names(limits)) {
    value <- query_integer(limits[[name]], name, 1)
    if (value > .Machine$integer.max || (name == "ast_depth" && value > 128L)) {
      query_error("invalid_request", "Query limit exceeds the supported range.")
    }
    defaults[[name]] <- as.integer(value)
  }
  defaults
}

query_alive <- function(holder) {
  if (!inherits(holder, "jdv_paged_table") || !is.environment(holder)) {
    query_error("invalid_request", "Expected a paged table holder.")
  }
  if (holder$closed) {
    query_error("table_not_found", "The table was disposed.")
  }
  invisible(holder)
}

# Respect class methods. Atomic S3 classes without a subset method retain their
# metadata; classes with row-dependent attributes must supply their own method.
query_slice <- function(x, rows) {
  out <- query_try(function() {
    if (is.matrix(x) || is.data.frame(x)) x[rows, , drop = FALSE] else x[rows]
  })
  if (
    is.object(x) &&
      !isS4(x) &&
      is.atomic(x) &&
      is.null(dim(x)) &&
      !identical(class(out), class(x))
  ) {
    methods <- vapply(
      class(x),
      function(class) !is.null(utils::getS3method("[", class, optional = TRUE)),
      logical(1L)
    )
    if (!any(methods)) {
      metadata <- attributes(x)
      metadata$names <- names(out)
      attributes(out) <- metadata
    }
  }
  if (
    column_size(out) != length(rows) ||
      (is.object(x) && !identical(class(out), class(x)))
  ) {
    query_error(
      "schema_changed",
      "Subsetting changed the column class or size."
    )
  }
  out
}

query_probe <- function(holder) {
  x <- holder$source
  rows <- seq_len(min(holder$nrow, holder$limits$probe_rows))
  n <- holder$ncol
  column_names <- colnames(x)
  if (is.null(column_names)) {
    column_names <- rep("", n)
  }
  channels <- c("display", "na", "values", "sortKey")
  shared <- if (is.matrix(x) && n) {
    query_try(function() {
      column_extract(x[rows, 1L], channels, holder$collation)
    })
  } else {
    NULL
  }
  probes <- lapply(seq_len(n), function(i) {
    result <- if (is.matrix(x)) {
      shared
    } else {
      column <- x[[i]]
      schema <- column_schema(column)
      query_try(function() {
        column_extract(
          query_slice(column, rows),
          channels,
          holder$collation,
          schema
        )
      })
    }
    result$schema$name <- column_names[[i]]
    result$schema$position <- i - 1L
    result
  })
  holder$schema <- lapply(probes, `[[`, "schema")
  holder$probe_errors <- lapply(probes, `[[`, "errors")
  invisible(holder)
}

paged_table <- function(x, collation = "C", limits = list()) {
  if (!is.data.frame(x) && !is.matrix(x)) {
    query_error("invalid_request", "Expected a data frame or matrix.")
  }
  if (
    !is.character(collation) ||
      length(collation) != 1L ||
      is.na(collation) ||
      !collation %in% c("C", "locale")
  ) {
    query_error("invalid_request", "Invalid collation.")
  }
  limits <- query_limits(limits)
  if (ncol(x) > limits$max_columns) {
    query_error("limit_exceeded", "Too many columns.")
  }
  holder <- new.env(parent = emptyenv())
  class(holder) <- "jdv_paged_table"
  holder$source <- x
  holder$nrow <- nrow(x)
  holder$ncol <- ncol(x)
  holder$collation <- collation
  holder$limits <- limits
  holder$closed <- FALSE
  holder$explicit_row_names <- if (is.data.frame(x)) {
    .row_names_info(x, type = 1L) > 0L
  } else {
    !is.null(rownames(x))
  }
  query_clear(holder)
  query_probe(holder)
  holder
}

query_clear <- function(holder) {
  query_alive(holder)
  holder$column_cache <- list()
  holder$channel_cache <- list()
  holder$index_cache <- list()
  invisible(holder)
}

query_dispose <- function(holder) {
  query_alive(holder)
  query_clear(holder)
  holder$source <- NULL
  holder$schema <- NULL
  holder$probe_errors <- NULL
  holder$explicit_row_names <- FALSE
  holder$nrow <- 0L
  holder$ncol <- 0L
  holder$closed <- TRUE
  invisible(NULL)
}

query_cache_get <- function(holder, name, key) {
  cache <- holder[[name]]
  at <- match(key, names(cache))
  if (is.na(at)) {
    return(NULL)
  }
  value <- cache[[at]]
  holder[[name]] <- c(cache[-at], cache[at])
  value
}

query_cache_set <- function(holder, name, key, value) {
  cache <- holder[[name]]
  cache[key] <- NULL
  cache[key] <- list(value)
  capacity <- holder$limits[[name]]
  if (length(cache) > capacity) {
    cache <- utils::tail(cache, capacity)
  }
  holder[[name]] <- cache
  value
}

query_col <- function(table, col) {
  col <- query_integer(col, "col")
  if (col >= table$ncol) {
    query_error("invalid_request", "Column is out of range.")
  }
  as.integer(col) + 1L
}

query_column <- function(holder, j) {
  key <- as.character(j)
  cached <- query_cache_get(holder, "column_cache", key)
  if (!is.null(cached)) {
    return(cached)
  }
  column <- query_try(function() {
    if (is.matrix(holder$source)) holder$source[, j] else holder$source[[j]]
  })
  if (
    column_size(column) != holder$nrow ||
      !identical(column_schema(column)$class, holder$schema[[j]]$class)
  ) {
    query_error("schema_changed", "The full column differs from its probe.")
  }
  query_cache_set(holder, "column_cache", key, column)
}

query_channel <- function(holder, j, channel) {
  key <- paste(j, channel, sep = ":")
  cached <- query_cache_get(holder, "channel_cache", key)
  if (!is.null(cached)) {
    return(cached)
  }
  column <- query_column(holder, j)
  result <- query_try(function() {
    column_extract(column, channel, holder$collation, holder$schema[[j]])
  })
  if (is.null(result$data[[channel]])) {
    messages <- unlist(result$errors, use.names = FALSE)
    code <- if (
      !length(messages) ||
        any(grepl("Invalid channel result", messages, fixed = TRUE))
    ) {
      "schema_changed"
    } else {
      "r_error"
    }
    query_error(code, paste0("Could not compute ", channel, "."), result)
  }
  query_cache_set(holder, "channel_cache", key, result$data)
}

query_sort <- function(table, sort) {
  if (!json_is_array(sort)) {
    query_error("invalid_request", "sort must be an array.")
  }
  if (length(sort) > table$limits$sort_columns) {
    query_error("limit_exceeded", "Too many sort columns.")
  }
  columns <- integer()
  result <- lapply(sort, function(item) {
    query_fields(item, c("col", "desc"), c("col", "desc"))
    j <- query_col(table, item$col)
    if (j %in% columns) {
      query_error("invalid_request", "Duplicate sort columns.")
    }
    columns <<- c(columns, j)
    if (
      !is.logical(item$desc) ||
        is.object(item$desc) ||
        !is.null(dim(item$desc)) ||
        length(item$desc) != 1L ||
        is.na(item$desc)
    ) {
      query_error("invalid_request", "desc must be one Boolean.")
    }
    if (!table$schema[[j]]$sortable) {
      query_error("unsupported", "Column is not sortable.")
    }
    list(col = j - 1L, desc = unname(item$desc))
  })
  result
}

query_indices <- function(holder, sort = list(), filter = NULL) {
  query_alive(holder)
  sort <- query_sort(holder, sort)
  filter <- query_filter_validate(holder, filter)
  if (!length(sort) && is.null(filter)) {
    return(seq_len(holder$nrow))
  }
  key <- paste(
    as.character(serialize(list(sort, filter), NULL, version = 2L)),
    collapse = ""
  )
  cached <- query_cache_get(holder, "index_cache", key)
  if (!is.null(cached)) {
    return(cached)
  }
  rows <- if (is.null(filter)) {
    seq_len(holder$nrow)
  } else {
    which(query_try(function() query_filter_eval(holder, filter)))
  }
  if (length(sort)) {
    keys <- lapply(sort, function(item) {
      j <- item$col + 1L
      column <- query_column(holder, j)
      key <- if (
        holder$collation == "C" && !is.object(column) && is.character(column)
      ) {
        column[rows]
      } else {
        query_channel(holder, j, "sortKey")$sortKey[rows]
      }
      missing <- query_channel(holder, j, "na")$na[rows]
      key[missing] <- NA
      key
    })
    rows <- rows[
      query_try(function() {
        do.call(
          order,
          c(
            keys,
            list(
              decreasing = vapply(sort, `[[`, logical(1L), "desc"),
              method = "radix",
              na.last = TRUE
            )
          )
        )
      })
    ]
  }
  query_cache_set(holder, "index_cache", key, rows)
}

query_page <- function(
  holder,
  offset = 0L,
  limit = 200L,
  sort = list(),
  filter = NULL,
  cols = NULL
) {
  query_alive(holder)
  offset <- query_integer(offset, "offset")
  limit <- min(query_integer(limit, "limit"), holder$limits$page_rows)
  js <- if (is.null(cols)) {
    seq_len(holder$ncol)
  } else {
    if (json_is_array(cols)) {
      vapply(cols, function(col) query_col(holder, col), integer(1L))
    } else if (
      (is.object(cols) && !inherits(cols, "jdv_json_array")) ||
        !is.null(dim(cols)) ||
        !typeof(cols) %in% c("integer", "double")
    ) {
      query_error("invalid_request", "cols must be integer column selectors.")
    } else {
      vapply(as.list(cols), function(col) query_col(holder, col), integer(1L))
    }
  }
  if (anyDuplicated(js)) {
    query_error("invalid_request", "Duplicate page columns.")
  }
  if (length(js) > holder$limits$page_columns) {
    query_error("limit_exceeded", "Too many page columns.")
  }
  indices <- query_indices(holder, sort, filter)
  total <- length(indices)
  count <- min(limit, max(0, total - offset))
  rows <- indices[offset + seq_len(count)]
  columns <- lapply(js, function(j) {
    column <- if (is.matrix(holder$source)) {
      query_try(function() holder$source[rows, j])
    } else {
      query_slice(holder$source[[j]], rows)
    }
    query_try(function() {
      column_extract(
        column,
        c("display", "na", "values"),
        holder$collation,
        holder$schema[[j]]
      )
    })
  })
  row_names <- if (holder$explicit_row_names) {
    if (is.matrix(holder$source)) {
      rownames(holder$source)[rows]
    } else {
      as.character(attr(holder$source, "row.names")[rows])
    }
  } else {
    NULL
  }
  list(
    total = total,
    total_unfiltered = holder$nrow,
    offset = offset,
    limit = limit,
    data = list(row_index = rows, row_names = row_names, columns = columns)
  )
}

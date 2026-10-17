# Internal query state owns references and bounded entry caches, not a registry.
query_error <- function(code, message, details = NULL) {
  stop(jdv_condition(code, message, details, "jdv_query_error"))
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
    page_rows = 2000L,
    page_columns = 256L,
    sort_columns = 16L,
    ast_depth = 32L,
    ast_nodes = 256L,
    text_bytes = 4096L,
    filter_bytes = 65536L,
    column_cache = 32L,
    channel_cache = 32L,
    index_cache = 8L,
    work_bytes = .jdv_max_work_bytes(),
    page_work_bytes = .jdv_page_work_bytes(),
    snapshot_work_bytes = .jdv_snapshot_work_bytes(),
    cache_bytes = .jdv_max_cache_bytes(),
    query_rows = .jdv_max_query_rows()
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
    value <- limits[[name]]
    if (name %in% c("work_bytes", "query_rows") && identical(value, Inf)) {
      defaults[[name]] <- Inf
      next
    }
    value <- query_integer(value, name, 1)
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
    query_error("view_not_found", "The view was disposed.")
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

# An attribute-free logical, integer, or double vector: its probe result is
# determined by its type alone when it dispatches to the default methods.
query_plain_candidate <- function(column) {
  !is.object(column) &&
    typeof(column) %in% c("logical", "integer", "double") &&
    is.null(attributes(column))
}

# TRUE when the column generics resolve to jdv's own default methods for the
# implicit class of this type, so user-defined methods are never bypassed.
query_plain_dispatch <- function(type) {
  classes <- c(type, if (type != "logical") "numeric")
  own <- topenv(environment(query_plain_dispatch))
  for (generic in c("col_display", "col_is_na", "col_values", "col_sort_key")) {
    for (class in classes) {
      if (!is.null(utils::getS3method(generic, class, optional = TRUE))) {
        return(FALSE)
      }
    }
    default <- utils::getS3method(generic, "default", optional = TRUE)
    if (!identical(environment(default), own)) {
      return(FALSE)
    }
  }
  # The default methods call these closure generics, which dispatch on the
  # implicit class even for unclassed vectors. (is.na() is primitive and does
  # not dispatch on non-objects.)
  for (generic in c("xtfrm", "format")) {
    for (class in classes) {
      if (!is.null(utils::getS3method(generic, class, optional = TRUE))) {
        return(FALSE)
      }
    }
  }
  TRUE
}

query_probe <- function(holder, budget = NULL) {
  x <- holder$source
  budget <- budget %||% .jdv_budget(holder$limits$page_work_bytes)
  rows <- seq_len(min(holder$nrow, holder$limits$probe_rows))
  n <- holder$ncol
  column_names <- colnames(x)
  if (is.null(column_names)) {
    column_names <- rep("", n)
  }
  channels <- c("display", "na", "values", "sortKey")
  shared <- if (is.matrix(x) && n) {
    query_try(function() {
      column_extract(x[rows, 1L], channels, holder$collation, budget = budget)
    })
  } else {
    NULL
  }
  probe_peak <- budget$used
  # Plain atomic columns of one type that dispatch to the default methods are
  # probed once and the result is shared, like the columns of a matrix.
  plain_probes <- list()
  plain_dispatch <- list()
  probes <- lapply(seq_len(n), function(i) {
    budget$used <- 0
    result <- if (is.matrix(x)) {
      shared
    } else {
      column <- x[[i]]
      plain_type <- NULL
      if (query_plain_candidate(column)) {
        type <- typeof(column)
        if (is.null(plain_dispatch[[type]])) {
          plain_dispatch[[type]] <<- query_plain_dispatch(type)
        }
        if (plain_dispatch[[type]]) plain_type <- type
      }
      if (!is.null(plain_type) && !is.null(plain_probes[[plain_type]])) {
        reused <- plain_probes[[plain_type]]
        reused$schema$name <- column_names[[i]]
        reused$schema$position <- i - 1L
        return(list(schema = reused$schema, errors = reused$errors))
      }
      schema <- column_schema(column)
      packed <- is.matrix(column) || is.data.frame(column)
      probed <- query_try(function() {
        column_extract(
          if (packed) column else query_slice(column, rows),
          channels,
          holder$collation,
          schema,
          budget,
          rows = if (packed) rows else NULL
        )
      })
      if (!is.null(plain_type)) {
        plain_probes[[plain_type]] <<- probed
      }
      probed
    }
    probe_peak <- max(probe_peak, budget$used)
    result$schema$name <- column_names[[i]]
    result$schema$position <- i - 1L
    list(schema = result$schema, errors = result$errors)
  })
  holder$schema <- lapply(probes, `[[`, "schema")
  holder$probe_errors <- lapply(probes, `[[`, "errors")
  budget$used <- probe_peak
  holder$probe_work_used <- probe_peak
  invisible(holder)
}

paged_table <- function(x, collation = "C", limits = list(), budget = NULL) {
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
  budget <- budget %||% .jdv_budget(limits$page_work_bytes)
  query_probe(holder, budget)
  holder
}

query_clear <- function(holder) {
  query_alive(holder)
  holder$column_cache <- list()
  holder$channel_cache <- list()
  holder$index_cache <- list()
  holder$recent_index_key <- NULL
  holder$recent_indices <- NULL
  holder$cache_order <- character()
  holder$cache_sizes <- numeric()
  holder$cache_bytes <- 0
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

.jdv_cache_token <- function(name, key) paste(name, key, sep = "\034")

.jdv_cache_estimate <- function(value, cap, depth = 0L) {
  if (depth > 8L) {
    return(cap + 1)
  }
  if (is.character(value)) {
    return(128 + length(value) * 8 + .jdv_string_bytes(value, cap))
  }
  if (is.list(value)) {
    bytes <- 128 + length(value) * 8
    if (!is.null(names(value))) {
      bytes <- bytes + .jdv_string_bytes(names(value), cap - bytes)
    }
    for (item in value) {
      bytes <- bytes + .jdv_cache_estimate(item, cap - bytes, depth + 1L)
      if (bytes > cap) return(cap + 1)
    }
    return(bytes)
  }
  per_element <- switch(
    typeof(value),
    logical = 4,
    integer = 4,
    double = 8,
    raw = 1,
    16
  )
  128 + as.double(length(value)) * per_element
}

.jdv_cache_evict <- function(holder, token) {
  split <- strsplit(token, "\034", fixed = TRUE)[[1L]]
  name <- split[[1L]]
  key <- substring(token, nchar(name, type = "bytes") + 2L)
  cache <- holder[[name]]
  cache[key] <- NULL
  holder[[name]] <- cache
  if (token %in% names(holder$cache_sizes)) {
    holder$cache_bytes <- holder$cache_bytes - holder$cache_sizes[[token]]
  }
  holder$cache_sizes <- holder$cache_sizes[names(holder$cache_sizes) != token]
  holder$cache_order <- holder$cache_order[holder$cache_order != token]
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
  token <- .jdv_cache_token(name, key)
  holder$cache_order <- c(
    holder$cache_order[holder$cache_order != token],
    token
  )
  value
}

query_cache_set <- function(holder, name, key, value) {
  token <- .jdv_cache_token(name, key)
  key_bytes <- nchar(key, type = "bytes") + 64
  bytes <- if (name == "column_cache" && !is.matrix(holder$source)) {
    key_bytes
  } else {
    key_bytes + .jdv_cache_estimate(value, holder$limits$cache_bytes)
  }
  if (bytes > holder$limits$cache_bytes) {
    return(value)
  }
  cache <- holder[[name]]
  if (key %in% names(cache)) {
    .jdv_cache_evict(holder, token)
  }
  cache <- holder[[name]]
  cache[key] <- list(value)
  capacity <- holder$limits[[name]]
  holder[[name]] <- cache
  holder$cache_sizes[token] <- bytes
  holder$cache_bytes <- holder$cache_bytes + bytes
  holder$cache_order <- c(holder$cache_order, token)
  while (length(holder[[name]]) > capacity) {
    oldest <- holder$cache_order[
      startsWith(holder$cache_order, paste0(name, "\034"))
    ][[1L]]
    .jdv_cache_evict(holder, oldest)
  }
  while (holder$cache_bytes > holder$limits$cache_bytes) {
    .jdv_cache_evict(holder, holder$cache_order[[1L]])
  }
  value
}

query_col <- function(table, col) {
  col <- query_integer(col, "col")
  if (col >= table$ncol) {
    query_error("invalid_request", "Column is out of range.")
  }
  as.integer(col) + 1L
}

query_column <- function(holder, j, budget = NULL) {
  key <- as.character(j)
  cached <- query_cache_get(holder, "column_cache", key)
  if (!is.null(cached)) {
    return(cached)
  }
  if (is.matrix(holder$source)) {
    .jdv_budget_charge(budget, as.double(holder$nrow) * 16, "matrix_column")
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

query_channel <- function(holder, j, channel, budget = NULL) {
  key <- paste(j, channel, sep = ":")
  cached <- query_cache_get(holder, "channel_cache", key)
  if (!is.null(cached)) {
    return(cached)
  }
  column <- query_column(holder, j, budget)
  result <- query_try(function() {
    column_extract(
      column,
      channel,
      holder$collation,
      holder$schema[[j]],
      budget
    )
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

.jdv_filter_nodes <- function(node) {
  if (is.null(node)) {
    return(0L)
  }
  if (node$op %in% c("and", "or")) {
    return(1L + sum(vapply(node$args, .jdv_filter_nodes, integer(1L))))
  }
  if (identical(node$op, "not")) {
    return(1L + .jdv_filter_nodes(node$arg))
  }
  1L
}

query_indices <- function(holder, sort = list(), filter = NULL, budget = NULL) {
  query_alive(holder)
  sort <- query_sort(holder, sort)
  filter <- query_filter_validate(holder, filter)
  budget <- budget %||% .jdv_budget(holder$limits$work_bytes)
  if (!length(sort) && is.null(filter)) {
    holder$recent_index_key <- NULL
    holder$recent_indices <- NULL
    # seq_len() is ALTREP on supported R versions and does not materialize a
    # full row index for an unfiltered table.
    return(seq_len(holder$nrow))
  }
  if (holder$nrow > holder$limits$query_rows) {
    query_error(
      "limit_exceeded",
      "Sort and filter work exceeds the configured row or byte limit."
    )
  }
  key <- paste(
    as.character(serialize(list(sort, filter), NULL, version = 2L)),
    collapse = ""
  )
  if (!identical(holder$recent_index_key, key)) {
    holder$recent_index_key <- NULL
    holder$recent_indices <- NULL
  } else if (!is.null(holder$recent_indices)) {
    return(holder$recent_indices)
  }
  cached <- query_cache_get(holder, "index_cache", key)
  if (!is.null(cached)) {
    holder$recent_index_key <- key
    holder$recent_indices <- cached
    return(cached)
  }
  work <- as.double(holder$nrow) *
    (16 + 24 * length(sort) + 6 * .jdv_filter_nodes(filter))
  if (work > .jdv_budget_remaining(budget)) {
    query_error(
      "limit_exceeded",
      "Sort and filter work exceeds the configured row or byte limit."
    )
  }
  .jdv_budget_charge(budget, work, "query_index")
  rows <- if (is.null(filter)) {
    seq_len(holder$nrow)
  } else {
    which(query_try(function() query_filter_eval(holder, filter, budget)))
  }
  if (length(sort)) {
    keys <- lapply(sort, function(item) {
      j <- item$col + 1L
      column <- query_column(holder, j, budget)
      key <- if (
        holder$collation == "C" && !is.object(column) && is.character(column)
      ) {
        column[rows]
      } else {
        query_channel(holder, j, "sortKey", budget)$sortKey[rows]
      }
      missing <- query_channel(holder, j, "na", budget)$na[rows]
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
  rows <- query_cache_set(holder, "index_cache", key, rows)
  holder$recent_index_key <- key
  holder$recent_indices <- rows
  rows
}

query_page <- function(
  holder,
  offset = 0L,
  limit = 200L,
  sort = list(),
  filter = NULL,
  cols = NULL,
  budget = NULL,
  query_budget = NULL
) {
  query_alive(holder)
  offset <- query_integer(offset, "offset")
  limit <- min(query_integer(limit, "limit"), holder$limits$page_rows)
  implicit_cols <- is.null(cols)
  js <- if (implicit_cols) {
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
  if (!implicit_cols && length(js) > holder$limits$page_columns) {
    query_error("limit_exceeded", "Too many page columns.")
  }
  budget <- budget %||% .jdv_budget(holder$limits$page_work_bytes)
  query_budget <- query_budget %||% .jdv_budget(holder$limits$work_bytes)
  has_query <- length(sort) > 0L || !is.null(filter)
  page_limit <- limit
  if (has_query) {
    indices <- query_indices(holder, sort, filter, query_budget)
    if (is.finite(holder$limits$work_bytes)) {
      budget$limit <- min(
        budget$limit,
        max(1, holder$limits$work_bytes - query_budget$used)
      )
    }
    total <- length(indices)
    count <- min(limit, max(0, total - offset))
    candidate_rows <- if (count) indices[offset + seq_len(count)] else integer()
    requested_count <- count
    if (implicit_cols) {
      count <- .jdv_page_row_capacity(
        holder,
        js,
        candidate_rows,
        requested_count,
        budget
      )
    }
    if (count < requested_count) {
      page_limit <- count
    }
    rows <- if (count) candidate_rows[seq_len(count)] else integer()
  } else {
    holder$recent_index_key <- NULL
    holder$recent_indices <- NULL
    total <- holder$nrow
    count <- min(limit, max(0, total - offset))
    candidate_rows <- if (count) {
      seq.int(offset + 1, length.out = count)
    } else {
      integer()
    }
    requested_count <- count
    if (implicit_cols) {
      count <- .jdv_page_row_capacity(
        holder,
        js,
        candidate_rows,
        requested_count,
        budget
      )
    }
    if (count < requested_count) {
      page_limit <- count
    }
    rows <- if (count) candidate_rows[seq_len(count)] else integer()
  }
  .jdv_budget_charge(budget, 8 * length(rows), "page_rows")
  columns <- lapply(js, function(j) {
    packed_column <- is.data.frame(holder$source) &&
      (is.matrix(holder$source[[j]]) || is.data.frame(holder$source[[j]]))
    column <- if (packed_column) {
      holder$source[[j]]
    } else if (is.matrix(holder$source)) {
      query_try(function() holder$source[rows, j])
    } else {
      query_slice(holder$source[[j]], rows)
    }
    query_try(function() {
      column_extract(
        column,
        c("display", "na", "values"),
        holder$collation,
        holder$schema[[j]],
        budget,
        rows = if (packed_column) rows else NULL
      )
    })
  })
  row_names <- if (holder$explicit_row_names) {
    .jdv_budget_charge(budget, 8 * length(rows), "row_names")
    if (is.matrix(holder$source)) {
      rownames(holder$source)[rows]
    } else {
      as.character(attr(holder$source, "row.names")[rows])
    }
  } else {
    NULL
  }
  result <- list(
    total = total,
    total_unfiltered = holder$nrow,
    offset = offset,
    limit = page_limit,
    data = list(row_index = rows, row_names = row_names, columns = columns)
  )
  attr(result, "jdv_work_budget") <- budget
  result
}

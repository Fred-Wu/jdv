# Engine work budgets are conservative estimates, not process RSS limits. They
# account for R-owned channel copies retained by a request and leave the
# remaining allowance for the native JSON encoder.
.jdv_budget <- function(limit, auto_fallback = FALSE) {
  budget <- new.env(parent = emptyenv())
  budget$limit <- as.double(limit)
  budget$used <- 0
  budget$auto_fallback <- auto_fallback
  budget
}

.jdv_budget_error <- function(message, kind, auto_fallback = FALSE) {
  query_error(
    "limit_exceeded",
    message,
    details = list(kind = kind, auto_fallback = auto_fallback)
  )
}

.jdv_budget_charge <- function(budget, bytes, kind = "work") {
  if (is.null(budget) || !is.environment(budget)) {
    return(invisible(NULL))
  }
  bytes <- as.double(bytes)
  if (!is.finite(bytes) || bytes < 0 || budget$used + bytes > budget$limit) {
    .jdv_budget_error(
      "The table operation exceeds its configured work byte budget.",
      kind,
      budget$auto_fallback
    )
  }
  budget$used <- budget$used + bytes
  invisible(NULL)
}

.jdv_budget_remaining <- function(budget) {
  if (is.null(budget)) {
    return(.jdv_page_work_bytes())
  }
  max(1, budget$limit - budget$used)
}

.jdv_plain_string_dispatch <- function() {
  tryCatch(
    {
      registry_method <- function(generic, class, namespace) {
        table <- get(".__S3MethodsTable__.", envir = namespace)
        get0(paste(generic, class, sep = "."), envir = table, inherits = FALSE)
      }
      visible_method <- function(generic, class) {
        name <- paste(generic, class, sep = ".")
        get0(name, envir = .GlobalEnv, mode = "function", inherits = TRUE)
      }
      method_matches <- function(generic, class, namespace, expected) {
        registered <- registry_method(generic, class, namespace)
        visible <- visible_method(generic, class)
        identical(registered, expected) &&
          (is.null(visible) || identical(visible, expected))
      }
      no_method <- function(generic, class, namespace) {
        is.null(registry_method(generic, class, namespace)) &&
          is.null(visible_method(generic, class))
      }
      method_matches(
        "col_display",
        "default",
        asNamespace("jdv"),
        col_display.default
      ) &&
        no_method("col_display", "character", asNamespace("jdv")) &&
        method_matches(
          "col_values",
          "character",
          asNamespace("jdv"),
          col_values.character
        ) &&
        method_matches(
          "col_is_na",
          "default",
          asNamespace("jdv"),
          col_is_na.default
        ) &&
        no_method("col_is_na", "character", asNamespace("jdv")) &&
        method_matches(
          "format",
          "default",
          asNamespace("base"),
          get("format.default", envir = asNamespace("base"), inherits = FALSE)
        ) &&
        no_method("format", "character", asNamespace("base"))
    },
    error = function(error) FALSE
  )
}

.jdv_plain_query_dispatch <- function(type) {
  if (!query_plain_dispatch(type)) {
    return(FALSE)
  }
  namespace <- asNamespace("jdv")
  base_namespace <- asNamespace("base")
  registry_method <- function(generic, class, method_namespace) {
    table <- get(".__S3MethodsTable__.", envir = method_namespace)
    get0(paste(generic, class, sep = "."), envir = table, inherits = FALSE)
  }
  visible_method <- function(generic, class) {
    name <- paste(generic, class, sep = ".")
    get0(name, envir = .GlobalEnv, mode = "function", inherits = TRUE)
  }
  no_method <- function(generic, class, method_namespace) {
    is.null(registry_method(generic, class, method_namespace)) &&
      is.null(visible_method(generic, class))
  }
  method_matches <- function(generic, class, method_namespace, expected) {
    registered <- registry_method(generic, class, method_namespace)
    visible <- visible_method(generic, class)
    identical(registered, expected) &&
      (is.null(visible) || identical(visible, expected))
  }
  classes <- c(type, if (type != "logical") "numeric")
  for (generic in c("col_display", "col_is_na", "col_values", "col_sort_key")) {
    for (class in classes) {
      if (!no_method(generic, class, namespace)) {
        return(FALSE)
      }
    }
    if (
      !method_matches(
        generic,
        "default",
        namespace,
        get(paste0(generic, ".default"), envir = namespace, inherits = FALSE)
      )
    ) {
      return(FALSE)
    }
  }
  for (generic in c("xtfrm", "format")) {
    for (class in classes) {
      if (!no_method(generic, class, base_namespace)) {
        return(FALSE)
      }
    }
    default <- get0(
      paste(generic, "default", sep = "."),
      envir = get(".__S3MethodsTable__.", envir = base_namespace),
      inherits = FALSE
    )
    if (!method_matches(generic, "default", base_namespace, default)) {
      return(FALSE)
    }
  }
  TRUE
}

.jdv_plain_column_attributes <- function(x) {
  attributes <- attributes(x)
  is.null(attributes) || all(names(attributes) %in% "names")
}

.jdv_plain_numeric_format <- function() {
  identical(getOption("scipen"), 0L) &&
    identical(getOption("digits"), 7L) &&
    identical(getOption("OutDec"), ".")
}

.jdv_page_row_capacity <- function(
  holder,
  columns,
  candidate_rows,
  requested_rows,
  budget,
  message_limit = .jdv_max_message_bytes(),
  exact_strings = TRUE
) {
  column_count <- length(columns)
  work_fixed <- 128 + 128 * column_count
  remaining_work <- min(budget$limit - budget$used, .jdv_page_work_bytes())
  if (remaining_work < work_fixed) {
    .jdv_budget_error(
      "The selected page columns exceed the fixed page work budget.",
      "page_metadata"
    )
  }
  wire_columns <- lapply(columns, function(j) {
    schema <- holder$schema[[j]]
    list(
      schema = .jdv_schema_fields(schema),
      data = list(
        values = .jdv_json_values(numeric()),
        display = .jdv_json_values(character()),
        na_rows = .jdv_json_values(integer())
      ),
      errors = list()
    )
  })
  skeleton <- list(
    id = 1,
    result = list(
      view = "v-9007199254740992",
      generation = 2^53,
      total = 2^53,
      total_unfiltered = 2^53,
      offset = 2^53,
      limit = 2^53,
      data = list(
        source_row = .jdv_json_values(numeric()),
        row_labels = if (holder$explicit_row_names) {
          .jdv_json_values(character())
        } else {
          NULL
        },
        columns = wire_columns
      )
    ),
    warnings = .jdv_json_values(character())
  )
  encoded <- tryCatch(
    .jdv_json_encode(
      skeleton,
      limit = message_limit,
      work_limit = remaining_work
    ),
    error = identity
  )
  if (inherits(encoded, "error")) {
    .jdv_budget_error(
      "The selected page columns cannot fit in the JSON output budget.",
      "page_metadata"
    )
  }
  wire_fixed <- nchar(encoded, type = "bytes") + 128 + 64 * column_count
  work_rows <- rep(64, requested_rows)
  wire_rows <- rep(32, requested_rows)
  work_display_prefix <- rep(0, requested_rows)
  wire_display_prefix <- rep(0, requested_rows)
  native_tree_prefix <- rep(0, requested_rows)
  plain_preflight_peak <- rep(0, requested_rows)
  plain_preflight_prior <- 64 * seq_len(requested_rows)
  measure_cap <- max(
    1,
    remaining_work - work_fixed + message_limit - wire_fixed
  )
  plain_string_methods <- .jdv_plain_string_dispatch()
  plain_query_types <- if (is.matrix(holder$source)) {
    if (
      any(vapply(
        columns,
        function(j) {
          holder$schema[[j]]$type %in% c("number", "integer", "boolean")
        },
        logical(1L)
      ))
    ) {
      typeof(holder$source)
    } else {
      character()
    }
  } else {
    unique(vapply(
      columns,
      function(j) {
        if (holder$schema[[j]]$type %in% c("number", "integer", "boolean")) {
          typeof(holder$source[[j]])
        } else {
          NA_character_
        }
      },
      character(1L)
    ))
  }
  plain_query_types <- plain_query_types[!is.na(plain_query_types)]
  plain_query_methods <- stats::setNames(
    vapply(plain_query_types, .jdv_plain_query_dispatch, logical(1L)),
    plain_query_types
  )
  plain_capacity_page <- length(columns) > 0L &&
    requested_rows > 0L &&
    isTRUE(exact_strings) &&
    any(vapply(
      columns,
      function(j) holder$schema[[j]]$type == "string",
      logical(1L)
    )) &&
    all(vapply(
      columns,
      function(j) {
        schema <- holder$schema[[j]]
        if (is.matrix(holder$source)) {
          standard_matrix <- identical(
            class(holder$source),
            c("matrix", "array")
          )
          standard_matrix &&
            schema$type %in% c("string", "number", "integer", "boolean") &&
            if (schema$type == "string") {
              plain_string_methods
            } else {
              isTRUE(plain_query_methods[[typeof(holder$source)]])
            }
        } else {
          value <- holder$source[[j]]
          if (schema$type == "string") {
            is.character(value) &&
              !is.object(value) &&
              .jdv_plain_column_attributes(value) &&
              plain_string_methods
          } else if (schema$type %in% c("number", "integer", "boolean")) {
            !is.object(value) &&
              .jdv_plain_column_attributes(value) &&
              isTRUE(plain_query_methods[[typeof(value)]])
          } else {
            FALSE
          }
        }
      },
      logical(1L)
    ))
  if (plain_capacity_page) {
    has_numeric <- any(vapply(
      columns,
      function(j) holder$schema[[j]]$type %in% c("number", "integer"),
      logical(1L)
    ))
    plain_capacity_page <- !has_numeric || .jdv_plain_numeric_format()
  }
  native_node_bytes <- if (plain_capacity_page) {
    attr(.jdv_json_string_measure(character(), measure_cap), "node_bytes")
  } else {
    NULL
  }
  string_widths <- function(x) {
    if (!is.character(x) || !length(x)) {
      return(numeric())
    }
    widths <- nchar(x, type = "bytes", allowNA = TRUE)
    widths[is.na(widths)] <- 4L
    as.double(widths)
  }
  for (j in columns) {
    schema <- holder$schema[[j]]
    kind <- schema$type
    cost_kind <- kind
    widths <- numeric()
    levels <- character()
    if (kind %in% c("string", "factor") && requested_rows > 0) {
      if (is.matrix(holder$source)) {
        positions <- candidate_rows + (j - 1L) * holder$nrow
        # Matrix cells hold factor codes rather than level text, so a factor
        # matrix is estimated like any other classed column.
        if (
          kind == "factor" ||
            (kind == "string" &&
              !identical(class(holder$source), c("matrix", "array")))
        ) {
          cost_kind <- "other"
        } else {
          widths <- string_widths(.subset(holder$source, positions))
        }
      } else {
        source_column <- holder$source[[j]]
        if (kind == "factor") {
          if (
            !identical(class(source_column), "factor") &&
              !identical(class(source_column), c("ordered", "factor"))
          ) {
            cost_kind <- "other"
          } else {
            codes <- .subset(source_column, candidate_rows)
            levels <- attr(source_column, "levels", exact = TRUE)
            widths <- rep(0, requested_rows)
            valid <- !is.na(codes)
            widths[valid] <- string_widths(levels[codes[valid]])
          }
        } else if (is.object(source_column)) {
          cost_kind <- "other"
          widths <- rep(0, requested_rows)
        } else {
          widths <- string_widths(.subset(source_column, candidate_rows))
        }
      }
    }
    if (cost_kind == "string") {
      source_column <- if (is.matrix(holder$source)) {
        .subset(holder$source, candidate_rows + (j - 1L) * holder$nrow)
      } else {
        .subset(holder$source[[j]], candidate_rows)
      }
      measured <- if (
        !is.object(source_column) &&
          plain_capacity_page &&
          schema$type == "string" &&
          length(source_column)
      ) {
        .jdv_json_string_measure(source_column, measure_cap)
      } else {
        NULL
      }
      if (!is.null(measured) && nrow(measured) == requested_rows) {
        positions <- seq_len(requested_rows)
        width <- pmax(widths, 1)
        # Keep the existing channel charges; the transient preflight has its
        # own peak bound below.
        display_generated <- cumsum(19 + 6 * width)
        values_generated <- cumsum(19 + 6 * width)
        display_reserved <- positions * (16 + 2 * cummax(width))
        r_work <- pmax(display_reserved, display_generated) +
          values_generated +
          20 * positions
        native_strings <- cumsum(measured[, 2L] + measured[, 3L]) + 256
        work_display_prefix <- work_display_prefix + r_work
        native_tree_prefix <- pmax(native_tree_prefix, native_strings)
        # The extraction preflight rejects a column when its conservative
        # max-string bound exceeds the remaining budget. Reserve enough room
        # for that check after the page's other estimated work has been used.
        plain_preflight_peak <- pmax(
          plain_preflight_peak,
          plain_preflight_prior + 6 * positions * cummax(width)
        )
        plain_preflight_prior <- plain_preflight_prior + r_work
        row_positions <- seq_len(requested_rows) - 1L
        missing_positions <- nchar(
          as.character(row_positions),
          type = "bytes"
        ) +
          1L
        wire_items <- measured[, 1L] +
          1 +
          ifelse(is.na(source_column), missing_positions, 0)
        wire_display_prefix <- wire_display_prefix + cumsum(wire_items)
      } else {
        work_rows <- work_rows + 16
        if (plain_capacity_page) {
          return(.jdv_page_row_capacity(
            holder,
            columns,
            candidate_rows,
            requested_rows,
            budget,
            message_limit,
            exact_strings = FALSE
          ))
        }
        work_rows <- work_rows + 64
        wire_rows <- wire_rows + 64
        if (length(widths)) {
          positions <- seq_along(widths)
          work_display_prefix <- work_display_prefix +
            cumsum(32 + 6 * widths) +
            6 * positions * cummax(widths)
          wire_display_prefix <- wire_display_prefix +
            cumsum(32 + 12 * widths) +
            2 * positions * cummax(widths)
        }
      }
    } else if (cost_kind == "factor") {
      work_rows <- work_rows + 16
      work_rows <- work_rows + 64
      wire_rows <- wire_rows + 64
      if (length(widths)) {
        positions <- seq_along(widths)
        level_width <- .jdv_max_string_bytes(
          levels,
          max(0, budget$limit - budget$used)
        )
        work_display_prefix <- work_display_prefix +
          pmax(
            32 * positions + 4 * positions * max(level_width, 1),
            32 * positions + 12 * positions * cummax(widths)
          )
        wire_display_prefix <- wire_display_prefix +
          cumsum(12 * widths) +
          2 * positions * cummax(widths)
      }
    } else if (
      is.data.frame(holder$source) &&
        (is.matrix(holder$source[[j]]) || is.data.frame(holder$source[[j]]))
    ) {
      work_rows <- work_rows + 16
      source_column <- holder$source[[j]]
      row_cells <- if (nrow(source_column)) {
        .jdv_packed_cells(source_column) / nrow(source_column)
      } else {
        0
      }
      work_rows <- work_rows + 6200 + 32 * row_cells + 16 * ncol(source_column)
      wire_rows <- wire_rows + 512
    } else if (cost_kind == "list") {
      work_rows <- work_rows + 16
      source_column <- holder$source[[j]]
      cell_bytes <- vapply(
        candidate_rows,
        function(row) {
          .jdv_preflight_cell(
            .subset2(source_column, row),
            max(0, budget$limit - budget$used)
          )
        },
        numeric(1L)
      )
      work_rows <- work_rows + 6100 + cell_bytes
      wire_rows <- wire_rows + 128 + cell_bytes
    } else {
      column_work <- switch(
        cost_kind,
        number = 256,
        integer = 128,
        boolean = 128,
        date = 256,
        datetime = 384,
        int64 = 512,
        other = 512,
        512
      )
      column_wire <- switch(
        cost_kind,
        number = 80,
        integer = 48,
        boolean = 32,
        date = 128,
        datetime = 256,
        int64 = 320,
        other = 512,
        512
      )
      work_rows <- work_rows + column_work
      wire_rows <- wire_rows + column_wire
      if (
        plain_capacity_page && cost_kind %in% c("number", "integer", "boolean")
      ) {
        plain_preflight_prior <- plain_preflight_prior +
          column_work * seq_len(requested_rows)
        # Default display text (32 bytes) and special tokens (7 bytes)
        # coexist with the values and missingness nodes in one column tree.
        native_tree_prefix <- pmax(
          native_tree_prefix,
          (8 * 39 + 4 * native_node_bytes + 4) * seq_len(requested_rows) + 512
        )
      }
    }
  }
  if (holder$explicit_row_names && requested_rows > 0) {
    row_names <- if (is.matrix(holder$source)) {
      rownames(holder$source)
    } else {
      attr(holder$source, "row.names", exact = TRUE)
    }
    selected_names <- as.character(row_names[candidate_rows])
    work_rows <- work_rows + 16
    wire_rows <- wire_rows + 16 + 6 * string_widths(selected_names)
  }
  available_work <- remaining_work - work_fixed
  available_wire <- message_limit - wire_fixed
  if (available_work < 0 || available_wire < 0) {
    .jdv_budget_error(
      "The selected page columns exceed their fixed work or JSON byte budget.",
      "page_metadata"
    )
  }
  if (requested_rows == 0) {
    return(0L)
  }
  work_cumulative <- cumsum(work_rows) + work_display_prefix
  wire_cumulative <- cumsum(wire_rows) + wire_display_prefix
  if (plain_capacity_page) {
    column_names <- vapply(
      columns,
      function(j) holder$schema[[j]]$name %||% "",
      character(1L)
    )
    metadata_tree <- 2048 + 8 * max(string_widths(column_names), 0)
    # Buffer growth, a printed column, and the returned R string need at
    # most four times the wire size, alongside one streamed column tree.
    work_cumulative <- work_cumulative +
      native_tree_prefix +
      4 * (wire_fixed + wire_cumulative) +
      metadata_tree
  }
  fits <- which(
    work_cumulative <= available_work &
      wire_cumulative <= available_wire &
      (!plain_capacity_page | plain_preflight_peak <= available_work)
  )
  if (!length(fits)) {
    .jdv_budget_error(
      "Even one row of the selected page exceeds its work or JSON byte budget.",
      "page_rows"
    )
  }
  min(requested_rows, max(fits))
}

# Estimate JSON-safe text upper bounds without UTF-8 conversion. A control
# byte can expand to six ASCII bytes; other encodings expand by less.
.jdv_string_bytes <- function(x, cap = Inf) {
  if (!is.character(x) || !length(x)) {
    return(0)
  }
  if (length(x) * 3 > cap) {
    return(cap + 1)
  }
  total <- 0
  chunk_size <- 4096L
  starts <- seq.int(1L, length(x), by = chunk_size)
  for (start in starts) {
    at <- start:min(length(x), start + chunk_size - 1L)
    values <- x[at]
    lengths <- nchar(values, type = "bytes", allowNA = TRUE)
    lengths[is.na(lengths)] <- 4L
    total <- total + sum(as.double(lengths) * 6 + 3)
    if (total > cap) return(cap + 1)
  }
  total
}

.jdv_max_string_bytes <- function(x, cap = Inf) {
  if (!is.character(x) || !length(x)) {
    return(0)
  }
  max_bytes <- 0
  chunk_size <- 4096L
  starts <- seq.int(1L, length(x), by = chunk_size)
  for (start in starts) {
    at <- start:min(length(x), start + chunk_size - 1L)
    lengths <- nchar(x[at], type = "bytes", allowNA = TRUE)
    lengths[is.na(lengths)] <- 4L
    max_bytes <- max(max_bytes, lengths)
    if (max_bytes * length(x) * 6 > cap) return(cap + 1)
  }
  max_bytes
}

.jdv_metadata_budget <- function(
  x,
  limit,
  snapshot = TRUE,
  auto_fallback_row_names = FALSE
) {
  cap <- min(as.double(limit), .jdv_max_message_bytes())
  total <- 128 + 16 * as.double(ncol(x))
  add <- function(strings, kind = "metadata", auto_fallback = FALSE) {
    if (total > cap) {
      .jdv_budget_error(
        "Table metadata exceeds the configured JSON or work byte budget.",
        kind,
        auto_fallback
      )
    }
    bytes <- .jdv_string_bytes(strings, max(0, cap - total))
    total <<- total + bytes
    if (total > cap) {
      .jdv_budget_error(
        "Table metadata exceeds the configured JSON or work byte budget.",
        kind,
        auto_fallback
      )
    }
  }
  add(colnames(x))
  add(class(x))
  if (snapshot && is.data.frame(x)) {
    if (.row_names_info(x, type = 1L) > 0L) {
      add(
        attr(x, "row.names", exact = TRUE),
        "snapshot_row_names",
        auto_fallback_row_names
      )
    }
  } else if (snapshot) {
    add(rownames(x), "snapshot_row_names", auto_fallback_row_names)
  }
  for (j in seq_len(ncol(x))) {
    if (is.data.frame(x)) {
      column <- x[[j]]
      add(class(column))
      levels <- attr(column, "levels", exact = TRUE)
      if (!is.null(levels)) {
        add(levels)
      }
      add(attr(column, "tzone", exact = TRUE))
    } else {
      # A homogeneous matrix has one class/attribute set. Avoid x[0, j],
      # which can dispatch an arbitrary `[` method just to inspect metadata.
      add(class(x))
      add(attr(x, "levels", exact = TRUE))
      add(attr(x, "tzone", exact = TRUE))
      break
    }
  }
  total
}

.jdv_snapshot_raw_preflight <- function(x, budget) {
  if (is.matrix(x) && typeof(x) == "character") {
    bytes <- .jdv_string_bytes(unclass(x), .jdv_budget_remaining(budget))
    if (bytes > .jdv_budget_remaining(budget)) {
      .jdv_budget_error(
        "Raw matrix strings exceed the configured work byte budget.",
        "source_strings",
        budget$auto_fallback
      )
    }
  }
  invisible(NULL)
}

.jdv_estimate_snapshot_bytes <- function(x, cells, max_message) {
  if (!nrow(x) || !ncol(x)) {
    return(64 + 16 * as.double(nrow(x)))
  }
  sample_size <- min(256L, as.integer(min(cells, 256L)))
  if (!sample_size) {
    return(0)
  }
  rows <- unique(as.integer(
    floor(
      (seq_len(sample_size) - 1) *
        (as.double(nrow(x)) - 1) /
        max(1, sample_size - 1)
    ) +
      1
  ))
  estimate <- 256 + 24 * as.double(nrow(x))
  for (j in seq_len(ncol(x))) {
    column <- if (is.data.frame(x)) {
      x[[j]]
    } else if (is.object(x)) {
      NULL
    } else {
      x[rows, j]
    }
    if (is.null(column)) {
      estimate <- estimate + as.double(nrow(x)) * 256
      if (!is.finite(estimate) || estimate > max_message) return(estimate)
      next
    }
    schema <- column_schema(column)
    size <- if (schema$type %in% c("string", "factor")) {
      if (schema$type == "factor") {
        levels <- attr(column, "levels", exact = TRUE)
        max(.jdv_max_string_bytes(levels, max_message), 8)
      } else {
        sampled <- if (is.data.frame(x)) column[rows] else column
        .jdv_max_string_bytes(sampled, max_message)
      }
    } else if (schema$type == "list" || is.object(column)) {
      256
    } else {
      switch(
        schema$type,
        number = 96,
        integer = 48,
        boolean = 32,
        datetime = 128,
        date = 80,
        96
      )
    }
    cell_estimate <- if (schema$type %in% c("string", "factor")) {
      64 + 12 * max(size, 1)
    } else {
      size
    }
    estimate <- estimate + as.double(nrow(x)) * cell_estimate
    if (!is.finite(estimate) || estimate > max_message) return(estimate)
  }
  estimate
}

.jdv_preflight_column <- function(
  x,
  schema,
  channels,
  budget,
  n = column_size(x)
) {
  n <- as.double(n)
  kind <- schema$type
  reserved <- numeric()
  reserve <- function(channel, bytes) {
    if (channel %in% channels) {
      prior <- if (channel %in% names(reserved)) reserved[[channel]] else 0
      reserved[[channel]] <<- prior + as.double(bytes)
    }
  }
  if (kind == "string" && is.character(x)) {
    needs_text <- any(channels %in% c("display", "sortKey", "text"))
    bytes <- if (needs_text) {
      .jdv_string_bytes(x, budget$limit - budget$used)
    } else {
      0
    }
    width <- if (needs_text) {
      .jdv_max_string_bytes(x, budget$limit - budget$used)
    } else {
      0
    }
    # Reserve for width-dependent formatting without relying on method output.
    reserve("display", n * (16 + 2 * max(width, 1)))
    if (schema$sortable) {
      reserve("sortKey", 16 * n + bytes)
    }
    reserve("text", 16 * n + bytes)
  } else if (kind == "factor") {
    needs_text <- any(channels %in% c("display", "sortKey", "text", "values"))
    levels <- if (needs_text) attr(x, "levels", exact = TRUE) else NULL
    width <- if (needs_text) {
      .jdv_max_string_bytes(levels, budget$limit - budget$used)
    } else {
      0
    }
    reserve("display", 16 * n + 2 * n * max(width, 1))
    reserve("values", 16 * n + 2 * n * max(width, 1))
    reserve("text", 16 * n + 2 * n * max(width, 1))
  } else if (is.matrix(x) || is.data.frame(x) || kind == "list") {
    cell_bytes <- 0
    if (kind == "list" && "display" %in% channels) {
      if (6100 * n > budget$limit - budget$used) {
        .jdv_budget_error(
          "List display exceeds the configured work byte budget.",
          "channel",
          budget$auto_fallback
        )
      }
      for (i in seq_len(column_size(x))) {
        cell_bytes <- cell_bytes + .jdv_preflight_cell(x[[i]], budget$limit)
        if (cell_bytes > budget$limit - budget$used) {
          .jdv_budget_error(
            "Nested cell text exceeds the configured work byte budget.",
            "channel",
            budget$auto_fallback
          )
        }
      }
    }
    display_bytes <- if (!"display" %in% channels) {
      0
    } else if (is.matrix(x) && n * max(1, ncol(x)) > 100) {
      64 * n
    } else {
      6100 * n + cell_bytes
    }
    reserve("display", display_bytes)
  } else {
    display_width <- switch(
      kind,
      number = 32,
      duration = 48,
      integer = 24,
      boolean = 12,
      datetime = 48,
      date = 24,
      0
    )
    if (display_width) reserve("display", display_width * n)
  }
  reserve("na", 4 * n)
  if (schema$sortable) {
    reserve("sortKey", 8 * n)
  }
  reserve(
    "values",
    switch(kind, boolean = 4, integer = 4, number = 8, duration = 8, 0) * n
  )
  if (kind %in% c("number", "duration") && "values" %in% channels) {
    # `special` construction and finite-value normalization create masks and
    # a replacement vector after the raw value channel is returned.
    reserve("values", 32 * n)
  }
  for (channel in names(reserved)) {
    .jdv_budget_charge(budget, reserved[[channel]], "channel")
  }
  reserved
}

.jdv_generated_bytes <- function(x, cap) {
  if (is.character(x)) {
    return(16 * length(x) + .jdv_string_bytes(x, cap))
  }
  bytes_per_element <- switch(
    typeof(x),
    logical = 4,
    integer = 4,
    double = 8,
    character = 8,
    list = 16,
    16
  )
  as.double(length(x)) * bytes_per_element + 128
}

.jdv_preflight_cell <- function(x, cap, depth = 0L) {
  if (is.character(x)) {
    return(.jdv_string_bytes(x, cap))
  } else if (is.list(x) && depth < 3L && length(x) <= 100L) {
    total <- 0
    for (item in x) {
      total <- total + .jdv_preflight_cell(item, cap - total, depth + 1L)
      if (total > cap) return(cap + 1)
    }
    return(total)
  }
  0
}

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

.jdv_page_row_capacity <- function(
  holder,
  columns,
  candidate_rows,
  requested_rows,
  budget,
  message_limit = .jdv_max_message_bytes()
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
        special = .jdv_json_values(character()),
        na = .jdv_json_values(logical())
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
        row_index = .jdv_json_values(numeric()),
        row_names = if (holder$explicit_row_names) {
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
    if (kind %in% c("string", "factor") && requested_rows > 0) {
      if (is.matrix(holder$source)) {
        positions <- candidate_rows + (j - 1L) * holder$nrow
        if (
          kind == "string" &&
            !identical(class(holder$source), c("matrix", "array"))
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
    } else if (cost_kind == "factor") {
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
      source_column <- holder$source[[j]]
      row_cells <- if (nrow(source_column)) {
        .jdv_packed_cells(source_column) / nrow(source_column)
      } else {
        0
      }
      work_rows <- work_rows + 6200 + 32 * row_cells + 16 * ncol(source_column)
      wire_rows <- wire_rows + 512
    } else if (cost_kind == "list") {
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
  fits <- which(
    work_cumulative <= available_work & wire_cumulative <= available_wire
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
    # format.character aligns all cells to the widest string.
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
  reserve("values", switch(kind, boolean = 4, integer = 4, number = 8, 0) * n)
  if (kind == "number" && "values" %in% channels) {
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

# Column classification is deliberately independent of channel computation.
column_schema <- function(x, name = "", position = 0L) {
  structural <- is.matrix(x) || is.data.frame(x)
  # An atomic vector wrapped only by I() is classified by its contents.
  bare <- column_unwrap_asis(x)
  type <- if (structural) {
    "other"
  } else if (inherits(x, "integer64")) {
    "int64"
  } else if (inherits(x, "factor")) {
    "factor"
  } else if (inherits(x, "Date")) {
    "date"
  } else if (inherits(x, "POSIXt")) {
    "datetime"
  } else if (inherits(x, "difftime") && column_duration_units(x)) {
    "duration"
  } else if (!is.object(bare)) {
    switch(
      typeof(bare),
      logical = "boolean",
      integer = "integer",
      double = "number",
      character = "string",
      list = "list",
      "other"
    )
  } else {
    "other"
  }
  sortable <- !structural &&
    type != "list" &&
    !typeof(x) %in% c("complex", "raw")
  # Only the listed types are filterable. Other classes can be shown and
  # sorted, and still answer is_na.
  filterable <- !structural &&
    !type %in% c("list", "other") &&
    !typeof(x) %in% c("complex", "raw")
  schema <- list(
    position = as.integer(position),
    name = name,
    type = type,
    class = class(x),
    sortable = sortable,
    filterable = filterable,
    drillable = column_drillable(x)
  )
  if (type == "factor") {
    schema$levels <- levels(x)
    schema$ordered <- is.ordered(x)
  }
  if (type == "datetime") {
    schema$tz <- column_tz(x)
  }
  if (type == "duration") schema$units <- attr(x, "units", exact = TRUE)
  schema
}

# The unit conversion factors follow base::difftime(), where a week is 7 days.
duration_unit_seconds <- c(
  secs = 1,
  mins = 60,
  hours = 3600,
  days = 86400,
  weeks = 604800
)

# A difftime whose units attribute is not one of the five known units cannot be
# converted, so it is left to the unfiltered "other" type.
column_duration_units <- function(x) {
  units <- attr(x, "units", exact = TRUE)
  is.character(units) &&
    length(units) == 1L &&
    !is.na(units) &&
    units %in% names(duration_unit_seconds) &&
    is.numeric(unclass(x))
}

# I() on a plain atomic vector adds only the AsIs class. Removing it restores
# the underlying basic type; any other class leaves the value untouched.
column_unwrap_asis <- function(x) {
  if (identical(class(x), "AsIs") && is.atomic(x) && is.null(dim(x))) {
    oldClass(x) <- NULL
  }
  x
}

column_tz <- function(x) {
  tz <- attr(x, "tzone", exact = TRUE)
  if (is.null(tz) || !length(tz) || is.na(tz[[1L]])) "" else tz[[1L]]
}

pad_iso_year <- function(value) {
  matches <- regmatches(value, regexec("^([0-9]{1,3})-", value))
  at <- which(lengths(matches) == 2L)
  if (length(at)) {
    years <- vapply(matches[at], `[[`, character(1L), 2L)
    value[at] <- paste0(strrep("0", 4L - nchar(years)), value[at])
  }
  value
}

column_size <- function(x) {
  if (is.matrix(x) || is.data.frame(x)) nrow(x) else length(x)
}

table_model <- function(x) {
  if (!is.data.frame(x) && !is.matrix(x)) {
    stop("Expected a data frame or matrix.", call. = FALSE)
  }
  columns <- if (is.matrix(x)) {
    lapply(seq_len(ncol(x)), function(i) x[, i])
  } else {
    lapply(seq_len(ncol(x)), function(i) x[[i]])
  }
  column_names <- colnames(x)
  if (is.null(column_names)) {
    column_names <- rep("", ncol(x))
  }
  schema <- lapply(
    seq_along(columns),
    function(i) column_schema(columns[[i]], column_names[[i]], i - 1L)
  )
  row_names <- if (is.data.frame(x)) {
    if (.row_names_info(x, type = 1L) > 0L) rownames(x) else NULL
  } else {
    rownames(x)
  }
  list(
    nrow = nrow(x),
    ncol = ncol(x),
    schema = schema,
    columns = columns,
    row_names = row_names,
    row_index = seq_len(nrow(x))
  )
}

#' @noRd
col_display <- function(x, ...) UseMethod("col_display")
#' @noRd
col_is_na <- function(x, ...) UseMethod("col_is_na")
#' @noRd
col_values <- function(x, ...) UseMethod("col_values")
#' @noRd
col_sort_key <- function(x, collation = "C", ...) UseMethod("col_sort_key")

#' @export
col_display.default <- function(x, ...) {
  if (identical(class(x), "AsIs") && is.list(x)) {
    return(col_display.list(x, ...))
  }
  fun <- if (isS4(x)) column_s4_generic("format", format) else format
  fun(x, trim = TRUE, justify = "none")
}
#' @export
col_is_na.default <- function(x, ...) is.na(x)
#' @export
col_values.default <- function(x, ...) {
  if (
    !is.object(x) &&
      is.null(dim(x)) &&
      typeof(x) %in% c("logical", "integer", "double", "character")
  ) {
    x
  } else {
    NULL
  }
}
#' @export
col_sort_key.default <- function(x, collation = "C", ...) {
  fun <- if (isS4(x)) column_s4_generic("xtfrm", xtfrm) else xtfrm
  fun(x)
}

column_s4_generic <- function(name, fallback) {
  if (!requireNamespace("methods", quietly = TRUE)) {
    stop("S4 methods are not available.", call. = FALSE)
  }
  fun <- methods::getGeneric(name)
  if (is.null(fun)) fallback else fun
}

#' @export
col_display.factor <- function(x, ...) {
  value <- as.character(x)
  value[is.na(value)] <- "NA"
  value
}
#' @export
col_values.factor <- function(x, ...) as.character(x)
#' @export
col_sort_key.factor <- function(x, collation = "C", ...) as.integer(x)

#' @export
col_values.character <- function(x, ...) if (is.object(x)) NULL else x
#' @export
col_sort_key.character <- function(x, collation = "C", ...) {
  if (!is.object(x) && collation == "C") dense_key(x) else xtfrm(x)
}

dense_key <- function(x) {
  match(x, sort(unique(x), na.last = NA, method = "radix"))
}

#' @export
col_values.difftime <- function(x, ...) as.double(unclass(x))
#' @export
col_sort_key.difftime <- function(x, collation = "C", ...) as.double(unclass(x))

#' @export
col_values.Date <- function(x, ...) {
  canonical <- structure(unclass(x), class = "Date")
  pad_iso_year(format.Date(canonical, format = "%Y-%m-%d"))
}
#' @export
col_sort_key.Date <- function(x, collation = "C", ...) as.numeric(unclass(x))

.jdv_iso_fraction <- function(x) {
  result <- rep("", length(x))
  result[is.na(x)] <- NA_character_
  indices <- which(!is.na(x) & x != 0)
  if (!length(indices)) {
    return(result)
  }

  starts <- seq.int(1L, length(indices), by = 64L)
  for (start in starts) {
    selected <- indices[start:min(start + 63L, length(indices))]
    encoded <- .jdv_json_encode(
      structure(x[selected], class = "jdv_json_array"),
      limit = 4096,
      work_limit = 64 * 1024
    )
    tokens <- strsplit(
      substring(encoded, 2L, nchar(encoded) - 1L),
      ",",
      fixed = TRUE
    )[[1L]]
    result[selected] <- vapply(
      tokens,
      function(token) {
        parts <- strsplit(tolower(token), "e", fixed = TRUE)[[1L]]
        exponent <- if (length(parts) == 2L) as.integer(parts[[2L]]) else 0L
        mantissa <- strsplit(parts[[1L]], ".", fixed = TRUE)[[1L]]
        whole <- mantissa[[1L]]
        decimal <- if (length(mantissa) == 2L) mantissa[[2L]] else ""
        digits <- paste0(whole, decimal)
        point <- nchar(whole) + exponent
        decimal_digits <- if (point <= 0L) {
          paste0(strrep("0", -point), digits)
        } else if (point >= nchar(digits)) {
          paste0(digits, strrep("0", point - nchar(digits)))
        } else {
          paste0(substr(digits, point + 1L, nchar(digits)))
        }
        paste0(".", sub("0+$", "", decimal_digits))
      },
      character(1L)
    )
  }
  result
}

.jdv_iso_complement_fraction <- function(x) {
  fractions <- .jdv_iso_fraction(abs(x))
  vapply(
    fractions,
    function(fraction) {
      digits <- utf8ToInt(substring(fraction, 2L, nchar(fraction))) - 48L
      digits <- 9L - digits
      for (i in rev(seq_along(digits))) {
        if (digits[[i]] < 9L) {
          digits[[i]] <- digits[[i]] + 1L
          break
        }
        digits[[i]] <- 0L
      }
      paste0(".", paste(digits, collapse = ""))
    },
    character(1L)
  )
}

#' @export
col_values.POSIXct <- function(x, ...) {
  seconds <- as.numeric(unclass(x))
  whole <- as.POSIXct(floor(seconds), origin = "1970-01-01", tz = column_tz(x))
  result <- pad_iso_year(format(
    whole,
    format = "%Y-%m-%dT%H:%M:%S",
    tz = column_tz(x)
  ))
  fractional_seconds <- seconds - floor(seconds)
  fraction <- .jdv_iso_fraction(fractional_seconds)
  rounded_fraction <- is.finite(seconds) & seconds < 0 & fractional_seconds == 1
  if (any(rounded_fraction)) {
    fraction[rounded_fraction] <- .jdv_iso_complement_fraction(seconds[
      rounded_fraction
    ])
  }
  offset <- format(whole, format = "%z", tz = column_tz(x))
  offset <- sub("([+-][0-9]{2})([0-9]{2})$", "\\1:\\2", offset)
  result <- paste0(result, fraction, offset)
  result[is.na(seconds)] <- NA_character_
  result
}
#' @export
col_values.POSIXlt <- function(x, ...) col_values.POSIXct(as.POSIXct.POSIXlt(x))
#' @export
col_sort_key.POSIXct <- function(x, collation = "C", ...) as.numeric(unclass(x))
#' @export
col_sort_key.POSIXlt <- function(x, collation = "C", ...) {
  as.numeric(as.POSIXct.POSIXlt(x))
}

#' @export
col_display.list <- function(x, ...) {
  vapply(x, cell_preview, character(1L), frame_cell = TRUE)
}
#' @export
col_display.matrix <- function(x, ...) {
  if (ncol(x) > 100) {
    return(rep(paste0("<matrix [1 x ", ncol(x), "]>"), nrow(x)))
  }
  vapply(
    seq_len(nrow(x)),
    function(i) cell_preview(x[i, , drop = FALSE]),
    character(1L)
  )
}

.jdv_display_matrix_rows <- function(x, rows, budget) {
  shape <- dim(x)
  # cell_preview() uses this same summary for a packed row above its traversal
  # budget, so preserve that result without copying a potentially huge row.
  if (shape[[2L]] > 100) {
    return(rep(paste0("<matrix [1 x ", shape[[2L]], "]>"), length(rows)))
  }
  .jdv_budget_charge(
    budget,
    as.double(length(rows)) * (64 + shape[[2L]] * 16),
    "packed_matrix_display"
  )
  vapply(rows, function(i) cell_preview(x[i, , drop = FALSE]), character(1L))
}

.jdv_display_data_frame_rows <- function(x, rows, budget) {
  packed_cells <- .jdv_packed_cells(x)
  row_cells <- if (nrow(x)) packed_cells / nrow(x) else 0
  if (ncol(x) > 100) {
    return(rep(paste0("<data.frame [1 x ", ncol(x), "]>"), length(rows)))
  }
  .jdv_budget_charge(
    budget,
    as.double(length(rows)) * (64 + 16 * row_cells + 8 * ncol(x)),
    "packed_frame_display"
  )
  vapply(rows, function(i) cell_preview(x[i, , drop = FALSE]), character(1L))
}
#' @export
col_display.data.frame <- function(x, ...) {
  if (ncol(x) > 100) {
    return(rep(paste0("<data.frame [1 x ", ncol(x), "]>"), nrow(x)))
  }
  vapply(
    seq_len(nrow(x)),
    function(i) cell_preview(x[i, , drop = FALSE]),
    character(1L)
  )
}
#' @export
col_is_na.matrix <- function(x, budget = NULL, ...) {
  .jdv_budget_charge(
    budget,
    as.double(nrow(x)) * ncol(x) * 5,
    "packed_matrix_missingness"
  )
  if (!ncol(x)) rep(FALSE, nrow(x)) else rowSums(is.na(x)) == ncol(x)
}

.jdv_is_na_matrix_rows <- function(x, rows, budget) {
  cells <- as.double(length(rows)) * ncol(x)
  .jdv_budget_charge(budget, cells * 16, "packed_matrix_missingness")
  if (!length(rows) || !ncol(x)) {
    return(rep(FALSE, length(rows)))
  }
  vapply(rows, function(i) all(is.na(x[i, , drop = TRUE])), logical(1L))
}
#' @export
col_is_na.data.frame <- function(x, ...) {
  if (!ncol(x)) {
    return(rep(FALSE, nrow(x)))
  }
  masks <- lapply(x, col_is_na)
  if (
    any(
      !vapply(
        masks,
        function(mask) {
          is.logical(mask) &&
            is.null(dim(mask)) &&
            length(mask) == nrow(x) &&
            !anyNA(mask)
        },
        logical(1L)
      )
    )
  ) {
    stop("Invalid packed column missingness.", call. = FALSE)
  }
  Reduce(`&`, masks)
}

.jdv_is_na_data_frame_rows <- function(x, rows, budget) {
  dimensions <- vapply(
    x,
    function(column) .jdv_packed_cells(column),
    numeric(1L)
  )
  row_cells <- if (nrow(x)) sum(dimensions) / nrow(x) else 0
  .jdv_budget_charge(
    budget,
    as.double(length(rows)) * (16 * row_cells + 8 * ncol(x)),
    "packed_frame_missingness"
  )
  if (!ncol(x)) {
    return(rep(FALSE, length(rows)))
  }
  masks <- lapply(x, function(column) {
    if (is.matrix(column)) {
      .jdv_is_na_matrix_rows(column, rows, budget = NULL)
    } else if (is.data.frame(column)) {
      .jdv_is_na_data_frame_rows(column, rows, budget = NULL)
    } else {
      col_is_na(query_slice(column, rows))
    }
  })
  Reduce(`&`, masks)
}

.jdv_packed_cells <- function(x) {
  if (is.matrix(x)) {
    return(as.double(nrow(x)) * ncol(x))
  }
  if (is.data.frame(x)) {
    return(sum(vapply(x, .jdv_packed_cells, numeric(1L))))
  }
  as.double(length(x))
}

# A cell has a shared traversal budget; summaries avoid formatting huge objects.
# A data.frame at the top level is normally one packed row of a data.frame
# column, so it is previewed by its values. With `frame_cell`, it is a whole
# cell of a list column and is summarized instead, as is a data.frame held in
# a plain list.
cell_preview <- function(x, frame_cell = FALSE) {
  budget <- new.env(parent = emptyenv())
  budget$remaining <- 100L
  preview <- function(value, depth, summarize_frame) {
    shape <- dim(value)
    size <- if (is.null(shape)) length(value) else prod(shape)
    if (
      depth >= 3L ||
        size > budget$remaining ||
        is.environment(value) ||
        is.function(value) ||
        isS4(value) ||
        inherits(value, "integer64") ||
        (is.data.frame(value) && summarize_frame) ||
        (is.object(value) &&
          is.list(value) &&
          !identical(class(value), "AsIs") &&
          !is.data.frame(value) &&
          !inherits(value, "POSIXlt"))
    ) {
      return(paste0(
        "<",
        class(value)[[1L]],
        " [",
        paste(if (is.null(shape)) size else shape, collapse = " x "),
        "]>"
      ))
    }
    budget$remaining <- budget$remaining - max(1L, size)
    if (is.null(value)) {
      return("NULL")
    }
    if (is.list(value) && !inherits(value, "POSIXlt")) {
      parts <- vapply(
        value,
        preview,
        character(1L),
        depth = depth + 1L,
        summarize_frame = !is.data.frame(value)
      )
      if (!is.null(names(value))) {
        # Only named elements get a prefix, as in a partially named list().
        labels <- substr(names(value), 1L, 1000L)
        named <- !is.na(labels) & nzchar(labels)
        parts[named] <- paste0(labels[named], " = ", parts[named])
      }
      return(paste0("list(", paste(parts, collapse = ", "), ")"))
    }
    if (is.character(value)) {
      parts <- encodeString(substr(value, 1L, 1000L), quote = '"')
    } else {
      parts <- format(value, trim = TRUE, justify = "none")
    }
    paste(substr(parts, 1L, 1000L), collapse = ", ")
  }
  value <- preview(x, 0L, frame_cell)
  if (nchar(value) > 1000L) paste0(substr(value, 1L, 999L), "\u2026") else value
}

# Only the requested channels are evaluated. Failures do not replace other data.
column_extract <- function(
  x,
  channels = c("display", "na", "values", "sortKey"),
  collation = "C",
  schema = column_schema(x),
  budget = NULL,
  rows = NULL
) {
  channels <- match.arg(
    channels,
    c("display", "na", "values", "sortKey", "text"),
    several.ok = TRUE
  )
  collation <- match.arg(collation, c("C", "locale"))
  force(schema)
  x <- column_unwrap_asis(x)
  n <- if (is.null(rows)) column_size(x) else length(rows)
  data <- list()
  errors <- list()
  budget <- budget %||% .jdv_budget(.jdv_page_work_bytes())
  structural <- is.matrix(x) || is.data.frame(x) || schema$type == "list"
  reserved <- .jdv_preflight_column(x, schema, channels, budget, n = n)
  plain <- function(value) {
    !is.object(value) && is.null(dim(value)) && length(value) == n
  }
  compute <- function(channel, fun, valid) {
    tryCatch(
      {
        value <- fun()
        if (!valid(value)) {
          stop("Invalid channel result.", call. = FALSE)
        }
        reserved_bytes <- if (channel %in% names(reserved)) {
          reserved[[channel]]
        } else {
          0
        }
        actual <- .jdv_generated_bytes(
          value,
          reserved_bytes + .jdv_budget_remaining(budget)
        )
        if (actual > reserved_bytes) {
          .jdv_budget_charge(budget, actual - reserved_bytes, "channel")
        }
        value
      },
      error = function(e) {
        if (inherits(e, "jdv_query_error") && e$code == "limit_exceeded") {
          stop(e)
        }
        errors[[channel]] <<- conditionMessage(e)
        NULL
      }
    )
  }
  for (channel in channels) {
    if (channel == "display") {
      display_fun <- if (is.matrix(x)) {
        function(value) {
          selected_rows <- if (is.null(rows)) seq_len(nrow(value)) else rows
          .jdv_display_matrix_rows(value, selected_rows, budget)
        }
      } else if (is.data.frame(x)) {
        function(value) {
          selected_rows <- if (is.null(rows)) seq_len(nrow(value)) else rows
          .jdv_display_data_frame_rows(value, selected_rows, budget)
        }
      } else {
        col_display
      }
      value <- compute(
        channel,
        function() display_fun(x),
        function(v) is.character(v) && plain(v)
      )
      if (!is.null(value)) {
        value[is.na(value)] <- "NA"
      }
      data$display <- if (is.null(value)) {
        rep(paste0("<", class(x)[[1L]], ">"), n)
      } else {
        value
      }
    } else if (channel == "na") {
      na_fun <- if (is.matrix(x)) {
        function(value) {
          selected_rows <- if (is.null(rows)) seq_len(nrow(value)) else rows
          .jdv_is_na_matrix_rows(value, selected_rows, budget)
        }
      } else if (is.data.frame(x)) {
        function(value) {
          selected_rows <- if (is.null(rows)) seq_len(nrow(value)) else rows
          .jdv_is_na_data_frame_rows(value, selected_rows, budget)
        }
      } else {
        col_is_na
      }
      data$na <- compute(
        channel,
        function() na_fun(x),
        function(v) is.logical(v) && plain(v) && !anyNA(v)
      )
    } else if (channel == "values" && !structural && schema$type != "other") {
      value <- compute(channel, function() col_values(x), function(v) {
        expected <- switch(
          schema$type,
          boolean = "logical",
          integer = "integer",
          number = "double",
          duration = "double",
          "character"
        )
        typeof(v) == expected && plain(v)
      })
      if (is.null(value)) {
        schema$filterable <- FALSE
      }
      if (schema$type %in% c("number", "duration") && !is.null(value)) {
        special <- rep(NA_character_, n)
        special[is.nan(value)] <- "nan"
        special[is.infinite(value) & value > 0] <- "pos_inf"
        special[is.infinite(value) & value < 0] <- "neg_inf"
        if (any(!is.na(special))) {
          data$special <- special
        }
        value[!is.finite(value)] <- NA_real_
      }
      data$values <- value
    } else if (channel == "sortKey" && schema$sortable) {
      value <- compute(
        channel,
        function() col_sort_key(x, collation = collation),
        function(v) typeof(v) %in% c("integer", "double") && plain(v)
      )
      if (is.null(value)) {
        schema$sortable <- FALSE
      } else if (
        schema$type == "other" &&
          {
            .jdv_budget_charge(budget, 24 * n, "dense_sort_key")
            any(!is.na(value) & (!is.finite(value) | abs(value) > 2^53))
          }
      ) {
        value <- dense_key(value)
      }
      data$sortKey <- value
    } else if (channel == "text" && !structural) {
      if (schema$type %in% c("string", "factor") && schema$filterable) {
        data$text <- compute(
          channel,
          function() col_values(x),
          function(v) is.character(v) && plain(v)
        )
        if (is.null(data$text)) schema$filterable <- FALSE
      }
    }
  }
  list(schema = schema, data = data, errors = errors)
}

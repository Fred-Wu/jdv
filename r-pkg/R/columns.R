# Column classification is deliberately independent of channel computation.
column_schema <- function(x, name = "", position = 0L) {
  structural <- is.matrix(x) || is.data.frame(x)
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
  } else if (!is.object(x)) {
    switch(
      typeof(x),
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
  filterable <- !structural &&
    type != "list" &&
    !typeof(x) %in% c("complex", "raw")
  schema <- list(
    position = as.integer(position),
    name = name,
    type = type,
    class = class(x),
    sortable = sortable,
    filterable = filterable
  )
  if (type == "factor") {
    schema$levels <- levels(x)
    schema$ordered <- is.ordered(x)
  }
  if (type == "datetime") schema$tz <- column_tz(x)
  schema
}

column_tz <- function(x) {
  tz <- attr(x, "tzone", exact = TRUE)
  if (is.null(tz) || !length(tz) || is.na(tz[[1L]])) "" else tz[[1L]]
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
col_values.Date <- function(x, ...) {
  canonical <- structure(unclass(x), class = "Date")
  format.Date(canonical, format = "%Y-%m-%d")
}
#' @export
col_sort_key.Date <- function(x, collation = "C", ...) as.numeric(unclass(x))

#' @export
col_values.POSIXct <- function(x, ...) {
  seconds <- as.numeric(unclass(x))
  whole <- as.POSIXct(floor(seconds), origin = "1970-01-01", tz = column_tz(x))
  result <- format(whole, format = "%Y-%m-%dT%H:%M:%S", tz = column_tz(x))
  fraction <- format(
    seconds - floor(seconds),
    scientific = FALSE,
    digits = 17,
    trim = TRUE,
    justify = "none",
    decimal.mark = ".",
    nsmall = 0L
  )
  fraction <- sub("0+$", "", fraction)
  fraction <- sub("^0", "", fraction)
  fraction[fraction == "."] <- ""
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
col_display.list <- function(x, ...) vapply(x, cell_preview, character(1L))
#' @export
col_display.matrix <- function(x, ...) {
  vapply(
    seq_len(nrow(x)),
    function(i) cell_preview(x[i, , drop = FALSE]),
    character(1L)
  )
}
#' @export
col_display.data.frame <- function(x, ...) {
  vapply(
    seq_len(nrow(x)),
    function(i) cell_preview(x[i, , drop = FALSE]),
    character(1L)
  )
}
#' @export
col_is_na.matrix <- function(x, ...) {
  if (!ncol(x)) rep(FALSE, nrow(x)) else rowSums(is.na(x)) == ncol(x)
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

# A cell has a shared traversal budget; summaries avoid formatting huge objects.
cell_preview <- function(x) {
  budget <- new.env(parent = emptyenv())
  budget$remaining <- 100L
  preview <- function(value, depth) {
    shape <- dim(value)
    size <- if (is.null(shape)) length(value) else prod(shape)
    if (
      depth >= 3L ||
        size > budget$remaining ||
        is.environment(value) ||
        is.function(value) ||
        isS4(value) ||
        inherits(value, "integer64") ||
        (is.object(value) &&
          is.list(value) &&
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
      parts <- vapply(value, preview, character(1L), depth = depth + 1L)
      if (!is.null(names(value))) {
        parts <- paste0(substr(names(value), 1L, 1000L), " = ", parts)
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
  value <- preview(x, 0L)
  if (nchar(value) > 1000L) paste0(substr(value, 1L, 999L), "\u2026") else value
}

# Only the requested channels are evaluated. Failures do not replace other data.
column_extract <- function(
  x,
  channels = c("display", "na", "values", "sortKey"),
  collation = "C",
  schema = column_schema(x)
) {
  channels <- match.arg(
    channels,
    c("display", "na", "values", "sortKey", "text"),
    several.ok = TRUE
  )
  collation <- match.arg(collation, c("C", "locale"))
  n <- column_size(x)
  data <- list()
  errors <- list()
  structural <- is.matrix(x) || is.data.frame(x) || schema$type == "list"
  plain <- function(value) {
    !is.object(value) && is.null(dim(value)) && length(value) == n
  }
  compute <- function(channel, fun, valid) {
    tryCatch(
      {
        value <- fun()
        if (!valid(value)) stop("Invalid channel result.", call. = FALSE)
        value
      },
      error = function(e) {
        errors[[channel]] <<- conditionMessage(e)
        NULL
      }
    )
  }
  for (channel in channels) {
    if (channel == "display") {
      display_fun <- if (is.matrix(x)) {
        col_display.matrix
      } else if (is.data.frame(x)) {
        col_display.data.frame
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
        col_is_na.matrix
      } else if (is.data.frame(x)) {
        col_is_na.data.frame
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
          "character"
        )
        typeof(v) == expected && plain(v)
      })
      if (is.null(value)) {
        schema$filterable <- FALSE
      }
      if (schema$type == "number" && !is.null(value)) {
        special <- rep(NA_character_, n)
        special[is.na(value)] <- "na"
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
          any(!is.na(value) & (!is.finite(value) | abs(value) > 2^53))
      ) {
        value <- dense_key(value)
      }
      data$sortKey <- value
    } else if (channel == "text" && !structural) {
      if (
        schema$type %in% c("string", "factor", "other") && schema$filterable
      ) {
        text_fun <- if (schema$type == "other") col_display else col_values
        data$text <- compute(
          channel,
          function() text_fun(x),
          function(v) is.character(v) && plain(v)
        )
        if (is.null(data$text)) schema$filterable <- FALSE
      }
    }
  }
  list(schema = schema, data = data, errors = errors)
}

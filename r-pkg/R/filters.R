query_fields <- function(node, allowed, required = allowed) {
  fields <- names(node)
  if (
    !is.list(node) ||
      (is.object(node) && !inherits(node, "jdv_json_object")) ||
      is.null(fields) ||
      anyNA(fields) ||
      any(!nzchar(fields)) ||
      anyDuplicated(fields) ||
      any(!fields %in% allowed) ||
      any(!required %in% fields)
  ) {
    query_error("invalid_request", "Invalid fields in query object.")
  }
  invisible(node)
}

json_is_array <- function(x) {
  is.list(x) &&
    is.null(names(x)) &&
    (!is.object(x) || inherits(x, "jdv_json_array"))
}

query_string <- function(value, limit) {
  if (
    !is.character(value) ||
      (is.object(value) && !inherits(value, "jdv_json_array")) ||
      !is.null(dim(value)) ||
      length(value) != 1L ||
      is.na(value)
  ) {
    query_error("invalid_request", "Expected one nonmissing string.")
  }
  if (nchar(value, type = "bytes") > limit) {
    query_error("limit_exceeded", "Query string is too long.")
  }
  value <- enc2utf8(unname(value))
  if (nchar(value, type = "bytes") > limit) {
    query_error("limit_exceeded", "Query string is too long.")
  }
  value
}

query_numeric_value <- function(value) {
  if (is.list(value)) {
    query_fields(value, "special")
    if (identical(value$special, "pos_inf")) {
      return(Inf)
    }
    if (identical(value$special, "neg_inf")) {
      return(-Inf)
    }
    query_error(
      "invalid_request",
      "Only pos_inf and neg_inf query tokens are allowed."
    )
  }
  if (
    !typeof(value) %in% c("integer", "double") ||
      is.object(value) ||
      !is.null(dim(value)) ||
      length(value) != 1L ||
      is.na(value) ||
      !is.finite(value)
  ) {
    query_error(
      "invalid_request",
      "Expected one finite numeric value or infinity token."
    )
  }
  unname(value)
}

query_iso_time <- function(text, tz) {
  explicit <- grepl("(Z|[+-][0-9]{2}:[0-9]{2})$", text)
  result <- rep(NA_real_, length(text))
  for (has_offset in c(FALSE, TRUE)) {
    at <- which(!is.na(text) & explicit == has_offset)
    if (length(at)) {
      if (!has_offset) {
        result[at] <- as.numeric(as.POSIXct(
          text[at],
          format = "%Y-%m-%dT%H:%M:%OS",
          tz = tz
        ))
        next
      }
      date <- as.Date(substr(text[at], 1L, 10L), format = "%Y-%m-%d")
      hour <- as.integer(substr(text[at], 12L, 13L))
      minute <- as.integer(substr(text[at], 15L, 16L))
      second <- as.integer(substr(text[at], 18L, 19L))
      fraction_match <- regexpr("\\.[0-9]+", text[at])
      has_fraction <- fraction_match > 0L
      fraction <- numeric(length(at))
      fraction[has_fraction] <- as.numeric(paste0(
        "0",
        regmatches(
          text[at][has_fraction],
          regexpr("\\.[0-9]+", text[at][has_fraction])
        )
      ))
      suffix <- rep("+00:00", length(at))
      has_numeric_offset <- !endsWith(text[at], "Z")
      suffix[has_numeric_offset] <- regmatches(
        text[at][has_numeric_offset],
        regexpr("[+-][0-9]{2}:[0-9]{2}$", text[at][has_numeric_offset])
      )
      sign <- ifelse(substr(suffix, 1L, 1L) == "-", -1, 1)
      offset <- sign *
        (as.integer(substr(suffix, 2L, 3L)) * 3600 +
          as.integer(substr(suffix, 5L, 6L)) * 60)
      result[at] <- as.numeric(date) * 86400 +
        hour * 3600 +
        minute * 60 +
        second +
        fraction -
        offset
    }
  }
  result
}

query_valid_iso_date <- function(text) {
  if (!grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", text)) {
    return(FALSE)
  }
  year <- as.integer(substr(text, 1L, 4L))
  month <- as.integer(substr(text, 6L, 7L))
  day <- as.integer(substr(text, 9L, 10L))
  if (month < 1L || month > 12L || day < 1L) {
    return(FALSE)
  }
  leap <- year %% 4L == 0L && (year %% 100L != 0L || year %% 400L == 0L)
  month_days <- c(
    31L,
    if (leap) 29L else 28L,
    31L,
    30L,
    31L,
    30L,
    31L,
    31L,
    30L,
    31L,
    30L,
    31L
  )
  day <= month_days[[month]]
}

query_date_value <- function(value, schema, limit) {
  text <- query_string(value, limit)
  date_text <- substr(text, 1L, 10L)
  date <- if (query_valid_iso_date(date_text)) {
    query_try(
      function() suppressWarnings(as.Date(date_text, format = "%Y-%m-%d")),
      "invalid_request"
    )
  } else {
    NA
  }
  if (is.na(date)) {
    query_error("invalid_request", "Invalid ISO date.")
  }
  if (schema$type == "date") {
    if (nchar(text) != 10L) {
      query_error("invalid_request", "Expected an ISO date without time.")
    }
    return(as.numeric(date))
  }
  if (
    !grepl(
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$",
      text
    ) ||
      as.integer(substr(text, 12L, 13L)) > 23L ||
      as.integer(substr(text, 15L, 16L)) > 59L ||
      as.integer(substr(text, 18L, 19L)) > 59L
  ) {
    query_error("invalid_request", "Invalid ISO datetime.")
  }
  suffix <- regmatches(text, regexpr("[+-][0-9]{2}:[0-9]{2}$", text))
  if (
    length(suffix) &&
      (as.integer(substr(suffix, 2L, 3L)) > 23L ||
        as.integer(substr(suffix, 5L, 6L)) > 59L)
  ) {
    query_error("invalid_request", "Invalid ISO timezone offset.")
  }
  value <- query_try(
    function() query_iso_time(text, schema$tz),
    "invalid_request"
  )
  if (is.na(value)) {
    query_error(
      "invalid_request",
      "ISO datetime is not representable in this timezone."
    )
  }
  value
}

query_decimal_value <- function(value, limit) {
  value <- query_string(value, limit)
  query_try(
    function() int64_eq(structure(numeric(), class = "integer64"), value),
    "invalid_request"
  )
  value
}

query_filter_validate <- function(table, filter) {
  if (is.null(filter)) {
    return(NULL)
  }
  nodes <- 0L
  bytes <- 0
  string <- function(value) {
    value <- query_string(value, table$limits$text_bytes)
    bytes <<- bytes + nchar(value, type = "bytes")
    if (bytes > table$limits$filter_bytes) {
      query_error(
        "limit_exceeded",
        "Filter strings exceed the total byte limit."
      )
    }
    value
  }
  visit <- function(node, depth) {
    nodes <<- nodes + 1L
    if (depth > table$limits$ast_depth || nodes > table$limits$ast_nodes) {
      query_error(
        "limit_exceeded",
        "Filter AST exceeds its depth or node limit."
      )
    }
    if (
      !is.list(node) ||
        (is.object(node) && !inherits(node, "jdv_json_object")) ||
        !"op" %in% names(node)
    ) {
      query_error("invalid_request", "Expected a filter AST object.")
    }
    op <- query_string(node$op, 32L)
    if (op %in% c("and", "or")) {
      query_fields(node, c("op", "args"))
      if (!json_is_array(node$args)) {
        query_error("invalid_request", "Logic args must be an array.")
      }
      if (length(node$args) > table$limits$ast_nodes) {
        query_error("limit_exceeded", "Too many logic args.")
      }
      return(list(op = op, args = lapply(node$args, visit, depth = depth + 1L)))
    }
    if (op == "not") {
      query_fields(node, c("op", "arg"))
      return(list(op = op, arg = visit(node$arg, depth + 1L)))
    }
    text_ops <- c("contains", "starts_with", "ends_with", "text_equals")
    numeric_ops <- c("eq", "ne", "lt", "le", "gt", "ge", "between")
    if (
      !op %in% c(text_ops, numeric_ops, "is_na", "is_true", "is_false", "in")
    ) {
      query_error("invalid_request", "Unknown filter operator.")
    }
    extras <- if (op == "between") {
      c("lower", "upper")
    } else if (op == "in") {
      "values"
    } else if (op %in% c(text_ops, numeric_ops)) {
      "value"
    } else {
      character()
    }
    query_fields(node, c("op", "col", extras))
    j <- query_col(table, node$col)
    schema <- table$schema[[j]]
    out <- list(op = op, col = j - 1L)
    if (op == "is_na") {
      return(out)
    }
    if (!schema$filterable) {
      query_error("unsupported", "Column is not filterable.")
    }
    if (op %in% text_ops) {
      if (!schema$type %in% c("string", "factor")) {
        query_error("unsupported", "Column has no text filter source.")
      }
      out$value <- string(node$value)
    } else if (op %in% c("is_true", "is_false")) {
      if (schema$type != "boolean") {
        query_error("unsupported", "Expected a Boolean column.")
      }
    } else if (op == "in") {
      if (schema$type != "factor") {
        query_error("unsupported", "Expected a factor column.")
      }
      values <- node$values
      if (
        (!is.character(values) && !is.list(values)) ||
          (is.object(values) && !inherits(values, "jdv_json_array")) ||
          !is.null(dim(values)) ||
          (is.list(values) && !is.null(names(values)))
      ) {
        query_error("invalid_request", "in values must be an array of labels.")
      }
      if (length(values) > table$limits$ast_nodes) {
        query_error("limit_exceeded", "Too many factor labels.")
      }
      out$values <- vapply(as.list(values), string, character(1L))
    } else {
      if (
        !schema$type %in% c("integer", "number", "date", "datetime", "int64")
      ) {
        query_error("unsupported", "Column has no numeric filter source.")
      }
      if (schema$type == "int64" && !op %in% c("eq", "between")) {
        query_error("unsupported", "integer64 supports only eq and between.")
      }
      parse <- function(value) {
        if (schema$type == "int64") {
          query_decimal_value(string(value), table$limits$text_bytes)
        } else if (schema$type %in% c("date", "datetime")) {
          query_date_value(string(value), schema, table$limits$text_bytes)
        } else {
          query_numeric_value(value)
        }
      }
      if (op == "between") {
        out$lower <- parse(node$lower)
        out$upper <- parse(node$upper)
        if (schema$type == "int64") {
          query_try(
            function() {
              int64_between(
                structure(numeric(), class = "integer64"),
                out$lower,
                out$upper
              )
            },
            "invalid_request"
          )
        } else if (out$lower > out$upper) {
          query_error("invalid_request", "lower must not exceed upper.")
        }
      } else {
        out$value <- parse(node$value)
      }
    }
    out
  }
  visit(filter, 1L)
}

# ASCII A-Z folding is independent of the current locale and Unicode casing.
query_fold <- function(x) {
  chartr(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
    enc2utf8(x)
  )
}

query_number_data <- function(holder, j, budget = NULL) {
  schema <- holder$schema[[j]]
  if (schema$type == "date") {
    sort_key <- query_channel(holder, j, "sortKey", budget)$sortKey
    .jdv_budget_charge(budget, as.double(holder$nrow) * 8, "date_filter_floor")
    return(floor(sort_key))
  }
  if (schema$type == "datetime") {
    return(query_channel(holder, j, "sortKey", budget)$sortKey)
  }
  data <- query_channel(holder, j, "values", budget)
  values <- data$values
  if (schema$type == "number" && !is.null(data$special)) {
    values[which(data$special == "pos_inf")] <- Inf
    values[which(data$special == "neg_inf")] <- -Inf
  }
  values
}

query_filter_eval <- function(holder, node, budget = NULL) {
  op <- node$op
  if (op %in% c("and", "or")) {
    result <- rep(op == "and", holder$nrow)
    for (arg in node$args) {
      value <- query_filter_eval(holder, arg, budget)
      result <- if (op == "and") result & value else result | value
    }
    return(result)
  }
  if (op == "not") {
    return(!query_filter_eval(holder, node$arg, budget))
  }
  j <- node$col + 1L
  missing <- query_channel(holder, j, "na", budget)$na
  if (op == "is_na") {
    return(missing)
  }
  type <- holder$schema[[j]]$type
  if (op %in% c("contains", "starts_with", "ends_with", "text_equals")) {
    text_data <- query_channel(holder, j, "text", budget)$text
    .jdv_budget_charge(
      budget,
      .jdv_generated_bytes(text_data, .jdv_budget_remaining(budget)),
      "filter_text_fold"
    )
    text <- query_fold(text_data)
    value <- query_fold(node$value)
    result <- switch(
      op,
      contains = grepl(value, text, fixed = TRUE),
      starts_with = startsWith(text, value),
      ends_with = endsWith(text, value),
      text_equals = text == value
    )
  } else if (op %in% c("is_true", "is_false", "in")) {
    values <- query_channel(holder, j, "values", budget)$values
    result <- switch(
      op,
      is_true = values == TRUE,
      is_false = values == FALSE,
      "in" = values %in% node$values
    )
  } else if (type == "int64") {
    column <- query_column(holder, j, budget)
    result <- if (op == "eq") {
      int64_eq(column, node$value)
    } else {
      int64_between(column, node$lower, node$upper)
    }
  } else {
    values <- query_number_data(holder, j, budget)
    result <- switch(
      op,
      eq = values == node$value,
      ne = values != node$value,
      lt = values < node$value,
      le = values <= node$value,
      gt = values > node$value,
      ge = values >= node$value,
      between = values >= node$lower & values <= node$upper
    )
  }
  result[is.na(result) | missing] <- FALSE
  result
}

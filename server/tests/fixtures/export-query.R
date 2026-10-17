args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2L) {
  stop("usage: export-query.R FIXTURE OUTPUT", call. = FALSE)
}

fixture_path <- args[[1L]]
output_path <- args[[2L]]
fixture <- jsonlite::fromJSON(fixture_path, simplifyVector = FALSE)
register <- getFromNamespace("jdv_register", "jdv")
notifications <- getFromNamespace("jdv_notifications", "jdv")

column_from_fixture <- function(column) {
  out <- column_from_fixture_values(column)
  if (isTRUE(column$asis)) I(out) else out
}

column_from_fixture_values <- function(column) {
  values <- column$values
  type <- column$type
  if (type == "boolean") {
    return(vapply(values, function(v) v %||% NA, logical(1L)))
  }
  if (type == "integer") {
    return(vapply(
      values,
      function(v) as.integer(v %||% NA_integer_),
      integer(1L)
    ))
  }
  if (type == "number") {
    special <- column$special %||% rep(list(NULL), length(values))
    return(vapply(
      seq_along(values),
      function(i) {
        token <- special[[i]]
        if (identical(token, "nan")) {
          return(NaN)
        }
        if (identical(token, "pos_inf")) {
          return(Inf)
        }
        if (identical(token, "neg_inf")) {
          return(-Inf)
        }
        if (identical(token, "na") || is.null(values[[i]])) {
          return(NA_real_)
        }
        as.numeric(values[[i]])
      },
      numeric(1L)
    ))
  }
  if (type %in% c("string", "factor")) {
    out <- vapply(values, function(v) v %||% NA_character_, character(1L))
    if (type == "factor") {
      return(factor(
        out,
        levels = unlist(column$levels),
        ordered = isTRUE(column$ordered)
      ))
    }
    return(out)
  }
  if (type == "date") {
    out <- vapply(values, function(v) v %||% NA_character_, character(1L))
    return(as.Date(out, format = "%Y-%m-%d"))
  }
  if (type == "datetime") {
    out <- vapply(values, function(v) v %||% NA_character_, character(1L))
    timezone <- column$tz %||% ""
    return(as.POSIXct(
      out,
      tz = timezone,
      tryFormats = c(
        "%Y-%m-%dT%H:%M:%OS%z",
        "%Y-%m-%dT%H:%M:%OSZ",
        "%Y-%m-%dT%H:%M:%OS"
      )
    ))
  }
  if (type == "int64") {
    return(bit64::as.integer64(vapply(
      values,
      function(v) v %||% NA_character_,
      character(1L)
    )))
  }
  if (type == "other") {
    values <- vapply(
      values,
      function(v) as.numeric(v %||% NA_real_),
      numeric(1L)
    )
    kind <- column$r %||% "query_record"
    if (kind == "query_record") {
      return(structure(values, class = "query_record"))
    }
    if (kind == "s4_record") {
      return(methods::new("query_s4_record", values))
    }
    if (kind == "difftime") {
      return(as.difftime(values, units = "secs"))
    }
    stop(sprintf("unsupported fixture class: %s", kind), call. = FALSE)
  }
  stop(sprintf("unsupported fixture type: %s", type), call. = FALSE)
}

`%||%` <- function(lhs, rhs) if (is.null(lhs)) rhs else lhs
format.query_record <- function(x, ...) paste0("value:", as.numeric(x))
xtfrm.query_record <- function(x, ...) as.numeric(x)
methods::setClass("query_s4_record", contains = "numeric")
methods::setMethod(
  "[",
  "query_s4_record",
  function(x, i, j, ..., drop = TRUE) {
    methods::new("query_s4_record", as.numeric(x)[i])
  }
)
methods::setMethod(
  "format",
  "query_s4_record",
  function(x, ...) paste0("s4:", as.numeric(x))
)
methods::setMethod("xtfrm", "query_s4_record", function(x) as.numeric(x))
xtfrm.query_reverse_numeric <- function(x, ...) -as.numeric(unclass(x))

export_table <- function(x) {
  register(x, mode = "snapshot")
  messages <- notifications()
  jsonlite::fromJSON(messages[[length(messages)]], simplifyVector = FALSE)
}

snapshots <- lapply(fixture$cases, function(case) {
  columns <- lapply(case$columns, column_from_fixture)
  names(columns) <- vapply(case$columns, `[[`, character(1L), "name")
  frame <- structure(
    columns,
    class = "data.frame",
    row.names = seq_along(columns[[1L]])
  )
  export_table(frame)
})
names(snapshots) <- vapply(fixture$cases, `[[`, character(1L), "name")

one_row <- export_table(data.frame(x = "one", check.names = FALSE))
zero_row <- export_table(data.frame(
  a = character(),
  b = integer(),
  check.names = FALSE
))
duplicates <- export_table(structure(
  list(c("first", NA_character_), c(2L, NA_integer_)),
  names = c("same", "same"),
  class = "data.frame",
  row.names = c("r1", "r2")
))
reverse_numeric <- data.frame(
  reversed = structure(c(1, 3, 2, 3), class = "query_reverse_numeric"),
  check.names = FALSE
)
reverse_numeric_snapshot <- export_table(reverse_numeric)
query_indices <- getFromNamespace("query_indices", "jdv")
paged_holder <- getFromNamespace("paged_table", "jdv")(reverse_numeric)
reverse_numeric_paged <- query_indices(
  paged_holder,
  sort = list(list(col = 0L, desc = FALSE))
)

submillisecond <- as.POSIXct(
  1577836800 + c(0.000001, 0.000002),
  origin = "1970-01-01",
  tz = "UTC"
)
submillisecond_snapshot <- export_table(data.frame(time = submillisecond))
early_year_dates <- as.Date(
  c("0000-01-01", "0001-01-01", "0099-12-31"),
  format = "%Y-%m-%d"
)
early_year_times <- as.POSIXct(early_year_dates, tz = "UTC")
early_year_snapshot <- export_table(data.frame(time = early_year_times))
ancient_dates <- as.Date(
  c(
    "0000-01-01",
    "0001-01-01",
    "0099-12-31",
    "1969-12-31",
    "1970-01-01",
    "1971-01-01"
  ),
  format = "%Y-%m-%d"
)
ancient_date_table <- data.frame(date = ancient_dates)
ancient_date_snapshot <- export_table(ancient_date_table)
ancient_date_holder <- getFromNamespace("paged_table", "jdv")(
  ancient_date_table
)
ancient_date_paged <- query_indices(
  ancient_date_holder,
  filter = list(op = "lt", col = 0L, value = "1970-01-01")
)

output <- list(
  cases = snapshots,
  extras = list(
    one_row = one_row,
    zero_row = zero_row,
    duplicates = duplicates,
    reverse_numeric = reverse_numeric_snapshot,
    reverse_numeric_paged = reverse_numeric_paged,
    submillisecond = submillisecond_snapshot,
    early_year_times = early_year_snapshot,
    ancient_dates = ancient_date_snapshot,
    ancient_dates_paged = ancient_date_paged
  )
)
writeLines(
  jsonlite::toJSON(
    output,
    auto_unbox = TRUE,
    null = "null",
    na = "null",
    digits = NA
  ),
  output_path,
  useBytes = TRUE
)

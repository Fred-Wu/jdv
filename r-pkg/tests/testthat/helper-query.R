with_query_methods <- function(code) {
  table <- get(".__S3MethodsTable__.", asNamespace("base"))
  methods <- list(
    format.query_record = function(x, ...) paste0("value:", as.numeric(x)),
    xtfrm.query_record = function(x) as.numeric(x),
    `[.query_record` = function(x, i, ...) {
      structure(unclass(x)[i], class = class(x))
    }
  )
  query_define_s4_record()
  on.exit(query_remove_s4_record(), add = TRUE)
  previous <- lapply(
    names(methods),
    function(name) {
      if (exists(name, table, inherits = FALSE)) get(name, table) else NULL
    }
  )
  on.exit(
    {
      for (i in seq_along(methods)) {
        if (is.null(previous[[i]])) {
          rm(list = names(methods)[i], envir = table)
        } else {
          assign(names(methods)[i], previous[[i]], table)
        }
      }
    },
    add = TRUE
  )
  for (name in names(methods)) {
    pieces <- strsplit(name, ".", fixed = TRUE)[[1L]]
    registerS3method(
      pieces[1L],
      pieces[2L],
      methods[[name]],
      asNamespace("base")
    )
  }
  eval(substitute(code), parent.frame())
}

# A synthetic S4 numeric vector class with display and sort methods, defined
# in the global environment as S4 methods need a package-independent home.
query_define_s4_record <- function() {
  name <- "query_s4_record"
  methods::setClass(name, contains = "numeric", where = .GlobalEnv)
  methods::setMethod(
    "[",
    name,
    function(x, i, j, ..., drop = TRUE) {
      methods::new("query_s4_record", as.numeric(x)[i])
    },
    where = .GlobalEnv
  )
  methods::setMethod(
    "format",
    name,
    function(x, ...) paste0("s4:", as.numeric(x)),
    where = .GlobalEnv
  )
  methods::setMethod(
    "xtfrm",
    name,
    function(x) as.numeric(x),
    where = .GlobalEnv
  )
}

query_remove_s4_record <- function() {
  name <- "query_s4_record"
  for (generic in c("[", "format", "xtfrm")) {
    methods::removeMethod(generic, name, where = .GlobalEnv)
  }
  methods::removeClass(name, where = .GlobalEnv)
}

query_fixture_table <- function(columns) {
  n <- length(columns[[1L]]$values)
  x <- data.frame(row.names = seq_len(n))
  for (column in columns) {
    type <- column$type
    values <- vapply(
      column$values,
      function(value) {
        if (is.null(value)) {
          switch(
            type,
            number = NA_real_,
            duration = NA_real_,
            integer = NA_real_,
            boolean = NA,
            other = NA_real_,
            NA_character_
          )
        } else {
          value
        }
      },
      switch(
        type,
        number = numeric(1L),
        duration = numeric(1L),
        integer = numeric(1L),
        boolean = logical(1L),
        other = numeric(1L),
        character(1L)
      )
    )
    if (type %in% c("number", "duration") && !is.null(column$special)) {
      for (i in seq_along(column$special)) {
        token <- column$special[[i]]
        if (!is.null(token)) {
          values[i] <- switch(
            token,
            na = NA_real_,
            nan = NaN,
            pos_inf = Inf,
            neg_inf = -Inf
          )
        }
      }
    }
    values <- switch(
      type,
      integer = as.integer(values),
      categorical = factor(
        values,
        levels = unlist(column$levels),
        ordered = isTRUE(column$ordered)
      ),
      date = as.Date(values),
      datetime = as.POSIXct(as.POSIXlt(
        values,
        format = "%Y-%m-%dT%H:%M:%OS",
        tz = column$tz
      )),
      int64 = int64_fixture(values),
      # The hms class structure is built directly so the hms package is not
      # needed.
      duration = if (identical(column$r, "hms")) {
        structure(values, units = column$units, class = c("hms", "difftime"))
      } else {
        as.difftime(values, units = column$units)
      },
      other = switch(
        column$r %||% "query_record",
        query_record = structure(values, class = "query_record"),
        s4_record = methods::new("query_s4_record", values),
        stop("Unknown fixture class: ", column$r, call. = FALSE)
      ),
      values
    )
    if (isTRUE(column$asis)) {
      values <- I(values)
    }
    x[[column$name]] <- values
  }
  x
}

# Reconstruct wire arrays after JSON has replaced non-finite values with null.
# Numeric sort keys are omitted, requiring the reference to consume special.
query_wire_snapshot <- function(snapshot) {
  skip_if_not_installed("jsonlite")
  for (j in seq_along(snapshot$columns)) {
    data <- snapshot$columns[[j]]$data
    if (
      snapshot$schema[[j]]$type %in%
        c("number", "duration", "integer", "boolean")
    ) {
      data$sortKey <- NULL
    }
    data <- lapply(data, unname)
    decoded <- jsonlite::fromJSON(
      jsonlite::toJSON(
        data,
        auto_unbox = FALSE,
        na = "null",
        null = "null",
        digits = NA
      ),
      simplifyVector = FALSE
    )
    for (name in names(data)) {
      prototype <- switch(
        typeof(data[[name]]),
        integer = integer(1L),
        double = numeric(1L),
        logical = logical(1L),
        character = character(1L)
      )
      decoded[[name]] <- vapply(
        decoded[[name]],
        function(value) {
          if (is.null(value)) {
            switch(
              typeof(prototype),
              integer = NA_integer_,
              double = NA_real_,
              logical = NA,
              character = NA_character_
            )
          } else if (typeof(prototype) == "integer") {
            as.integer(value)
          } else {
            value
          }
        },
        prototype
      )
    }
    snapshot$columns[[j]]$data <- decoded
  }
  snapshot
}

expect_query_code <- function(code, expected) {
  error <- tryCatch(force(code), error = identity)
  expect_s3_class(error, "jdv_query_error")
  expect_identical(error$code, expected)
  invisible(error)
}

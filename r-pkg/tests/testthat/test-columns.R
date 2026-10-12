with_column_method <- function(generic, class, method, code) {
  table <- get(".__S3MethodsTable__.", envir = asNamespace("base"))
  name <- paste(generic, class, sep = ".")
  had <- exists(name, envir = table, inherits = FALSE)
  previous <- if (had) get(name, envir = table)
  registerS3method(generic, class, method, envir = asNamespace("base"))
  on.exit({
    if (had) {
      assign(name, previous, envir = table)
    } else {
      rm(list = name, envir = table)
    }
  })
  eval(substitute(code), envir = parent.frame())
}

test_that("the reference type matrix has independent channels", {
  x <- data.frame(
    integer = c(42L, NA_integer_),
    double = c(1.54e-100, NA_real_),
    huge_double = c(1.23456789012345e14, NA_real_),
    logical = c(TRUE, NA),
    character = c('中文 😀 "quoted" <html>', NA_character_),
    factor = factor(c("apple", NA)),
    ordered = ordered(c("low", NA), levels = c("low", "high")),
    date = as.Date(c("2000-01-01", NA)),
    datetime = as.POSIXct(c("2020-01-01", NA), tz = "Australia/Sydney"),
    difftime = as.difftime(c(60, NA), units = "secs"),
    complex = c(1 + 2i, NA_complex_),
    raw = as.raw(c(0, 255)),
    check.names = FALSE
  )
  x[["column with spaces"]] <- c("001", "")
  x[["a.b$c@d"]] <- c(FALSE, TRUE)
  x$list <- list(list(number = 1L, value = 3 - 4i), NULL)
  x$complex_matrix <- I(matrix(c(1 + 2i, NA_complex_), ncol = 1L))
  x$integer64 <- structure(c(1, NA_real_), class = "integer64")
  original <- serialize(x, NULL)
  model <- table_model(x)
  expect_length(model$schema, 17L)
  expect_identical(
    vapply(model$schema, `[[`, character(1L), "type"),
    c(
      "integer",
      "number",
      "number",
      "boolean",
      "string",
      "factor",
      "factor",
      "date",
      "datetime",
      "other",
      "other",
      "other",
      "string",
      "boolean",
      "list",
      "other",
      "int64"
    )
  )
  results <- lapply(model$columns, column_extract)
  for (i in seq_along(results)) {
    expect_identical(
      typeof(results[[i]]$data$display),
      "character",
      info = names(x)[[i]]
    )
    expect_identical(
      length(results[[i]]$data$display),
      2L,
      info = names(x)[[i]]
    )
  }
  expect_identical(results[[1L]]$data$values, c(42L, NA_integer_))
  expect_identical(results[[2L]]$data$values, c(1.54e-100, NA_real_))
  expect_identical(results[[3L]]$data$values, x$huge_double)
  expect_identical(results[[4L]]$data$values, c(TRUE, NA))
  expect_identical(results[[5L]]$data$values, x$character)
  expect_identical(results[[6L]]$data$values, c("apple", NA_character_))
  expect_identical(results[[7L]]$data$sortKey, c(1L, NA_integer_))
  expect_identical(results[[8L]]$data$values, c("2000-01-01", NA_character_))
  expect_identical(results[[8L]]$data$display, c("2000-01-01", "NA"))
  expect_identical(results[[9L]]$data$display, c("2020-01-01", "NA"))
  expect_identical(
    results[[9L]]$data$values,
    c("2020-01-01T00:00:00+11:00", NA_character_)
  )
  expect_null(results[[10L]]$data$values)
  for (i in 11:12) {
    expect_false(results[[i]]$schema$sortable)
    expect_false(results[[i]]$schema$filterable)
  }
  for (i in 15:17) {
    expect_false(results[[i]]$schema$sortable)
    expect_false(results[[i]]$schema$filterable)
    expect_null(results[[i]]$data$values)
    expect_null(results[[i]]$data$sortKey)
  }
  expect_identical(results[[17L]]$data$display, rep("<integer64>", 2L))
  expect_identical(serialize(x, NULL), original)
})

test_that("classification is lazy and channel requests are independent", {
  calls <- character()
  x <- structure(c(3, 2, 1), class = "jdv_lazy")
  with_column_method(
    "format",
    "jdv_lazy",
    function(x, ...) {
      calls <<- c(calls, "format")
      paste0("v", unclass(x))
    },
    with_column_method(
      "xtfrm",
      "jdv_lazy",
      function(x) {
        calls <<- c(calls, "xtfrm")
        -unclass(x)
      },
      {
        model <- table_model(structure(
          list(x = x),
          class = "data.frame",
          row.names = c(NA_integer_, -3L)
        ))
        expect_identical(calls, character())
        expect_identical(model$schema[[1L]]$type, "other")
        expect_identical(
          column_extract(x, "display")$data$display,
          c("v3", "v2", "v1")
        )
        expect_identical(calls, "format")
        expect_identical(
          column_extract(x, "sortKey")$data$sortKey,
          c(-3, -2, -1)
        )
        expect_identical(calls, c("format", "xtfrm"))
        expect_null(column_extract(x, "values")$data$values)
        expect_identical(calls, c("format", "xtfrm"))
      }
    )
  )
})

test_that("table identities retain empty shapes and duplicate names", {
  expect_identical(table_model(data.frame())$row_index, integer())
  expect_length(table_model(data.frame())$schema, 0L)
  x <- data.frame(a = integer(), b = character())
  expect_length(table_model(x)$schema, 2L)
  expect_identical(column_extract(x$a)$data$display, character())
  expect_identical(column_extract(x$b)$data$sortKey, integer())
  expect_null(table_model(data.frame(x = 1:3))$row_names)
  x <- data.frame(
    x = 1:3,
    x = 4:6,
    check.names = FALSE,
    row.names = c("c", "a", "b")
  )
  model <- table_model(x)
  expect_identical(model$row_names, c("c", "a", "b"))
  expect_identical(model$row_index, 1:3)
  expect_identical(vapply(model$schema, `[[`, integer(1L), "position"), 0:1)
  expect_identical(
    vapply(model$schema, `[[`, character(1L), "name"),
    c("x", "x")
  )
  expect_length(table_model(matrix(integer(), nrow = 3L, ncol = 0L))$schema, 0L)
  m <- matrix(1:6, ncol = 2L, dimnames = list(c("c", "a", "b"), NULL))
  expect_identical(table_model(m)$row_names, c("c", "a", "b"))
  expect_identical(table_model(m)$columns[[1L]], m[, 1L])
  expect_error(table_model(1:3), "data frame or matrix")
})

test_that("missingness never depends on displayed labels", {
  x <- c("NA", NA_character_, "NaN", "")
  out <- column_extract(x)
  expect_identical(out$data$na, c(FALSE, TRUE, FALSE, FALSE))
  expect_identical(out$data$values, x)
  for (x in list(
    rep(NA_real_, 3L),
    rep(NA_character_, 3L),
    factor(rep(NA, 3L))
  )) {
    out <- column_extract(x)
    expect_true(all(out$data$na))
    expect_true(all(is.na(out$data$sortKey)))
  }
  x <- c(1.2, NA_real_, NaN, Inf, -Inf)
  out <- column_extract(x)
  expect_identical(
    out$data$special,
    c(NA_character_, "na", "nan", "pos_inf", "neg_inf")
  )
  expect_identical(
    out$data$values,
    c(1.2, NA_real_, NA_real_, NA_real_, NA_real_)
  )
  expect_identical(out$data$na, c(FALSE, TRUE, TRUE, FALSE, FALSE))
  expect_identical(out$data$sortKey, x)
  expect_null(column_extract(c(1, 2))$data$special)
  expect_null(column_extract(c(1L, NA_integer_))$data$special)
})

test_that("keys preserve ties, factor levels and both collations", {
  x <- c("b", "a", "b", NA_character_, "中文", "A", "é")
  keys <- column_extract(x, "sortKey")$data$sortKey
  expect_identical(keys, match(x, sort(unique(x), method = "radix")))
  expect_identical(order(keys, method = "radix"), order(x, method = "radix"))
  expect_identical(keys[[1L]], keys[[3L]])
  expect_identical(
    column_extract(x, "sortKey", collation = "locale")$data$sortKey,
    xtfrm(x)
  )
  x <- factor(c("high", "low", "high", NA), levels = c("low", "high"))
  expect_identical(column_extract(x)$data$sortKey, c(2L, 1L, 2L, NA_integer_))
  expect_false(column_schema(x)$ordered)
  expect_true(column_schema(ordered(x))$ordered)
})

test_that("date and datetime values preserve timezone and fractional seconds", {
  for (tz in c("UTC", "Australia/Sydney", "America/New_York")) {
    x <- as.POSIXct(c("2020-01-01", "2020-07-01", NA), tz = tz) +
      c(0.125, 0.000001, 0)
    for (value in list(x, as.POSIXlt(x))) {
      out <- column_extract(value)
      expect_identical(out$schema$tz, tz)
      expect_identical(out$data$sortKey, as.numeric(x))
      expect_match(out$data$values[[1L]], "T00:00:00\\.125")
      restored <- as.POSIXct(strptime(
        sub("([+-][0-9]{2}):([0-9]{2})$", "\\1\\2", out$data$values),
        "%Y-%m-%dT%H:%M:%OS%z",
        tz = "UTC"
      ))
      expect_identical(as.numeric(restored), as.numeric(x))
    }
  }
  x <- as.POSIXct(-0.125, origin = "1970-01-01", tz = "UTC")
  expect_identical(
    column_extract(x)$data$values,
    "1969-12-31T23:59:59.875+00:00"
  )
})

test_that(
  "date subclasses customize display without changing canonical values",
  {
    x <- structure(
      as.Date(c("2020-01-01", NA)),
      class = c("jdv_decorated_date", "Date")
    )
    with_column_method(
      "format",
      "jdv_decorated_date",
      function(x, ...) c("Date label", NA_character_),
      {
        out <- column_extract(x)
        expect_identical(out$data$display, c("Date label", "NA"))
        expect_identical(out$data$values, c("2020-01-01", NA_character_))
        expect_identical(out$data$sortKey, c(18262, NA_real_))
        expect_identical(out$data$na, c(FALSE, TRUE))
      }
    )
    x <- as.POSIXct(c("2020-01-01", NA), tz = "Australia/Sydney") + c(0.125, 0)
    class(x) <- c("jdv_decorated_time", class(x))
    with_column_method(
      "format",
      "jdv_decorated_time",
      function(x, ...) c("Time label", NA_character_),
      {
        out <- column_extract(x)
        expect_identical(out$data$display, c("Time label", "NA"))
        expect_identical(
          out$data$values,
          c("2020-01-01T00:00:00.125+11:00", NA_character_)
        )
        expect_identical(out$data$na, c(FALSE, TRUE))
      }
    )
  }
)

test_that(
  "datetime fractions retain very small values independently of print options",
  {
    x <- as.POSIXct(c(1e-100, 0.125), origin = "1970-01-01", tz = "UTC")
    old <- options(OutDec = ",", digits.secs = 0)
    on.exit(options(old))
    values <- column_extract(x, "values")$data$values
    expect_identical(
      values[[1L]],
      paste0(
        "1970-01-01T00:00:00.",
        paste(rep("0", 99L), collapse = ""),
        "1+00:00"
      )
    )
    expect_identical(values[[2L]], "1970-01-01T00:00:00.125+00:00")
  }
)

test_that(
  "text channels use source strings, factor labels and whole-column format",
  {
    x <- paste(rep("a", 2000L), collapse = "")
    expect_identical(column_extract(x, "text")$data$text, x)
    x <- factor(c("low", "high", NA), levels = c("high", "low"))
    expect_identical(column_extract(x, "text")$data$text, as.character(x))
    x <- structure(c(1, 1e10), class = "jdv_text")
    with_column_method(
      "format",
      "jdv_text",
      function(x, ...) format(unclass(x), ...),
      {
        expect_identical(
          column_extract(x, "text")$data$text,
          format(unclass(x), trim = TRUE, justify = "none")
        )
      }
    )
    expect_null(column_extract(1:3, "text")$data$text)
    expect_null(column_extract(list(1, 2), "text")$data$text)
  }
)

test_that("malformed methods degrade only their own channels", {
  x <- structure(c(1, 2, NA_real_), class = "jdv_broken")
  for (method in list(
    function(x, ...) stop("broken format"),
    function(x, ...) "wrong length",
    function(x, ...) 1:3,
    function(x, ...) matrix(rep("x", 3L), ncol = 1L)
  )) {
    with_column_method("format", "jdv_broken", method, {
      out <- column_extract(x)
      expect_identical(out$data$display, rep("<jdv_broken>", 3L))
      expect_identical(out$data$na, is.na(x))
      expect_identical(out$data$sortKey, xtfrm(x))
      expect_true(out$schema$sortable)
      expect_true("display" %in% names(out$errors))
      expect_false(column_extract(x, "text")$schema$filterable)
    })
  }
  for (method in list(
    function(x) stop("broken key"),
    function(x) 1,
    function(x) letters[1:3],
    function(x) matrix(1:3, ncol = 1L),
    function(x) structure(1:3, class = "not_plain")
  )) {
    with_column_method("xtfrm", "jdv_broken", method, {
      out <- column_extract(x)
      expect_false(out$schema$sortable)
      expect_null(out$data$sortKey)
      expect_identical(
        out$data$display,
        format(x, trim = TRUE, justify = "none")
      )
      expect_identical(out$data$na, is.na(x))
    })
  }
  with_column_method(
    "is.na",
    "jdv_broken",
    function(x) matrix(c(TRUE, FALSE, FALSE), ncol = 1L),
    {
      out <- column_extract(x)
      expect_null(out$data$na)
      expect_true("na" %in% names(out$errors))
      expect_true(out$schema$sortable)
    }
  )
})

test_that("numeric subclasses use methods and unsafe keys become dense ranks", {
  x <- structure(c(1, 2, NA_real_), class = "jdv_numeric")
  with_column_method(
    "format",
    "jdv_numeric",
    function(x, ...) paste0("n", unclass(x)),
    {
      with_column_method(
        "xtfrm",
        "jdv_numeric",
        function(x) c(Inf, -Inf, NA_real_),
        {
          out <- column_extract(x)
          expect_identical(out$schema$type, "other")
          expect_null(out$data$values)
          expect_identical(out$data$display, c("n1", "n2", "nNA"))
          expect_identical(out$data$sortKey, c(2L, 1L, NA_integer_))
        }
      )
      with_column_method(
        "xtfrm",
        "jdv_numeric",
        function(x) c(2^54, 2^54, -2^54),
        {
          expect_identical(column_extract(x)$data$sortKey, c(2L, 2L, 1L))
        }
      )
      with_column_method(
        "xtfrm",
        "jdv_numeric",
        function(x) c(2^53, -2^53, NA_real_),
        {
          expect_identical(
            column_extract(x)$data$sortKey,
            c(2^53, -2^53, NA_real_)
          )
        }
      )
    }
  )
})

test_that(
  "S4 numeric subclasses retain their formatting and ordering semantics",
  {
    class_name <- "jdv_test_numeric_s4"
    methods::setClass(class_name, contains = "numeric", where = .GlobalEnv)
    calls <- character()
    methods::setMethod(
      "format",
      class_name,
      function(x, ...) {
        calls <<- c(calls, "format")
        paste0("s4:", as.numeric(x))
      },
      where = .GlobalEnv
    )
    methods::setMethod(
      "xtfrm",
      class_name,
      function(x) {
        calls <<- c(calls, "xtfrm")
        -as.numeric(x)
      },
      where = .GlobalEnv
    )
    on.exit(
      {
        methods::removeMethod("format", class_name, where = .GlobalEnv)
        methods::removeMethod("xtfrm", class_name, where = .GlobalEnv)
        methods::removeClass(class_name, where = .GlobalEnv)
      },
      add = TRUE
    )
    x <- methods::new(class_name, c(2, 1))
    expect_identical(column_schema(x)$type, "other")
    expect_identical(calls, character())
    out <- column_extract(x)
    expect_null(out$data$values)
    expect_identical(out$data$display, c("s4:2", "s4:1"))
    expect_identical(out$data$sortKey, c(-2, -1))
    expect_identical(calls, c("format", "xtfrm"))
    methods::setMethod(
      "format",
      class_name,
      function(x, ...) stop("bad S4 format"),
      where = .GlobalEnv
    )
    out <- column_extract(x)
    expect_identical(out$data$display, rep("<jdv_test_numeric_s4>", 2L))
    expect_identical(out$data$sortKey, c(-2, -1))
    expect_true(out$schema$sortable)
    methods::setMethod(
      "xtfrm",
      class_name,
      function(x) "bad S4 key",
      where = .GlobalEnv
    )
    out <- column_extract(x)
    expect_false(out$schema$sortable)
    expect_null(out$data$sortKey)
    local_mocked_bindings(
      column_s4_generic = function(...) stop("S4 unavailable")
    )
    out <- column_extract(x)
    expect_identical(out$data$display, rep("<jdv_test_numeric_s4>", 2L))
    expect_false(out$schema$sortable)
    expect_identical(column_extract(c(2, 1))$data$sortKey, c(2, 1))
    expect_identical(column_extract(c(2, 1))$data$display, c("2", "1"))
  }
)

test_that("vctrs records keep semantic ordering and formatting", {
  skip_if_not_installed("vctrs")
  x <- vctrs::new_rcrd(list(a = c(2, 1, NA_real_)), class = "jdv_test_record")
  format_method <- function(x, ...) paste0("record:", vctrs::field(x, "a"))
  with_column_method("format", "jdv_test_record", format_method, {
    with_column_method(
      "xtfrm",
      "jdv_test_record",
      function(x) vctrs::field(x, "a"),
      {
        out <- column_extract(x)
        expect_identical(out$schema$type, "other")
        expect_null(out$data$values)
        expect_identical(
          out$data$display,
          c("record:2", "record:1", "record:NA")
        )
        expect_identical(out$data$sortKey, c(2, 1, NA_real_))
        expect_identical(out$data$na, c(FALSE, FALSE, TRUE))
      }
    )
  })
})

test_that("structural previews obey traversal, depth and text budgets", {
  expect_identical(
    cell_preview(structure(1, class = "integer64")),
    "<integer64 [1]>"
  )
  expect_identical(column_extract(list(NULL))$data$display, "NULL")
  expect_identical(
    column_extract(list(seq_len(10000000L)))$data$display,
    "<integer [10000000]>"
  )
  expect_match(cell_preview(list(list(list(list(1L))))), "<list \\[1\\]>")
  expect_lte(nchar(cell_preview(paste(rep("a", 10000L), collapse = ""))), 1000L)
  expect_lte(
    nchar(cell_preview(rep(paste(rep("a", 1000L), collapse = ""), 100L))),
    1000L
  )
  x <- matrix(c(NA_real_, 1, NA_real_, NA_real_), nrow = 2L)
  expect_identical(column_extract(I(x))$data$na, c(TRUE, FALSE))
  expect_length(column_extract(x)$data$display, 2L)
  x <- data.frame(a = c(NA, 1), b = c(NA, NA))
  out <- column_extract(x)
  expect_identical(out$data$na, c(TRUE, FALSE))
  expect_length(out$data$display, 2L)
  expect_null(out$data$values)
  expect_false(out$schema$sortable)
  expect_false(out$schema$filterable)
  expect_identical(
    column_extract(matrix(integer(), nrow = 2L, ncol = 0L))$data$na,
    c(FALSE, FALSE)
  )
})

test_that("jdv itself does not change random state or options", {
  set.seed(123)
  seed <- .Random.seed
  opts <- options()
  x <- data.frame(a = c(1, NA, NaN), b = c("a", "NA", NA_character_))
  model <- table_model(x)
  invisible(lapply(model$columns, column_extract))
  invisible(column_extract(list(list(1, 2), 3)))
  expect_identical(.Random.seed, seed)
  expect_identical(options(), opts)
})

test_that(
  "column generics are private and methods do not extend base generics",
  {
    expect_false(any(
      c("col_display", "col_is_na", "col_values", "col_sort_key") %in%
        getNamespaceExports("jdv")
    ))
    expect_identical(
      environment(getS3method(
        "col_display",
        "factor",
        envir = asNamespace("jdv")
      )),
      asNamespace("jdv")
    )
  }
)

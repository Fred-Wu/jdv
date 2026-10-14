test_that(
  "the canonical fixture is shipped without hand-edited package copies",
  {
    path <- system.file("spec", "query-fixtures.json", package = "jdv")
    expect_true(file.exists(path))
    canonical <- test_path("..", "..", "..", "spec", "query-fixtures.json")
    if (file.exists(canonical)) {
      expect_identical(
        readBin(path, "raw", file.info(path)$size),
        readBin(canonical, "raw", file.info(canonical)$size)
      )
    }
  }
)

test_that(
  "shared fixtures agree across Paged and an independent wire Snapshot",
  {
    fixture <- jsonlite::fromJSON(
      system.file("spec", "query-fixtures.json", package = "jdv"),
      simplifyVector = FALSE
    )
    for (fold in fixture$fold) {
      expect_identical(query_fold(fold$input), fold$expected)
    }
    with_query_methods({
      for (case in fixture$cases) {
        x <- query_fixture_table(case$columns)
        before <- serialize(x, NULL)
        holder <- paged_table(x)
        snapshot <- query_wire_snapshot(snapshot_table(x))
        expect_identical(snapshot$schema, holder$schema)
        for (request in case$queries) {
          sort <- if (is.null(request$sort)) list() else request$sort
          expected <- as.integer(unlist(request$expected))
          if (!length(expected)) {
            expected <- integer()
          }
          actual <- query_indices(holder, sort, request$filter)
          reference <- snapshot_indices(snapshot, sort, request$filter)
          expect_identical(
            actual,
            expected,
            info = paste(case$name, request$name)
          )
          expect_identical(
            reference,
            expected,
            info = paste("snapshot", case$name, request$name)
          )
          page <- query_page(
            holder,
            limit = 200L,
            sort = sort,
            filter = request$filter
          )
          expect_identical(page$data$row_index, expected)
          expect_identical(page$total, length(expected))
        }
        expect_identical(serialize(x, NULL), before)
      }
    })
  }
)

test_that("default query limits allow five-million-row sorts and filters", {
  option_names <- c(
    "jdv.max_work_bytes",
    "jdv.max_query_rows",
    "jdv.max_message_bytes",
    "jdv.snapshot_max_bytes"
  )
  old_options <- setNames(lapply(option_names, getOption), option_names)
  on.exit(options(old_options), add = TRUE)
  options(setNames(rep(list(NULL), length(option_names)), option_names))

  n <- 5000000L

  numeric_holder <- paged_table(data.frame(value = as.double(seq_len(n))))
  numeric_sorted <- query_indices(
    numeric_holder,
    list(list(col = 0L, desc = TRUE))
  )
  expect_length(numeric_sorted, n)
  expect_identical(numeric_sorted[1L], n)
  expect_identical(numeric_sorted[[n]], 1L)
  numeric_filtered <- query_indices(
    numeric_holder,
    filter = list(op = "ge", col = 0L, value = as.double(n - 3L))
  )
  expect_identical(numeric_filtered, as.integer((n - 3L):n))
  rm(numeric_holder, numeric_sorted, numeric_filtered)
  gc()

  character_holder <- paged_table(data.frame(
    value = rep(c("a", "b"), length.out = n),
    stringsAsFactors = FALSE
  ))
  character_sorted <- query_indices(
    character_holder,
    list(list(col = 0L, desc = FALSE))
  )
  expect_length(character_sorted, n)
  expect_identical(character_sorted[1L], 1L)
  expect_identical(character_sorted[[n]], n)
  character_filtered <- query_indices(
    character_holder,
    filter = list(op = "text_equals", col = 0L, value = "b")
  )
  expect_length(character_filtered, n %/% 2L)
  expect_identical(character_filtered[1L], 2L)
  expect_identical(character_filtered[[n %/% 2L]], n)
})

test_that("locale and C character sorting have stable R order semantics", {
  strings <- c("é", "z", "a", "ä", NA, "a")
  x <- data.frame(text = strings, tie = c(2, 1, 2, 1, 0, 1))
  for (collation in c("C", "locale")) {
    holder <- paged_table(x, collation)
    snapshot <- query_wire_snapshot(snapshot_table(x, collation))
    for (desc in c(FALSE, TRUE)) {
      sort <- list(list(col = 0L, desc = desc), list(col = 1L, desc = !desc))
      key <- if (collation == "C") strings else xtfrm(strings)
      expected <- order(
        key,
        x$tie,
        decreasing = c(desc, !desc),
        na.last = TRUE,
        method = "radix"
      )
      expect_identical(query_indices(holder, sort), expected)
      expect_identical(snapshot_indices(snapshot, sort), expected)
    }
    expect_identical(
      query_indices(holder, list(list(col = 0L, desc = FALSE))),
      order(
        strings,
        na.last = TRUE,
        method = if (collation == "C") "radix" else "shell"
      )
    )
  }
})

test_that("registration is lazy and requested channels are cached", {
  counters <- new.env(parent = emptyenv())
  counters$format <- counters$xtfrm <- integer()
  with_column_method(
    "format",
    "query_count",
    function(x, ...) {
      counters$format <- c(counters$format, length(x))
      paste0("value:", as.numeric(x))
    },
    with_column_method(
      "xtfrm",
      "query_count",
      function(x) {
        counters$xtfrm <- c(counters$xtfrm, length(x))
        as.numeric(x)
      },
      {
        x <- data.frame(id = 1:100)
        x$count <- structure(as.double(100:1), class = "query_count")
        holder <- paged_table(x, limits = list(probe_rows = 3L))
        expect_identical(counters$format, 3L)
        expect_identical(counters$xtfrm, 3L)
        expect_length(holder$column_cache, 0L)
        expect_length(holder$index_cache, 0L)
        expect_false("row_index" %in% names(holder))
        query_page(holder, offset = 5L, limit = 2L)
        expect_identical(counters$format, c(3L, 2L))
        sort <- list(list(col = 1L, desc = FALSE))
        expect_identical(query_indices(holder, sort), 100:1)
        query_indices(holder, list(list(col = 1L, desc = TRUE)))
        expect_identical(counters$xtfrm, c(3L, 100L))
        filter <- list(op = "text_equals", col = 1L, value = "value:2")
        expect_identical(query_indices(holder, filter = filter), 99L)
        query_indices(
          holder,
          filter = list(op = "contains", col = 1L, value = "value:")
        )
        expect_identical(counters$format, c(3L, 2L, 100L))
        query_indices(holder, sort, filter)
        expect_identical(counters$xtfrm, c(3L, 100L))
        expect_setequal(names(holder$column_cache), "2")
      }
    )
  )
})

test_that(
  "matrix registration shares one probe and slices only requested rows",
  {
    calls <- list()
    with_column_method(
      "[",
      "query_matrix",
      function(x, i, j, ..., drop = TRUE) {
        calls[[length(calls) + 1L]] <<- list(
          rows = if (missing(i)) NULL else i,
          col = if (missing(j)) NULL else j
        )
        unclass(x)[i, j, drop = drop]
      },
      {
        x <- matrix(seq_len(1000L), 100L, 10L)
        class(x) <- c("query_matrix", "matrix", "array")
        holder <- paged_table(x, limits = list(probe_rows = 4L))
        expect_length(calls, 1L)
        expect_identical(calls[[1L]]$rows, 1:4)
        expect_identical(calls[[1L]]$col, 1L)
        expect_length(holder$column_cache, 0L)
        query_page(holder, offset = 7L, limit = 3L, cols = c(0L, 9L))
        expect_length(calls, 3L)
        expect_identical(calls[[2L]]$rows, 8:10)
        expect_identical(calls[[3L]]$col, 10L)
        query_indices(holder, list(list(col = 2L, desc = FALSE)))
        expect_length(calls, 4L)
        expect_null(calls[[4L]]$rows)
        query_indices(holder, list(list(col = 2L, desc = TRUE)))
        expect_length(calls, 4L)
        expect_setequal(names(holder$column_cache), "3")
        expect_query_code(
          snapshot_table(x, limits = list(max_columns = 2L)),
          "limit_exceeded"
        )
        expect_length(calls, 4L)
      }
    )
  }
)

test_that("page displays never become filter text", {
  with_column_method(
    "format",
    "query_page_text",
    function(x, ...) paste0("n=", length(x), ":", as.numeric(x)),
    {
      x <- data.frame(id = 1:5)
      x$value <- structure(as.double(1:5), class = "query_page_text")
      holder <- paged_table(x)
      page <- query_page(holder, offset = 1L, limit = 1L)
      expect_identical(page$data$columns[[2L]]$data$display, "n=1:2")
      expect_identical(
        query_indices(
          holder,
          filter = list(op = "text_equals", col = 1L, value = "n=5:2")
        ),
        2L
      )
      expect_identical(
        query_indices(
          holder,
          filter = list(op = "text_equals", col = 1L, value = "n=1:2")
        ),
        integer()
      )
    }
  )
})

test_that("named values and custom missing sort keys agree across modes", {
  x <- data.frame(id = 1:4)
  x$text <- setNames(c("A", "b", NA, "a"), letters[1:4])
  x$flag <- setNames(c(FALSE, TRUE, NA, FALSE), letters[1:4])
  x$key <- structure(c(2, NA, 1, NA), class = "query_na_key")
  with_column_method(
    "xtfrm",
    "query_na_key",
    function(x) {
      values <- as.numeric(x)
      values[is.na(values)] <- -100
      values
    },
    {
      holder <- paged_table(x)
      snapshot <- snapshot_table(x)
      for (filter in list(
        list(op = "text_equals", col = 1L, value = "a"),
        list(op = "is_false", col = 2L)
      )) {
        expect_identical(query_indices(holder, filter = filter), c(1L, 4L))
        expect_identical(snapshot_indices(snapshot, filter = filter), c(1L, 4L))
      }
      for (desc in c(FALSE, TRUE)) {
        sort <- list(list(col = 3L, desc = desc))
        expected <- if (desc) c(1L, 3L, 2L, 4L) else c(3L, 1L, 2L, 4L)
        expect_identical(query_indices(holder, sort), expected)
        expect_identical(snapshot_indices(snapshot, sort), expected)
      }
    }
  )
})

test_that(
  "packed and list columns retain row structure and allow only missingness",
  {
    x <- aggregate(
      cbind(Ozone, Temp) ~ Month,
      airquality,
      quantile,
      probs = c(.25, .5, .75)
    )
    x$packed <- I(matrix(c(NA, NA, 1, NA, 2, NA, 3, NA, 4, NA), nrow = 5L))
    x$list <- list(NA, NULL, 1, NA, list(NA))
    before <- serialize(x, NULL)
    holder <- paged_table(x)
    sort <- list(list(col = 0L, desc = TRUE))
    page <- query_page(holder, offset = 1L, limit = 2L, sort = sort)
    expect_identical(page$data$row_index, c(4L, 3L))
    expect_identical(
      query_slice(x$Ozone, c(4L, 3L)),
      x$Ozone[c(4L, 3L), , drop = FALSE]
    )
    expect_length(page$data$columns[[2L]]$data$display, 2L)
    expect_query_code(
      query_indices(holder, list(list(col = 1L, desc = FALSE))),
      "unsupported"
    )
    expect_query_code(
      query_indices(holder, filter = list(op = "eq", col = 1L, value = 70)),
      "unsupported"
    )
    expect_identical(
      query_indices(holder, filter = list(op = "is_na", col = 3L)),
      1L
    )
    expect_identical(
      query_indices(holder, filter = list(op = "is_na", col = 4L)),
      c(1L, 4L)
    )
    expect_identical(serialize(x, NULL), before)
    raw_frame <- data.frame(id = 1:2)
    raw_frame$raw <- as.raw(c(0, 255))
    raw_frame$complex <- c(NA_complex_, 1 + 2i)
    holder <- paged_table(raw_frame)
    expect_identical(
      query_indices(holder, filter = list(op = "is_na", col = 1L)),
      integer()
    )
    expect_identical(
      query_indices(holder, filter = list(op = "is_na", col = 2L)),
      1L
    )
  }
)

test_that("invalid queries carry stable error codes before cache access", {
  holder <- paged_table(data.frame(n = c(1, 2, NA), text = c("a", "b", NA)))
  for (col in list(
    -1L,
    1 + 1i,
    2L,
    0.5,
    "n",
    NA_real_,
    TRUE,
    c(0, 1),
    structure(0, class = "col")
  )) {
    expect_query_code(
      query_indices(holder, list(list(col = col, desc = FALSE))),
      "invalid_request"
    )
  }
  for (filter in list(
    list(op = "wat", col = 0),
    list(op = "eq", col = 0, value = 1, extra = 1),
    list(op = "eq", col = 0),
    list(op = "not", args = list()),
    list(op = "and", args = 1),
    list(op = "eq", col = 0, value = NA_real_),
    list(op = "eq", col = 0, value = Inf),
    list(op = "eq", col = 0, value = list(special = "nan"))
  )) {
    expect_query_code(query_indices(holder, filter = filter), "invalid_request")
  }
  expect_query_code(
    query_indices(holder, filter = list(op = "contains", col = 0, value = "1")),
    "unsupported"
  )
  expect_query_code(
    query_indices(
      holder,
      list(list(col = 0L, desc = FALSE), list(col = 0L, desc = TRUE))
    ),
    "invalid_request"
  )
  expect_query_code(query_page(holder, cols = c(0L, 0L)), "invalid_request")
  expect_query_code(query_page(holder, offset = -1L), "invalid_request")
  expect_query_code(query_page(holder, limit = 1.5), "invalid_request")
  filter <- list(op = "and", args = list(list(op = "eq", col = 0, value = 1)))
  expect_identical(query_indices(holder, filter = filter), 1L)
  holder$limits$ast_nodes <- 1L
  expect_query_code(query_indices(holder, filter = filter), "limit_exceeded")
  holder$limits$ast_nodes <- 256L
  expect_query_code(
    query_indices(
      holder,
      filter = list(
        op = "and",
        args = rep(list(list(op = "is_na", col = 0L)), 256L)
      )
    ),
    "limit_exceeded"
  )
  nested <- list(op = "is_na", col = 0L)
  for (i in 1:32) {
    nested <- list(op = "not", arg = nested)
  }
  expect_query_code(query_indices(holder, filter = nested), "limit_exceeded")
  expect_query_code(
    query_indices(
      holder,
      filter = list(
        op = "contains",
        col = 1L,
        value = paste(rep("a", 4097L), collapse = "")
      )
    ),
    "limit_exceeded"
  )
  expect_query_code(
    query_page(paged_table(
      matrix(1, 1L, 3L),
      limits = list(page_columns = 2L)
    )),
    "limit_exceeded"
  )
  expect_query_code(
    paged_table(matrix(1, 1L, 3L), limits = list(max_columns = 2L)),
    "limit_exceeded"
  )
})

test_that("invalid integer64 and ISO query values are client errors", {
  x <- data.frame(
    date = as.Date(c("2020-01-01", NA)),
    time = as.POSIXct(c("2020-01-01", NA), tz = "UTC")
  )
  x$i <- int64_fixture(c("1", NA))
  holder <- paged_table(x)
  for (value in list(
    "-9223372036854775808",
    "9223372036854775808",
    "01",
    "-0",
    1,
    NA_character_
  )) {
    expect_query_code(
      query_indices(holder, filter = list(op = "eq", col = 2L, value = value)),
      "invalid_request"
    )
  }
  expect_query_code(
    query_indices(
      holder,
      filter = list(op = "between", col = 2L, lower = "1", upper = "0")
    ),
    "invalid_request"
  )
  for (value in c(
    "2020-02-31",
    "2020-13-01",
    "2020-01-01 trailing",
    "20-01-01"
  )) {
    expect_query_code(
      query_indices(holder, filter = list(op = "eq", col = 0L, value = value)),
      "invalid_request"
    )
  }
  for (value in c(
    "2020-01-01T24:00:00",
    "2020-01-01T00:60:00",
    "2020-01-01T00:00:60",
    "2020-01-01T00:00:00+25:00",
    "2020-01-01T00:00:00trailing"
  )) {
    expect_query_code(
      query_indices(holder, filter = list(op = "eq", col = 1L, value = value)),
      "invalid_request"
    )
  }
})

test_that("bad full methods expose channel details and can recover", {
  broken <- TRUE
  with_column_method(
    "xtfrm",
    "query_bad",
    function(x) {
      if (broken && length(x) > 2L) {
        return(1L)
      }
      as.numeric(x)
    },
    with_column_method(
      "format",
      "query_bad",
      function(x, ...) {
        if (length(x) == 1L) {
          stop("display failed")
        }
        as.character(as.numeric(x))
      },
      {
        x <- data.frame(ok = 1:5)
        x$bad <- structure(as.double(5:1), class = "query_bad")
        holder <- paged_table(x, limits = list(probe_rows = 2L))
        sort <- list(list(col = 1L, desc = FALSE))
        error <- expect_query_code(
          query_indices(holder, sort),
          "schema_changed"
        )
        expect_false(error$details$schema$sortable)
        expect_named(error$details$errors, "sortKey")
        expect_length(holder$index_cache, 0L)
        expect_length(holder$channel_cache, 0L)
        expect_identical(
          query_indices(holder, list(list(col = 0L, desc = FALSE))),
          1:5
        )
        broken <- FALSE
        expect_identical(query_indices(holder, sort), 5:1)
        page <- query_page(holder, limit = 1L)
        expect_named(page$data$columns[[2L]]$errors, "display")
        expect_identical(page$data$columns[[2L]]$data$display, "<query_bad>")
      }
    )
  )
  with_column_method(
    "format",
    "query_throw",
    function(x, ...) {
      if (length(x) > 2L) {
        stop("full format failed")
      }
      rep("ok", length(x))
    },
    {
      x <- data.frame(id = 1:5)
      x$bad <- structure(as.double(1:5), class = "query_throw")
      holder <- paged_table(x, limits = list(probe_rows = 2L))
      expect_query_code(
        query_indices(
          holder,
          filter = list(op = "contains", col = 1L, value = "ok")
        ),
        "r_error"
      )
      expect_identical(
        query_indices(holder, filter = list(op = "eq", col = 0L, value = 3)),
        3L
      )
    }
  )
})

test_that("cache limits, clear, disposal, pages, and row names are explicit", {
  x <- data.frame(a = 1:4, b = 4:1, row.names = letters[1:4])
  holder <- paged_table(
    x,
    limits = list(
      column_cache = 1L,
      channel_cache = 1L,
      index_cache = 2L,
      page_rows = 2L
    )
  )
  for (j in c(0L, 1L, 0L)) {
    query_indices(holder, list(list(col = j, desc = FALSE)))
  }
  expect_lte(length(holder$column_cache), 1L)
  expect_lte(length(holder$channel_cache), 1L)
  expect_lte(length(holder$index_cache), 2L)
  page <- query_page(holder, offset = 1L, limit = 999L)
  expect_identical(page$data$row_index, 2:3)
  expect_identical(page$data$row_names, c("b", "c"))
  expect_identical(page$limit, 2L)
  expect_identical(query_page(holder, offset = 99L)$data$row_index, integer())
  expect_identical(query_page(holder, limit = 0L)$data$row_index, integer())
  expect_length(query_page(holder, cols = integer())$data$columns, 0L)
  query_clear(holder)
  expect_length(holder$column_cache, 0L)
  expect_length(holder$channel_cache, 0L)
  expect_length(holder$index_cache, 0L)
  query_dispose(holder)
  expect_null(holder$source)
  expect_null(holder$schema)
  expect_length(holder$column_cache, 0L)
  expect_query_code(query_page(holder), "view_not_found")
  expect_query_code(query_clear(holder), "view_not_found")
  expect_query_code(query_dispose(holder), "view_not_found")
  expect_null(query_page(paged_table(data.frame(a = 1:3)))$data$row_names)
  expect_identical(
    query_page(
      paged_table(matrix(1:6, 3L, dimnames = list(letters[1:3], NULL))),
      limit = 2L
    )$data$row_names,
    c("a", "b")
  )
  expect_identical(
    query_page(paged_table(matrix(integer(), 0L, 2L)))$data$row_index,
    integer()
  )
})

test_that("integer64 subclass display is independent of exact query values", {
  x <- int64_fixture(c("9007199254740993", "1", NA))
  class(x) <- c("query_int64", "integer64")
  with_column_method(
    "format",
    "query_int64",
    function(x, ...) paste0("custom:", col_values.integer64(x)),
    {
      holder <- paged_table(structure(
        list(x = x),
        class = "data.frame",
        row.names = 1:3
      ))
      page <- query_page(holder, limit = 2L)
      expect_identical(
        page$data$columns[[1L]]$data$display,
        c("custom:9007199254740993", "custom:1")
      )
      expect_identical(
        page$data$columns[[1L]]$data$values,
        c("9007199254740993", "1")
      )
      expect_identical(
        query_indices(holder, list(list(col = 0L, desc = FALSE))),
        c(2L, 1L, 3L)
      )
      expect_identical(
        query_indices(
          holder,
          filter = list(op = "eq", col = 0L, value = "9007199254740993")
        ),
        1L
      )
    }
  )
  class(x) <- c("query_no_format", "integer64")
  expect_identical(col_display(x), c("9007199254740993", "1", "NA"))
})

test_that("query engine itself preserves RNG, options, and source objects", {
  before_options <- options()
  seed_exists <- exists(".Random.seed", .GlobalEnv, inherits = FALSE)
  seed <- if (seed_exists) get(".Random.seed", .GlobalEnv) else NULL
  with_query_methods({
    x <- data.frame(a = c(3, NA, 1), b = c("B", "a", "b"))
    original <- serialize(x, NULL)
    holder <- paged_table(x)
    query_indices(
      holder,
      list(list(col = 0L, desc = FALSE)),
      list(op = "contains", col = 1L, value = "b")
    )
    query_page(holder, limit = 2L)
    snapshot_indices(
      query_wire_snapshot(snapshot_table(x)),
      list(list(col = 1L, desc = TRUE))
    )
    query_clear(holder)
    query_dispose(holder)
    expect_identical(serialize(x, NULL), original)
  })
  expect_identical(options(), before_options)
  expect_identical(
    exists(".Random.seed", .GlobalEnv, inherits = FALSE),
    seed_exists
  )
  if (seed_exists) expect_identical(get(".Random.seed", .GlobalEnv), seed)
})

test_that("S4 and vctrs subsetting preserves row size and query semantics", {
  name <- "jdv_query_s4_numeric"
  methods::setClass(name, contains = "numeric", where = .GlobalEnv)
  methods::setMethod(
    "[",
    name,
    function(x, i, j, ..., drop = TRUE) {
      methods::new("jdv_query_s4_numeric", as.numeric(x)[i])
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
    function(x) -as.numeric(x),
    where = .GlobalEnv
  )
  on.exit({
    for (generic in c("[", "format", "xtfrm")) {
      methods::removeMethod(generic, name, where = .GlobalEnv)
    }
    methods::removeClass(name, where = .GlobalEnv)
  })
  x <- data.frame(id = 1:4)
  x$value <- methods::new(name, c(2, 1, NA_real_, 1))
  holder <- paged_table(x, limits = list(probe_rows = 2L))
  snapshot <- snapshot_table(x)
  expect_true(isS4(query_slice(x$value, c(2L, 4L))))
  expect_identical(
    query_page(holder, offset = 1L, limit = 2L)$data$columns[[2L]]$data$display,
    c("s4:1", "s4:NA")
  )
  sort <- list(list(col = 1L, desc = FALSE))
  expect_identical(query_indices(holder, sort), c(1L, 2L, 4L, 3L))
  expect_identical(snapshot_indices(snapshot, sort), c(1L, 2L, 4L, 3L))
  filter <- list(op = "text_equals", col = 1L, value = "s4:1")
  expect_identical(query_indices(holder, filter = filter), c(2L, 4L))
  expect_identical(snapshot_indices(snapshot, filter = filter), c(2L, 4L))
  skip_if_not_installed("vctrs")
  x$value <- vctrs::new_rcrd(
    list(a = c(2, 1, NA_real_, 1)),
    class = "query_vctrs_record"
  )
  with_column_method(
    "format",
    "query_vctrs_record",
    function(x, ...) paste0("record:", vctrs::field(x, "a")),
    with_column_method(
      "xtfrm",
      "query_vctrs_record",
      function(x) vctrs::field(x, "a"),
      {
        holder <- paged_table(x, limits = list(probe_rows = 2L))
        snapshot <- snapshot_table(x)
        expect_s3_class(query_slice(x$value, c(2L, 4L)), "query_vctrs_record")
        expect_length(query_slice(x$value, c(2L, 4L)), 2L)
        expect_identical(query_indices(holder, sort), c(2L, 4L, 1L, 3L))
        expect_identical(snapshot_indices(snapshot, sort), c(2L, 4L, 1L, 3L))
        filter <- list(op = "text_equals", col = 1L, value = "record:1")
        expect_identical(query_indices(holder, filter = filter), c(2L, 4L))
        expect_identical(snapshot_indices(snapshot, filter = filter), c(2L, 4L))
      }
    )
  )
})

test_that("POSIXct and POSIXlt pages keep timezone and fractional seconds", {
  for (class in c("POSIXct", "POSIXlt")) {
    values <- as.POSIXct(
      c("2020-01-01T00:00:00.5", NA, "2020-01-01T00:00:00"),
      format = "%Y-%m-%dT%H:%M:%OS",
      tz = "Australia/Sydney"
    )
    if (class == "POSIXlt") {
      values <- as.POSIXlt(values)
    }
    x <- data.frame(id = 1:3)
    x$time <- values
    holder <- paged_table(x, limits = list(probe_rows = 1L))
    subset <- query_slice(values, c(1L, 3L))
    expect_identical(class(subset), class(values))
    expect_identical(attr(subset, "tzone"), attr(values, "tzone"))
    expect_identical(
      query_indices(holder, list(list(col = 1L, desc = FALSE))),
      c(3L, 1L, 2L)
    )
    expect_identical(
      query_page(holder, limit = 1L)$data$columns[[2L]]$data$values,
      "2020-01-01T00:00:00.5+11:00"
    )
  }
})

test_that("subset shape changes and missingness channel failures are typed", {
  x <- data.frame(id = 1:5)
  x$bad <- structure(as.double(1:5), class = "query_subset_bad")
  with_column_method(
    "[",
    "query_subset_bad",
    function(x, i, ...) {
      structure(
        unclass(x)[i],
        class = if (length(i) == 1L) "wrong" else class(x)
      )
    },
    {
      holder <- paged_table(x, limits = list(probe_rows = 2L))
      expect_query_code(query_page(holder, limit = 1L), "schema_changed")
    }
  )
  with_column_method(
    "is.na",
    "query_subset_bad",
    function(x) {
      if (length(x) > 2L) {
        matrix(rep(FALSE, length(x)), ncol = 1L)
      } else {
        rep(FALSE, length(x))
      }
    },
    {
      holder <- paged_table(x, limits = list(probe_rows = 2L))
      expect_query_code(
        query_indices(holder, filter = list(op = "is_na", col = 1L)),
        "schema_changed"
      )
      expect_identical(
        query_indices(holder, filter = list(op = "eq", col = 0L, value = 1L)),
        1L
      )
    }
  )
})

test_that("explicit integer row names are converted only after page slicing", {
  x <- structure(list(x = 1:2), class = "data.frame", row.names = c(42L, 84L))
  holder <- paged_table(x)
  expect_identical(
    query_page(holder, offset = 1L, limit = 1L)$data$row_names,
    "84"
  )
  expect_identical(snapshot_table(x)$schema, holder$schema)
})

test_that(
  "all ordered numeric predicates preserve infinity and missing rules",
  {
    x <- data.frame(n = c(-Inf, 1, 1, Inf, NaN, NA_real_))
    holder <- paged_table(x)
    snapshot <- query_wire_snapshot(snapshot_table(x))
    expected <- list(lt = 1L, le = 1:3, gt = 4L, ge = 2:4)
    for (op in names(expected)) {
      filter <- list(op = op, col = 0L, value = 1)
      expect_identical(query_indices(holder, filter = filter), expected[[op]])
      expect_identical(
        snapshot_indices(snapshot, filter = filter),
        expected[[op]]
      )
    }
    expect_query_code(
      query_indices(
        holder,
        filter = list(op = "between", col = 0L, lower = 2, upper = 1)
      ),
      "invalid_request"
    )
    expect_query_code(query_page(holder, cols = 1 + 1i), "invalid_request")
  }
)

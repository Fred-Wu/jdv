rpc_json <- function(value) jsonlite::fromJSON(value, simplifyVector = FALSE)

rpc_request <- function(method, params = list(), id = 1, extra = list()) {
  jsonlite::toJSON(
    c(list(id = id, method = method, params = params), extra),
    auto_unbox = TRUE,
    null = "null",
    digits = 17
  )
}

rpc_call <- function(method, params = list(), id = 1, extra = list()) {
  rpc_json(jdv_rpc(rpc_request(method, params, id, extra)))
}

expect_rpc_code <- function(response, expected) {
  expect_identical(response$error$code, expected)
  invisible(response)
}

test_that("internal grid source dispatch preserves matrix recognition", {
  source <- getFromNamespace("jdv_source", "jdv")
  frame <- structure(
    list(value = 1:2),
    class = c("custom_frame", "data.frame"),
    row.names = c(NA_integer_, -2L)
  )
  matrix <- structure(matrix(1:4, nrow = 2L), class = "custom_matrix")

  expect_identical(source(frame)$kind, "grid")
  expect_identical(source(frame)$data, frame)
  expect_true(is.matrix(matrix))
  expect_false(inherits(matrix, "matrix"))
  expect_identical(source(matrix)$kind, "grid")
  expect_identical(source(matrix)$data, matrix)
  expect_identical(source(list(value = 1:2))$kind, "tree")

  registered <- jdv_register(matrix, mode = "snapshot")
  on.exit(.jdv_close_internal(registered$id), add = TRUE)
  expect_identical(rpc_json(registered$open)$params$nrow, 2L)
})

test_that("the JSON bridge preserves arrays, objects, and strict syntax", {
  parse <- getFromNamespace(".jdv_json_parse", "jdv")
  parsed <- parse('{"a":[],"b":{},"c":[[],{}]}')
  expect_s3_class(parsed$a, "jdv_json_array")
  expect_s3_class(parsed$b, "jdv_json_object")
  expect_s3_class(parsed$c[[1]], "jdv_json_array")
  expect_s3_class(parsed$c[[2]], "jdv_json_object")
  expect_identical(parse('{"text":"\\\\u0000"}')$text, "\\u0000")

  for (input in c(
    '{"a":1,"a":2}',
    '{"a":1} {}',
    '{"a":"\\u0000"}',
    '{"a":"raw\nnewline"}',
    '{"a":01}',
    '{"a":1e999}'
  )) {
    expect_error(parse(input), class = "jdv_query_error")
  }
  expect_rpc_code(
    rpc_json(jdv_rpc('{"id":9007199254740991,"method":"unknown"}')),
    "method_not_found"
  )
  expect_rpc_code(
    rpc_json(jdv_rpc('{"id":9007199254740990.5,"method":"unknown"}')),
    "invalid_request"
  )
  expect_rpc_code(
    rpc_json(jdv_rpc('{"i\\u0064":9007199254740992,"method":"unknown"}')),
    "invalid_request"
  )
})

test_that("registration returns snapshots and reuses titled generations", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  x <- data.frame(id = c(1, NA), text = c("one", "two"))
  first <- jdv_register(x, title = "table", mode = "snapshot")
  open <- rpc_json(first$open)
  expect_identical(open$method, "view/open")
  expect_match(first$id, "^v-[0-9]+$")
  expect_identical(
    names(open$params),
    c(
      "view",
      "kind",
      "access",
      "encoding",
      "capabilities",
      "generation",
      "title",
      "mode",
      "collation",
      "nrow",
      "ncol",
      "row_names",
      "columns",
      "data"
    )
  )
  expect_null(open$params$table)
  expect_identical(open$params$kind, "grid")
  expect_identical(open$params$access, "snapshot")
  expect_identical(open$params$encoding, "r-json")
  expect_identical(
    open$params$capabilities,
    setNames(
      as.list(c(rep(TRUE, 4L), FALSE, FALSE)),
      c("seek", "sort", "filter", "known_total", "next", "children")
    )
  )
  expect_null(open$params$total_rows)
  expect_identical(open$params$mode, "snapshot")
  expect_length(open$params$data$columns, 2)
  expect_identical(open$params$data$row_index, list(1L, 2L))
  expect_named(first, c("id", "open", "notifications"))
  expect_length(first$notifications, 0)

  second <- jdv_register(x, title = "table", mode = "paged")
  second_open <- rpc_json(second$open)
  expect_identical(second$id, first$id)
  expect_identical(second_open$params$generation, 2L)
  expect_identical(second_open$params$mode, "paged")
  expect_identical(second_open$params$access, "random")
  expect_named(
    second_open$params$capabilities,
    c("seek", "sort", "filter", "known_total", "next", "children")
  )
  expect_rpc_code(
    rpc_call("view/schema", list(view = first$id, generation = 1)),
    "stale_generation"
  )
  expect_type(
    rpc_call(
      "view/schema",
      list(view = first$id, generation = 2)
    )$result$columns,
    "list"
  )
  expect_null(rpc_call(
    "view/close",
    list(view = first$id, generation = 2)
  )$error)
  after_close <- jdv_register(x, title = "table", mode = "paged")
  expect_false(identical(after_close$id, first$id))
  expect_identical(rpc_json(after_close$open)$params$generation, 1L)
})

test_that("legacy table RPC names are not aliases for view requests", {
  old_field <- rpc_json(jdv_rpc(paste0(
    '{"id":1,"method":"table/rows","params":',
    '{"table":"v-1","generation":1}}'
  )))
  old_method <- rpc_json(jdv_rpc(paste0(
    '{"id":2,"method":"table/schema","params":',
    '{"view":"v-1","generation":1}}'
  )))

  expect_rpc_code(old_field, "invalid_request")
  expect_rpc_code(old_method, "method_not_found")
})

test_that("view/schema preserves schema arrays for factors", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  x <- data.frame(
    one_level = factor(c("only", "only"), levels = "only"),
    no_levels = factor(c(NA, NA), levels = character())
  )
  registered <- jdv_register(x, mode = "paged")
  open_columns <- rpc_json(registered$open)$params$columns
  schema_columns <- rpc_call(
    "view/schema",
    list(view = registered$id, generation = 1)
  )$result$columns

  expect_identical(schema_columns, open_columns)
  expect_identical(open_columns[[1]]$class, list("factor"))
  expect_identical(open_columns[[1]]$levels, list("only"))
  expect_identical(open_columns[[2]]$class, list("factor"))
  expect_identical(open_columns[[2]]$levels, list())
})

test_that("Snapshot keeps custom integer64 missing labels in display", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  with_column_method(
    "format",
    "rpc_custom64",
    function(x, ...) {
      values <- col_values.integer64(x)
      values[is.na(values)] <- "<missing>"
      values
    },
    {
      custom <- structure(
        int64_fixture(c("1", NA)),
        class = c("rpc_custom64", "integer64")
      )
      registered <- jdv_register(data.frame(value = custom), mode = "snapshot")
      wire <- rpc_json(registered$open)$params$data$columns[[1]]
      expect_identical(wire$display, list("1", "<missing>"))

      standard <- jdv_register(
        data.frame(value = int64_fixture(c("1", NA))),
        mode = "snapshot"
      )
      standard_wire <- rpc_json(standard$open)$params$data$columns[[1]]
      expect_null(standard_wire$display)
    }
  )
})

test_that("RPC pages preserve schema, channel errors, and source row indices", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  x <- data.frame(id = 1:4)
  x$custom <- structure(as.double(c(4, 3, 2, 1)), class = "rpc_format_error")
  with_column_method(
    "format",
    "rpc_format_error",
    function(x, ...) {
      if (length(x) > 2) {
        stop("format failed")
      }
      paste0("v", x)
    },
    {
      registered <- jdv_register(x, mode = "paged")
      reply <- rpc_call(
        "table/rows",
        list(
          view = registered$id,
          generation = 1,
          offset = 1,
          limit = 2,
          sort = list(list(col = 0, desc = TRUE)),
          cols = list(0, 1)
        )
      )
      expect_null(reply$error)
      expect_identical(reply$result$data$row_index, list(3L, 2L))
      expect_identical(reply$result$data$columns[[2]]$schema$name, "custom")
      expect_true(is.list(reply$result$data$columns[[2]]$errors))
      expect_identical(
        reply$result$data$columns[[2]]$data$display,
        list("v2", "v3")
      )
    }
  )
})

test_that("RPC retains typed query error details", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  x <- data.frame(value = structure(as.double(1:3), class = "rpc_sort_error"))
  fail <- FALSE
  with_column_method(
    "xtfrm",
    "rpc_sort_error",
    function(x) {
      if (fail) {
        stop("sort key failed")
      }
      as.numeric(x)
    },
    {
      registered <- jdv_register(x, mode = "paged")
      fail <- TRUE
      response <- rpc_call(
        "table/rows",
        list(
          view = registered$id,
          generation = 1,
          sort = list(list(col = 0, desc = FALSE))
        )
      )
      expect_rpc_code(response, "r_error")
      expect_identical(response$error$message, "Could not compute sortKey.")
      expect_identical(response$error$details$errors$sortKey, "sort key failed")
    }
  )
})

test_that(
  "RPC errors are typed and request extensions stay forward-compatible",
  {
    .jdv_close_internal()
    on.exit(.jdv_close_internal(), add = TRUE)
    registered <- jdv_register(data.frame(x = 1:2), mode = "paged")
    params <- list(
      view = registered$id,
      generation = 1,
      future = list(any = TRUE)
    )
    ok <- rpc_call(
      "view/schema",
      params,
      extra = list(future_envelope_field = list())
    )
    expect_null(ok$error)
    expect_rpc_code(rpc_call("no/such/method"), "method_not_found")
    expect_rpc_code(
      rpc_call("view/schema", list(view = "missing", generation = 1)),
      "view_not_found"
    )
    expect_rpc_code(
      rpc_call("view/schema", list(view = registered$id, generation = 9)),
      "stale_generation"
    )
    expect_rpc_code(
      rpc_call(
        "table/rows",
        list(
          view = registered$id,
          generation = 1,
          sort = list(list(col = 99, desc = FALSE))
        )
      ),
      "invalid_request"
    )
    expect_null(jdv_rpc('{"method":"wake"}'))
    expect_null(jdv_rpc('{"method":"cancel","params":{"id":"pending"}}'))
    expect_rpc_code(
      rpc_call("view/schema", params, extra = list(deadline = 1)),
      "expired"
    )
    expect_rpc_code(
      rpc_call(
        "view/schema",
        params,
        extra = list(deadline = list(special = "pos_inf"))
      ),
      "invalid_request"
    )
  }
)

test_that("the minimum response budget covers every accepted string id", {
  old <- getOption("jdv.max_message_bytes")
  options(jdv.max_message_bytes = 1024)
  on.exit(options(jdv.max_message_bytes = old), add = TRUE)
  id <- strrep("\b", 128)
  request <- jsonlite::toJSON(
    list(id = id, method = "unknown"),
    auto_unbox = TRUE
  )
  response <- jdv_rpc(as.character(request))
  expect_lte(nchar(response, type = "bytes"), 1024)
  expect_identical(rpc_json(response)$id, id)
  expect_identical(rpc_json(response)$error$code, "method_not_found")
})

test_that(
  "registry replacement is reentrant-safe and close notifications are exposed",
  {
    .jdv_close_internal()
    on.exit(.jdv_close_internal(), add = TRUE)
    old <- jdv_register(data.frame(x = 1:3), title = "same", mode = "paged")
    entry <- get(old$id, envir = .jdv_state$entries)
    entry$inflight <- 1L
    replacement <- jdv_register(
      data.frame(x = 10:12),
      title = "same",
      mode = "paged"
    )
    expect_identical(replacement$id, old$id)
    expect_true(entry$close_pending)
    expect_true(entry$closed)
    expect_false(is.null(entry$holder))
    entry$inflight <- 0L
    .jdv_close_entry(entry)
    expect_true(entry$closed)

    .jdv_close_internal()
    jdv_register(data.frame(x = 1), mode = "paged")
    jdv_register(data.frame(x = 2), mode = "paged")
    jdv_register(data.frame(x = 3), mode = "paged")
    options(jdv.max_tables = 1)
    on.exit(options(jdv.max_tables = NULL), add = TRUE)
    next_table <- jdv_register(data.frame(x = 4), mode = "paged")
    expect_length(next_table$notifications, 3)
    expect_true(all(vapply(
      next_table$notifications,
      function(message) identical(rpc_json(message)$method, "view/closed"),
      logical(1L)
    )))
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 1)
  }
)

test_that(
  "pinned requests survive replacement and close skips source methods",
  {
    .jdv_close_internal()
    on.exit(.jdv_close_internal(), add = TRUE)
    trigger <- FALSE
    fail <- FALSE
    calls <- 0L
    x <- structure(
      data.frame(value = 1:3),
      class = c("rpc_reenter", "data.frame")
    )
    with_column_method(
      "[[",
      "rpc_reenter",
      function(x, i, ..., exact = TRUE) {
        calls <<- calls + 1L
        if (fail) {
          stop("source access should not run while closing")
        }
        if (trigger) {
          trigger <<- FALSE
          jdv_register(x, title = "reentrant", mode = "paged")
        }
        NextMethod("[[")
      },
      {
        registered <- jdv_register(x, title = "reentrant", mode = "paged")
        trigger <- TRUE
        schema <- rpc_call(
          "view/schema",
          list(view = registered$id, generation = 1)
        )
        expect_null(schema$error)
        current <- get(registered$id, envir = .jdv_state$entries)
        expect_equal(current$generation, 2)
        fail <- TRUE
        calls_before_close <- calls
        closed <- rpc_call(
          "view/close",
          list(view = registered$id, generation = 2)
        )
        expect_null(closed$error)
        expect_identical(calls, calls_before_close)
      }
    )
  }
)

test_that(
  "registration honors the collation option and re-registration refreshes values",
  {
    .jdv_close_internal()
    on.exit(.jdv_close_internal(), add = TRUE)
    old <- getOption("jdv.collation")
    options(jdv.collation = "locale")
    on.exit(options(jdv.collation = old), add = TRUE)
    x <- data.frame(text = c("z", "a"))
    first <- jdv_register(x, title = "refresh", mode = "paged")
    expect_identical(rpc_json(first$open)$params$collation, "locale")
    x$text <- c("changed", "values")
    page <- rpc_call(
      "table/rows",
      list(view = first$id, generation = 1, limit = 2)
    )
    expect_identical(page$result$data$columns[[1]]$data$values, list("z", "a"))
    refreshed <- jdv_register(
      x,
      title = "refresh",
      mode = "paged",
      collation = "C"
    )
    expect_identical(rpc_json(refreshed$open)$params$generation, 2L)
    expect_identical(rpc_json(refreshed$open)$params$collation, "C")
  }
)

test_that("the page row cap is captured when a paged table is registered", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  old <- getOption("jdv.max_page_rows")
  on.exit(options(jdv.max_page_rows = old), add = TRUE)
  options(jdv.max_page_rows = 2)
  x <- data.frame(value = 1:5)
  first <- jdv_register(x, title = "row-cap", mode = "paged")
  first_page <- rpc_call(
    "table/rows",
    list(view = first$id, generation = 1, limit = 5)
  )
  expect_identical(first_page$result$limit, 2L)

  options(jdv.max_page_rows = 4)
  still_capped <- rpc_call(
    "table/rows",
    list(view = first$id, generation = 1, limit = 5)
  )
  expect_identical(still_capped$result$limit, 2L)
  refreshed <- jdv_register(x, title = "row-cap", mode = "paged")
  refreshed_page <- rpc_call(
    "table/rows",
    list(view = refreshed$id, generation = 2, limit = 5)
  )
  expect_identical(refreshed_page$result$limit, 4L)
})

test_that("auto registration budgets compact zero-column row indices", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  x <- structure(
    list(),
    class = "data.frame",
    row.names = c(NA_integer_, -800000000L)
  )
  registered <- jdv_register(x, mode = "auto")
  open <- rpc_json(registered$open)
  expect_identical(open$params$mode, "paged")
  expect_identical(open$params$nrow, 800000000L)
  expect_identical(open$params$ncol, 0L)
  expect_true(is.environment(get(
    registered$id,
    envir = .jdv_state$entries
  )$holder))
  expect_error(jdv_register(x, mode = "snapshot"), class = "jdv_query_error")
})

test_that("row pages shrink to fit the configured message bound", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  old <- getOption("jdv.max_message_bytes")
  options(jdv.max_message_bytes = 2048)
  on.exit(options(jdv.max_message_bytes = old), add = TRUE)
  calls <- 0L
  x <- data.frame(value = structure(as.double(1:30), class = "rpc_shrink"))
  with_column_method(
    "format",
    "rpc_shrink",
    function(x, ...) {
      calls <<- calls + 1L
      rep(strrep("x", 100), length(x))
    },
    {
      registered <- jdv_register(x, mode = "paged")
      response <- jdv_rpc(rpc_request(
        "table/rows",
        list(view = registered$id, generation = 1, limit = 30)
      ))
      expect_lte(nchar(response, type = "bytes"), 2048)
      result <- rpc_json(response)$result
      expect_gt(result$limit, 0)
      expect_lt(result$limit, 30)
      expect_length(result$data$row_index, result$limit)
      expect_length(result$data$columns[[1]]$data$display, result$limit)
      expect_identical(calls, 2L)
    }
  )
})

test_that("public calls leave last value and process options intact", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  previous <- .Last.value
  options_before <- options()
  set.seed(234)
  rng_before <- .Random.seed
  registered <- jdv_register(data.frame(x = 1:3), mode = "paged")
  rpc_call("table/rows", list(view = registered$id, generation = 1))
  expect_identical(.Last.value, previous)
  expect_identical(options(), options_before)
  expect_identical(.Random.seed, rng_before)
})

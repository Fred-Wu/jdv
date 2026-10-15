jdv_budget_test_options <- function(values) {
  old <- setNames(lapply(names(values), getOption), names(values))
  options(values)
  function() options(old)
}

jdv_budget_test_rpc <- function(method, params, id = 1) {
  skip_if_not_installed("jsonlite")
  request <- jsonlite::toJSON(
    list(id = id, method = method, params = params),
    auto_unbox = TRUE,
    null = "null",
    digits = 17
  )
  jsonlite::fromJSON(jdv_rpc(request), simplifyVector = FALSE)
}

with_jdv_budget_method <- function(generic, class, method, code) {
  table <- get(".__S3MethodsTable__.", envir = asNamespace("jdv"))
  name <- paste(generic, class, sep = ".")
  had <- exists(name, envir = table, inherits = FALSE)
  previous <- if (had) get(name, envir = table)
  registerS3method(generic, class, method, envir = asNamespace("jdv"))
  on.exit({
    if (had) {
      assign(name, previous, envir = table)
    } else {
      rm(list = name, envir = table)
    }
  })
  eval(substitute(code), envir = parent.frame())
}

test_that("wide packed data-frame missingness fails before slicing cells", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- jdv_budget_test_options(list(jdv.max_work_bytes = 7 * 1024^2))
  on.exit(restore(), add = TRUE)

  counter <- new.env(parent = emptyenv())
  counter$slices <- 0L
  subset_method <- function(x, i, ...) {
    counter$slices <- counter$slices + 1L
    out <- NextMethod("[")
    class(out) <- class(x)
    out
  }
  with_column_method("[", "jdv_budget_slice_probe", subset_method, {
    packed <- structure(
      setNames(
        rep(
          list(structure(seq_len(64L), class = "jdv_budget_slice_probe")),
          8000L
        ),
        paste0("v", seq_len(8000L))
      ),
      class = "data.frame",
      row.names = seq_len(64L)
    )
    source <- structure(
      list(packed = packed),
      class = "data.frame",
      row.names = seq_len(64L)
    )
    registered <- jdv_register(source, mode = "paged")
    expect_identical(registered$open != "", TRUE)
    entry <- .jdv_state$entries[[registered$id]]
    expect_identical(entry$holder$limits$work_bytes, as.integer(7 * 1024^2))

    counter$slices <- 0L
    options(jdv.max_work_bytes = 64 * 1024^2)
    prefix <- jdv_budget_test_rpc(
      "table/rows",
      list(view = registered$id, generation = 1, offset = 0, limit = 32)
    )
    expect_null(prefix$error)
    expect_gt(counter$slices, 0L)

    counter$slices <- 0L
    options(jdv.max_work_bytes = 1024)
    reply <- jdv_budget_test_rpc(
      "table/rows",
      list(view = registered$id, generation = 1, offset = 0, limit = 64)
    )
    expect_identical(reply$error$code, "limit_exceeded")
    expect_identical(counter$slices, 0L)
  })
})

test_that(
  "unlimited query defaults retain finite registration and page budgets",
  {
    restore <- jdv_budget_test_options(list(
      jdv.max_work_bytes = NULL,
      jdv.max_query_rows = NULL,
      jdv.max_message_bytes = NULL,
      jdv.snapshot_max_bytes = NULL
    ))
    on.exit(restore(), add = TRUE)

    expect_identical(.jdv_max_work_bytes(), Inf)
    expect_identical(.jdv_max_query_rows(), Inf)
    expect_identical(.jdv_page_work_bytes(), 64 * 1024^2)
    expect_identical(.jdv_snapshot_work_bytes(), 64 * 1024^2)

    holder <- paged_table(data.frame(value = as.double(1:100)))
    expect_identical(holder$limits$work_bytes, Inf)
    expect_identical(holder$limits$query_rows, Inf)
    expect_identical(holder$limits$page_work_bytes, 64 * 1024^2)
    expect_identical(
      query_indices(holder, list(list(col = 0L, desc = TRUE)))[1L],
      100L
    )
  }
)

test_that(
  "explicit finite query work and row limits still reject full queries",
  {
    row_limited <- paged_table(
      data.frame(value = as.double(1:100)),
      limits = list(query_rows = 10L)
    )
    work_limited <- paged_table(
      data.frame(value = as.double(1:100)),
      limits = list(work_bytes = 1024)
    )
    sort <- list(list(col = 0L, desc = TRUE))
    filter <- list(op = "ge", col = 0L, value = 50)
    expect_query_code(query_indices(row_limited, sort), "limit_exceeded")
    expect_query_code(query_indices(work_limited, sort), "limit_exceeded")
    expect_query_code(
      query_indices(work_limited, filter = filter),
      "limit_exceeded"
    )
  }
)

test_that(
  "finite query and page work share the configured operation allowance",
  {
    holder <- paged_table(
      data.frame(value = as.double(1:100)),
      limits = list(work_bytes = 8192)
    )
    reply <- tryCatch(
      query_page(
        holder,
        limit = 100L,
        sort = list(list(col = 0L, desc = TRUE))
      ),
      error = identity
    )
    expect_s3_class(reply, "jdv_query_error")
    expect_identical(reply$code, "limit_exceeded")
  }
)

test_that("public registration and RPC encode with unset work options", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- jdv_budget_test_options(list(
    jdv.max_work_bytes = NULL,
    jdv.max_query_rows = NULL
  ))
  on.exit(restore(), add = TRUE)

  paged <- jdv_register(data.frame(value = 1:100), mode = "paged")
  expect_true(nzchar(paged$open))
  paged_reply <- jdv_budget_test_rpc(
    "table/rows",
    list(view = paged$id, generation = 1, offset = 0, limit = 2)
  )
  expect_null(paged_reply$error)
  expect_identical(paged_reply$result$data$row_index, list(1L, 2L))

  .jdv_close_internal(paged$id)
  snapshot <- jdv_register(data.frame(value = 1:3), mode = "auto")
  expect_identical(
    jsonlite::fromJSON(snapshot$open, simplifyVector = FALSE)$params$mode,
    "snapshot"
  )
})

test_that("one-row wide double packed matrices return a shape summary", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- jdv_budget_test_options(list(jdv.max_work_bytes = 64 * 1024^2))
  on.exit(restore(), add = TRUE)

  packed <- matrix(as.double(seq_len(20000L)), nrow = 1L)
  source <- data.frame(packed = I(packed))
  registered <- jdv_register(source, mode = "paged")
  reply <- jdv_budget_test_rpc(
    "table/rows",
    list(view = registered$id, generation = 1, offset = 0, limit = 1)
  )

  expect_null(reply$error)
  column <- reply$result$data$columns[[1L]]$data
  expect_identical(column$display, list("<matrix [1 x 20000]>"))
  expect_identical(column$na, list(FALSE))
})

test_that("snapshot and page guards precede packed matrix and frame slicing", {
  skip_if_not_installed("jsonlite")
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- jdv_budget_test_options(list(jdv.max_work_bytes = 2 * 1024^2))
  on.exit(restore(), add = TRUE)

  counter <- new.env(parent = emptyenv())
  counter$slices <- 0L
  subset_method <- function(x, i, j, ..., drop = TRUE) {
    counter$slices <- counter$slices + 1L
    out <- NextMethod("[")
    class(out) <- class(x)
    out
  }
  with_column_method("[", "jdv_budget_nested_matrix", subset_method, {
    packed_matrix <- structure(
      matrix(1, nrow = 64L, ncol = 2500L),
      class = c("jdv_budget_nested_matrix", "matrix", "array")
    )
    nested_frame <- data.frame(packed = I(matrix(1, nrow = 64L, ncol = 1000L)))
    sources <- list(
      matrix = data.frame(packed = I(packed_matrix)),
      data_frame = data.frame(nested = I(nested_frame))
    )

    for (source in sources) {
      counter$slices <- 0L
      expect_error(
        jdv_register(source, mode = "snapshot"),
        class = "jdv_query_error"
      )
      expect_identical(counter$slices, 0L)

      registered <- jdv_register(source, mode = "auto")
      descriptor <- jsonlite::fromJSON(
        registered$open,
        simplifyVector = FALSE
      )$params
      expect_identical(descriptor$mode, "paged")

      counter$slices <- 0L
      reply <- jdv_budget_test_rpc(
        "table/rows",
        list(view = registered$id, generation = 1, offset = 0, limit = 64)
      )
      expect_identical(reply$error$code, "limit_exceeded")
      expect_identical(counter$slices, 0L)
    }
  })
})

test_that("packed matrix page displays match per-row cell previews", {
  matrix_value <- matrix(seq_len(128L), nrow = 32L, ncol = 4L)
  source <- data.frame(packed = I(matrix_value))
  holder <- paged_table(source, limits = list(work_bytes = 1024^2))
  on.exit(query_dispose(holder), add = TRUE)

  for (page in list(c(0L, 1L), c(5L, 7L), c(0L, 32L))) {
    offset <- page[[1L]]
    limit <- page[[2L]]
    rows <- offset + seq_len(limit)
    result <- query_page(holder, offset = offset, limit = limit)
    expected <- vapply(
      rows,
      function(i) cell_preview(matrix_value[i, , drop = FALSE]),
      character(1L)
    )
    expect_identical(result$data$columns[[1L]]$data$display, expected)
  }
})

test_that("oversized Date and factor formatter results remain limit errors", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- jdv_budget_test_options(list(jdv.max_work_bytes = 16384))
  on.exit(restore(), add = TRUE)

  cases <- list(
    list(
      class = "jdv_budget_date",
      value = structure(
        replace(
          as.Date("2000-01-01") + seq_len(50L),
          40L,
          as.Date("2099-01-01")
        ),
        class = c("jdv_budget_date", "Date")
      ),
      format = function(x, ...) {
        if (any(unclass(x) > 30000)) {
          return(rep(strrep("d", 100000L), length(x)))
        }
        format.Date(structure(unclass(x), class = "Date"), ...)
      }
    ),
    list(
      class = "jdv_budget_factor",
      value = structure(
        replace(
          factor(rep("ordinary", 50L), levels = c("ordinary", "explode")),
          40L,
          "explode"
        ),
        class = c("jdv_budget_factor", "factor")
      ),
      display = function(x, ...) {
        labels <- as.character(x)
        if (any(labels == "explode")) {
          return(rep(strrep("f", 100000L), length(x)))
        }
        labels
      }
    )
  )

  for (case in cases) {
    .jdv_close_internal()
    subset_method <- function(x, i, ...) {
      out <- NextMethod("[")
      class(out) <- class(x)
      out
    }
    run_case <- function() {
      with_column_method("[", case$class, subset_method, {
        registered <- jdv_register(
          data.frame(value = case$value),
          mode = "paged"
        )
        reply <- jdv_budget_test_rpc(
          "table/rows",
          list(view = registered$id, generation = 1, offset = 39, limit = 1)
        )
        expect_identical(reply$error$code, "limit_exceeded")
        if (identical(case$class, "jdv_budget_date")) {
          expect_error(
            column_extract(
              case$value,
              channels = "display",
              budget = .jdv_budget(1500)
            ),
            class = "jdv_query_error"
          )
        }
      })
    }
    if (is.null(case$display)) {
      with_column_method("format", case$class, case$format, run_case())
    } else {
      with_jdv_budget_method(
        "col_display",
        case$class,
        case$display,
        run_case()
      )
    }
  }
})

test_that("numeric special-value work is reserved before value conversion", {
  values <- c(NA_real_, NaN, Inf, -Inf, rep(1, 20L))
  conversions <- 0L
  local_mocked_bindings(
    col_values.default = function(x, ...) {
      conversions <<- conversions + 1L
      x
    }
  )

  budget <- .jdv_budget(8 * length(values))
  expect_error(
    column_extract(values, channels = "values", budget = budget),
    class = "jdv_query_error"
  )
  expect_identical(conversions, 0L)
  expect_identical(budget$used, 0)

  result <- column_extract(
    values,
    channels = "values",
    budget = .jdv_budget(1024^2)
  )
  expect_identical(
    result$data$special,
    c("na", "nan", "pos_inf", "neg_inf", rep(NA_character_, 20L))
  )
})

test_that("compound filter masks fail before full columns are materialized", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- jdv_budget_test_options(list(jdv.max_work_bytes = 256 * 1024))
  on.exit(restore(), add = TRUE)

  registered <- jdv_register(
    data.frame(value = seq_len(10000L)),
    mode = "paged"
  )
  entry <- .jdv_state$entries[[registered$id]]
  filter <- list(
    op = "and",
    args = lapply(
      seq_len(30L),
      function(i) list(op = "ge", col = 0L, value = i)
    )
  )
  reply <- jdv_budget_test_rpc(
    "table/rows",
    list(
      view = registered$id,
      generation = 1,
      offset = 0,
      limit = 1,
      filter = filter
    )
  )

  expect_identical(reply$error$code, "limit_exceeded")
  expect_length(entry$holder$column_cache, 0L)
})

test_that("numeric byte estimates drive aggregate cache LRU eviction", {
  holder <- paged_table(
    data.frame(value = 1:4),
    limits = list(cache_bytes = 1000L, channel_cache = 8L, index_cache = 8L)
  )
  on.exit(query_dispose(holder), add = TRUE)

  a <- as.double(seq_len(20L))
  b <- as.double(seq_len(30L))
  c <- as.double(seq_len(25L))
  query_cache_set(holder, "channel_cache", "a", a)
  query_cache_set(holder, "index_cache", "b", b)
  expect_identical(holder$cache_bytes, 786)
  expect_identical(
    unname(holder$cache_sizes[[.jdv_cache_token("channel_cache", "a")]]),
    353
  )
  expect_identical(
    unname(holder$cache_sizes[[.jdv_cache_token("index_cache", "b")]]),
    433
  )

  expect_identical(query_cache_get(holder, "channel_cache", "a"), a)
  query_cache_set(holder, "index_cache", "c", c)

  expect_false("b" %in% names(holder$index_cache))
  expect_true("a" %in% names(holder$channel_cache))
  expect_true("c" %in% names(holder$index_cache))
  expect_identical(holder$cache_bytes, 746)
  expect_identical(holder$cache_bytes, sum(unname(holder$cache_sizes)))
})

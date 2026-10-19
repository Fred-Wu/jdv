handle_rpc_result <- function(view, method, params = list()) {
  request <- list(
    id = 1L,
    method = method,
    params = c(
      list(view = view$id, generation = view$generation %||% 1L),
      params
    )
  )
  response <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
  if (!is.null(response$error)) {
    stop(response$error$message, call. = FALSE)
  }
  response$result
}

normalize_handle_descriptor <- function(value) {
  value$view <- NULL
  value$generation <- NULL
  value$title <- NULL
  value$reason <- NULL
  value$parent <- NULL
  if (!is.null(value$capabilities)) {
    value$capabilities$refresh <- NULL
    value$capabilities$track <- NULL
  }
  value
}

normalize_handle_result <- function(value) {
  if (!is.list(value)) {
    return(value)
  }
  if (inherits(value, "jdv_json_object")) {
    value$view <- NULL
    value$generation <- NULL
  }
  lapply(value, normalize_handle_result)
}

test_that("handle descriptors and row results match ordinary RPC results", {
  source <- data.frame(
    id = c(3L, 1L, NA_integer_, 2L),
    label = c("café", "東京", "naïve", "plain"),
    score = c(30, 10, 99, 20),
    row.names = c("third", "first", "missing", "second")
  )
  handle <- jdv_handle(source, mode = "paged", collation = "C")
  on.exit(jdv_handle_close(handle), add = TRUE)
  ordinary <- register_view(source, mode = "paged", collation = "C")
  on.exit(.jdv_close_internal(ordinary$id), add = TRUE)

  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  ordinary_descriptor <- .jdv_json_parse(ordinary$open)$params
  expect_identical(
    normalize_handle_descriptor(descriptor),
    normalize_handle_descriptor(ordinary_descriptor)
  )
  expect_equal(descriptor$generation, 1)
  expect_identical(descriptor$capabilities$refresh, FALSE)
  expect_identical(descriptor$capabilities$track, FALSE)

  params <- list(
    offset = 0L,
    limit = 4L,
    cols = 0:2,
    sort = list(list(col = 0L, desc = FALSE)),
    filter = list(op = "ge", col = 2L, value = 20)
  )
  actual <- .jdv_json_parse(jdv_handle_request(handle, "grid/rows", params))
  expected <- handle_rpc_result(ordinary, "grid/rows", params)
  expect_identical(
    normalize_handle_result(actual),
    normalize_handle_result(expected)
  )
  expect_match(actual$view, "^h-")
  expect_equal(actual$generation, 1)
  expect_equal(unlist(actual$data$source_row, use.names = FALSE), c(3, 0, 2))
  expect_identical(
    unlist(actual$data$columns[[2L]]$data$values, use.names = FALSE),
    c("plain", "café", "naïve")
  )

  empty <- .jdv_json_parse(jdv_handle_request(
    handle,
    "grid/rows",
    list(offset = 20L, limit = 2L)
  ))
  expect_length(empty$data$source_row, 0L)
  expect_length(empty$data$columns, 3L)
})

test_that("matrix snapshots and grid child descriptors match ordinary views", {
  matrix_source <- matrix(
    c(NA_real_, NaN, Inf, -Inf),
    nrow = 2L,
    dimnames = list(c("north", "south"), c("left", "right"))
  )
  snapshot <- jdv_handle(matrix_source, mode = "snapshot")
  on.exit(jdv_handle_close(snapshot), add = TRUE)
  ordinary_snapshot <- register_view(matrix_source, mode = "snapshot")
  on.exit(.jdv_close_internal(ordinary_snapshot$id), add = TRUE)
  expect_identical(
    normalize_handle_descriptor(.jdv_json_parse(jdv_handle_descriptor(
      snapshot
    ))),
    normalize_handle_descriptor(.jdv_json_parse(ordinary_snapshot$open)$params)
  )
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(offset = 0L, limit = 1L)),
    class = "jdv_error_unsupported"
  )

  source <- data.frame(
    payload = I(list(data.frame(value = c(NA_integer_, 2L))))
  )
  handle <- jdv_handle(source, mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)
  ordinary <- register_view(source, mode = "paged")
  on.exit(.jdv_close_internal(ordinary$id), add = TRUE)
  path <- list(list(kind = "cell", source_row = 0L, column = 0L))
  child <- jdv_handle_open(handle, path, mode = "paged")
  on.exit(jdv_handle_close(child), add = TRUE)
  opened <- handle_rpc_result(
    ordinary,
    "object/open",
    list(path = path, mode = "paged")
  )
  expect_identical(
    normalize_handle_descriptor(.jdv_json_parse(jdv_handle_descriptor(child))),
    normalize_handle_descriptor(opened)
  )
  page <- .jdv_json_parse(jdv_handle_request(
    child,
    "grid/rows",
    list(offset = 0L, limit = 2L)
  ))
  expect_equal(
    unlist(page$data$columns[[1L]]$data$na_rows, use.names = FALSE),
    0
  )
  expect_null(page$data$columns[[1L]]$data[["na"]])
})

test_that("tree child handles preserve scalar, missing, and empty values", {
  source <- list(numbers = c(NA_real_, NaN, Inf, -Inf), empty = integer())
  handle <- jdv_handle(source, collation = "C")
  on.exit(jdv_handle_close(handle), add = TRUE)
  ordinary <- register_view(source)
  on.exit(.jdv_close_internal(ordinary$id), add = TRUE)
  path <- list(list(type = "index", index = 1L))
  child <- jdv_handle_open(handle, path, collation = "C")
  on.exit(jdv_handle_close(child), add = TRUE)
  opened <- handle_rpc_result(ordinary, "object/open", list(path = path))
  expect_identical(
    normalize_handle_descriptor(.jdv_json_parse(jdv_handle_descriptor(child))),
    normalize_handle_descriptor(opened)
  )
  params <- list(path = list(), offset = 0L, limit = 10L)
  expect_identical(
    normalize_handle_result(.jdv_json_parse(jdv_handle_request(
      child,
      "object/children",
      params
    ))),
    normalize_handle_result(handle_rpc_result(
      list(id = opened$view, generation = opened$generation),
      "object/children",
      params
    ))
  )
})

test_that("sequential sources are rejected for roots and opened children", {
  skip_if_not_installed("arrow")
  sequential <- arrow::arrow_table(x = 1:3)
  expect_error(jdv_handle(sequential), class = "jdv_error_unsupported")

  tree <- jdv_handle(list(source = sequential))
  on.exit(jdv_handle_close(tree), add = TRUE)
  expect_error(
    jdv_handle_open(tree, list(list(type = "index", index = 1L))),
    class = "jdv_error_unsupported"
  )
})

test_that(
  "tree child pages match ordinary RPC and opened children are handles",
  {
    source <- list(
      nested = list(values = c(NA_integer_, 2L), text = c("é", "漢字")),
      empty = list()
    )
    handle <- jdv_handle(source)
    on.exit(jdv_handle_close(handle), add = TRUE)
    ordinary <- register_view(source)
    on.exit(.jdv_close_internal(ordinary$id), add = TRUE)

    params <- list(path = list(), offset = 0L, limit = 10L)
    actual <- .jdv_json_parse(jdv_handle_request(
      handle,
      "object/children",
      params
    ))
    expected <- handle_rpc_result(ordinary, "object/children", params)
    expect_identical(
      normalize_handle_result(actual),
      normalize_handle_result(expected)
    )
    expect_true(all(
      c("nested", "empty") %in% vapply(actual$children, `[[`, "", "label")
    ))

    path <- list(list(type = "index", index = 1L))
    child <- jdv_handle_open(handle, path)
    expect_s3_class(child, "jdv_handle")
    child_descriptor <- .jdv_json_parse(jdv_handle_descriptor(child))
    opened <- handle_rpc_result(ordinary, "object/open", list(path = path))
    expect_identical(
      normalize_handle_descriptor(child_descriptor),
      normalize_handle_descriptor(opened)
    )
    child_params <- list(path = list(), offset = 0L, limit = 10L)
    expect_identical(
      normalize_handle_result(.jdv_json_parse(jdv_handle_request(
        child,
        "object/children",
        child_params
      ))),
      normalize_handle_result(handle_rpc_result(
        list(id = opened$view, generation = opened$generation),
        "object/children",
        child_params
      ))
    )
    jdv_handle_close(child)
  }
)

test_that(
  "handle result encoding respects UTF-8 byte limits and empty arrays",
  {
    source <- data.frame(
      label = rep(paste0("界", strrep("x", 40L)), 100L),
      value = seq_len(100L)
    )
    handle <- jdv_handle(source, mode = "paged")
    on.exit(jdv_handle_close(handle), add = TRUE)

    full <- .jdv_json_parse(jdv_handle_request(
      handle,
      "grid/rows",
      list(offset = 0L, limit = 100L),
      max_bytes = 10000L
    ))
    bounded_json <- jdv_handle_request(
      handle,
      "grid/rows",
      list(offset = 0L, limit = 100L),
      max_bytes = 1500L
    )
    bounded <- .jdv_json_parse(bounded_json)
    expect_lt(bounded$limit, full$limit)
    expect_true(nchar(bounded_json, type = "bytes") <= 1500L)
    expect_equal(bounded$offset, 0)
    expect_identical(bounded$total, full$total)
    expect_identical(bounded$total_unfiltered, full$total_unfiltered)
    expect_length(bounded$data$source_row, bounded$limit)

    no_columns <- .jdv_json_parse(jdv_handle_request(
      handle,
      "grid/rows",
      list(offset = 0L, limit = 3L, cols = integer())
    ))
    expect_equal(
      unlist(no_columns$data$source_row, use.names = FALSE),
      as.double(0:2)
    )
    expect_length(no_columns$data$columns, 0L)
  }
)

test_that("tree byte limits paginate without losing or repeating children", {
  source <- as.list(seq_len(30L))
  names(source) <- paste0("漢", seq_len(30L))
  handle <- jdv_handle(source)
  on.exit(jdv_handle_close(handle), add = TRUE)

  labels <- character()
  expected_labels <- names(source)
  offset <- 0L
  repeat {
    encoded <- jdv_handle_request(
      handle,
      "object/children",
      list(path = list(), offset = offset, limit = 30L, attributes = FALSE),
      max_bytes = 1500L
    )
    expect_true(nchar(encoded, type = "bytes") <= 1500L)
    page <- .jdv_json_parse(encoded)
    expect_equal(page$total_children, length(expected_labels))
    current <- vapply(page$children, `[[`, "", "label")
    expect_gt(length(current), 0L)
    labels <- c(labels, current)
    offset <- offset + length(current)
    if (offset >= page$total_children) break
  }
  expect_identical(labels, expected_labels)
})

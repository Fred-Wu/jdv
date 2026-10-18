test_that("handle API returns descriptors and result JSON", {
  handle <- jdv_handle(mtcars, mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)

  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  expect_identical(descriptor$kind, "grid")
  expect_identical(descriptor$generation, 1)
  expect_false(descriptor$capabilities$refresh)
  expect_false(descriptor$capabilities$track)

  rows <- .jdv_json_parse(jdv_handle_request(
    handle,
    "grid/rows",
    list(offset = 0L, limit = 2L, cols = 0:2)
  ))
  expect_identical(rows$offset, 0)
  expect_identical(rows$limit, 2)
  expect_length(rows$data$source_row, 2L)
  expect_length(rows$data$columns, 3L)
  expect_error(jdv_handle_request(handle, "grid/rows"), NA)
})

test_that("handle arguments and methods use the agreed error codes", {
  expect_error(jdv_handle(NULL), class = "jdv_error_unsupported")
  expect_error(
    jdv_handle_descriptor(list()),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle(mtcars, mode = "unknown"),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle(mtcars, collation = "unknown"),
    class = "jdv_error_invalid_argument"
  )

  snapshot <- jdv_handle(mtcars, mode = "snapshot")
  on.exit(jdv_handle_close(snapshot), add = TRUE)
  expect_error(
    jdv_handle_request(snapshot, "grid/rows"),
    class = "jdv_error_unsupported"
  )
  for (method in c("object/open", "view/describe", "unknown/method")) {
    expect_error(
      jdv_handle_request(snapshot, method),
      class = "jdv_error_method_not_found"
    )
  }
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(view = "h-999")),
    class = "jdv_error_invalid_request"
  )
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(generation = 1L)),
    class = "jdv_error_invalid_request"
  )
  expect_error(
    jdv_handle_descriptor(snapshot, max_bytes = matrix(8)),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(), max_bytes = 0),
    class = "jdv_error_invalid_argument"
  )
})

test_that("byte limits fail cleanly when a single item cannot fit", {
  handle <- jdv_handle(data.frame(value = 1L), mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)
  expect_error(
    jdv_handle_request(
      handle,
      "grid/rows",
      list(offset = 0L, limit = 1L),
      max_bytes = 1
    ),
    class = "jdv_error_limit_exceeded"
  )
  expect_error(
    jdv_handle_descriptor(handle, max_bytes = 1),
    class = "jdv_error_limit_exceeded"
  )
})

test_that("omitted mode and collation use defaults without warnings", {
  expect_warning(handle <- jdv_handle(mtcars), NA)
  on.exit(jdv_handle_close(handle), add = TRUE)
  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  expect_null(descriptor$mode)

  root <- jdv_handle(list(value = data.frame(x = 1L)))
  on.exit(jdv_handle_close(root), add = TRUE)
  child <- jdv_handle_open(root, list(list(type = "index", index = 1L)))
  on.exit(jdv_handle_close(child), add = TRUE)
  expect_null(.jdv_json_parse(jdv_handle_descriptor(child))$mode)
})

test_that("single explicit row labels remain JSON arrays", {
  source <- data.frame(value = 1L, row.names = "named-row")
  handle <- jdv_handle(source, mode = "snapshot")
  on.exit(jdv_handle_close(handle), add = TRUE)
  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  expect_identical(descriptor$row_labels, list("named-row"))
})

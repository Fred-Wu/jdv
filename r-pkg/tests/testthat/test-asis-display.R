test_that("AsIs list columns use ordinary structural previews", {
  values <- list(NULL, list(a = 2L), "x", c(1, 22))
  ordinary <- data.frame(id = seq_along(values))
  ordinary$values <- values
  as_is <- data.frame(id = seq_along(values))
  as_is$values <- I(values)

  snapshot_ordinary <- snapshot_table(ordinary)
  snapshot_as_is <- snapshot_table(as_is)
  expect_identical(
    snapshot_as_is$columns[[2L]]$data$display,
    snapshot_ordinary$columns[[2L]]$data$display
  )
  expect_identical(snapshot_as_is$columns[[2L]]$data$display[[1L]], "NULL")

  page_ordinary <- query_page(paged_table(ordinary), limit = length(values))
  page_as_is <- query_page(paged_table(as_is), limit = length(values))
  expect_identical(
    page_as_is$data$columns[[2L]]$data$display,
    page_ordinary$data$columns[[2L]]$data$display
  )
  expect_identical(page_as_is$data$columns[[2L]]$data$display[[1L]], "NULL")
})

test_that("AsIs atomic and packed columns retain their display paths", {
  atomic <- c(1L, 2L)
  matrix_value <- matrix(1:4, nrow = 2L)
  frame_value <- data.frame(a = 1:2)

  expect_identical(
    column_extract(I(atomic))$data$display,
    column_extract(atomic)$data$display
  )
  expect_identical(
    column_extract(I(matrix_value))$data$display,
    column_extract(matrix_value)$data$display
  )
  expect_identical(
    column_extract(I(frame_value))$data$display,
    column_extract(frame_value)$data$display
  )
})

test_that("AsIs atomic columns are classified and computed by their contents", {
  cases <- list(
    list(I(c(3L, 1L, NA)), "integer", "integer"),
    list(I(c(1.5, NA, 2)), "number", "double"),
    list(I(c("b", "a", NA)), "string", "character"),
    list(I(c(TRUE, NA, FALSE)), "boolean", "logical")
  )
  for (case in cases) {
    x <- case[[1L]]
    schema <- column_schema(x)
    expect_identical(schema$type, case[[2L]])
    expect_true(schema$filterable)
    expect_identical(schema$class, "AsIs")
    out <- column_extract(x, c("display", "na", "values", "sortKey"))
    expect_identical(typeof(out$data$values), case[[3L]])
    expect_identical(out$data$na, is.na(unclass(x)))
    expect_identical(
      out$data$display,
      column_extract(unclass(x), "display")$data$display
    )
    expect_length(out$errors, 0L)
  }
  text <- column_extract(I(c("b", "a", NA)), "text")
  expect_identical(text$data$text, c("b", "a", NA))
})

test_that("AsIs does not unwrap classed or structural contents", {
  # Classed contents keep the classification of their own class.
  expect_identical(column_schema(I(factor("a")))$type, "factor")
  expect_identical(column_schema(I(Sys.Date()))$type, "date")
  expect_identical(
    column_schema(I(as.difftime(1, units = "secs")))$type,
    "other"
  )
  expect_false(column_schema(I(as.difftime(1, units = "secs")))$filterable)
  expect_identical(column_schema(I(matrix(1:4, 2L)))$type, "other")
  expect_false(column_schema(I(list(1, 2)))$filterable)
  expect_identical(column_schema(I(list(1, 2)))$type, "other")
})

test_that("AsIs atomic data frame columns filter and sort in both modes", {
  x <- data.frame(id = 1:4)
  x$n <- I(c(3L, 1L, NA, 2L))
  x$s <- I(c("b", "a", NA, "ab"))
  holder <- paged_table(x)
  snapshot <- snapshot_table(x)
  gt <- list(op = "gt", col = 1L, value = 1)
  contains <- list(op = "contains", col = 2L, value = "A")
  sort <- list(list(col = 1L, desc = FALSE))
  expect_identical(query_indices(holder, filter = gt), c(1L, 4L))
  expect_identical(snapshot_indices(snapshot, filter = gt), c(1L, 4L))
  expect_identical(query_indices(holder, filter = contains), c(2L, 4L))
  expect_identical(snapshot_indices(snapshot, filter = contains), c(2L, 4L))
  expect_identical(query_indices(holder, sort), c(2L, 4L, 1L, 3L))
  expect_identical(snapshot_indices(snapshot, sort), c(2L, 4L, 1L, 3L))
})

test_that("unknown S3 columns display and sort but accept only is_na", {
  with_query_methods({
    x <- data.frame(id = 1:3)
    x$v <- structure(c(2, 1, NA), class = "query_record")
    holder <- paged_table(x)
    snapshot <- snapshot_table(x)
    page <- query_page(holder, limit = 3L)
    expect_identical(
      page$data$columns[[2L]]$data$display,
      c("value:2", "value:1", "value:NA")
    )
    sort <- list(list(col = 1L, desc = FALSE))
    expect_identical(query_indices(holder, sort), c(2L, 1L, 3L))
    expect_identical(snapshot_indices(snapshot, sort), c(2L, 1L, 3L))
    missing <- list(op = "is_na", col = 1L)
    expect_identical(query_indices(holder, filter = missing), 3L)
    text <- list(op = "contains", col = 1L, value = "value")
    expect_query_code(query_indices(holder, filter = text), "unsupported")
    expect_query_code(snapshot_indices(snapshot, filter = text), "unsupported")
    expect_null(snapshot$columns[[2L]]$data$text)
  })
})

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

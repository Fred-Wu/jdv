test_that("the latest query index survives cache limits for page requests", {
  holder <- paged_table(
    data.frame(value = seq_len(2000L)),
    limits = list(cache_bytes = 1L, index_cache = 1L)
  )
  filter <- list(op = "ge", col = 0L, value = 1990)

  first <- query_page(holder, limit = 5L, filter = filter)
  expect_identical(first$data$row_index, 1990:1994)
  expect_length(holder$index_cache, 0L)
  expect_identical(holder$recent_indices, 1990:2000)

  next_page <- query_page(
    holder,
    offset = 5L,
    limit = 5L,
    filter = filter,
    query_budget = .jdv_budget(1)
  )
  expect_identical(next_page$data$row_index, 1995:1999)
  expect_identical(next_page$total, 11L)

  empty_filter <- list(op = "gt", col = 0L, value = 2000)
  empty <- query_page(holder, filter = empty_filter)
  expect_identical(empty$data$row_index, integer())
  expect_identical(empty$total, 0L)
  expect_identical(holder$recent_indices, integer())

  query_page(holder, limit = 1L)
  expect_null(holder$recent_index_key)
  expect_null(holder$recent_indices)

  query_page(holder, limit = 1L, filter = filter)
  query_clear(holder)
  expect_null(holder$recent_index_key)
  expect_null(holder$recent_indices)

  query_page(holder, limit = 1L, filter = filter)
  query_dispose(holder)
  expect_null(holder$recent_index_key)
  expect_null(holder$recent_indices)
})

test_that("sort and combined query indices survive the LRU byte limit", {
  holder <- paged_table(
    data.frame(value = seq_len(2000L)),
    limits = list(cache_bytes = 1L)
  )
  sort <- list(list(col = 0L, desc = TRUE))

  first_sorted <- query_page(holder, limit = 4L, sort = sort)
  expect_identical(first_sorted$data$row_index, 2000:1997)
  expect_length(holder$index_cache, 0L)
  next_sorted <- query_page(
    holder,
    offset = 4L,
    limit = 4L,
    sort = sort,
    query_budget = .jdv_budget(1)
  )
  expect_identical(next_sorted$data$row_index, 1996:1993)

  filter <- list(op = "ge", col = 0L, value = 1500)
  first_combined <- query_page(holder, limit = 4L, sort = sort, filter = filter)
  expect_identical(first_combined$data$row_index, 2000:1997)
  expect_length(holder$index_cache, 0L)
  next_combined <- query_page(
    holder,
    offset = 4L,
    limit = 4L,
    sort = sort,
    filter = filter,
    query_budget = .jdv_budget(1)
  )
  expect_identical(next_combined$data$row_index, 1996:1993)
})

test_that("generation replacement and view close release retained indices", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)

  first <- jdv_register(
    data.frame(value = seq_len(20L)),
    title = "retained-index-lifecycle",
    mode = "paged"
  )
  entries <- .jdv_state$entries
  old_entry <- get(first$id, envir = entries)
  old_holder <- old_entry$holder
  query_page(old_holder, limit = 1L, sort = list(list(col = 0L, desc = TRUE)))
  expect_false(is.null(old_holder$recent_indices))

  second <- jdv_register(
    data.frame(value = seq_len(20L) + 100L),
    title = "retained-index-lifecycle",
    mode = "paged"
  )
  expect_identical(second$id, first$id)
  expect_identical(old_entry$generation, 1)
  expect_true(old_holder$closed)
  expect_null(old_holder$recent_index_key)
  expect_null(old_holder$recent_indices)

  current_entry <- get(second$id, envir = entries)
  current_holder <- current_entry$holder
  query_page(
    current_holder,
    limit = 1L,
    sort = list(list(col = 0L, desc = TRUE))
  )
  expect_false(is.null(current_holder$recent_indices))
  .jdv_close_internal(second$id)
  expect_true(current_holder$closed)
  expect_null(current_holder$recent_index_key)
  expect_null(current_holder$recent_indices)
})

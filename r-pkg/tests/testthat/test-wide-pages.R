wide_page_rpc <- function(view, include_cols = FALSE, cols = NULL) {
  params <- list(view = view$id, generation = 1, offset = 0, limit = 200)
  if (include_cols) {
    params["cols"] <- list(cols)
  }
  request <- jsonlite::toJSON(
    list(id = 1, method = "table/rows", params = params),
    auto_unbox = TRUE,
    null = "null",
    digits = 17
  )
  jsonlite::fromJSON(jdv_rpc(as.character(request)), simplifyVector = FALSE)
}

test_that("omitted and null cols return every wide matrix column", {
  skip_if_not_installed("jsonlite")
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  old_options <- options(
    jdv.max_message_bytes = NULL,
    jdv.max_work_bytes = NULL,
    jdv.max_query_rows = NULL
  )
  on.exit(options(old_options), add = TRUE)

  row_count <- 200L
  column_count <- 10000L
  values <- matrix(
    as.double(seq_len(row_count * column_count)),
    nrow = row_count,
    ncol = column_count,
    dimnames = list(NULL, sprintf("v%05d", seq_len(column_count)))
  )
  registered <- jdv_register(values, mode = "paged")

  omitted <- wide_page_rpc(registered)
  expect_null(omitted$error)
  expect_equal(omitted$result$total, row_count)
  expect_equal(omitted$result$total_unfiltered, row_count)
  expect_true(omitted$result$limit > 0)
  expect_lt(omitted$result$limit, row_count)
  expect_length(omitted$result$data$row_index, omitted$result$limit)
  expect_length(omitted$result$data$columns, column_count)
  expect_identical(omitted$result$data$columns[[1L]]$schema$name, "v00001")
  expect_identical(
    omitted$result$data$columns[[column_count]]$schema$name,
    "v10000"
  )
  expect_equal(omitted$result$data$columns[[1L]]$data$values[[1L]], 1)
  expect_equal(
    omitted$result$data$columns[[column_count]]$data$values[[1L]],
    as.double((column_count - 1L) * row_count + 1L)
  )

  explicit_null <- wide_page_rpc(registered, include_cols = TRUE, cols = NULL)
  expect_null(explicit_null$error)
  expect_identical(explicit_null$result$limit, omitted$result$limit)
  expect_length(explicit_null$result$data$columns, column_count)
  expect_equal(
    explicit_null$result$data$columns[[column_count]]$data$values[[1L]],
    as.double((column_count - 1L) * row_count + 1L)
  )
})

test_that(
  "wide-page limits preserve selectors, totals, and empty-page behavior",
  {
    holder <- paged_table(structure(
      rep(list(1:2), 257L),
      names = paste0("v", seq_len(257L)),
      class = "data.frame",
      row.names = .set_row_names(2L)
    ))
    expect_query_code(query_page(holder, cols = 0:256), "limit_exceeded")

    no_rows <- paged_table(matrix(numeric(), nrow = 0L, ncol = 3L))
    empty_table_page <- query_page(no_rows)
    expect_identical(empty_table_page$data$row_index, integer())
    expect_length(empty_table_page$data$columns, 3L)

    small <- paged_table(data.frame(value = c(4, 1, 3, 2), group = 1:4))
    zero_limit <- query_page(small, limit = 0L)
    expect_identical(zero_limit$data$row_index, integer())
    expect_identical(zero_limit$limit, 0L)
    beyond <- query_page(small, offset = 10L)
    expect_identical(beyond$data$row_index, integer())
    expect_length(beyond$data$columns, 2L)
    no_columns <- query_page(small, cols = integer(), limit = 2L)
    expect_identical(no_columns$data$row_index, 1:2)
    expect_length(no_columns$data$columns, 0L)
    zero_column_source <- paged_table(matrix(numeric(), nrow = 3L, ncol = 0L))
    zero_column_page <- query_page(zero_column_source, limit = 2L)
    expect_identical(zero_column_page$data$row_index, 1:2)
    expect_length(zero_column_page$data$columns, 0L)

    queried <- query_page(
      small,
      limit = 2L,
      sort = list(list(col = 0L, desc = TRUE)),
      filter = list(op = "ge", col = 0L, value = 2)
    )
    expect_identical(queried$total, 3L)
    expect_identical(queried$total_unfiltered, 4L)
    expect_identical(queried$data$row_index, c(1L, 3L))
  }
)

test_that(
  "page sizing rejects fixed metadata or a single row that cannot fit",
  {
    wide <- paged_table(structure(
      rep(list(1L), 257L),
      names = paste0("column", seq_len(257L)),
      class = "data.frame",
      row.names = .set_row_names(1L)
    ))
    expect_query_code(
      query_page(wide, limit = 1L, budget = .jdv_budget(1024)),
      "limit_exceeded"
    )

    old_message_limit <- getOption("jdv.max_message_bytes")
    options(jdv.max_message_bytes = 1024)
    on.exit(options(jdv.max_message_bytes = old_message_limit), add = TRUE)
    expect_query_code(
      query_page(wide, limit = 1L, budget = .jdv_budget(64 * 1024^2)),
      "limit_exceeded"
    )
  }
)

test_that("implicit page sizing samples only returned string and factor rows", {
  source <- data.frame(
    text = c("small", strrep("z", 10000L)),
    ordered = ordered(c("low", "high"), levels = c("low", "high")),
    value = 1:2
  )
  holder <- paged_table(source)
  first <- query_page(holder, limit = 2L, budget = .jdv_budget(10000))
  expect_equal(first$limit, 1L)
  expect_identical(first$data$row_index, 1L)
  expect_identical(first$data$columns[[1L]]$data$values, "small")
  expect_identical(first$data$columns[[2L]]$data$values, "low")

  long_rows <- paged_table(data.frame(text = rep(strrep("x", 1000L), 2L)))
  bounded <- query_page(long_rows, limit = 2L, budget = .jdv_budget(20000))
  expect_equal(bounded$limit, 1L)

  unused_long_level <- paged_table(data.frame(
    ordered = ordered(c("low", "low"), levels = c("low", strrep("u", 10000L))),
    a = 1:2,
    b = 3:4
  ))
  expect_query_code(
    query_page(unused_long_level, budget = .jdv_budget(4096)),
    "limit_exceeded"
  )
})

test_that("wide list pages reserve existing display preflight work", {
  source <- data.frame(id = 1:2)
  source$items <- list(list(label = "first"), list(label = "second"))
  source$tail <- 3:4
  holder <- paged_table(source)
  holder$limits$page_columns <- 2L
  page <- query_page(holder, limit = 2L, budget = .jdv_budget(10000))
  expect_equal(page$limit, 1L)
  expect_identical(page$data$row_index, 1L)

  packed <- data.frame(id = 1:2)
  packed$matrix <- I(matrix(seq_len(40L), nrow = 2L, ncol = 20L))
  packed$tail <- 3:4
  packed_holder <- paged_table(packed)
  packed_holder$limits$page_columns <- 2L
  packed_page <- query_page(
    packed_holder,
    limit = 2L,
    budget = .jdv_budget(10000)
  )
  expect_equal(packed_page$limit, 1L)
  expect_identical(packed_page$data$row_index, 1L)
})

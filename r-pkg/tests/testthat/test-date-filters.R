test_that("Date filters compare numeric day values without ISO values", {
  x <- data.frame(
    date = as.Date(c("2020-01-01", "2020-01-02", "2020-01-03", NA))
  )
  holder <- paged_table(x, limits = list(probe_rows = 1L))
  filters <- list(
    eq = list(op = "eq", col = 0L, value = "2020-01-02"),
    ne = list(op = "ne", col = 0L, value = "2020-01-02"),
    lt = list(op = "lt", col = 0L, value = "2020-01-02"),
    le = list(op = "le", col = 0L, value = "2020-01-02"),
    gt = list(op = "gt", col = 0L, value = "2020-01-02"),
    ge = list(op = "ge", col = 0L, value = "2020-01-02"),
    between = list(
      op = "between",
      col = 0L,
      lower = "2020-01-02",
      upper = "2020-01-03"
    )
  )
  expected <- list(
    eq = 2L,
    ne = c(1L, 3L),
    lt = 1L,
    le = 1:2,
    gt = 3L,
    ge = 2:3,
    between = 2:3
  )
  for (op in names(filters)) {
    expect_identical(
      query_indices(holder, filter = filters[[op]]),
      expected[[op]]
    )
  }
  expect_false(any(grepl(":values$", names(holder$channel_cache))))
})

test_that("Date filters use displayed days for fractional Date values", {
  x <- data.frame(
    date = structure(c(18262, 18262.5, 18263, -0.5), class = "Date")
  )
  holder <- paged_table(x, limits = list(probe_rows = 1L))
  snapshot <- snapshot_table(x)
  filters <- list(
    eq = list(op = "eq", col = 0L, value = "2020-01-01"),
    ne = list(op = "ne", col = 0L, value = "2020-01-01"),
    lt = list(op = "lt", col = 0L, value = "2020-01-01"),
    le = list(op = "le", col = 0L, value = "2020-01-01"),
    gt = list(op = "gt", col = 0L, value = "2020-01-01"),
    ge = list(op = "ge", col = 0L, value = "2020-01-01"),
    between = list(
      op = "between",
      col = 0L,
      lower = "2020-01-01",
      upper = "2020-01-02"
    )
  )
  expected <- list(
    eq = 1:2,
    ne = c(3L, 4L),
    lt = 4L,
    le = c(1L, 2L, 4L),
    gt = 3L,
    ge = 1:3,
    between = 1:3
  )
  for (op in names(filters)) {
    actual <- query_indices(holder, filter = filters[[op]])
    expect_identical(actual, expected[[op]], info = op)
    expect_identical(
      snapshot_indices(snapshot, filter = filters[[op]]),
      actual,
      info = paste("snapshot", op)
    )
  }
  expect_identical(
    query_indices(holder, list(list(col = 0L, desc = FALSE))),
    c(4L, 1L, 2L, 3L)
  )
  expect_identical(
    query_indices(holder, list(list(col = 0L, desc = TRUE))),
    c(3L, 2L, 1L, 4L)
  )
  expect_identical(
    holder$channel_cache[["1:sortKey"]]$sortKey,
    c(18262, 18262.5, 18263, -0.5)
  )
  expect_false(any(grepl(":values$", names(holder$channel_cache))))

  negative_date <- list(op = "eq", col = 0L, value = "1969-12-31")
  expect_identical(query_indices(holder, filter = negative_date), 4L)
  expect_identical(snapshot_indices(snapshot, filter = negative_date), 4L)
})

test_that(
  "POSIXct and POSIXlt filters compare instants and fractional seconds",
  {
    values <- as.POSIXct(
      c(
        "2020-01-01T00:00:00.125",
        "2020-01-01T00:00:00.25",
        "2020-01-01T00:00:01",
        NA
      ),
      format = "%Y-%m-%dT%H:%M:%OS",
      tz = "Australia/Sydney"
    )
    expected <- list(
      eq = 1L,
      ne = 2:3,
      lt = integer(),
      le = 1L,
      gt = 2:3,
      ge = 1:3,
      between = 1:2
    )
    filters <- list(
      eq = list(op = "eq", col = 1L, value = "2019-12-31T13:00:00.125Z"),
      ne = list(op = "ne", col = 1L, value = "2019-12-31T13:00:00.125Z"),
      lt = list(op = "lt", col = 1L, value = "2019-12-31T13:00:00.125Z"),
      le = list(op = "le", col = 1L, value = "2019-12-31T13:00:00.125Z"),
      gt = list(op = "gt", col = 1L, value = "2019-12-31T13:00:00.125Z"),
      ge = list(op = "ge", col = 1L, value = "2019-12-31T13:00:00.125Z"),
      between = list(
        op = "between",
        col = 1L,
        lower = "2019-12-31T13:00:00.125Z",
        upper = "2020-01-01T00:00:00.25+11:00"
      )
    )
    for (class in c("POSIXct", "POSIXlt")) {
      time <- if (class == "POSIXlt") as.POSIXlt(values) else values
      x <- data.frame(id = seq_along(time))
      x$time <- time
      holder <- paged_table(x, limits = list(probe_rows = 1L))
      for (op in names(filters)) {
        expect_identical(
          query_indices(holder, filter = filters[[op]]),
          expected[[op]],
          info = paste(class, op)
        )
      }
      expect_false(any(grepl(":values$", names(holder$channel_cache))))
    }
  }
)

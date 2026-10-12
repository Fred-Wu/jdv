test_that(
  "integer64 channels retain every storage bit and exact decimal value",
  {
    values <- c(
      "9223372036854775807",
      "9007199254740993",
      "9007199254740992",
      "9007199254740991",
      "9007199254740994",
      "-9223372036854775807",
      "-9007199254740993",
      "-2",
      "-1",
      "0",
      "1",
      "2",
      "1",
      NA_character_
    )
    x <- int64_fixture(values)
    names(x) <- paste0("row", seq_along(x))
    before <- serialize(x, NULL)
    out <- column_extract(x)
    expect_identical(out$data$values, values)
    expect_identical(out$data$display, replace(values, is.na(values), "NA"))
    expect_identical(out$data$na, is.na(values))
    expect_identical(
      out$data$sortKey,
      c(12L, 10L, 9L, 8L, 11L, 1L, 2L, 3L, 4L, 5L, 6L, 7L, 6L, NA_integer_)
    )
    expect_true(out$schema$sortable)
    expect_true(out$schema$filterable)
    expect_length(out$errors, 0L)
    expect_null(column_extract(x, "text")$data$text)
    expect_identical(
      int64_order(x),
      c(6L, 7L, 8L, 9L, 10L, 11L, 13L, 12L, 4L, 3L, 2L, 5L, 1L, 14L)
    )
    expect_identical(
      int64_order(x, TRUE),
      c(1L, 5L, 2L, 3L, 4L, 12L, 11L, 13L, 10L, 9L, 8L, 7L, 6L, 14L)
    )
    expect_identical(serialize(x, NULL), before)
  }
)

test_that("integer64 missing rows and ties have stable orders", {
  x <- int64_fixture(c(NA, "2", "1", "2", NA, "1"))
  expect_identical(int64_order(x), c(3L, 6L, 2L, 4L, 1L, 5L))
  expect_identical(int64_order(x, TRUE), c(2L, 4L, 3L, 6L, 1L, 5L))
  expect_identical(col_sort_key(x), c(NA_integer_, 2L, 1L, 2L, NA_integer_, 1L))
  x <- int64_fixture(rep(NA_character_, 3L))
  expect_identical(col_values(x), rep(NA_character_, 3L))
  expect_identical(col_is_na(x), rep(TRUE, 3L))
  expect_identical(col_sort_key(x), rep(NA_integer_, 3L))
  expect_identical(int64_order(x), 1:3)
  expect_identical(int64_order(x, TRUE), 1:3)
  x <- int64_fixture(character())
  expect_identical(col_display(x), character())
  expect_identical(col_values(x), character())
  expect_identical(col_is_na(x), logical())
  expect_identical(col_sort_key(x), integer())
  expect_identical(int64_order(x), integer())
  expect_identical(int64_eq(x, "0"), logical())
  expect_identical(int64_between(x, "-1", "1"), logical())
})

test_that("integer64 filters compare canonical decimal strings exactly", {
  x <- int64_fixture(c(
    "-9223372036854775807",
    "-1",
    "0",
    "1",
    "9007199254740992",
    "9007199254740993",
    "9223372036854775807",
    NA
  ))
  before <- serialize(x, NULL)
  expect_identical(
    int64_eq(x, "9007199254740993"),
    c(FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE)
  )
  expect_identical(
    int64_eq(x, "9223372036854775807"),
    c(FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE)
  )
  expect_identical(int64_eq(x, "-9223372036854775807"), c(TRUE, rep(FALSE, 7L)))
  expect_identical(
    int64_between(x, "0", "9007199254740993"),
    c(FALSE, FALSE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE)
  )
  expect_identical(
    int64_between(x, "-9223372036854775807", "9223372036854775807"),
    c(rep(TRUE, 7L), FALSE)
  )
  expect_identical(int64_between(x, "1", "1"), int64_eq(x, "1"))
  expect_identical(serialize(x, NULL), before)
  expect_error(int64_between(x, "1", "0"), "lower")
  for (value in c(
    "",
    "-",
    "+1",
    "01",
    "-0",
    "-01",
    " 1",
    "1 ",
    "1.0",
    "1e0",
    "a",
    "１",
    "NA"
  )) {
    expect_error(int64_eq(x, value), "canonical", info = value)
  }
  for (value in c(
    "9223372036854775808",
    "-9223372036854775809",
    "9999999999999999999999999999999"
  )) {
    expect_error(int64_eq(x, value), "range", info = value)
  }
  expect_error(int64_eq(x, "-9223372036854775808"), "reserved")
  for (value in list(
    1,
    1L,
    NA_character_,
    character(),
    c("1", "2"),
    TRUE,
    structure("1", class = "query"),
    matrix("1")
  )) {
    expect_error(int64_eq(x, value), "plain decimal")
  }
  expect_error(int64_between(x, NA_character_, "1"), "plain decimal")
  expect_error(int64_between(x, "0", 1), "plain decimal")
})

test_that(
  "integer64 validates storage and downgrades failing channels independently",
  {
    x <- structure(1:2, class = "integer64")
    out <- column_extract(x)
    expect_false(out$schema$sortable)
    expect_false(out$schema$filterable)
    expect_null(out$data$values)
    expect_null(out$data$sortKey)
    expect_setequal(names(out$errors), c("display", "na", "values", "sortKey"))
    expect_error(col_is_na(x), "double storage")
    expect_error(int64_order(unclass(int64_fixture("1"))), "integer64 vector")
    expect_error(
      col_values(structure(int64_fixture("1"), dim = c(1L, 1L))),
      "dimensions"
    )
    for (value in list(NA, logical(), c(TRUE, FALSE), 1L, "TRUE")) {
      expect_error(int64_order(int64_fixture("1"), value), "nonmissing logical")
    }
  }
)

test_that("integer64 table schemas preserve duplicate names and positions", {
  x <- data.frame(a = 1:2)
  x[[2L]] <- int64_fixture(c("9007199254740993", NA))
  names(x) <- c("duplicate", "duplicate")
  before <- serialize(x, NULL)
  model <- table_model(x)
  expect_identical(model$schema[[2L]]$name, "duplicate")
  expect_identical(model$schema[[2L]]$position, 1L)
  out <- column_extract(model$columns[[2L]], "values")
  expect_identical(out$data$values, c("9007199254740993", NA_character_))
  expect_named(out$data, "values")
  expect_identical(serialize(x, NULL), before)
})

test_that("integer64 orders agree with bit64 without a runtime dependency", {
  skip_if_not_installed("bit64")
  values <- c(
    "9223372036854775807",
    "-9223372036854775807",
    "9007199254740993",
    "9007199254740992",
    "-1",
    "0",
    "1",
    "1",
    NA,
    NA
  )
  x <- int64_fixture(values)
  reference <- bit64::as.integer64(values)
  expect_identical(unclass(x), unclass(reference))
  for (decreasing in c(FALSE, TRUE)) {
    expect_identical(
      int64_order(x, decreasing),
      bit64::order(reference, na.last = TRUE, decreasing = decreasing)
    )
  }
  set.seed(164)
  values <- sample(
    c("-2", "-1", "0", "1", "2", "9007199254740993", NA),
    10000L,
    replace = TRUE
  )
  x <- int64_fixture(values)
  reference <- bit64::as.integer64(values)
  expect_identical(int64_order(x), bit64::order(reference, na.last = TRUE))
  expect_identical(
    int64_order(x, TRUE),
    bit64::order(reference, na.last = TRUE, decreasing = TRUE)
  )
})

test_that("installed integer64 extraction works without loading bit64", {
  skip_if(
    !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
    "Requires an installed package"
  )
  result <- callr::r(
    function() {
      stopifnot(!"bit64" %in% loadedNamespaces())
      loadNamespace("jdv")
      x <- structure(
        readBin(
          as.raw(c(rep(255L, 7L), 127L, rep(0L, 7L), 128L)),
          "double",
          n = 2L,
          endian = "little"
        ),
        class = "integer64"
      )
      out <- jdv:::column_extract(x)
      stopifnot(
        identical(out$data$values, c("9223372036854775807", NA_character_)),
        identical(out$data$na, c(FALSE, TRUE))
      )
      stopifnot(!"bit64" %in% loadedNamespaces())
      stopifnot(is.null(getS3method("format", "integer64", optional = TRUE)))
      assign(
        "format.jdv_fresh_int64",
        function(x, ...) paste0("custom:", jdv:::col_values.integer64(x)),
        .GlobalEnv
      )
      class(x) <- c("jdv_fresh_int64", "integer64")
      holder <- jdv:::paged_table(structure(
        list(x = x),
        class = "data.frame",
        row.names = 1:2
      ))
      page <- jdv:::query_page(holder, limit = 1L)
      stopifnot(identical(
        page$data$columns[[1L]]$data$display,
        "custom:9223372036854775807"
      ))
      stopifnot(identical(
        page$data$columns[[1L]]$data$values,
        "9223372036854775807"
      ))
      class(x) <- c("jdv_fresh_no_format", "integer64")
      stopifnot(identical(jdv:::col_display(x), c("9223372036854775807", "NA")))
      stopifnot(!"bit64" %in% loadedNamespaces())
      TRUE
    },
    libpath = .libPaths()
  )
  expect_true(result)
})

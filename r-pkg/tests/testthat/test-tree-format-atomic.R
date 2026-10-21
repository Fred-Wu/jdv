test_that("tree pages use class display methods for atomic vectors", {
  date <- as.Date(c("2020-01-02", NA, "2020-03-04"))
  expect_identical(
    .jdv_tree_element_text(date, .jdv_tree_info(date), 2L, 2L),
    c("NA", "2020-03-04")
  )

  time <- as.POSIXct(
    c("2020-01-02 03:04:05", "2020-02-03 04:05:06"),
    tz = "UTC"
  )
  expect_identical(
    .jdv_tree_element_text(time, .jdv_tree_info(time), 2L, 1L),
    format(time[2L], trim = TRUE, justify = "none")
  )

  skip_if_not_installed("withr")
  formatted <- structure(c(11L, 22L, 33L), class = "jdvTreeFormatFixture")
  seen <- integer()
  with_column_method(
    "format",
    "jdvTreeFormatFixture",
    function(x, ...) {
      seen <<- length(x)
      paste0("formatted:", unclass(x))
    },
    {
      expect_identical(
        .jdv_tree_element_text(formatted, .jdv_tree_info(formatted), 2L, 1L),
        "formatted:22"
      )
      expect_identical(seen, 1L)
    }
  )
})

test_that("tree class display failures fall back to atomic storage text", {
  skip_if_not_installed("withr")
  broken <- structure(c(4L, 9L), class = "jdvTreeBrokenFormat")
  with_column_method(
    "format",
    "jdvTreeBrokenFormat",
    function(x, ...) stop("format failed"),
    {
      expect_identical(
        .jdv_tree_element_text(broken, .jdv_tree_info(broken), 1L, 2L),
        c("4", "9")
      )
    }
  )

  changed_type <- structure(1:2, class = "jdvTreeSliceType")
  with_column_method(
    "[",
    "jdvTreeSliceType",
    function(x, i, ...) unclass(x)[i],
    {
      expect_identical(
        .jdv_tree_element_text(
          changed_type,
          .jdv_tree_info(changed_type),
          1L,
          2L
        ),
        c("1", "2")
      )
    }
  )

  changed_length <- structure(1:2, class = "jdvTreeSliceLength")
  with_column_method(
    "[",
    "jdvTreeSliceLength",
    function(x, i, ...) structure(unclass(x)[i[[1L]]], class = class(x)),
    {
      expect_identical(
        .jdv_tree_element_text(
          changed_length,
          .jdv_tree_info(changed_length),
          1L,
          2L
        ),
        c("1", "2")
      )
    }
  )

  shaped <- structure(c(5L, 8L), class = "jdvTreeShapedFormat")
  with_column_method(
    "format",
    "jdvTreeShapedFormat",
    function(x, ...) matrix(paste0("formatted:", unclass(x)), nrow = 1L),
    {
      expect_identical(
        .jdv_tree_element_text(shaped, .jdv_tree_info(shaped), 1L, 2L),
        c("5", "8")
      )
    }
  )

  wrong_length <- structure(c(6L, 7L), class = "jdvTreeWrongLength")
  with_column_method(
    "format",
    "jdvTreeWrongLength",
    function(x, ...) "wrong length",
    {
      expect_identical(
        .jdv_tree_element_text(
          wrong_length,
          .jdv_tree_info(wrong_length),
          1L,
          2L
        ),
        c("6", "7")
      )
    }
  )
})

test_that("tree class display suppresses formatter warnings and messages", {
  skip_if_not_installed("withr")
  noisy <- structure(c(3L, 6L), class = "jdvTreeNoisyFormat")
  with_column_method(
    "format",
    "jdvTreeNoisyFormat",
    function(x, ...) {
      warning("formatter warning")
      message("formatter message")
      paste0("formatted:", unclass(x))
    },
    {
      expect_no_warning(expect_no_message(expect_identical(
        .jdv_tree_element_text(noisy, .jdv_tree_info(noisy), 1L, 2L),
        c("formatted:3", "formatted:6")
      )))
    }
  )
})

test_that("tree formatting respects class slicing and formatter contracts", {
  skip_if_not_installed("withr")
  sliced <- structure(1:2, class = "jdvTreeSliceFailure")
  with_column_method(
    "[",
    "jdvTreeSliceFailure",
    function(...) stop("subset failed"),
    {
      expect_identical(
        .jdv_tree_element_text(sliced, .jdv_tree_info(sliced), 1L, 2L),
        c("1", "2")
      )
    }
  )

  wrong_type <- structure(1:2, class = "jdvTreeWrongType")
  with_column_method("format", "jdvTreeWrongType", function(x, ...) c(1L, 2L), {
    expect_identical(
      .jdv_tree_element_text(wrong_type, .jdv_tree_info(wrong_type), 1L, 2L),
      c("1", "2")
    )
  })
})

test_that("tree classed ALTREP formatting receives only the requested page", {
  skip_if_not_installed("withr")
  value <- structure(seq_len(1e8), class = "jdvTreeAltRep")
  before <- paste(capture.output(.Internal(inspect(value))), collapse = "\n")
  expect_match(before, "compact")
  seen <- integer()
  with_column_method(
    "format",
    "jdvTreeAltRep",
    function(x, ...) {
      seen <<- length(x)
      paste0("n=", unclass(x))
    },
    {
      page <- .jdv_tree_element_text(value, .jdv_tree_info(value), 1001L, 500L)
      expect_length(page, 500L)
      expect_identical(page[[1L]], "n=1001")
      expect_identical(page[[500L]], "n=1500")
      expect_identical(seen, 500L)
    }
  )
  after <- paste(capture.output(.Internal(inspect(value))), collapse = "\n")
  expect_match(after, "compact")
})

test_that("tree formatting handles time zones and difftime units", {
  utc <- as.POSIXct(c("2020-11-01 05:30:00", "2020-11-01 06:30:00"), tz = "UTC")
  auckland <- as.POSIXct(
    c("2020-11-01 18:30:00", "2020-11-01 19:30:00"),
    tz = "Pacific/Auckland"
  )
  expect_identical(
    .jdv_tree_element_text(utc, .jdv_tree_info(utc), 1L, 2L),
    format(utc, trim = TRUE, justify = "none")
  )
  expect_identical(
    .jdv_tree_element_text(auckland, .jdv_tree_info(auckland), 1L, 2L),
    format(auckland, trim = TRUE, justify = "none")
  )

  minutes <- as.difftime(c(30, 90), units = "mins")
  hours <- as.difftime(c(0.5, 1.5), units = "hours")
  expect_identical(
    .jdv_tree_element_text(minutes, .jdv_tree_info(minutes), 1L, 2L),
    format(minutes, trim = TRUE, justify = "none")
  )
  expect_identical(
    .jdv_tree_element_text(hours, .jdv_tree_info(hours), 1L, 2L),
    format(hours, trim = TRUE, justify = "none")
  )
})

test_that("tree class formatting retains optional vector precision", {
  skip_if_not_installed("bit64")
  int64 <- bit64::as.integer64(c("9007199254740993", NA, "4"))
  expect_identical(
    .jdv_tree_element_text(int64, .jdv_tree_info(int64), 1L, 3L),
    c("9007199254740993", "NA", "4")
  )
})

test_that("tree class formatting supports optional vctrs vectors", {
  skip_if_not_installed("vctrs")
  vector <- vctrs::new_vctr(c(2L, NA, 5L), class = "jdvTreeFormatVctr")
  expect_identical(
    .jdv_tree_element_text(vector, .jdv_tree_info(vector), 1L, 3L),
    col_display(query_slice(vector, 1:3))
  )
})

test_that("Date previews appear in tree list children and internal summaries", {
  value <- as.Date(c("2020-01-02", "2020-03-04"))
  expect_identical(.jdv_tree_summary(value), "Date (2): 2020-01-02, 2020-03-04")

  initial_session <- save_notification_session()
  on.exit(restore_notification_session(initial_session), add = TRUE)
  root <- register_view(list(date = value))
  on.exit(.jdv_close_internal(root$id), add = TRUE)
  response <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
    id = 1,
    method = "object/children",
    params = list(
      view = root$id,
      generation = 1,
      path = list(),
      offset = 0,
      limit = 10
    )
  ))))
  expect_identical(
    response$result$children[[1L]]$summary,
    "Date (2): 2020-01-02, 2020-03-04"
  )
})

test_that("tree factor display keeps invalid code diagnostics", {
  value <- structure(c(1L, 3L, NA_integer_), levels = "a", class = "factor")
  expect_identical(
    .jdv_tree_element_text(value, .jdv_tree_info(value), 1L, 3L),
    c("a", "<invalid code 3>", "NA")
  )
})

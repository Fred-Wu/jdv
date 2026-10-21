test_that("tree summaries format classed list previews", {
  skip_if_not_installed("withr")
  value <- structure(as.list(1:7), class = "jdvTreeFormattedList")
  with_column_method(
    "[",
    "jdvTreeFormattedList",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeFormattedList",
        function(x, ...) paste0("item-", unlist(unclass(x), use.names = FALSE)),
        {
          summary <- .jdv_tree_summary(value)
          expect_identical(
            summary,
            "jdvTreeFormattedList (7): item-1, item-2, item-3, item-4, item-5"
          )
        }
      )
    }
  )
})

test_that("tree list previews validate length, slicing, and display results", {
  skip_if_not_installed("withr")
  value <- structure(as.list(1:4), class = "jdvTreeInvalidLength")
  with_column_method(
    "[",
    "jdvTreeInvalidLength",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeInvalidLength",
        function(x, ...) paste0("item-", unlist(unclass(x), use.names = FALSE)),
        {
          for (bad_length in list(NA_real_, Inf, -1, 1.5, c(1, 2), "4")) {
            with_column_method(
              "length",
              "jdvTreeInvalidLength",
              local({
                result <- bad_length
                function(x) result
              }),
              expect_false(grepl(
                ": item-",
                .jdv_tree_summary(value),
                fixed = TRUE
              ))
            )
          }
          with_column_method(
            "length",
            "jdvTreeInvalidLength",
            function(x) {
              warning("length warning")
              message("length message")
              4
            },
            {
              expect_no_warning(expect_no_message(expect_match(
                .jdv_tree_summary(value),
                ": item-1, item-2, item-3, item-4$"
              )))
            }
          )
        }
      )
    }
  )

  length_error <- structure(as.list(1:2), class = "jdvTreeLengthErrorList")
  with_column_method(
    "[",
    "jdvTreeLengthErrorList",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeLengthErrorList",
        function(x, ...) paste0("item-", unlist(unclass(x), use.names = FALSE)),
        {
          with_column_method(
            "length",
            "jdvTreeLengthErrorList",
            function(x) stop("length failed"),
            {
              expect_identical(
                .jdv_tree_summary(length_error),
                "jdvTreeLengthErrorList (2)"
              )
            }
          )
        }
      )
    }
  )

  for (bad_slice in c("wrong_type", "wrong_length", "wrong_class")) {
    class_name <- paste0("jdvTreeBadListSlice", bad_slice)
    object <- structure(as.list(1:3), class = class_name)
    with_column_method("format", class_name, function(x, ...) "formatted", {
      slice_method <- switch(
        bad_slice,
        wrong_type = function(x, i, ...) {
          structure(unlist(unclass(x), use.names = FALSE)[i], class = class(x))
        },
        wrong_length = function(x, i, ...) {
          structure(unclass(x)[i[[1L]]], class = class(x))
        },
        wrong_class = function(x, i, ...) unclass(x)[i]
      )
      with_column_method("[", class_name, slice_method, {
        expect_identical(.jdv_tree_summary(object), paste0(class_name, " (3)"))
      })
    })
  }

  broken <- structure(as.list(1:2), class = "jdvTreeBrokenListFormat")
  with_column_method(
    "[",
    "jdvTreeBrokenListFormat",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeBrokenListFormat",
        function(x, ...) stop("format failed"),
        {
          expect_identical(
            .jdv_tree_summary(broken),
            "jdvTreeBrokenListFormat (2)"
          )
        }
      )
    }
  )

  wrong_length <- structure(
    as.list(1:2),
    class = "jdvTreeWrongLengthListFormat"
  )

  wrong_type <- structure(as.list(1:2), class = "jdvTreeWrongTypeListFormat")
  with_column_method(
    "[",
    "jdvTreeWrongTypeListFormat",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeWrongTypeListFormat",
        function(x, ...) 1:2,
        {
          expect_identical(
            .jdv_tree_summary(wrong_type),
            "jdvTreeWrongTypeListFormat (2)"
          )
        }
      )
    }
  )
  with_column_method(
    "[",
    "jdvTreeWrongLengthListFormat",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeWrongLengthListFormat",
        function(x, ...) "only one",
        {
          expect_identical(
            .jdv_tree_summary(wrong_length),
            "jdvTreeWrongLengthListFormat (2)"
          )
        }
      )
    }
  )

  sliced <- structure(as.list(1:4), class = "jdvTreeSliceFailureList")
  with_column_method(
    "format",
    "jdvTreeSliceFailureList",
    function(x, ...) paste0("item-", unlist(unclass(x), use.names = FALSE)),
    {
      with_column_method(
        "[",
        "jdvTreeSliceFailureList",
        function(...) stop("subset failed"),
        {
          expect_identical(
            .jdv_tree_summary(sliced),
            "jdvTreeSliceFailureList (4)"
          )
        }
      )
    }
  )

  wrong_format <- structure(as.list(1:2), class = "jdvTreeWrongListFormat")
  with_column_method(
    "[",
    "jdvTreeWrongListFormat",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeWrongListFormat",
        function(x, ...) matrix("wrong", nrow = 1L),
        {
          expect_identical(
            .jdv_tree_summary(wrong_format),
            "jdvTreeWrongListFormat (2)"
          )
        }
      )
    }
  )
})

test_that("tree list previews suppress formatter warnings and messages", {
  skip_if_not_installed("withr")
  value <- structure(as.list(1:2), class = "jdvTreeNoisyListFormat")
  with_column_method(
    "[",
    "jdvTreeNoisyListFormat",
    function(x, i, ...) structure(unclass(x)[i], class = class(x)),
    {
      with_column_method(
        "format",
        "jdvTreeNoisyListFormat",
        function(x, ...) {
          warning("formatter warning")
          message("formatter message")
          paste0("item-", unlist(unclass(x), use.names = FALSE))
        },
        {
          expect_no_warning(expect_no_message(expect_identical(
            .jdv_tree_summary(value),
            "jdvTreeNoisyListFormat (2): item-1, item-2"
          )))
        }
      )
    }
  )
})

test_that(
  "tree list previews share text cleanup for missing and invalid text",
  {
    skip_if_not_installed("withr")
    value <- structure(as.list(1:3), class = "jdvTreeListTextCleanup")
    invalid <- rawToChar(as.raw(255L))
    Encoding(invalid) <- "bytes"
    expected_long <- paste(rep.int("x", 160L), collapse = "")
    with_column_method(
      "[",
      "jdvTreeListTextCleanup",
      function(x, i, ...) structure(unclass(x)[i], class = class(x)),
      {
        with_column_method(
          "format",
          "jdvTreeListTextCleanup",
          function(x, ...) {
            c(NA_character_, paste(rep.int("x", 200L), collapse = ""), invalid)
          },
          {
            expect_identical(
              .jdv_tree_summary(value),
              paste0(
                "jdvTreeListTextCleanup (3): NA, ",
                expected_long,
                ", <invalid string>"
              )
            )
          }
        )
      }
    )
  }
)

test_that("tree list previews support POSIXlt and classed vctrs records", {
  time <- as.POSIXlt(as.POSIXct(
    c("2020-01-02 03:04:05", "2020-02-03 04:05:06"),
    tz = "UTC"
  ))
  expect_identical(
    .jdv_tree_summary(time),
    paste0(
      "POSIXlt/POSIXt (11): ",
      paste(format(time, trim = TRUE), collapse = ", ")
    )
  )
  time_info <- .jdv_tree_info(time)
  expect_identical(time_info$length, 11)
  expect_length(.jdv_tree_list_children(time, list(), 0, 11)$children, 11)

  skip_if_not_installed("vctrs")
  record <- vctrs::new_rcrd(list(value = 1:2), class = "jdvTreeRecord")
  with_column_method(
    "format",
    "jdvTreeRecord",
    function(x, ...) paste0("record-", unclass(x)$value),
    {
      expect_identical(
        .jdv_tree_summary(record),
        "jdvTreeRecord/vctrs_rcrd/vctrs_vctr (1): record-1, record-2"
      )
    }
  )
})

test_that("tree summaries omit previews without an eligible list formatter", {
  plain <- structure(as.list(1:2), class = "jdvTreeNoFormatList")
  expect_identical(.jdv_tree_summary(plain), "jdvTreeNoFormatList (2)")
  expect_identical(.jdv_tree_summary(I(as.list(1:2))), "AsIs (2)")
  expect_identical(.jdv_tree_summary(data.frame(value = 1:2)), "data.frame (1)")
})

test_that("tree child listing does not dispatch list subset methods", {
  skip_if_not_installed("withr")
  counts <- new.env(parent = emptyenv())
  counts$subset <- 0L
  counts$length <- 0L
  no_format <- structure(as.list(1:2), class = "jdvTreeNoFormatSafeList")
  with_column_method(
    "[",
    "jdvTreeNoFormatSafeList",
    function(...) {
      counts$subset <- counts$subset + 1L
      stop("subset dispatched")
    },
    {
      with_column_method(
        "[[",
        "jdvTreeNoFormatSafeList",
        function(...) {
          counts$subset <- counts$subset + 1L
          stop("double bracket dispatched")
        },
        {
          with_column_method(
            "length",
            "jdvTreeNoFormatSafeList",
            function(x) {
              counts$length <- counts$length + 1L
              stop("length dispatched")
            },
            {
              info <- .jdv_tree_info(no_format)
              expect_identical(
                .jdv_tree_summary(no_format, info = info),
                "jdvTreeNoFormatSafeList (2)"
              )
              .jdv_tree_list_children(no_format, list(), 0, 10)
              expect_identical(counts$length, 0L)
              expect_identical(counts$subset, 0L)
              formatted <- structure(
                as.list(1:2),
                class = "jdvTreeSafeFormattedList"
              )
              formatted_counts <- new.env(parent = emptyenv())
              formatted_counts$subset <- 0L
              formatted_counts$length <- 0L
              with_column_method(
                "format",
                "jdvTreeSafeFormattedList",
                function(x, ...) "formatted",
                {
                  with_column_method(
                    "[",
                    "jdvTreeSafeFormattedList",
                    function(...) {
                      formatted_counts$subset <- formatted_counts$subset + 1L
                      stop("subset dispatched")
                    },
                    {
                      with_column_method(
                        "[[",
                        "jdvTreeSafeFormattedList",
                        function(...) {
                          formatted_counts$subset <- formatted_counts$subset +
                            1L
                          stop("double bracket dispatched")
                        },
                        {
                          with_column_method(
                            "length",
                            "jdvTreeSafeFormattedList",
                            function(x) {
                              formatted_counts$length <- formatted_counts$length +
                                1L
                              stop("length dispatched")
                            },
                            {
                              .jdv_tree_list_children(formatted, list(), 0, 10)
                              expect_identical(formatted_counts$length, 0L)
                              expect_identical(formatted_counts$subset, 0L)
                            }
                          )
                        }
                      )
                    }
                  )
                }
              )
            }
          )
        }
      )
    }
  )
})

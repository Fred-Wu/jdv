test_that("UTF-8 previews and titles retain their previous quoting", {
  skip_if_not(isTRUE(l10n_info()[["UTF-8"]]), "Requires a UTF-8 locale")
  values <- c(
    intToUtf8(c(0x65e5, 0x672c, 0x8a9e)),
    intToUtf8(0x1f600),
    "plain",
    "with space",
    "a\\b\"c`",
    "\n\t\r\a\b\f\v",
    "\001\177",
    ""
  )
  expect_identical(.jdv_title_string(values), encodeString(values, quote = '"'))
  for (value in values) {
    expected_symbol <- if (identical(make.names(value), value)) {
      value
    } else {
      paste0("`", gsub("`", "\\`", encodeString(value), fixed = TRUE), "`")
    }
    expect_identical(.jdv_title_symbol(value), expected_symbol)
    expect_identical(cell_preview(value), encodeString(value, quote = '"'))
  }
  expect_identical(
    cell_preview(c(values, NA_character_)),
    paste(encodeString(c(values, NA_character_), quote = '"'), collapse = ", ")
  )
})

test_that("C locale quoting retains control escapes and Unicode", {
  skip_on_cran()
  skip_on_os("windows")
  skip_if_not_installed("callr")
  package <- find.package("jdv")
  skip_if_not(
    file.exists(file.path(package, "Meta", "package.rds")),
    "Requires an installed package"
  )
  result <- callr::r(
    function() {
      stopifnot(!l10n_info()[["UTF-8"]])
      controls <- intToUtf8(c(1:31, 127:159), multiple = TRUE)
      unicode <- intToUtf8(c(0x65e5, 0x672c, 0x1f600))
      value <- paste0(unicode, '\\"\n\t')
      list(
        controls = identical(
          jdv:::.jdv_encode_string(controls, quote = '"'),
          encodeString(controls, quote = '"')
        ),
        actual = jdv:::.jdv_title_string(value),
        expected = paste0('"', unicode, '\\\\\\"\\n\\t"')
      )
    },
    env = c(callr::rcmd_safe_env(), LC_ALL = "C"),
    timeout = 60
  )
  expect_true(result$controls)
  expect_identical(result$actual, result$expected)
})

with_locale_format_method <- function(class, method, code) {
  table <- get(".__S3MethodsTable__.", envir = asNamespace("base"))
  name <- paste("format", class, sep = ".")
  had_method <- exists(name, envir = table, inherits = FALSE)
  old_method <- if (had_method) get(name, envir = table) else NULL
  registerS3method("format", class, method, envir = asNamespace("base"))
  withr::defer({
    if (had_method) {
      assign(name, old_method, envir = table)
    } else {
      rm(list = name, envir = table)
    }
  })
  eval(substitute(code), envir = parent.frame())
}

with_locale_global_method <- function(name, method, code) {
  had_method <- exists(name, envir = .GlobalEnv, inherits = FALSE)
  old_method <- if (had_method) get(name, envir = .GlobalEnv) else NULL
  assign(name, method, envir = .GlobalEnv)
  withr::defer({
    if (had_method) {
      assign(name, old_method, envir = .GlobalEnv)
    } else {
      rm(list = name, envir = .GlobalEnv)
    }
  })
  eval(substitute(code), envir = parent.frame())
}

test_that("plain strings and previews preserve Unicode in a C locale", {
  skip_on_cran()
  skip_on_os("windows")
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")
  installed <- file.path(.libPaths(), "jdv")
  installed <- installed[
    file.exists(file.path(installed, "Meta", "package.rds"))
  ]
  if (!length(installed)) {
    skip(
      "A locally installed jdv package is required for the locale subprocess"
    )
  }

  result <- callr::r(
    function(libpath) {
      .libPaths(libpath)
      loadNamespace("jdv")
      stopifnot(!l10n_info()[["UTF-8"]])
      value <- c(
        vapply(c(945L, 26481L, 128578L), intToUtf8, character(1L)),
        NA_character_,
        ""
      )
      display <- jdv:::col_display.default(value)
      column <- jdv:::column_extract(value)
      extracted <- column$data$display
      wire <- jdv:::.jdv_json_column(column)
      encoded <- jdv:::.jdv_json_encode(wire$values)
      preview <- jdv:::cell_preview(value)
      list_display <- jdv:::col_display.list(as.list(value[1:3]))
      titles <- c(
        jdv:::.jdv_title_string(paste0(value[[1L]], '"')),
        jdv:::.jdv_title_symbol(paste0(value[[1L]], " name"))
      )
      list(
        display = display,
        extracted = extracted,
        preview = preview,
        list_display = list_display,
        titles = titles,
        json = encoded,
        json_roundtrip = jsonlite::fromJSON(encoded, simplifyVector = FALSE),
        display_omitted = !("display" %in% names(wire))
      )
    },
    args = list(libpath = .libPaths()),
    env = c(callr::rcmd_safe_env(), LC_ALL = "C"),
    timeout = 60
  )
  if (is.null(result)) {
    skip("The installed jdv package is unavailable")
  }

  unicode <- vapply(c(945L, 26481L, 128578L), intToUtf8, character(1L))
  expect_identical(result$display, c(unicode, NA_character_, ""))
  expect_identical(result$extracted, c(unicode, "NA", ""))
  expect_identical(
    result$preview,
    paste0(paste0('"', unicode, '"', collapse = ", "), ', NA, ""')
  )
  expect_identical(result$list_display, paste0('"', unicode[1:3], '"'))
  expect_identical(
    result$json_roundtrip,
    list(unicode[[1L]], unicode[[2L]], unicode[[3L]], NULL, "")
  )
  expect_true(result$display_omitted)
  expect_identical(
    result$titles,
    c(
      paste0('"', unicode[[1L]], '\\"', '"'),
      paste0("`", unicode[[1L]], " name`")
    )
  )
  for (character in unicode) {
    expect_match(result$json, character, fixed = TRUE)
  }
})

test_that("CP1252 locale retains Unicode when the locale is available", {
  skip_on_cran()
  skip_on_os("windows")
  skip_if_not_installed("callr")
  installed <- file.path(.libPaths(), "jdv")
  installed <- installed[
    file.exists(file.path(installed, "Meta", "package.rds"))
  ]
  if (!length(installed)) {
    skip(
      "A locally installed jdv package is required for the locale subprocess"
    )
  }

  locale_path <- Sys.getenv("JDV_TEST_LOCPATH", unset = "")
  child_env <- c(callr::rcmd_safe_env(), LC_ALL = "en_US.CP1252")
  if (nzchar(locale_path)) {
    child_env <- c(child_env, LOCPATH = locale_path)
  }

  result <- callr::r(
    function(libpath) {
      .libPaths(libpath)
      loadNamespace("jdv")
      if (!identical(l10n_info()[["codeset"]], "CP1252")) {
        return(NULL)
      }
      stopifnot(!l10n_info()[["UTF-8"]])
      value <- intToUtf8(945L)
      list(
        display = jdv:::col_display.default(value),
        preview = jdv:::cell_preview(value),
        title = jdv:::.jdv_title_string(value)
      )
    },
    args = list(libpath = .libPaths()),
    env = child_env,
    timeout = 60
  )
  if (is.null(result)) {
    skip("A CP1252 locale is unavailable")
  }
  alpha <- intToUtf8(945L)
  expect_identical(result$display, alpha)
  expect_identical(result$preview, paste0('"', alpha, '"'))
  expect_identical(result$title, paste0('"', alpha, '"'))
})

test_that("UTF-8 Unicode values survive jdv JSON encoding without display", {
  skip_if_not_installed("jsonlite")
  unicode <- vapply(c(945L, 26481L, 128578L), intToUtf8, character(1L))
  value <- c(unicode, NA_character_, "")
  column <- column_extract(value)
  wire <- .jdv_json_column(column)
  encoded <- .jdv_json_encode(wire$values)

  expect_identical(column$data$display, c(unicode, "NA", ""))
  expect_false("display" %in% names(wire))
  expect_identical(
    jsonlite::fromJSON(encoded, simplifyVector = FALSE),
    list(unicode[[1L]], unicode[[2L]], unicode[[3L]], NULL, "")
  )
})

test_that("classed strings and custom format methods keep their dispatch", {
  skip_if_not_installed("withr")
  classed <- structure("value", class = c("jdv_locale_character", "character"))
  with_locale_format_method(
    "jdv_locale_character",
    function(x, ...) paste0("class:", unclass(x)),
    {
      expect_identical(col_display(classed), "class:value")
    }
  )

  with_locale_global_method(
    "format.character",
    function(x, ...) paste0("global:", x),
    {
      expect_false(.jdv_plain_format_dispatch())
      expect_false(.jdv_plain_string_dispatch())
      expect_identical(col_display("value"), "global:value")
    }
  )

  expect_identical(col_display(factor(c("a", NA))), c("a", "NA"))

  skip_if_not_installed("vctrs")
  vector <- vctrs::new_vctr("value", class = "jdv_locale_vector")
  with_locale_format_method(
    "jdv_locale_vector",
    function(x, ...) paste0("vector:", vctrs::vec_data(x)),
    {
      expect_identical(col_display(vector), "vector:value")
    }
  )
})

test_that("UTF-8 locale string encoding remains encodeString compatible", {
  skip_if_not(isTRUE(l10n_info()[["UTF-8"]]), "A UTF-8 locale is unavailable")
  value <- c(intToUtf8(945L), "a\\b\"c", "\001", NA_character_)
  expect_identical(
    .jdv_encode_string(value, quote = '"'),
    encodeString(value, quote = '"')
  )
})

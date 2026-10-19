with_page_measure_saved_seed <- function(seed, code) {
  had_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  if (had_seed) {
    old_seed <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  }
  on.exit(
    {
      if (had_seed) {
        assign(".Random.seed", old_seed, envir = .GlobalEnv)
      } else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) {
        rm(".Random.seed", envir = .GlobalEnv)
      }
    },
    add = TRUE
  )
  set.seed(seed)
  force(code)
}

test_that("native string measurements bound encoded JSON and tree work", {
  values <- with_page_measure_saved_seed(20261019, {
    alphabet <- c(
      letters,
      LETTERS,
      as.character(0:9),
      " ",
      "-",
      "_",
      "\"",
      "\\",
      "/",
      "é",
      "界",
      "🙂"
    )
    random_ascii <- vapply(
      seq_len(128L),
      function(i) {
        paste0(
          sample(alphabet, sample(0:80, 1L), replace = TRUE),
          collapse = ""
        )
      },
      character(1L)
    )
    c(
      "",
      "a",
      "quote\"",
      "slash/",
      "backslash\\",
      "both\"\\/",
      enc2utf8("é界日本語🙂"),
      strrep("x", 255L),
      strrep("y", 4096L),
      random_ascii
    )
  })

  measured <- .jdv_json_string_measure(values, 1024^2)
  expect_type(measured, "double")
  expect_identical(dim(measured), c(length(values), 3L))
  expect_identical(colnames(measured), NULL)
  expect_true(all(is.finite(measured)))
  expect_true(all(measured >= 0))
  expect_identical(
    unname(measured[, 3L]),
    rep(attr(measured, "node_bytes"), length(values))
  )
  expect_gt(attr(measured, "node_bytes"), 0)

  encoded <- .jdv_json_encode(.jdv_json_values(values))
  actual_bytes <- nchar(encoded, type = "bytes")
  measured_array_bytes <- sum(measured[, 1L]) + length(values) + 1
  expect_gte(measured_array_bytes, actual_bytes)

  work_limit <- sum(measured[, 2L]) +
    attr(measured, "node_bytes") +
    4 * measured_array_bytes +
    4096
  expect_no_error(.jdv_json_encode(
    .jdv_json_values(values),
    work_limit = work_limit
  ))
})

test_that("unsupported strings and measurements over the cap fall back", {
  expect_null(.jdv_json_string_measure(NA_character_, 1024))
  expect_null(.jdv_json_string_measure("line\nbreak", 1024))

  latin1 <- "\xe9"
  Encoding(latin1) <- "latin1"
  expect_null(.jdv_json_string_measure(latin1, 1024))

  bytes <- "\xe9"
  Encoding(bytes) <- "bytes"
  expect_null(.jdv_json_string_measure(bytes, 1024))

  invalid_utf8 <- "\xff"
  Encoding(invalid_utf8) <- "UTF-8"
  expect_null(.jdv_json_string_measure(invalid_utf8, 1024))

  expect_null(.jdv_json_string_measure(rep("", 100L), 100))
  expect_null(.jdv_json_string_measure(strrep("z", 2048L), 1024))
})

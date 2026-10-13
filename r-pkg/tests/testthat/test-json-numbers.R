test_that("finite JSON numbers round-trip without unnecessary digits", {
  encode <- getFromNamespace(".jdv_json_encode", "jdv")

  expect_identical(encode(0.1), "0.1")
  expect_identical(encode(3.14), "3.14")
  expect_identical(encode(0.1 + 0.2), "0.30000000000000004")

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

  set.seed(20261013)
  random <- runif(100000L, min = -1, max = 1)

  values <- unname(c(
    0.1,
    3.14,
    0.1 + 0.2,
    1 / 3,
    1e-20,
    5e-324,
    .Machine$double.xmax,
    2^53 + 2,
    random
  ))
  encoded <- encode(structure(values, class = "jdv_json_array"))
  text_values <- strsplit(
    substring(encoded, 2L, nchar(encoded) - 1L),
    ",",
    fixed = TRUE
  )[[1L]]

  expect_identical(as.numeric(text_values), values)
})

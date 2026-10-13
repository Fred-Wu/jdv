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

test_that(
  "wide-exponent JSON numbers round-trip through a correctly rounded parser",
  {
    skip_if_not_installed("jsonlite")
    encode <- getFromNamespace(".jdv_json_encode", "jdv")

    had_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
    if (had_seed) {
      old_seed <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
    }
    on.exit(
      {
        if (had_seed) {
          assign(".Random.seed", old_seed, envir = .GlobalEnv)
        } else if (
          exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
        ) {
          rm(".Random.seed", envir = .GlobalEnv)
        }
      },
      add = TRUE
    )

    set.seed(20261013)
    bits <- as.raw(sample.int(256L, 8L * 100000L, replace = TRUE) - 1L)
    connection <- rawConnection(bits, open = "rb")
    on.exit(close(connection), add = TRUE)
    values <- readBin(
      connection,
      what = double(),
      n = length(bits) %/% 8L,
      size = 8L,
      endian = .Platform$endian
    )
    values <- values[is.finite(values) & values != 0]

    encoded <- encode(structure(values, class = "jdv_json_array"))
    parsed <- jsonlite::fromJSON(encoded)
    expect_identical(length(parsed), length(values))

    expected_connection <- rawConnection(raw(), open = "wb")
    actual_connection <- rawConnection(raw(), open = "wb")
    on.exit(close(expected_connection), add = TRUE)
    on.exit(close(actual_connection), add = TRUE)
    writeBin(values, expected_connection, size = 8L, endian = .Platform$endian)
    writeBin(parsed, actual_connection, size = 8L, endian = .Platform$endian)
    expect_identical(
      rawConnectionValue(actual_connection),
      rawConnectionValue(expected_connection)
    )
  }
)

test_that("JSON encoder enforces its native work budget", {
  encode <- getFromNamespace(".jdv_json_encode", "jdv")

  value <- structure(
    c('quote"', "backslash\\", "line\nbreak", "é", "\u0001"),
    class = "jdv_json_array"
  )
  expect_identical(
    encode(value, limit = 1024, work_limit = 1024^2),
    '["quote\\\"","backslash\\\\","line\\nbreak","é","\\u0001"]'
  )

  oversized_string <- strrep("x", 10000L)
  error <- tryCatch(
    encode(oversized_string, limit = 1024^2, work_limit = 1024),
    error = identity
  )
  expect_s3_class(error, "jdv_query_error")
  expect_identical(error$code, "limit_exceeded")

  repeated <- structure(rep("x", 1000L), class = "jdv_json_array")
  error <- tryCatch(
    encode(repeated, limit = 1024^2, work_limit = 1024),
    error = identity
  )
  expect_s3_class(error, "jdv_query_error")
  expect_identical(error$code, "limit_exceeded")
})

test_that("JSON output and native work budgets report the same limit code", {
  encode <- getFromNamespace(".jdv_json_encode", "jdv")

  error <- tryCatch(
    encode(strrep("x", 32L), limit = 16, work_limit = 1024^2),
    error = identity
  )
  expect_s3_class(error, "jdv_query_error")
  expect_identical(error$code, "limit_exceeded")
})

test_that("UTF-8 translations are released after each streamed JSON tree", {
  encode <- getFromNamespace(".jdv_json_encode", "jdv")
  latin1 <- iconv(c("café", "über"), from = "UTF-8", to = "latin1")
  expect_identical(Encoding(latin1), c("latin1", "latin1"))

  columns <- list(columns = unname(list(latin1, rev(latin1))))
  expect_identical(
    encode(columns, limit = 1024, work_limit = 1024),
    '{"columns":[["café","über"],["über","café"]]}'
  )

  keys <- enc2utf8(paste0("日本語-", seq_len(64L)))
  object <- as.list(seq_len(64L))
  names(object) <- keys
  expected <- paste0(
    "{",
    paste0('"', keys, '":', seq_len(64L), collapse = ","),
    "}"
  )
  expect_identical(encode(object, limit = 8192, work_limit = 1024^2), expected)
})

test_that(
  "a translation-time work-limit error does not break the next encode",
  {
    encode <- getFromNamespace(".jdv_json_encode", "jdv")
    short_latin1 <- iconv("café", from = "UTF-8", to = "latin1")
    long_latin1 <- iconv(
      paste(rep("é", 80L), collapse = ""),
      from = "UTF-8",
      to = "latin1"
    )

    error <- tryCatch(
      encode(long_latin1, limit = 1024, work_limit = 1024),
      error = identity
    )
    expect_s3_class(error, "jdv_query_error")
    expect_identical(error$code, "limit_exceeded")
    expect_identical(
      encode(short_latin1, limit = 1024, work_limit = 1024),
      '"café"'
    )
  }
)

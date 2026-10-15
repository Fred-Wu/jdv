page_roundtrip <- function(stream, max_rows = 200L, max_bytes = 1048576) {
  token <- jdv:::.jdv_stream_move(stream)
  on.exit(jdv:::.jdv_stream_close(token), add = TRUE)
  descriptor <- jdv:::.jdv_stream_open(token)
  pages <- list()
  repeat {
    page <- jdv:::.jdv_stream_page(token, max_rows, max_bytes)
    pages[[length(pages) + 1L]] <- page
    if (isTRUE(page$done)) {
      break
    }
    if (page$rows_fetched == 0) break
  }
  list(descriptor = descriptor, pages = pages)
}

decode_page <- function(payload) {
  connection <- rawConnection(payload)
  on.exit(try(close(connection), silent = TRUE), add = TRUE)
  arrow::read_ipc_stream(connection, as_data_frame = FALSE)
}

compile_pagefixture <- function(work, output) {
  skip_on_cran()
  system2(
    file.path(R.home("bin"), "R"),
    c(
      "CMD",
      "SHLIB",
      "-o",
      shQuote(output),
      shQuote(file.path(work, "pagefixture.c"))
    ),
    stdout = TRUE,
    stderr = TRUE
  )
}

test_that("sequential pages preserve row order and only report observed EOF", {
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  result <- page_roundtrip(
    nanoarrow::as_nanoarrow_array_stream(data.frame(
      id = c(11L, 12L, 13L),
      label = c("a", "b", "c")
    )),
    max_rows = 2L
  )
  expect_identical(unlist(result$descriptor$mapping), c(0L, 1L))
  expect_length(result$pages, 3L)
  expect_identical(
    lapply(
      result$pages,
      function(x) c(x$first_row, x$rows_fetched, x$rows_seen, x$done)
    ),
    list(c(0, 2, 2, FALSE), c(2, 1, 3, FALSE), c(3, 0, 3, TRUE))
  )
  expect_gt(length(result$pages[[3]]$payload), 0L)
  expect_identical(
    as.data.frame(decode_page(result$pages[[3]]$payload)),
    data.frame(id = integer(), label = character())
  )
  observed <- do.call(
    rbind,
    lapply(result$pages[1:2], function(x) as.data.frame(decode_page(x$payload)))
  )
  expect_identical(observed$id, c(11L, 12L, 13L))
  expect_identical(observed$label, c("a", "b", "c"))
})

test_that("page slicing adds the parent struct offset to unoffset children", {
  skip_on_cran()
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  work <- tempfile("jdv-page-parent-offset-")
  dir.create(work)
  work <- normalizePath(work, winslash = "/", mustWork = TRUE)
  output <- file.path(work, paste0("pagefixture", .Platform$dynlib.ext))
  dll <- NULL
  token <- NULL
  on.exit(
    {
      if (!is.null(token)) {
        try(jdv:::.jdv_stream_close(token), silent = TRUE)
      }
      if (!is.null(dll)) {
        dyn.unload(output)
      }
      unlink(work, recursive = TRUE)
    },
    add = TRUE
  )
  fixture <- test_path("fixtures", "pagefixture.c")
  file.copy(fixture, work)
  include <- system.file("include", package = "nanoarrow")
  old_flags <- Sys.getenv("PKG_CPPFLAGS", unset = NA_character_)
  on.exit(
    if (is.na(old_flags)) {
      Sys.unsetenv("PKG_CPPFLAGS")
    } else {
      Sys.setenv(PKG_CPPFLAGS = old_flags)
    },
    add = TRUE
  )
  Sys.setenv(PKG_CPPFLAGS = paste0("-I", shQuote(include)))
  log <- compile_pagefixture(work, output)
  expect_null(attr(log, "status"), info = paste(log, collapse = "\n"))
  expect_true(file.exists(output), info = paste(log, collapse = "\n"))
  dll <- dyn.load(output)
  pointer <- getExportedValue("nanoarrow", "nanoarrow_allocate_array_stream")()
  init <- getDLLRegisteredRoutines(dll)[[".Call"]][["pagefixture_init"]]
  .Call(init, pointer, 0L)
  token <- jdv:::.jdv_stream_move(pointer)
  jdv:::.jdv_stream_open(token)
  page <- jdv:::.jdv_stream_page(token, 10L, 100000L)
  observed <- as.data.frame(decode_page(page$payload))
  expect_identical(observed$value, c(20L, 30L))
  expect_identical(page$rows_seen, 2)
})

test_that("unsupported top-level fields are mapped out without losing rows", {
  skip_on_cran()
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  work <- tempfile("jdv-page-unsupported-")
  dir.create(work)
  work <- normalizePath(work, winslash = "/", mustWork = TRUE)
  output <- file.path(work, paste0("pagefixture", .Platform$dynlib.ext))
  dll <- NULL
  token <- NULL
  on.exit(
    {
      if (!is.null(token)) {
        try(jdv:::.jdv_stream_close(token), silent = TRUE)
      }
      if (!is.null(dll)) {
        dyn.unload(output)
      }
      unlink(work, recursive = TRUE)
    },
    add = TRUE
  )
  file.copy(test_path("fixtures", "pagefixture.c"), work)
  include <- system.file("include", package = "nanoarrow")
  old_flags <- Sys.getenv("PKG_CPPFLAGS", unset = NA_character_)
  on.exit(
    if (is.na(old_flags)) {
      Sys.unsetenv("PKG_CPPFLAGS")
    } else {
      Sys.setenv(PKG_CPPFLAGS = old_flags)
    },
    add = TRUE
  )
  Sys.setenv(PKG_CPPFLAGS = paste0("-I", shQuote(include)))
  log <- compile_pagefixture(work, output)
  expect_null(attr(log, "status"), info = paste(log, collapse = "\n"))
  expect_true(file.exists(output), info = paste(log, collapse = "\n"))
  dll <- dyn.load(output)
  pointer <- getExportedValue("nanoarrow", "nanoarrow_allocate_array_stream")()
  init <- getDLLRegisteredRoutines(dll)[[".Call"]][["pagefixture_init"]]
  .Call(init, pointer, 1L)
  token <- jdv:::.jdv_stream_move(pointer)
  descriptor <- jdv:::.jdv_stream_open(token)
  expect_length(descriptor$columns, 1L)
  expect_identical(
    descriptor$columns[[1]]$unsupported,
    "list_view columns are not supported"
  )
  expect_null(descriptor$columns[[1]]$ipc_index)
  expect_null(descriptor$mapping[[1]])
  page <- jdv:::.jdv_stream_page(token, 10L, 512L)
  expect_false(page$done)
  expect_gt(length(page$payload), 0L)
  expect_identical(page$rows_fetched, 1)
  expect_equal(ncol(as.data.frame(decode_page(page$payload))), 0L)
  eof <- jdv:::.jdv_stream_page(token, 10L, 512L)
  expect_true(eof$done)
  expect_identical(eof$rows_fetched, 0)

  expect_true(jdv:::.jdv_stream_close(token))
  pointer <- getExportedValue("nanoarrow", "nanoarrow_allocate_array_stream")()
  .Call(init, pointer, 2L)
  token <- jdv:::.jdv_stream_move(pointer)
  jdv:::.jdv_stream_open(token)
  nested_page <- jdv:::.jdv_stream_page(token, 10L, 100000L)
  nested_table <- decode_page(nested_page$payload)
  nested_values <- as.data.frame(nested_table)$items[[1]]
  expect_identical(as.character(nested_values), c("alpha", "beta"))

  expect_true(jdv:::.jdv_stream_close(token))
  token <- NULL
  for (mode in 3:5) {
    pointer <- getExportedValue(
      "nanoarrow",
      "nanoarrow_allocate_array_stream"
    )()
    .Call(init, pointer, as.integer(mode))
    token <- jdv:::.jdv_stream_move(pointer)
    descriptor <- jdv:::.jdv_stream_open(token)
    page <- jdv:::.jdv_stream_page(token, 1L, 1024L)
    expect_identical(page$rows_fetched, 1)
    expect_lte(length(page$payload), 1024L)
    decoded <- decode_page(page$payload)
    if (mode == 5) {
      expect_identical(
        decoded$schema$GetFieldByName("group")$type$fields()[[
          1
        ]]$type$ToString(),
        "large_string"
      )
      expect_identical(
        descriptor$schema$children[[1]]$children[[1]]$format,
        "vu"
      )
    }
    expect_true(jdv:::.jdv_stream_close(token))
    token <- NULL
  }
})

test_that("dictionary and nested list pages are self-contained", {
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  dictionary <- arrow::DictionaryArray$create(
    c(0L, 1L, 0L),
    dict = c("alpha", "beta")
  )
  dictionary_reader <- arrow::as_record_batch_reader(arrow::Table$create(
    category = dictionary
  ))
  dict_result <- page_roundtrip(
    nanoarrow::as_nanoarrow_array_stream(dictionary_reader),
    max_rows = 2L
  )
  dict_values <- unlist(
    lapply(
      dict_result$pages[1:2],
      function(x) as.data.frame(decode_page(x$payload))$category
    ),
    use.names = FALSE
  )
  expect_identical(as.character(dict_values), c("alpha", "beta", "alpha"))

  items <- arrow::Array$create(list(c(1L, 2L), integer(), c(3L)))
  list_reader <- arrow::as_record_batch_reader(arrow::Table$create(
    items = items
  ))
  list_result <- page_roundtrip(
    nanoarrow::as_nanoarrow_array_stream(list_reader),
    max_rows = 2L
  )
  list_values <- lapply(
    list_result$pages[1:2],
    function(x) as.data.frame(decode_page(x$payload))$items
  )
  expect_identical(
    unlist(list_values, recursive = FALSE),
    list(c(1L, 2L), integer(), 3L)
  )
})

test_that(
  "pages preserve exact wide numeric, decimal, time, and binary values",
  {
    skip_if_not_installed("nanoarrow")
    skip_if_not_installed("arrow")
    skip_if_not_installed("bit64")
    wide <- arrow::Table$create(
      int64 = arrow::Array$create(
        bit64::as.integer64(c("9007199254740993", "-9007199254740995")),
        type = arrow::int64()
      ),
      uint64 = arrow::Array$create(c(
        "9007199254740993",
        "18446744073709551615"
      ))$cast(arrow::uint64()),
      decimal128 = arrow::Array$create(c(
        "12345678901234567890.1234567890",
        "-0.0000000123"
      ))$cast(arrow::decimal128(30, 10)),
      decimal256 = arrow::Array$create(c(
        "1234567890123456789012345678901234567890.1234567890",
        "-1234567890123456789012345678901234567890.1234567890"
      ))$cast(arrow::decimal256(50, 10)),
      timestamp_ns_utc = arrow::Array$create(
        bit64::as.integer64(c("1791981296123456789", "-1")),
        type = arrow::int64()
      )$cast(arrow::timestamp("ns", "UTC")),
      duration_ns = arrow::Array$create(
        bit64::as.integer64(c("1", "-123456789")),
        type = arrow::int64()
      )$cast(arrow::duration("ns")),
      binary = arrow::Array$create(
        list(as.raw(c(0, 1, 255)), as.raw(c(65, 0, 66))),
        type = arrow::binary()
      )
    )
    result <- page_roundtrip(
      nanoarrow::as_nanoarrow_array_stream(arrow::as_record_batch_reader(wide)),
      max_rows = 2L
    )
    observed <- decode_page(result$pages[[1]]$payload)
    as_utf8 <- function(name) {
      index <- match(name, names(observed)) - 1L
      as.character(observed$column(index)$cast(arrow::utf8())$as_vector())
    }
    expect_identical(
      as_utf8("int64"),
      c("9007199254740993", "-9007199254740995")
    )
    expect_identical(
      as_utf8("uint64"),
      c("9007199254740993", "18446744073709551615")
    )
    expect_identical(
      as_utf8("decimal128"),
      c("12345678901234567890.1234567890", "-1.23E-8")
    )
    expect_identical(
      as_utf8("decimal256"),
      c(
        "1234567890123456789012345678901234567890.1234567890",
        "-1234567890123456789012345678901234567890.1234567890"
      )
    )
    timestamp_ticks <- observed$column(
      match("timestamp_ns_utc", names(observed)) - 1L
    )$cast(arrow::int64())
    expect_identical(
      as.character(timestamp_ticks$as_vector()),
      c("1791981296123456789", "-1")
    )
    duration_ticks <- observed$column(
      match("duration_ns", names(observed)) - 1L
    )$cast(arrow::int64())
    expect_identical(
      as.character(duration_ticks$as_vector()),
      c("1", "-123456789")
    )
    expect_identical(
      as.list(
        observed$column(match("binary", names(observed)) - 1L)$as_vector()
      ),
      list(as.raw(c(0, 1, 255)), as.raw(c(65, 0, 66)))
    )
    expect_match(result$descriptor$schema$children[[5]]$format, "UTC")

    map_array <- arrow::Array$create(
      list(
        data.frame(key = c("a", "b"), value = c(1L, 2L)),
        data.frame(key = character(), value = integer())
      ),
      type = arrow::map_of(arrow::utf8(), arrow::int32())
    )
    map_result <- page_roundtrip(
      nanoarrow::as_nanoarrow_array_stream(arrow::Table$create(
        entries = map_array
      )),
      max_rows = 2L
    )
    expect_identical(map_result$descriptor$columns[[1]]$type, "+m")
    expect_identical(map_result$pages[[1]]$rows_fetched, 2)
    expect_gt(length(map_result$pages[[1]]$payload), 0L)

    extension_schema <- arrow::schema(arrow::field(
      "payload",
      arrow::int32(),
      metadata = c(
        "ARROW:extension:name" = "org.example.test",
        "ARROW:extension:metadata" = "v1"
      )
    ))
    extension_batch <- arrow::RecordBatch$create(
      payload = arrow::Array$create(c(1L, 2L), type = arrow::int32()),
      schema = extension_schema
    )
    extension_result <- page_roundtrip(nanoarrow::as_nanoarrow_array_stream(arrow::RecordBatchReader$create(
      extension_batch
    )))
    field_metadata <- decode_page(extension_result$pages[[
      1
    ]]$payload)$schema$GetFieldByName("payload")$metadata
    expect_identical(
      field_metadata[["ARROW:extension:name"]],
      "org.example.test"
    )
    expect_identical(field_metadata[["ARROW:extension:metadata"]], "v1")
  }
)

test_that("dictionary replacement remains batch scoped and is recopied", {
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  first <- arrow::DictionaryArray$create(c(0L, 1L), dict = c("alpha", "beta"))
  second <- arrow::DictionaryArray$create(c(0L, 1L), dict = c("gamma", "delta"))
  reader <- arrow::RecordBatchReader$create(
    arrow::RecordBatch$create(category = first),
    arrow::RecordBatch$create(category = second)
  )
  token <- jdv:::.jdv_stream_move(nanoarrow::as_nanoarrow_array_stream(reader))
  on.exit(jdv:::.jdv_stream_close(token), add = TRUE)
  jdv:::.jdv_stream_open(token)
  page1 <- jdv:::.jdv_stream_page(token, 10L, 100000L)
  page2 <- jdv:::.jdv_stream_page(token, 10L, 100000L)
  expect_identical(page1$rows_fetched, 2)
  expect_identical(page2$first_row, 2)
  expect_identical(page2$rows_fetched, 2)
  expect_identical(
    as.character(decode_page(page1$payload)$category),
    c("alpha", "beta")
  )
  expect_identical(
    as.character(decode_page(page2$payload)$category),
    c("gamma", "delta")
  )
  nested <- arrow::StructArray$create(
    category = arrow::DictionaryArray$create(
      c(0L, 1L, 0L),
      dict = c("nested-a", "nested-b")
    ),
    score = c(1L, 2L, 3L)
  )
  nested_result <- page_roundtrip(
    nanoarrow::as_nanoarrow_array_stream(arrow::Table$create(group = nested)),
    max_rows = 2L
  )
  nested_values <- do.call(
    rbind,
    lapply(
      nested_result$pages[1:2],
      function(page) as.data.frame(decode_page(page$payload))$group
    )
  )
  expect_identical(
    as.character(nested_values$category),
    c("nested-a", "nested-b", "nested-a")
  )
})

test_that("byte budget splits batches and empty batches do not imply EOF", {
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  stream <- nanoarrow::as_nanoarrow_array_stream(data.frame(
    value = rep(strrep("x", 100L), 5L)
  ))
  token <- jdv:::.jdv_stream_move(stream)
  on.exit(jdv:::.jdv_stream_close(token), add = TRUE)
  jdv:::.jdv_stream_open(token)
  first <- jdv:::.jdv_stream_page(token, 5L, 700L)
  expect_gt(first$rows_fetched, 0)
  expect_lt(first$rows_fetched, 5)
  expect_lte(length(first$payload), 700L)
  rest <- list(first)
  while (rest[[length(rest)]]$rows_fetched > 0) {
    rest[[length(rest) + 1L]] <- jdv:::.jdv_stream_page(token, 5L, 700L)
  }
  expect_identical(sum(vapply(rest, `[[`, numeric(1), "rows_fetched")), 5)

  with_arrow_owner(function(owner) {
    empty_token <- jdv:::.jdv_stream_move(owner$stream(lengths = rep(0L, 64L)))
    on.exit(jdv:::.jdv_stream_close(empty_token), add = TRUE)
    jdv:::.jdv_stream_open(empty_token)
    empty_page <- jdv:::.jdv_stream_page(empty_token, 1L, 100000L)
    expect_identical(empty_page$rows_fetched, 0)
    expect_false(empty_page$done)
    expect_gt(length(empty_page$payload), 0L)
    eof_page <- jdv:::.jdv_stream_page(empty_token, 1L, 100000L)
    expect_true(eof_page$done)
    expect_gt(length(eof_page$payload), 0L)
    expect_equal(owner$counts(), c(0, 0, 64, 1))
  })
})

test_that("encoder interrupts unwind cleanly and preserve the page cursor", {
  skip_on_cran()
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  work <- tempfile("jdv-page-interrupt-")
  dir.create(work)
  work <- normalizePath(work, winslash = "/", mustWork = TRUE)
  output <- file.path(work, paste0("pagefixture", .Platform$dynlib.ext))
  file.copy(test_path("fixtures", "pagefixture.c"), work)
  include <- system.file("include", package = "nanoarrow")
  old_flags <- Sys.getenv("PKG_CPPFLAGS", unset = NA_character_)
  on.exit(
    if (is.na(old_flags)) {
      Sys.unsetenv("PKG_CPPFLAGS")
    } else {
      Sys.setenv(PKG_CPPFLAGS = old_flags)
    },
    add = TRUE
  )
  Sys.setenv(PKG_CPPFLAGS = paste0("-I", shQuote(include)))
  compile_log <- compile_pagefixture(work, output)
  expect_null(
    attr(compile_log, "status"),
    info = paste(compile_log, collapse = "\n")
  )
  expect_true(file.exists(output), info = paste(compile_log, collapse = "\n"))
  fixture <- dyn.load(output)
  init <- getDLLRegisteredRoutines(fixture)[[".Call"]][["pagefixture_init"]]
  pointer <- getExportedValue("nanoarrow", "nanoarrow_allocate_array_stream")()
  .Call(init, pointer, 6L)
  token <- jdv:::.jdv_stream_move(pointer)
  on.exit(
    {
      jdv:::.jdv_stream_close(token)
      dyn.unload(output)
      unlink(work, recursive = TRUE)
    },
    add = TRUE
  )
  jdv:::.jdv_stream_open(token)
  first <- jdv:::.jdv_stream_page(token, 1L, 100000L)
  expect_identical(first$first_row, 0)
  expect_identical(first$rows_fetched, 1)
  expect_identical(as.data.frame(decode_page(first$payload))$value, 101L)

  interrupted <- tryCatch(
    jdv:::.jdv_stream_page(token, 1L, 100000L),
    interrupt = identity
  )
  expect_s3_class(interrupted, "interrupt")

  retry <- jdv:::.jdv_stream_page(token, 1L, 100000L)
  expect_identical(retry$first_row, 1)
  expect_identical(retry$rows_fetched, 1)
  expect_identical(retry$rows_seen, 2)
  expect_identical(as.data.frame(decode_page(retry$payload))$value, 202L)
})

test_that("only a null release callback marks producer EOF", {
  with_arrow_owner(function(owner) {
    token <- jdv:::.jdv_stream_move(owner$stream(
      lengths = integer(),
      mode = 3L
    ))
    on.exit(jdv:::.jdv_stream_close(token), add = TRUE)
    jdv:::.jdv_stream_open(token)
    page <- jdv:::.jdv_stream_page(token, 1L, 100000L)
    expect_true(page$done)
    expect_identical(page$rows_fetched, 0)
    expect_gt(length(page$payload), 0L)
    expect_equal(owner$counts(), c(0, 0, 0, 1))
  })
})

test_that("Polars string_view is normalized to large_string in page IPC", {
  skip_if_not_installed("polars")
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  source <- polars::pl$DataFrame(label = c("alpha", "beta"))
  stream <- nanoarrow::as_nanoarrow_array_stream(source)
  expect_identical(stream$get_schema()$children[[1]]$format, "vu")
  result <- page_roundtrip(stream, max_rows = 2L)
  expect_identical(result$descriptor$schema$children[[1]]$format, "vu")
  observed <- as.data.frame(decode_page(result$pages[[1]]$payload))
  expect_identical(observed$label, c("alpha", "beta"))
  nested <- polars::pl$DataFrame(items = list(c("a", "b"), character()))
  nested_stream <- nanoarrow::as_nanoarrow_array_stream(nested)
  nested_schema <- nested_stream$get_schema()
  expect_identical(nested_schema$children[[1]]$format, "+L")
  expect_identical(nested_schema$children[[1]]$children[[1]]$format, "vu")
  nested_result <- page_roundtrip(nested_stream, max_rows = 2L)
  nested_values <- as.data.frame(decode_page(nested_result$pages[[
    1
  ]]$payload))$items
  expect_identical(nested_values[[1]], c("a", "b"))
  expect_length(nested_values[[2]], 0L)
})

test_that("a single row over max_bytes fails the cursor explicitly", {
  skip_if_not_installed("nanoarrow")
  token <- jdv:::.jdv_stream_move(nanoarrow::as_nanoarrow_array_stream(data.frame(
    value = strrep("x", 1024L)
  )))
  on.exit(jdv:::.jdv_stream_close(token), add = TRUE)
  jdv:::.jdv_stream_open(token)
  condition <- tryCatch(
    jdv:::.jdv_stream_page(token, 1L, 64L),
    jdv_stream_error = identity
  )
  expect_s3_class(condition, "jdv_stream_error")
  expect_identical(condition$code, "limit_exceeded")
  expect_true(condition$terminal)
  failed <- tryCatch(
    jdv:::.jdv_stream_page(token, 1L, 1024L),
    jdv_stream_error = identity
  )
  expect_identical(failed$code, "limit_exceeded")
  expect_error(jdv:::.jdv_stream_page(token, 1L, 2^63))
})

test_that("null fixed-width values count toward copy budgets", {
  skip_if_not_installed("nanoarrow")
  skip_if_not_installed("arrow")
  fixed_binary <- arrow::Array$create(
    list(NULL, as.raw(rep(1L, 2048L))),
    type = arrow::fixed_size_binary(2048L)
  )
  fixed_list <- arrow::Array$create(
    list(NULL, rep(1L, 1024L)),
    type = arrow::fixed_size_list_of(arrow::int32(), 1024L)
  )
  hidden_variable_child <- arrow::Array$create(
    list(NULL, strrep("x", 4096L)),
    type = arrow::fixed_size_list_of(arrow::utf8(), 1L)
  )
  token <- jdv:::.jdv_stream_move(nanoarrow::as_nanoarrow_array_stream(arrow::Table$create(
    fixed_binary = fixed_binary,
    fixed_list = fixed_list
  )))
  on.exit(jdv:::.jdv_stream_close(token), add = TRUE)
  jdv:::.jdv_stream_open(token)
  condition <- tryCatch(
    jdv:::.jdv_stream_page(token, 1L, 512L),
    jdv_stream_error = identity
  )
  expect_s3_class(condition, "jdv_stream_error")
  expect_identical(condition$code, "limit_exceeded")
  expect_true(condition$terminal)

  hidden_token <- jdv:::.jdv_stream_move(nanoarrow::as_nanoarrow_array_stream(arrow::Table$create(
    hidden = hidden_variable_child
  )))
  on.exit(jdv:::.jdv_stream_close(hidden_token), add = TRUE)
  jdv:::.jdv_stream_open(hidden_token)
  hidden_page <- jdv:::.jdv_stream_page(hidden_token, 1L, 512L)
  expect_identical(hidden_page$rows_fetched, 1)
  expect_lte(length(hidden_page$payload), 512L)
  hidden_value <- as.data.frame(decode_page(hidden_page$payload))$hidden[[1]]
  expect_null(hidden_value)
})

test_that("producer callback errors terminally release page resources", {
  with_arrow_owner(function(owner) {
    schema_token <- jdv:::.jdv_stream_move(owner$stream(
      hook = function(event) {
        if (event == "schema") stop("schema callback failure")
      }
    ))
    schema_error <- tryCatch(
      jdv:::.jdv_stream_open(schema_token),
      jdv_stream_error = identity
    )
    expect_s3_class(schema_error, "jdv_stream_error")
    expect_identical(schema_error$code, "producer_error")
    expect_true(schema_error$terminal)
    expect_equal(owner$counts(), c(1, 1, 0, 0))
    expect_true(jdv:::.jdv_stream_close(schema_token))

    next_token <- jdv:::.jdv_stream_move(owner$stream(
      hook = function(event) if (event == "next") stop("next callback failure")
    ))
    jdv:::.jdv_stream_open(next_token)
    next_error <- tryCatch(
      jdv:::.jdv_stream_page(next_token, 10L, 100000L),
      jdv_stream_error = identity
    )
    expect_s3_class(next_error, "jdv_stream_error")
    expect_identical(next_error$code, "producer_error")
    expect_true(next_error$terminal)
    expect_equal(owner$counts(), c(2, 2, 1, 0))
    expect_true(jdv:::.jdv_stream_close(next_token))

    return_token <- jdv:::.jdv_stream_move(owner$stream(mode = 1L))
    jdv:::.jdv_stream_open(return_token)
    return_error <- tryCatch(
      jdv:::.jdv_stream_page(return_token, 10L, 100000L),
      jdv_stream_error = identity
    )
    expect_s3_class(return_error, "jdv_stream_error")
    expect_identical(return_error$code, "producer_error")
    expect_true(return_error$terminal)
    expect_equal(owner$counts(), c(3, 3, 2, 0))
    expect_true(jdv:::.jdv_stream_close(return_token))

    schema_return_token <- jdv:::.jdv_stream_move(owner$stream(mode = 2L))
    schema_return_error <- tryCatch(
      jdv:::.jdv_stream_open(schema_return_token),
      jdv_stream_error = identity
    )
    expect_s3_class(schema_return_error, "jdv_stream_error")
    expect_identical(schema_return_error$code, "producer_error")
    expect_true(schema_return_error$terminal)
    expect_equal(owner$counts(), c(4, 4, 2, 0))
    expect_true(jdv:::.jdv_stream_close(schema_return_token))

    reentrant_token <- NULL
    reentry_error <- NULL
    release_token <- jdv:::.jdv_stream_move(owner$stream(
      mode = 4L,
      hook = function(event) {
        if (event == "array_release") {
          reentry_error <<- tryCatch(
            jdv:::.jdv_stream_close(reentrant_token),
            error = identity
          )
          stop("release callback interrupted before clearing release")
        }
      }
    ))
    reentrant_token <- release_token
    jdv:::.jdv_stream_open(release_token)
    release_error <- tryCatch(
      jdv:::.jdv_stream_page(release_token, 1L, 100000L),
      jdv_stream_error = identity
    )
    expect_s3_class(release_error, "jdv_stream_error")
    expect_identical(release_error$code, "producer_error")
    expect_true(release_error$terminal)
    expect_s3_class(reentry_error, "error")
    expect_equal(owner$counts(), c(5, 5, 3, 0))
    expect_true(jdv:::.jdv_stream_close(release_token))
    expect_equal(owner$counts(), c(5, 5, 3, 0))

    interrupt_token <- jdv:::.jdv_stream_move(owner$stream(
      hook = function(event) if (event == "next") interrupt()
    ))
    jdv:::.jdv_stream_open(interrupt_token)
    interrupt_error <- tryCatch(
      jdv:::.jdv_stream_page(interrupt_token, 1L, 100000L),
      jdv_stream_error = identity
    )
    expect_s3_class(interrupt_error, "jdv_stream_error")
    expect_identical(interrupt_error$code, "producer_error")
    expect_true(interrupt_error$terminal)
    expect_equal(owner$counts(), c(6, 6, 4, 0))
    expect_true(jdv:::.jdv_stream_close(interrupt_token))
  })
})

test_that("legacy stream callbacks reject page-owned cursors in every state", {
  with_arrow_owner(function(owner) {
    expect_legacy_rejection <- function(token) {
      before <- owner$counts()
      expect_error(jdv:::.jdv_stream_schema(token), "sequential page cursor")
      expect_error(jdv:::.jdv_stream_next(token), "sequential page cursor")
      expect_identical(owner$counts(), before)
    }

    opened <- jdv:::.jdv_stream_move(owner$stream(lengths = integer()))
    on.exit(jdv:::.jdv_stream_close(opened), add = TRUE)
    jdv:::.jdv_stream_open(opened)
    expect_legacy_rejection(opened)

    failed_open <- jdv:::.jdv_stream_move(owner$stream(mode = 2L))
    on.exit(jdv:::.jdv_stream_close(failed_open), add = TRUE)
    schema_error <- tryCatch(
      jdv:::.jdv_stream_open(failed_open),
      jdv_stream_error = identity
    )
    expect_identical(schema_error$code, "producer_error")
    expect_true(schema_error$terminal)
    expect_legacy_rejection(failed_open)

    failed_page <- jdv:::.jdv_stream_move(owner$stream(mode = 1L))
    on.exit(jdv:::.jdv_stream_close(failed_page), add = TRUE)
    jdv:::.jdv_stream_open(failed_page)
    producer_error <- tryCatch(
      jdv:::.jdv_stream_page(failed_page, 1L, 100000L),
      jdv_stream_error = identity
    )
    expect_identical(producer_error$code, "producer_error")
    expect_true(producer_error$terminal)
    expect_legacy_rejection(failed_page)

    over_budget <- jdv:::.jdv_stream_move(owner$stream(lengths = 1L))
    on.exit(jdv:::.jdv_stream_close(over_budget), add = TRUE)
    jdv:::.jdv_stream_open(over_budget)
    budget_error <- tryCatch(
      jdv:::.jdv_stream_page(over_budget, 1L, 1L),
      jdv_stream_error = identity
    )
    expect_identical(budget_error$code, "limit_exceeded")
    expect_true(budget_error$terminal)
    expect_legacy_rejection(over_budget)
  })
})

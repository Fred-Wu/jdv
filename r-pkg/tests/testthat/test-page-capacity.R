page_capacity_rows <- function(holder, exact_strings = TRUE) {
  rows <- seq_len(holder$nrow)
  .jdv_page_row_capacity(
    holder,
    seq_len(ncol(holder$source)),
    rows,
    length(rows),
    .jdv_budget(64 * 1024^2),
    exact_strings = exact_strings
  )
}

page_capacity_s3_method <- function(generic, class, envir, method, code) {
  table <- get(".__S3MethodsTable__.", envir = envir)
  name <- paste(generic, class, sep = ".")
  had <- exists(name, envir = table, inherits = FALSE)
  previous <- if (had) get(name, envir = table)
  registerS3method(generic, class, method, envir = envir)
  on.exit({
    if (had) {
      assign(name, previous, envir = table)
    } else if (exists(name, envir = table, inherits = FALSE)) {
      rm(list = name, envir = table)
    }
  })
  force(code())
}

page_capacity_global_method <- function(name, method, code) {
  had <- exists(name, envir = .GlobalEnv, inherits = FALSE)
  previous <- if (had) get(name, envir = .GlobalEnv, inherits = FALSE)
  assign(name, method, envir = .GlobalEnv)
  on.exit({
    if (had) {
      assign(name, previous, envir = .GlobalEnv)
    } else if (exists(name, envir = .GlobalEnv, inherits = FALSE)) {
      rm(list = name, envir = .GlobalEnv)
    }
  })
  force(code())
}

page_capacity_wire_encode <- function(page, work_budget) {
  .jdv_json_encode(
    list(
      view = "v-page-capacity",
      generation = 1,
      total = page$total,
      total_unfiltered = page$total_unfiltered,
      offset = page$offset,
      limit = page$limit,
      data = list(
        source_row = .jdv_json_values(page$data$row_index - 1L),
        row_labels = NULL,
        columns = lapply(page$data$columns, .jdv_page_column)
      )
    ),
    limit = .jdv_max_message_bytes(),
    work_limit = .jdv_budget_remaining(work_budget)
  )
}

test_that("plain string capacity returns and encodes 500 rows", {
  source <- as.data.frame(
    matrix(rep(strrep("x", 20L), 500L * 150L), nrow = 500L),
    stringsAsFactors = FALSE
  )
  names(source) <- paste0("text", seq_len(ncol(source)))
  holder <- paged_table(source)
  budget <- .jdv_budget(64 * 1024^2)
  page <- query_page(holder, limit = 500L, budget = budget)

  expect_identical(page$limit, 500L)
  work_budget <- attr(page, "jdv_work_budget")
  encoded <- page_capacity_wire_encode(page, work_budget)
  expect_lte(nchar(encoded, type = "bytes"), .jdv_max_message_bytes())
  expect_lte(work_budget$used, work_budget$limit)
})

test_that("plain strings with missing values retain exact page capacity", {
  source <- matrix(strrep("x", 20L), nrow = 500L, ncol = 150L)
  source[seq.int(10L, length(source), by = 10L)] <- NA_character_
  holder <- paged_table(source)
  fallback <- page_capacity_rows(holder, exact_strings = FALSE)

  page <- query_page(holder, limit = 500L, budget = .jdv_budget(64 * 1024^2))

  expect_identical(page$limit, 500L)
  expect_gt(page$limit, fallback)
  expect_false(any(vapply(
    page$data$columns,
    function(column) "display" %in% names(.jdv_json_column(column)),
    logical(1L)
  )))
  work_budget <- attr(page, "jdv_work_budget")
  encoded <- page_capacity_wire_encode(page, work_budget)
  expect_lte(nchar(encoded, type = "bytes"), .jdv_max_message_bytes())
  expect_lte(work_budget$used, work_budget$limit)
})

test_that(
  "missing and literal NA strings encode their values and display mask",
  {
    values <- c(NA_character_, "NA", "plain", NA_character_)
    column <- column_extract(
      values,
      channels = c("display", "na", "values"),
      schema = column_schema(values)
    )
    wire <- .jdv_json_column(column)

    expect_identical(column$data$display, c("NA", "NA", "plain", "NA"))
    expect_identical(column$data$na, c(TRUE, FALSE, FALSE, TRUE))
    expect_identical(column$data$values, values)
    expect_false("display" %in% names(wire))
    expect_identical(
      .jdv_json_encode(wire$values),
      "[null,\"NA\",\"plain\",null]"
    )
    expect_identical(.jdv_json_encode(wire$na), "[true,false,false,true]")

    all_missing <- column_extract(
      rep(NA_character_, 4L),
      channels = c("display", "na", "values"),
      schema = column_schema("text")
    )
    expect_false("display" %in% names(.jdv_json_column(all_missing)))
    empty <- .jdv_json_string_measure(character(), 1)
    expect_identical(dim(empty), c(0L, 3L))

    holder <- paged_table(data.frame(text = rep(NA_character_, 5L)))
    page <- query_page(holder, limit = 5L, budget = .jdv_budget(64 * 1024^2))
    expect_identical(page$limit, 5L)
    encoded <- page_capacity_wire_encode(page, attr(page, "jdv_work_budget"))
    expect_lte(nchar(encoded, type = "bytes"), .jdv_max_message_bytes())
  }
)

test_that("column wire estimates cover mask bytes near the message limit", {
  text <- rep(strrep("x", 20L), 500L)
  text[c(1L, length(text))] <- NA_character_
  holder <- paged_table(data.frame(text = text))
  full <- query_page(holder, limit = 500L, budget = .jdv_budget(64 * 1024^2))
  full_budget <- attr(full, "jdv_work_budget")
  full_encoded <- page_capacity_wire_encode(full, full_budget)
  full_bytes <- nchar(full_encoded, type = "bytes")

  column <- full$data$columns[[1L]]
  measured <- .jdv_json_string_measure(column$data$values, 64 * 1024^2)
  wire_column <- .jdv_json_column(column)
  values_bytes <- nchar(.jdv_json_encode(wire_column$values), type = "bytes")
  na_bytes <- nchar(.jdv_json_encode(wire_column$na), type = "bytes")
  measured_column_bytes <- sum(measured[, 1L]) +
    length(column$data$values) +
    1L +
    6L * length(column$data$na) +
    1L
  expect_gte(measured_column_bytes, values_bytes + na_bytes)

  old_message_limit <- getOption("jdv.max_message_bytes")
  options(jdv.max_message_bytes = full_bytes - 1L)
  on.exit(options(jdv.max_message_bytes = old_message_limit), add = TRUE)
  bounded <- query_page(holder, limit = 500L, budget = .jdv_budget(64 * 1024^2))
  expect_lt(bounded$limit, 500L)
  bounded_encoded <- page_capacity_wire_encode(
    bounded,
    attr(bounded, "jdv_work_budget")
  )
  expect_lte(nchar(bounded_encoded, type = "bytes"), full_bytes - 1L)
})

test_that("plain string fast path falls back when S3 dispatch changes", {
  holder <- paged_table(data.frame(
    text1 = rep(strrep("x", 200L), 500L),
    text2 = rep(strrep("y", 200L), 500L),
    stringsAsFactors = FALSE
  ))
  fallback <- page_capacity_rows(holder, exact_strings = FALSE)
  jdv_namespace <- asNamespace("jdv")
  methods <- list(
    list("col_display", "character", jdv_namespace),
    list("col_values", "character", jdv_namespace),
    list("col_is_na", "character", jdv_namespace),
    list("col_display", "default", jdv_namespace),
    list("col_is_na", "default", jdv_namespace),
    list("format", "character", baseenv()),
    list("format", "default", baseenv())
  )

  for (entry in methods) {
    generic <- entry[[1L]]
    class <- entry[[2L]]
    envir <- entry[[3L]]
    page_capacity_s3_method(
      generic,
      class,
      envir,
      function(x, ...) x,
      function() {
        expect_false(
          .jdv_plain_string_dispatch(),
          info = paste(generic, class, sep = ".")
        )
        expect_identical(page_capacity_rows(holder), fallback)
      }
    )
  }
})

test_that("plain string fast path respects visible global S3 methods", {
  holder <- paged_table(data.frame(text = rep("plain", 20L)))
  fallback <- page_capacity_rows(holder, exact_strings = FALSE)
  method_cases <- list(
    list(
      name = "col_display.character",
      method = function(x, ...) rep("changed", length(x)),
      channel = "display",
      expected = "changed"
    ),
    list(
      name = "col_values.character",
      method = function(x, ...) rep("changed", length(x)),
      channel = NULL
    ),
    list(
      name = "col_is_na.character",
      method = function(x, ...) rep(TRUE, length(x)),
      channel = NULL
    ),
    list(
      name = "format.character",
      method = function(x, ...) rep("changed", length(x)),
      channel = "display",
      expected = "changed"
    ),
    list(
      name = "col_display.default",
      method = function(x, ...) rep("changed", length(x)),
      channel = NULL
    ),
    list(
      name = "col_is_na.default",
      method = function(x, ...) rep(TRUE, length(x)),
      channel = NULL
    ),
    list(
      name = "format.default",
      method = function(x, ...) rep("changed", length(x)),
      channel = NULL
    )
  )

  for (entry in method_cases) {
    page_capacity_global_method(entry$name, entry$method, function() {
      expect_false(.jdv_plain_string_dispatch(), info = entry$name)
      expect_identical(page_capacity_rows(holder), fallback)
      if (!is.null(entry$channel)) {
        extracted <- column_extract(
          "plain",
          channels = c("display", "na", "values"),
          schema = column_schema("plain")
        )
        expect_identical(extracted$data[[entry$channel]], entry$expected)
      }
    })
  }
})

test_that("visible global default methods disable mixed primitive capacity", {
  holder <- paged_table(data.frame(value = 1:20, text = rep("plain", 20L)))
  fallback <- page_capacity_rows(holder, exact_strings = FALSE)
  for (name in c(
    "col_display.default",
    "col_values.default",
    "col_is_na.default"
  )) {
    page_capacity_global_method(name, function(x, ...) x, function() {
      expect_false(.jdv_plain_query_dispatch("integer"), info = name)
      expect_identical(page_capacity_rows(holder), fallback)
    })
  }
})

test_that("classed, attributed, and nonstandard numeric data use fallback", {
  values <- rep(strrep("x", 200L), 500L)
  attributed <- paged_table(data.frame(
    text = structure(values, label = "custom"),
    stringsAsFactors = FALSE
  ))
  classed <- paged_table(data.frame(
    text = structure(values, class = c("custom_character", "character")),
    stringsAsFactors = FALSE
  ))
  expect_identical(
    page_capacity_rows(attributed),
    page_capacity_rows(attributed, exact_strings = FALSE)
  )
  expect_identical(
    page_capacity_rows(classed),
    page_capacity_rows(classed, exact_strings = FALSE)
  )

  mixed <- paged_table(data.frame(
    value = as.double(seq_len(500L)),
    text = values,
    stringsAsFactors = FALSE
  ))
  old_options <- options(scipen = 999L, digits = 15L, OutDec = ",")
  on.exit(options(old_options), add = TRUE)
  expect_false(.jdv_plain_numeric_format())
  expect_identical(
    page_capacity_rows(mixed),
    page_capacity_rows(mixed, exact_strings = FALSE)
  )
})

test_that("data frame registration shares probes between plain columns", {
  x <- data.frame(
    a = 1:4,
    b = 5:8,
    c = c(1.5, 2, NA, 4),
    d = c(TRUE, NA, FALSE, TRUE)
  )
  holder <- paged_table(x)
  expect_identical(vapply(holder$schema, `[[`, "", "name"), names(x))
  expect_identical(vapply(holder$schema, `[[`, 0L, "position"), 0:3)
  expect_identical(
    vapply(holder$schema, `[[`, "", "type"),
    c("integer", "integer", "number", "boolean")
  )
  expect_true(all(vapply(holder$schema, `[[`, TRUE, "sortable")))
  expect_true(all(vapply(holder$schema, `[[`, TRUE, "filterable")))
})

test_that("shared plain probes never bypass user-defined methods", {
  counters <- new.env(parent = emptyenv())
  counters$display <- 0L
  table <- get(".__S3MethodsTable__.", envir = asNamespace("jdv"))
  registerS3method(
    "col_display",
    "numeric",
    function(x, ...) {
      counters$display <- counters$display + 1L
      format(x)
    },
    envir = asNamespace("jdv")
  )
  on.exit(rm(list = "col_display.numeric", envir = table))
  holder <- paged_table(mtcars[, c("cyl", "gear", "carb")])
  expect_identical(counters$display, 3L)
  expect_length(holder$schema, 3L)
})

test_that("classed and attributed columns are probed individually", {
  x <- mtcars[, c("cyl", "gear")]
  x$gear <- structure(x$gear, label = "gears")
  x$cyl <- factor(x$cyl)
  holder <- paged_table(x)
  expect_identical(holder$schema[[1L]]$type, "factor")
  expect_identical(holder$schema[[2L]]$name, "gear")
})

test_that("shared plain probes respect methods of nested generics", {
  counters <- new.env(parent = emptyenv())
  counters$format <- 0L
  table <- get(".__S3MethodsTable__.", envir = baseenv())
  registerS3method(
    "format",
    "numeric",
    function(x, ...) {
      counters$format <- counters$format + 1L
      format.default(x, ...)
    },
    envir = baseenv()
  )
  on.exit(rm(list = "format.numeric", envir = table))
  expect_false(query_plain_dispatch("double"))
  holder <- paged_table(mtcars[, c("cyl", "gear", "carb")])
  expect_identical(counters$format, 3L)
  expect_length(holder$schema, 3L)
})

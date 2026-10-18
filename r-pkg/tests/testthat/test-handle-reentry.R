test_that("user format methods cannot reenter a running handle", {
  child <- data.frame(value = structure(1:2, class = "jdv_reentry_probe"))
  source <- data.frame(
    nested = I(list(child, child)),
    probe = structure(c(2L, 1L), class = "jdv_reentry_probe")
  )
  handle <- jdv_handle(source, mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)

  observations <- new.env(parent = emptyenv())
  observations$attempted <- FALSE
  with_column_method(
    "format",
    "jdv_reentry_probe",
    function(x, ...) {
      if (!observations$attempted) {
        observations$attempted <- TRUE
        path <- list(list(kind = "cell", row_index = 1L, column = 0L))
        observations$request <- tryCatch(
          jdv_handle_request(
            handle,
            "table/rows",
            list(offset = 0L, limit = 1L)
          ),
          error = identity
        )
        observations$descriptor <- tryCatch(
          jdv_handle_descriptor(handle),
          error = identity
        )
        observations$open <- tryCatch(
          jdv_handle_open(handle, path),
          error = identity
        )
      }
      format(unclass(x), ...)
    },
    {
      page <- jdv_handle_request(
        handle,
        "table/rows",
        list(offset = 0L, limit = 2L)
      )
    }
  )

  expect_type(page, "character")
  expect_true(observations$attempted)
  for (name in c("request", "descriptor", "open")) {
    expect_s3_class(observations[[name]], "jdv_error_in_use")
  }
  expect_silent(jdv_handle_descriptor(handle))
})

test_that("closing a parent during a child query defers cleanup safely", {
  child <- data.frame(value = structure(1:2, class = "jdv_close_probe"))
  parent <- jdv_handle(data.frame(nested = I(list(child))), mode = "paged")
  on.exit(jdv_handle_close(parent), add = TRUE)
  child_handle <- jdv_handle_open(
    parent,
    list(list(kind = "cell", row_index = 1L, column = 0L)),
    mode = "paged"
  )
  on.exit(jdv_handle_close(child_handle), add = TRUE)

  closed <- FALSE
  with_column_method(
    "format",
    "jdv_close_probe",
    function(x, ...) {
      if (!closed) {
        closed <<- TRUE
        jdv_handle_close(parent)
      }
      format(unclass(x), ...)
    },
    {
      request_error <- tryCatch(
        jdv_handle_request(
          child_handle,
          "table/rows",
          list(offset = 0L, limit = 2L)
        ),
        error = identity
      )
    }
  )

  expect_true(closed)
  expect_s3_class(request_error, "jdv_error_view_not_found")
  expect_error(
    jdv_handle_descriptor(child_handle),
    class = "jdv_error_view_not_found"
  )
  expect_silent(jdv_handle_close(parent))
  expect_silent(jdv_handle_close(child_handle))
})

test_that("closing a parent while opening a child rolls the child back", {
  child <- data.frame(value = structure(1:2, class = "jdv_open_close_probe"))
  parent <- jdv_handle(data.frame(nested = I(list(child))), mode = "paged")
  on.exit(jdv_handle_close(parent), add = TRUE)

  closed <- FALSE
  open_error <- NULL
  with_column_method(
    "format",
    "jdv_open_close_probe",
    function(x, ...) {
      if (!closed) {
        closed <<- TRUE
        jdv_handle_close(parent)
      }
      format(unclass(x), ...)
    },
    {
      open_error <- tryCatch(
        jdv_handle_open(
          parent,
          list(list(kind = "cell", row_index = 1L, column = 0L)),
          mode = "paged"
        ),
        error = identity
      )
    }
  )

  expect_true(closed)
  expect_s3_class(open_error, "jdv_error_view_not_found")
  expect_error(
    jdv_handle_descriptor(parent),
    class = "jdv_error_view_not_found"
  )
  expect_silent(jdv_handle_close(parent))
})

test_that("handles reject an observable source dimension change", {
  with_column_method(
    "dim",
    "jdv_mutable_dimensions",
    function(x) c(attr(x, "dimensions", exact = TRUE)$rows, 1L),
    {
      for (mode in c("paged", "snapshot")) {
        dimensions <- new.env(parent = emptyenv())
        dimensions$rows <- 2L
        source <- structure(
          data.frame(value = 1:2),
          class = c("jdv_mutable_dimensions", "data.frame"),
          dimensions = dimensions
        )
        handle <- jdv_handle(source, mode = mode)
        expect_silent(jdv_handle_descriptor(handle))
        dimensions$rows <- 3L
        expect_error(
          jdv_handle_descriptor(handle),
          class = "jdv_error_schema_changed"
        )
        jdv_handle_close(handle)
      }
    }
  )
})

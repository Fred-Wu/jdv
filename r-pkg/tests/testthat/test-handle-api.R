test_that("handle API returns descriptors and result JSON", {
  handle <- jdv_handle(mtcars, mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)

  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  expect_identical(descriptor$kind, "grid")
  expect_identical(descriptor$generation, 1)
  expect_false(descriptor$capabilities$refresh)
  expect_false(descriptor$capabilities$track)

  rows <- .jdv_json_parse(jdv_handle_request(
    handle,
    "grid/rows",
    list(offset = 0L, limit = 2L, cols = 0:2)
  ))
  expect_identical(rows$offset, 0)
  expect_identical(rows$limit, 2)
  expect_length(rows$data$source_row, 2L)
  expect_length(rows$data$columns, 3L)
  expect_error(jdv_handle_request(handle, "grid/rows"), NA)
})

test_that("handle arguments and methods use the agreed error codes", {
  expect_error(jdv_handle(NULL), class = "jdv_error_unsupported")
  expect_error(
    jdv_handle_descriptor(list()),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle(mtcars, mode = "unknown"),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle(mtcars, collation = "unknown"),
    class = "jdv_error_invalid_argument"
  )

  snapshot <- jdv_handle(mtcars, mode = "snapshot")
  on.exit(jdv_handle_close(snapshot), add = TRUE)
  expect_error(
    jdv_handle_request(snapshot, "grid/rows"),
    class = "jdv_error_unsupported"
  )
  for (method in c("object/open", "view/describe", "unknown/method")) {
    expect_error(
      jdv_handle_request(snapshot, method),
      class = "jdv_error_method_not_found"
    )
  }
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(view = "h-999")),
    class = "jdv_error_invalid_request"
  )
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(generation = 1L)),
    class = "jdv_error_invalid_request"
  )
  expect_error(
    jdv_handle_descriptor(snapshot, max_bytes = matrix(8)),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle_request(snapshot, "grid/rows", list(), max_bytes = 0),
    class = "jdv_error_invalid_argument"
  )
})

test_that("byte limits fail cleanly when a single item cannot fit", {
  handle <- jdv_handle(data.frame(value = 1L), mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)
  expect_error(
    jdv_handle_request(
      handle,
      "grid/rows",
      list(offset = 0L, limit = 1L),
      max_bytes = 1
    ),
    class = "jdv_error_limit_exceeded"
  )
  expect_error(
    jdv_handle_descriptor(handle, max_bytes = 1),
    class = "jdv_error_limit_exceeded"
  )
})

test_that("omitted mode and collation use defaults without warnings", {
  expect_warning(handle <- jdv_handle(mtcars), NA)
  on.exit(jdv_handle_close(handle), add = TRUE)
  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  expect_null(descriptor$mode)

  root <- jdv_handle(list(value = data.frame(x = 1L)))
  on.exit(jdv_handle_close(root), add = TRUE)
  child <- jdv_handle_open(root, list(list(type = "index", index = 1L)))
  on.exit(jdv_handle_close(child), add = TRUE)
  expect_null(.jdv_json_parse(jdv_handle_descriptor(child))$mode)
})

test_that("single explicit row labels remain in snapshot data", {
  source <- data.frame(value = 1L, row.names = "named-row")
  handle <- jdv_handle(source, mode = "snapshot")
  on.exit(jdv_handle_close(handle), add = TRUE)
  descriptor <- .jdv_json_parse(jdv_handle_descriptor(handle))
  expect_false("row_labels" %in% names(descriptor))
  expect_identical(descriptor$data$row_labels, list("named-row"))
})

test_that("handles can register captured values as independent views", {
  handle <- jdv_handle(mtcars, mode = "paged", collation = "C")
  on.exit(jdv_handle_close(handle), add = TRUE)
  registered <- jdv_handle_register(handle)
  expect_identical(names(registered), c("id", "generation"))
  expect_identical(registered$generation, 1)
  entry <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
  expect_identical(entry$mode, "paged")
  expect_identical(entry$collation, "C")
  expect_null(entry$track_ref)
  messages <- lapply(jdv_notifications(), .jdv_json_parse)
  opens <- Filter(
    function(message) identical(message$method, "view/open"),
    messages
  )
  expect_true(any(vapply(
    opens,
    function(message) identical(message$params$view, registered$id),
    logical(1L)
  )))
  registered_open <- opens[[
    which(vapply(
      opens,
      function(message) identical(message$params$view, registered$id),
      logical(1L)
    ))
  ]]
  expect_null(registered_open$params$tracking)
  expect_error(
    jdv_handle_register(handle, mode = NULL),
    class = "jdv_error_invalid_argument"
  )
  expect_error(
    jdv_handle_register(handle, collation = NULL),
    class = "jdv_error_invalid_argument"
  )

  overridden <- jdv_handle_register(
    handle,
    title = "explicit handle view",
    mode = "snapshot",
    collation = "locale"
  )
  on.exit(.jdv_close_internal(overridden$id), add = TRUE)
  override_entry <- get(
    overridden$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  )
  expect_identical(override_entry$mode, "snapshot")
  expect_identical(override_entry$collation, "locale")
  expect_identical(override_entry$title, "explicit handle view")

  jdv_handle_close(handle)
  expect_true(exists(
    registered$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  ))
  expect_silent(.jdv_close_internal(registered$id))
})

test_that("handle registration uses an already opened child's captured value", {
  source <- structure(list(mtcars), class = "jdv_registration_bracket_stop")
  with_column_method(
    "[[",
    "jdv_registration_bracket_stop",
    function(x, ...) {
      stop("class extraction must not be dispatched", call. = FALSE)
    },
    {
      root <- jdv_handle(source)
      on.exit(jdv_handle_close(root), add = TRUE)
      child <- jdv_handle_open(root, list(list(type = "index", index = 1L)))
      on.exit(jdv_handle_close(child), add = TRUE)
      registered <- jdv_handle_register(child)
      on.exit(.jdv_close_internal(registered$id), add = TRUE)
      registered_entry <- get(
        registered$id,
        envir = .jdv_state$entries,
        inherits = FALSE
      )
      expect_identical(registered_entry$captured, mtcars)
    }
  )
})

test_that("registering a handle view follows the ordinary registry limit", {
  original_options <- options(jdv.max_tables = 1)
  on.exit(options(original_options), add = TRUE)
  previous <- jdv_register(mtcars)
  previous_id <- previous$id
  handle <- jdv_handle(mtcars, mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)
  registered <- jdv_handle_register(handle)
  expect_false(exists(
    previous_id,
    envir = .jdv_state$entries,
    inherits = FALSE
  ))
  expect_true(exists(
    registered$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  ))
  messages <- lapply(jdv_notifications(), .jdv_json_parse)
  closed <- Filter(
    function(message) identical(message$method, "view/closed"),
    messages
  )
  expect_true(any(vapply(
    closed,
    function(message) identical(message$params$view, previous_id),
    logical(1L)
  )))
  on.exit(.jdv_close_internal(registered$id), add = TRUE)
})

test_that("same handle title replaces the view and advances generation", {
  handle <- jdv_handle(mtcars, mode = "paged")
  on.exit(jdv_handle_close(handle), add = TRUE)
  first <- jdv_handle_register(handle, title = "same handle title")
  second <- jdv_handle_register(handle, title = "same handle title")
  on.exit(.jdv_close_internal(second$id), add = TRUE)

  expect_identical(second$id, first$id)
  expect_identical(first$generation, 1)
  expect_identical(second$generation, 2)
})

test_that("handle registration inherits its creation collation intent", {
  old <- options(jdv.collation = "C")
  on.exit(options(old), add = TRUE)
  locale_handle <- jdv_handle(mtcars, collation = "locale")
  on.exit(jdv_handle_close(locale_handle), add = TRUE)
  options(jdv.collation = "C")
  locale_view <- jdv_handle_register(locale_handle)
  on.exit(.jdv_close_internal(locale_view$id), add = TRUE)
  locale_entry <- get(
    locale_view$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  )
  expect_identical(locale_entry$collation, "locale")

  c_handle <- jdv_handle(mtcars, collation = "C")
  on.exit(jdv_handle_close(c_handle), add = TRUE)
  options(jdv.collation = "locale")
  c_view <- jdv_handle_register(c_handle)
  on.exit(.jdv_close_internal(c_view$id), add = TRUE)
  c_entry <- get(c_view$id, envir = .jdv_state$entries, inherits = FALSE)
  expect_identical(c_entry$collation, "C")
})

test_that("handle registration inherits automatic mode intent", {
  handle <- jdv_handle(mtcars)
  on.exit(jdv_handle_close(handle), add = TRUE)
  old <- options(jdv.snapshot_max_cells = 0)
  on.exit(options(old), add = TRUE)
  registered <- jdv_handle_register(handle)
  on.exit(.jdv_close_internal(registered$id), add = TRUE)
  entry <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
  expect_identical(entry$intent_mode, "auto")
  expect_identical(entry$mode, "paged")
})

test_that("registering a handle does not reevaluate its active binding", {
  bindings <- new.env(parent = emptyenv())
  calls <- 0L
  makeActiveBinding(
    "value",
    function(value) {
      if (!missing(value)) {
        stop("binding is read-only")
      }
      calls <<- calls + 1L
      list(mtcars)
    },
    bindings
  )
  handle <- jdv_handle(bindings$value)
  on.exit(jdv_handle_close(handle), add = TRUE)

  registered <- jdv_handle_register(handle)
  on.exit(.jdv_close_internal(registered$id), add = TRUE)
  expect_identical(calls, 1L)
})

test_that("registration from a child fails after its parent closes", {
  root <- jdv_handle(list(list(value = 1L)))
  child <- jdv_handle_open(root, list(list(type = "index", index = 1L)))
  jdv_handle_close(root)

  expect_error(jdv_handle_register(child), class = "jdv_error_view_not_found")
  expect_silent(jdv_handle_close(child))
})

test_that("list handles register the captured child value and inherit title", {
  root <- jdv_handle(list(items = list(answer = 42L)), mode = "paged")
  on.exit(jdv_handle_close(root), add = TRUE)
  child <- jdv_handle_open(
    root,
    list(list(type = "index", index = 1L)),
    mode = "paged"
  )
  on.exit(jdv_handle_close(child), add = TRUE)

  registered <- jdv_handle_register(child)
  on.exit(.jdv_close_internal(registered$id), add = TRUE)
  entry <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
  expect_identical(entry$mode, "tree")
  expect_identical(entry$title, child$state$entry$title)
  expect_identical(entry$tree_value, child$state$entry$tree_value)
})

test_that("handle registration reports closed and schema-changed handles", {
  closed <- jdv_handle(mtcars)
  jdv_handle_close(closed)
  expect_error(jdv_handle_register(closed), class = "jdv_error_view_not_found")

  with_column_method(
    "dim",
    "jdv_register_mutable_dimensions",
    function(x) c(attr(x, "dimensions", exact = TRUE)$rows, 1L),
    {
      dimensions <- new.env(parent = emptyenv())
      dimensions$rows <- 2L
      source <- structure(
        data.frame(value = 1:2),
        class = c("jdv_register_mutable_dimensions", "data.frame"),
        dimensions = dimensions
      )
      handle <- jdv_handle(source, mode = "paged")
      on.exit(jdv_handle_close(handle), add = TRUE)
      dimensions$rows <- 3L
      expect_error(
        jdv_handle_register(handle),
        class = "jdv_error_schema_changed"
      )
    }
  )
})

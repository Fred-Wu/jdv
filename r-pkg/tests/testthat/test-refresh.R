notification_methods <- function(messages) {
  vapply(
    messages,
    function(message) .jdv_json_parse(message)$method,
    "",
    USE.NAMES = FALSE
  )
}

notification_views <- function(messages) {
  vapply(
    messages,
    function(message) .jdv_json_parse(message)$params$view %||% NA_character_,
    "",
    USE.NAMES = FALSE
  )
}

refresh_json <- function(view, generation = NULL, extra = list()) {
  params <- c(
    list(
      view = if (is.list(view)) view$id else view,
      generation = generation %||% view$generation
    ),
    extra
  )
  request <- list(id = "refresh-1", method = "view/refresh", params = params)
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

refresh_open <- function(view, path) {
  request <- list(
    id = "open-1",
    method = "object/open",
    params = list(view = view$id, generation = view$generation, path = path)
  )
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

refresh_new_session <- function(.env = parent.frame()) {
  jdv_disconnect()
  withr::defer(jdv_disconnect(), envir = .env)
  invisible(NULL)
}

refresh_entry <- function(id) {
  get(id, envir = .jdv_state$entries, inherits = FALSE)
}

test_that("refresh rebuilds the captured value as the next generation", {
  refresh_new_session()
  view <- jdv_register(mtcars)
  jdv_notifications()
  entry <- refresh_entry(view$id)

  response <- refresh_json(view)
  expect_null(response$error)
  expect_identical(response$result$view, view$id)
  expect_equal(response$result$previous_generation, 1)
  expect_equal(response$result$generation, 2)
  expect_true(response$result$refreshed)

  replacement <- refresh_entry(view$id)
  expect_false(identical(replacement, entry))
  expect_true(entry$closed)
  expect_identical(replacement$generation, 2)
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/open")
  opened <- .jdv_json_parse(messages)$params
  expect_identical(opened$view, view$id)
  expect_equal(opened$generation, 2)
  expect_true(opened$capabilities$refresh)

  # A value that did not change is rebuilt too.
  again <- refresh_json(view$id, 2)
  expect_equal(again$result$generation, 3)
  expect_identical(
    jdv_notifications() |>
      notification_methods(),
    "view/open"
  )
  expect_identical(refresh_entry(view$id)$generation, 3)
})

test_that("refresh reports invalid, stale, unknown, and closed views", {
  refresh_new_session()
  view <- jdv_register(mtcars)
  jdv_notifications()

  expect_identical(refresh_json(view, 7)$error$code, "stale_generation")
  expect_identical(refresh_json("v-999", 1)$error$code, "view_not_found")
  expect_identical(
    refresh_json(view, extra = list(path = list()))$error$code,
    "invalid_request"
  )
  request <- list(
    id = "refresh-1",
    method = "view/refresh",
    params = list(view = view$id)
  )
  expect_identical(
    .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))$error$code,
    "invalid_request"
  )
  expect_identical(refresh_entry(view$id)$generation, 1)
  expect_identical(jdv_notifications(), character())

  refresh_json(view)
  expect_identical(refresh_json(view, 1)$error$code, "stale_generation")
  jdv_close(view$id)
  expect_identical(refresh_json(view, 2)$error$code, "view_not_found")
})

test_that("refresh closes descendants deepest first without an old close", {
  refresh_new_session()
  root <- jdv_register(list(a = list(b = list(c = 1))))
  child <- refresh_open(root, list(list(type = "index", index = 1)))$result
  grandchild <- refresh_open(
    list(id = child$view, generation = child$generation),
    list(list(type = "index", index = 1))
  )$result
  expect_type(grandchild$view, "character")
  jdv_notifications()

  response <- refresh_json(root)
  expect_equal(response$result$generation, 2)
  messages <- jdv_notifications()
  expect_identical(
    notification_methods(messages),
    c("view/open", "view/closed", "view/closed")
  )
  expect_identical(
    notification_views(messages),
    c(root$id, grandchild$view, child$view)
  )
  closed <- lapply(messages[2:3], .jdv_json_parse)
  expect_identical(closed[[1L]]$params$reason, "parent_closed")
  expect_identical(closed[[2L]]$params$reason, "parent_closed")
  expect_equal(.jdv_json_parse(messages[[1L]])$params$generation, 2)
  expect_identical(sort(ls(.jdv_state$entries)), root$id)
  expect_identical(refresh_entry(root$id)$children, character())
})

test_that("refreshing a child keeps its relationship to the parent", {
  refresh_new_session()
  root <- jdv_register(list(a = list(b = list(c = 1)), d = mtcars))
  child <- refresh_open(root, list(list(type = "index", index = 1)))$result
  grandchild <- refresh_open(
    list(id = child$view, generation = child$generation),
    list(list(type = "index", index = 1))
  )$result
  grid <- refresh_open(root, list(list(type = "index", index = 2)))$result
  jdv_notifications()

  response <- refresh_json(child$view, child$generation)
  expect_equal(response$result$generation, 2)
  messages <- jdv_notifications()
  expect_identical(notification_views(messages), c(child$view, grandchild$view))
  opened <- .jdv_json_parse(messages[[1L]])$params
  expect_identical(opened$parent, root$id)
  expect_identical(opened$kind, "tree")
  replacement <- refresh_entry(child$view)
  expect_identical(replacement$parent_entry, refresh_entry(root$id))
  expect_identical(replacement$parent_generation, 1)
  expect_true(child$view %in% refresh_entry(root$id)$children)

  # A grid child keeps parent and path in its descriptor.
  response <- refresh_json(grid$view, grid$generation)
  expect_equal(response$result$generation, 2)
  opened <- .jdv_json_parse(jdv_notifications())$params
  expect_identical(opened$kind, "grid")
  expect_identical(opened$parent, root$id)
  expect_length(opened$path, 0L)

  # Closing the parent still closes the refreshed children.
  jdv_notifications()
  jdv_close(root$id)
  messages <- jdv_notifications()
  expect_setequal(
    notification_views(messages),
    c(root$id, child$view, grid$view)
  )
  expect_identical(
    sum(vapply(
      messages,
      function(message) {
        identical(.jdv_json_parse(message)$params$reason, "parent_closed")
      },
      logical(1L)
    )),
    2L
  )
})

test_that("a child cannot be refreshed once its parent changed", {
  refresh_new_session()
  root <- jdv_register(list(a = list(b = 1)))
  child <- refresh_open(root, list(list(type = "index", index = 1)))$result
  refresh_json(root)
  expect_identical(
    refresh_json(child$view, child$generation)$error$code,
    "view_not_found"
  )
})

test_that("the registration intent is replayed, not the effective mode", {
  refresh_new_session()
  old <- options(jdv.snapshot_max_cells = 10000, jdv.collation = NULL)
  on.exit(options(old), add = TRUE)
  auto <- jdv_register(mtcars)
  snapshot <- jdv_register(mtcars, mode = "snapshot", collation = "locale")
  paged <- jdv_register(mtcars, mode = "paged")
  jdv_notifications()

  options(jdv.snapshot_max_cells = 5, jdv.collation = "locale")
  refreshed <- lapply(list(auto, snapshot, paged), function(view) {
    refresh_json(view)
    .jdv_json_parse(jdv_notifications())$params
  })
  expect_identical(refreshed[[1L]]$mode, "paged")
  expect_identical(refreshed[[1L]]$collation, "locale")
  expect_identical(refreshed[[2L]]$mode, "snapshot")
  expect_identical(refreshed[[2L]]$collation, "locale")
  expect_identical(refreshed[[3L]]$mode, "paged")
  expect_identical(refresh_entry(auto$id)$intent_mode, "auto")

  options(jdv.snapshot_max_cells = 10000)
  refresh_json(auto$id, 2)
  expect_identical(.jdv_json_parse(jdv_notifications())$params$mode, "snapshot")
  options(jdv.collation = NULL)
  refresh_json(snapshot$id, 2)
  expect_identical(
    .jdv_json_parse(jdv_notifications())$params$collation,
    "locale"
  )
})

test_that("a failed rebuild leaves the generation, children, and state", {
  refresh_new_session()
  fail <- FALSE
  value <- structure(
    list(items = I(list(list(1)))),
    class = c("refresh_fail", "data.frame"),
    row.names = 1L
  )
  with_column_method(
    "[[",
    "refresh_fail",
    function(x, i, ..., exact = TRUE) {
      if (fail) {
        stop("boom")
      }
      NextMethod("[[")
    },
    {
      root <- jdv_register(value, mode = "paged")
      child <- refresh_open(
        root,
        list(list(kind = "cell", row_index = 1, column = 0))
      )$result
      expect_type(child$view, "character")
      jdv_notifications()
      entry <- refresh_entry(root$id)

      fail <- TRUE
      response <- refresh_json(root)
      expect_false(is.null(response$error))
      expect_identical(response$error$code, "r_error")
      expect_identical(refresh_entry(root$id), entry)
      expect_identical(entry$generation, 1)
      expect_false(entry$closed)
      expect_identical(entry$children, child$view)
      expect_false(refresh_entry(child$view)$closed)
      expect_identical(jdv_notifications(), character())
      expect_false(.jdv_state$refreshing)

      fail <- FALSE
      expect_equal(refresh_json(root)$result$generation, 2)
    }
  )
})

test_that("an explicit close during construction is not undone", {
  refresh_new_session()
  closing <- NULL
  value <- structure(
    list(x = 1:3),
    class = c("refresh_close", "data.frame"),
    row.names = 1:3
  )
  with_column_method(
    "[[",
    "refresh_close",
    function(x, i, ..., exact = TRUE) {
      if (!is.null(closing)) {
        id <- closing
        closing <<- NULL
        jdv_close(id)
      }
      NextMethod("[[")
    },
    {
      view <- jdv_register(value, mode = "paged")
      jdv_notifications()
      closing <- view$id
      response <- refresh_json(view)
      expect_identical(response$error$code, "view_not_found")
      expect_false(exists(view$id, .jdv_state$entries, inherits = FALSE))
      messages <- jdv_notifications()
      expect_identical(notification_methods(messages), "view/closed")
      expect_false(.jdv_state$refreshing)
    }
  )
})

test_that("a disconnect during construction ends the refresh", {
  refresh_new_session()
  armed <- FALSE
  value <- structure(
    list(x = 1:3),
    class = c("refresh_disconnect", "data.frame"),
    row.names = 1:3
  )
  with_column_method(
    "[[",
    "refresh_disconnect",
    function(x, i, ..., exact = TRUE) {
      if (armed) {
        armed <<- FALSE
        jdv_disconnect()
      }
      NextMethod("[[")
    },
    {
      view <- jdv_register(value, mode = "paged")
      armed <- TRUE
      response <- refresh_json(view)
      expect_identical(response$error$code, "view_not_found")
      expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
      expect_identical(jdv_connection()$owner, "none")
      expect_identical(jdv_notifications(), character())
      expect_false(.jdv_state$refreshing)
    }
  )
})

test_that("a register or refresh issued while rebuilding is rejected", {
  refresh_new_session()
  nested <- NULL
  armed <- FALSE
  value <- structure(
    list(x = 1:3),
    class = c("refresh_nested", "data.frame"),
    row.names = 1:3
  )
  with_column_method(
    "[[",
    "refresh_nested",
    function(x, i, ..., exact = TRUE) {
      if (armed && is.null(nested)) {
        nested <<- list(
          register = tryCatch(jdv_register(mtcars), error = identity),
          refresh = tryCatch(
            .jdv_update_view(refresh_entry("v-1"), mtcars, "auto", NULL),
            error = identity
          )
        )
      }
      NextMethod("[[")
    },
    {
      view <- jdv_register(value, mode = "paged")
      armed <- TRUE
      jdv_notifications()
      response <- refresh_json(view)
      expect_null(response$error)
      expect_identical(nested$register$code, "in_use")
      expect_identical(nested$refresh$code, "in_use")
      expect_length(ls(.jdv_state$entries, all.names = TRUE), 1L)
      expect_false(.jdv_state$refreshing)
    }
  )
})

test_that("a refreshed title keeps the registry consistent", {
  refresh_new_session()
  first <- jdv_register(mtcars, title = "cars")
  refresh_json(first)
  second <- jdv_register(mtcars, title = "cars")
  expect_identical(second$id, first$id)
  expect_identical(second$generation, 3)
})

test_that("sequential views cannot be refreshed", {
  refresh_new_session()
  local_mocked_bindings(
    .jdv_sequential_acquire = function(x) {
      token <- new.env(parent = emptyenv())
      token$closed <- FALSE
      token
    },
    .jdv_sequential_open = function(token) {
      list(
        schema = list(
          format = "+s",
          name = "",
          flags = 0,
          metadata = "",
          metadata_encoding = "hex",
          children = list(),
          dictionary = NULL
        ),
        columns = list(list(
          index = 0,
          name = "x",
          type = "int64",
          unsupported = NULL,
          ipc_index = 0
        )),
        mapping = 0L
      )
    },
    .jdv_sequential_can_release = function() TRUE,
    .jdv_sequential_release_token = function(token) {
      token$closed <- TRUE
      TRUE
    },
    .package = "jdv"
  )
  view <- .jdv_sequential_register(NULL)
  .jdv_notify(view$open)
  jdv_notifications()
  expect_false(.jdv_json_parse(view$open)$params$capabilities$refresh)
  response <- refresh_json(view)
  expect_identical(response$error$code, "unsupported")
  expect_identical(refresh_entry(view$id)$generation, 1)
  expect_false(refresh_entry(view$id)$closed)
  expect_identical(jdv_notifications(), character())
})

test_that(
  "a notification overflow during refresh still releases the old generation",
  {
    refresh_new_session()
    old <- options(jdv.notification_max_messages = 2L)
    on.exit(options(old), add = TRUE)
    # hello and the first view/open fill the queue, so the refresh overflows.
    view <- jdv_register(mtcars, mode = "paged")
    previous <- refresh_entry(view$id)
    expect_false(is.null(previous$holder))

    tryCatch(refresh_json(view), error = function(error) NULL)

    expect_true(previous$closed)
    expect_null(previous$holder)
    expect_identical(
      jdv_connection()$last_disconnect_reason,
      "notification_overflow"
    )
    expect_identical(ls(.jdv_state$entries), character())
  }
)

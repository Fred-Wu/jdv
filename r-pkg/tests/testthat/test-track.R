skip_if_not(.jdv_track_supported(), "binding tracking needs R 4.6.0 or later")

track_new_session <- function(.env = parent.frame()) {
  jdv_disconnect()
  withr::defer(jdv_disconnect(), envir = .env)
  invisible(NULL)
}

track_entry <- function(id) {
  get(id, envir = .jdv_state$entries, inherits = FALSE)
}

# A variable in its own environment, registered with an explicit binding.
track_register <- function(value, env, name = "x", ...) {
  assign(name, value, envir = env)
  jdv_register(
    get(name, envir = env),
    binding = list(name = name, env = env),
    ...
  )
}

track_methods <- function() notification_methods(jdv_notifications())

test_that("binding helpers read without evaluating and report status", {
  env <- new.env()
  value <- data.frame(a = 1)
  assign("plain", value, envir = env)
  delayedAssign("later", stop("promise evaluated"), assign.env = env)
  makeActiveBinding("live", function() stop("active evaluated"), env)
  delayedAssign("forced", 42, assign.env = env)
  force(env$forced)
  env$missing_arg <- quote(expr = )
  ref <- .Call(C_jdv_weakref_make, env)

  read <- .jdv_binding_read(ref, "plain")
  expect_identical(read$status, "value")
  expect_true(.jdv_track_same(read$value, value))
  expect_false(.jdv_track_same(read$value, data.frame(a = 1)))
  expect_identical(.jdv_binding_read(ref, "later")$status, "delayed")
  expect_identical(.jdv_binding_read(ref, "live")$status, "active")
  expect_identical(.jdv_binding_read(ref, "forced")$status, "forced")
  expect_identical(.jdv_binding_read(ref, "forced")$value, 42)
  expect_identical(.jdv_binding_read(ref, "absent")$status, "unbound")
  expect_identical(.jdv_binding_read(ref, "missing_arg")$status, "missing")
  expect_error(.jdv_binding_read(ref, NA_character_))
  expect_error(.Call(C_jdv_weakref_make, 1))
  expect_error(.jdv_binding_read(env, "plain"))
})

test_that("a weak environment reference does not keep the frame alive", {
  ref <- local({
    env <- new.env()
    env$x <- mtcars
    .Call(C_jdv_weakref_make, env)
  })
  expect_true(is.environment(.Call(C_jdv_weakref_key, ref)))
  gc()
  expect_null(.Call(C_jdv_weakref_key, ref))
  expect_identical(.jdv_binding_read(ref, "x")$status, "gone")
  expect_identical(.jdv_binding_read(ref, "x")$value, NULL)
})

test_that("the owning environment is found without evaluating", {
  outer <- new.env()
  inner <- new.env(parent = outer)
  delayedAssign("p", stop("promise evaluated"), assign.env = outer)
  expect_identical(.jdv_binding_owner("p", inner), outer)
  inner$p <- 1
  expect_identical(.jdv_binding_owner("p", inner), inner)
  expect_null(.jdv_binding_owner("no_such_variable_jdv", inner))
  expect_identical(
    .jdv_binding_owner("mtcars", globalenv()) |>
      is.environment(),
    TRUE
  )
})

test_that("jdv_register validates the binding argument", {
  track_new_session()
  env <- new.env()
  env$x <- mtcars
  bad <- list(
    1,
    list(name = "x"),
    list(env = env),
    list(name = "x", env = env, extra = 1),
    list(name = c("x", "y"), env = env),
    list(name = "", env = env),
    list(name = NA_character_, env = env),
    list(name = 1, env = env),
    list(name = "x", env = list()),
    list("x", env)
  )
  for (binding in bad) {
    expect_error(
      jdv_register(mtcars, binding = binding),
      class = "jdv_query_error"
    )
  }
  # Nothing is registered or started by a rejected call.
  expect_length(ls(.jdv_state$entries), 0L)
  expect_identical(.jdv_session_owner(), "none")
  expect_identical(jdv_notifications(), character())

  # The binding must hold exactly the object being registered.
  expect_error(
    jdv_register(data.frame(a = 1), binding = list(name = "x", env = env)),
    "does not hold"
  )
  expect_error(
    jdv_register(mtcars, binding = list(name = "absent", env = env)),
    class = "jdv_query_error"
  )
  delayedAssign("p", stop("promise evaluated"), assign.env = env)
  err <- expect_error(
    jdv_register(mtcars, binding = list(name = "p", env = env)),
    class = "jdv_query_error"
  )
  expect_identical(err$code, "unavailable")
  makeActiveBinding("a", function() stop("active evaluated"), env)
  err <- expect_error(
    jdv_register(mtcars, binding = list(name = "a", env = env)),
    class = "jdv_query_error"
  )
  expect_identical(err$code, "unavailable")
  expect_length(ls(.jdv_state$entries), 0L)
  expect_identical(.jdv_session_owner(), "none")

  # A sequential source cannot be rewound.
  skip_if_not_installed("nanoarrow")
  stream <- nanoarrow::as_nanoarrow_array_stream(data.frame(a = 1:2))
  env$s <- stream
  err <- expect_error(
    jdv_register(stream, binding = list(name = "s", env = env)),
    class = "jdv_query_error"
  )
  expect_identical(err$code, "unsupported")
})

test_that("an older R cannot track an explicit binding", {
  track_new_session()
  testthat::local_mocked_bindings(.jdv_track_supported = function() FALSE)
  env <- new.env()
  env$x <- mtcars
  err <- expect_error(
    jdv_register(mtcars, binding = list(name = "x", env = env)),
    class = "jdv_query_error"
  )
  expect_identical(err$code, "unsupported")
  expect_length(ls(.jdv_state$entries), 0L)
  # A plain registration still works.
  expect_type(jdv_register(mtcars)$id, "character")
})

test_that("a new object is rebuilt as the next generation", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  expect_identical(track_methods(), c("hello", "view/open"))
  expect_false(is.null(track_entry(view$id)$track_ref))
  expect_true(
    "jdv_track_pid" %in% sub("[0-9]+$", "pid", getTaskCallbackNames())
  )

  # Nothing changed.
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())

  old <- track_entry(view$id)
  env$x <- transform(env$x, mpg = mpg * 2)
  expect_null(jdv_rpc(NULL))
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/open")
  opened <- .jdv_json_parse(messages)$params
  expect_identical(opened$view, view$id)
  expect_equal(opened$generation, 2)
  expect_true(old$closed)
  expect_identical(track_entry(view$id)$generation, 2)
  expect_true(.jdv_track_same(track_entry(view$id)$track_value, env$x))

  # Assigning the very same object again does nothing.
  env$x <- env$x
  value <- env$x
  env$x <- value
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$generation, 2)

  # A different but equal object is a change.
  env$x <- env$x[seq_len(nrow(env$x)), , drop = FALSE]
  jdv_rpc(NULL)
  expect_identical(track_methods(), "view/open")
  expect_identical(track_entry(view$id)$generation, 3)
})

test_that("the tracked type may change between grid and tree", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  env$x <- list(a = 1, b = list(c = 2))
  jdv_rpc(NULL)
  opened <- .jdv_json_parse(jdv_notifications())$params
  expect_identical(opened$kind, "tree")
  expect_equal(opened$generation, 2)
  env$x <- mtcars
  jdv_rpc(NULL)
  opened <- .jdv_json_parse(jdv_notifications())$params
  expect_identical(opened$kind, "grid")
  expect_equal(opened$generation, 3)
})

test_that("changes made in place are not detected", {
  track_new_session()
  env <- new.env()
  target <- new.env()
  target$a <- 1
  view <- track_register(target, env)
  jdv_notifications()
  target$a <- 2
  target$b <- 3
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$generation, 1)
  # A manual refresh covers it.
  response <- refresh_json(view)
  expect_equal(response$result$generation, 2)
})

test_that("every changed view is updated in one poll", {
  track_new_session()
  env <- new.env()
  first <- track_register(mtcars, env, "a")
  second <- track_register(mtcars, env, "b")
  third <- track_register(mtcars, env, "c")
  fixed <- jdv_register(mtcars)
  jdv_notifications()
  env$a <- mtcars[1:5, ]
  env$b <- mtcars[1:6, ]
  env$c <- mtcars[1:7, ]
  jdv_rpc(NULL)
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), rep("view/open", 3L))
  expect_identical(
    notification_views(messages),
    c(first$id, second$id, third$id)
  )
  expect_identical(track_entry(fixed$id)$generation, 1)
  expect_identical(track_entry(first$id)$generation, 2)
  expect_identical(track_entry(second$id)$generation, 2)
  expect_identical(track_entry(third$id)$generation, 2)
})

test_that("promise and active bindings are skipped without evaluation", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()

  rm("x", envir = env)
  delayedAssign("x", stop("promise evaluated"), assign.env = env)
  expect_no_error(jdv_rpc(NULL))
  expect_identical(jdv_notifications(), character())
  expect_null(track_entry(view$id)$track_lost)

  rm("x", envir = env)
  makeActiveBinding("x", function() stop("active evaluated"), env)
  expect_no_error(jdv_rpc(NULL))
  expect_identical(jdv_notifications(), character())
  expect_null(track_entry(view$id)$track_lost)
  # A manual refresh cannot read it either.
  expect_identical(refresh_json(view)$error$code, "unavailable")
  expect_identical(track_entry(view$id)$generation, 1)

  # Once it is an ordinary variable again the next check sees the change.
  rm("x", envir = env)
  env$x <- mtcars[1:3, ]
  jdv_rpc(NULL)
  expect_identical(track_methods(), "view/open")
  expect_identical(track_entry(view$id)$generation, 2)
})

test_that("removing the binding ends tracking and keeps the last view", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  rm("x", envir = env)
  jdv_rpc(NULL)
  expect_identical(track_methods(), "view/tracking")
  entry <- track_entry(view$id)
  expect_false(entry$closed)
  expect_match(entry$track_lost, "removed")
  expect_identical(entry$track_lost_token, "removed")
  expect_null(entry$track_value)

  # A recreated variable is not picked up again.
  env$x <- mtcars[1:3, ]
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$generation, 1)

  response <- refresh_json(view)
  expect_identical(response$error$code, "unavailable")
  expect_match(response$error$message, "removed")
  expect_false(.jdv_track_active())
})

test_that("a collected local environment ends tracking", {
  track_new_session()
  view <- local({
    env <- environment()
    x <- mtcars
    jdv_register(x, binding = list(name = "x", env = env))
  })
  jdv_notifications()
  gc()
  jdv_rpc(NULL)
  expect_identical(track_methods(), "view/tracking")
  entry <- track_entry(view$id)
  expect_false(entry$closed)
  expect_match(entry$track_lost, "garbage collected")
  expect_identical(refresh_json(view)$error$code, "unavailable")
})

test_that("a manual refresh uses the current binding value", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  env$x <- mtcars[1:4, ]
  response <- refresh_json(view)
  expect_equal(response$result$generation, 2)
  opened <- .jdv_json_parse(jdv_notifications())$params
  expect_equal(opened$nrow, 4)
  # The baseline moved with it.
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$generation, 2)
})

test_that("a failed rebuild keeps the view and is reported once", {
  track_new_session()
  fail <- FALSE
  make <- function(n) {
    structure(
      list(x = seq_len(n)),
      class = c("track_fail", "data.frame"),
      row.names = seq_len(n)
    )
  }
  with_column_method(
    "[[",
    "track_fail",
    function(x, i, ..., exact = TRUE) {
      if (fail) {
        stop("boom")
      }
      NextMethod("[[")
    },
    {
      env <- new.env()
      view <- track_register(make(3), env, mode = "paged")
      jdv_notifications()
      entry <- track_entry(view$id)

      fail <- TRUE
      candidate <- make(4)
      env$x <- candidate
      jdv_rpc(NULL)
      messages <- jdv_notifications()
      expect_identical(notification_methods(messages), "view/update_failed")
      failed <- .jdv_json_parse(messages)$params
      expect_identical(failed$view, view$id)
      expect_equal(failed$generation, 1)
      expect_identical(failed$code, "r_error")
      expect_match(failed$message, "boom")
      expect_identical(track_entry(view$id), entry)
      expect_false(entry$closed)
      expect_false(.jdv_state$refreshing)

      # The same candidate is not retried.
      fail <- FALSE
      jdv_rpc(NULL)
      jdv_rpc(NULL)
      expect_identical(jdv_notifications(), character())
      expect_identical(track_entry(view$id)$generation, 1)

      # A new value is tried, and the baseline is the last successful one.
      env$x <- make(5)
      jdv_rpc(NULL)
      expect_identical(track_methods(), "view/open")
      expect_identical(track_entry(view$id)$generation, 2)
      expect_null(track_entry(view$id)$track_failed)

      # A manual refresh clears the suppression of the failed value.
      fail <- TRUE
      env$x <- make(6)
      jdv_rpc(NULL)
      expect_identical(track_methods(), "view/update_failed")
      fail <- FALSE
      response <- refresh_json(view$id, 2)
      expect_equal(response$result$generation, 3)
      jdv_notifications()
      jdv_rpc(NULL)
      expect_identical(jdv_notifications(), character())

      # A failing manual refresh is not announced again by the next poll.
      fail <- TRUE
      env$x <- make(7)
      response <- refresh_json(view$id, 3)
      expect_identical(response$error$code, "r_error")
      jdv_rpc(NULL)
      expect_identical(jdv_notifications(), character())
    }
  )
})

test_that("a failed rebuild reports a limit error code", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env, mode = "snapshot")
  jdv_notifications()
  old <- options(jdv.max_message_bytes = 2048)
  on.exit(options(old), add = TRUE)
  env$x <- mtcars[rep(seq_len(nrow(mtcars)), 20), ]
  jdv_rpc(NULL)
  failed <- .jdv_json_parse(jdv_notifications())
  expect_identical(failed$method, "view/update_failed")
  expect_identical(failed$params$code, "limit_exceeded")
  expect_identical(track_entry(view$id)$generation, 1)
})

test_that("checks are deferred during requests and refreshes", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  env$x <- mtcars[1:3, ]

  .jdv_state$rpc_depth <- 1L
  expect_false(.jdv_track_poll())
  .jdv_state$rpc_depth <- 0L
  .jdv_state$refreshing <- TRUE
  expect_false(.jdv_track_poll())
  .jdv_state$refreshing <- FALSE
  .jdv_state$tracking <- TRUE
  expect_false(.jdv_track_poll())
  .jdv_state$tracking <- FALSE
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$generation, 1)

  expect_true(.jdv_track_poll())
  expect_identical(track_methods(), "view/open")
})

test_that("the task callback follows the tracked views", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  name <- .jdv_state$track_task_callback
  expect_true(name %in% getTaskCallbackNames())

  env$x <- mtcars[1:3, ]
  expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_identical(track_methods(), "view/open")

  # Closing the last tracked view lets the callback remove itself.
  jdv_close(view$id)
  jdv_notifications()
  expect_false(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_false(name %in% getTaskCallbackNames())
  expect_null(.jdv_state$track_task_callback)

  # It comes back with the next tracked view.
  track_register(mtcars, env)
  expect_false(is.null(.jdv_state$track_task_callback))
  expect_true(.jdv_state$track_task_callback %in% getTaskCallbackNames())
})

test_that("the task callback turns an overflow into a warning", {
  track_new_session()
  old <- options(jdv.notification_max_messages = 3)
  on.exit(options(old), add = TRUE)
  env <- new.env()
  track_register(mtcars, env, "a")
  track_register(mtcars, env, "b")
  # hello and two opens fill the queue; a rebuild overflows it.
  env$a <- mtcars[1:3, ]
  expect_warning(
    expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE)),
    "overflowed"
  )
  expect_identical(
    jdv_connection()$last_disconnect_reason,
    "notification_overflow"
  )
  expect_length(ls(.jdv_state$entries), 0L)
})

test_that("views opened from a tracked view are not tracked", {
  track_new_session()
  env <- new.env()
  root <- track_register(list(a = list(b = 1), d = mtcars), env)
  child <- refresh_open(root, list(list(type = "index", index = 1)))$result
  grid <- refresh_open(root, list(list(type = "index", index = 2)))$result
  jdv_notifications()
  expect_null(track_entry(child$view)$track_ref)
  expect_null(track_entry(grid$view)$track_ref)

  env$x <- list(a = list(b = 2), d = mtcars)
  jdv_rpc(NULL)
  messages <- jdv_notifications()
  expect_identical(
    notification_methods(messages),
    c("view/open", "view/closed", "view/closed")
  )
  closed <- lapply(messages[-1L], .jdv_json_parse)
  expect_identical(
    vapply(closed, function(m) m$params$reason, ""),
    rep("parent_closed", 2L)
  )
})

test_that("closing a view releases its tracking state", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  entry <- track_entry(view$id)
  jdv_close(view$id)
  expect_null(entry$track_value)
  expect_false(.jdv_track_active())
  jdv_notifications()
  env$x <- mtcars[1:3, ]
  expect_no_error(jdv_rpc(NULL))
  expect_identical(jdv_notifications(), character())
})

test_that("a replaced title does not leave tracking behind", {
  track_new_session()
  env <- new.env()
  first <- track_register(mtcars, env, title = "tracked-title")
  jdv_notifications()
  second <- jdv_register(mtcars, title = "tracked-title")
  expect_identical(second$id, first$id)
  expect_null(track_entry(second$id)$track_ref)
  jdv_notifications()
  env$x <- mtcars[1:3, ]
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
})

track_json <- function(view, enabled, generation = NULL, extra = list()) {
  params <- c(
    list(
      view = if (is.list(view)) view$id else view,
      generation = generation %||% view$generation,
      enabled = enabled
    ),
    extra
  )
  request <- list(id = "track-1", method = "view/track", params = params)
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

test_that("the descriptor carries the tracking state and capability", {
  track_new_session()
  env <- new.env()
  track_register(mtcars, env)
  opened <- .jdv_json_parse(jdv_notifications()[[2L]])$params
  expect_identical(unclass(opened$tracking), list(name = "x", state = "active"))
  expect_true(opened$capabilities$track)

  # A tree view tracks too.
  env$y <- list(a = 1)
  jdv_register(env$y, binding = list(name = "y", env = env))
  tree <- .jdv_json_parse(jdv_notifications()[[1L]])$params
  expect_identical(tree$kind, "tree")
  expect_identical(unclass(tree$tracking), list(name = "y", state = "active"))
  expect_true(tree$capabilities$track)

  # Views that follow nothing have no tracking and cannot be tracked.
  jdv_register(mtcars, title = "fixed")
  child <- jdv_register(list(a = mtcars), title = "root")
  plain <- lapply(jdv_notifications(), .jdv_json_parse)
  for (message in plain) {
    expect_null(message$params$tracking)
    expect_false(message$params$capabilities$track)
  }
  expect_identical(track_json(child, FALSE)$error$code, "unsupported")
})

test_that("pausing keeps the binding and stops rebuilding", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()

  response <- track_json(view, FALSE)
  expect_null(response$error)
  expect_identical(response$result$view, view$id)
  expect_equal(response$result$generation, 1)
  expect_identical(
    unclass(response$result$tracking),
    list(name = "x", state = "paused")
  )
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/tracking")
  notice <- .jdv_json_parse(messages)$params
  expect_identical(notice$view, view$id)
  expect_equal(notice$generation, 1)
  expect_identical(unclass(notice$tracking), list(name = "x", state = "paused"))
  expect_false(is.null(track_entry(view$id)$track_ref))
  expect_false(.jdv_track_active())

  env$x <- mtcars[1:3, ]
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$generation, 1)

  # Pausing again is a successful no-op without a notification.
  again <- track_json(view, FALSE)
  expect_null(again$error)
  expect_identical(again$result$tracking$state, "paused")
  expect_identical(jdv_notifications(), character())

  # The task callback is removed once no view is active.
  expect_false(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_null(.jdv_state$track_task_callback)
})

test_that("resuming rebuilds a changed variable and leaves a same one", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  track_json(view, FALSE)
  jdv_notifications()

  # Unchanged: only the state notification, same generation.
  response <- track_json(view, TRUE)
  expect_null(response$error)
  expect_equal(response$result$generation, 1)
  expect_identical(response$result$tracking$state, "active")
  expect_identical(track_methods(), "view/tracking")
  expect_true(.jdv_track_active())
  expect_false(is.null(.jdv_state$track_task_callback))

  # Resuming an active view changes nothing.
  expect_null(track_json(view, TRUE)$error)
  expect_identical(jdv_notifications(), character())

  # Changed while paused: rebuilt as tracked, active in the new view/open.
  track_json(view, FALSE)
  env$x <- mtcars[1:3, ]
  jdv_notifications()
  response <- track_json(view, TRUE, 1)
  expect_null(response$error)
  expect_equal(response$result$generation, 2)
  expect_identical(response$result$tracking$state, "active")
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/open")
  opened <- .jdv_json_parse(messages)$params
  expect_identical(opened$reason, "tracked")
  expect_equal(opened$generation, 2)
  expect_equal(opened$nrow, 3)
  expect_identical(unclass(opened$tracking), list(name = "x", state = "active"))
  expect_true(opened$capabilities$track)

  # The baseline moved: following goes on from the new object.
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())
  env$x <- mtcars[1:2, ]
  jdv_rpc(NULL)
  expect_identical(track_entry(view$id)$generation, 3)
})

test_that("resuming skips a binding that cannot be read", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  track_json(view, FALSE)
  rm("x", envir = env)
  delayedAssign("x", stop("promise evaluated"), assign.env = env)
  jdv_notifications()
  response <- track_json(view, TRUE)
  expect_null(response$error)
  expect_identical(response$result$tracking$state, "active")
  expect_identical(track_methods(), "view/tracking")
})

test_that("resuming reports a variable that is gone", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  track_json(view, FALSE)
  rm("x", envir = env)
  jdv_notifications()
  response <- track_json(view, TRUE)
  expect_null(response$error)
  expect_identical(response$result$tracking$state, "lost")
  expect_identical(response$result$tracking$reason, "removed")
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/tracking")
  expect_identical(.jdv_json_parse(messages)$params$tracking$state, "lost")
})

test_that("a paused view can be refreshed and stays paused", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  track_json(view, FALSE)
  jdv_notifications()
  env$x <- mtcars[1:4, ]
  response <- refresh_json(view)
  expect_null(response$error)
  expect_equal(response$result$generation, 2)
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/open")
  opened <- .jdv_json_parse(messages)$params
  expect_identical(opened$reason, "refresh")
  expect_equal(opened$nrow, 4)
  expect_identical(unclass(opened$tracking), list(name = "x", state = "paused"))
  expect_true(opened$capabilities$track)
  expect_false(.jdv_track_active())

  # The baseline was updated, so resuming finds nothing new.
  response <- track_json(view$id, TRUE, 2)
  expect_equal(response$result$generation, 2)
  expect_identical(track_methods(), "view/tracking")
})

test_that("losing the binding sends view/tracking with the reason", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  rm("x", envir = env)
  jdv_rpc(NULL)
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/tracking")
  notice <- .jdv_json_parse(messages)$params
  expect_identical(notice$view, view$id)
  expect_equal(notice$generation, 1)
  expect_identical(notice$tracking$name, "x")
  expect_identical(notice$tracking$state, "lost")
  expect_identical(notice$tracking$reason, "removed")
  expect_match(notice$tracking$message, "removed")
  expect_identical(track_json(view, TRUE)$error$code, "unsupported")
  expect_identical(track_json(view, FALSE)$error$code, "unsupported")
  # A lost view is announced once.
  jdv_rpc(NULL)
  expect_identical(jdv_notifications(), character())

  # A refresh that finds the variable gone announces it before the error.
  other <- new.env()
  second <- track_register(mtcars, other)
  jdv_notifications()
  rm("x", envir = other)
  response <- refresh_json(second)
  expect_identical(response$error$code, "unavailable")
  expect_identical(track_methods(), "view/tracking")

  # A lost view reports it in refresh and track the same way.
  gone <- local({
    env <- environment()
    x <- mtcars
    jdv_register(x, binding = list(name = "x", env = env))
  })
  jdv_notifications()
  gc()
  jdv_rpc(NULL)
  lost <- .jdv_json_parse(jdv_notifications())$params
  expect_identical(lost$tracking$reason, "collected")
  expect_match(lost$tracking$message, "garbage collected")
})

test_that("view/track validates its request", {
  track_new_session()
  env <- new.env()
  view <- track_register(mtcars, env)
  jdv_notifications()
  expect_identical(track_json(view, "yes")$error$code, "invalid_request")
  expect_identical(track_json(view, NA)$error$code, "invalid_request")
  expect_identical(
    track_json(view, FALSE, extra = list(extra = 1))$error$code,
    "invalid_request"
  )
  request <- list(
    id = "track-2",
    method = "view/track",
    params = list(view = view$id, generation = 1)
  )
  response <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
  expect_identical(response$error$code, "invalid_request")
  expect_identical(track_json(view, FALSE, 7)$error$code, "stale_generation")
  expect_identical(track_json("v-999", FALSE, 1)$error$code, "view_not_found")
  expect_identical(jdv_notifications(), character())
  expect_identical(track_entry(view$id)$track_paused, NULL)
})

test_that("re-registering a title tracks again as active", {
  track_new_session()
  env <- new.env()
  first <- track_register(mtcars, env, title = "t")
  track_json(first, FALSE)
  second <- track_register(mtcars[1:3, ], env, title = "t")
  expect_identical(second$id, first$id)
  expect_identical(.jdv_track_state(track_entry(second$id)), "active")
})

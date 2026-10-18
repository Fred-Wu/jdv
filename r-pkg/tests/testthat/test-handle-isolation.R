handle_registry_snapshot <- function() {
  entries <- ls(.jdv_state$entries, all.names = TRUE)
  details <- lapply(entries, function(id) {
    entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    list(
      id = id,
      title = entry$title,
      generation = entry$generation,
      sequence = entry$sequence,
      parent = entry$parent
    )
  })
  names(details) <- entries
  titles <- ls(.jdv_state$titles, all.names = TRUE)
  title_map <- lapply(
    titles,
    function(title) get(title, envir = .jdv_state$titles, inherits = FALSE)
  )
  names(title_map) <- titles
  list(
    entries = details,
    titles = title_map,
    next_id = .jdv_state$next_id,
    sequence = .jdv_state$sequence,
    eviction_pins = .jdv_state$eviction_pins,
    queue = .jdv_state$queue,
    queue_bytes = .jdv_state$queue_bytes,
    queue_max_messages = .jdv_state$queue_max_messages,
    queue_max_bytes = .jdv_state$queue_max_bytes,
    owner = .jdv_session_owner(),
    embedded = .jdv_state$embedded,
    transport = !is.null(.jdv_state$transport),
    transport_epoch = .jdv_state$transport_epoch
  )
}

test_that("handles do not use the shared registry or notification session", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  old_options <- options(jdv.max_tables = 1L)
  on.exit(options(old_options), add = TRUE)

  ordinary <- jdv_register(data.frame(value = 1:3), mode = "paged")
  jdv_notifications()
  before <- handle_registry_snapshot()
  expect_identical(before$owner, "embedded")

  table_handle <- jdv_handle(data.frame(value = c(3L, 1L, 2L)), mode = "paged")
  tree_handle <- jdv_handle(list(items = list(answer = 42L)))
  child <- jdv_handle_open(tree_handle, list(list(type = "index", index = 1L)))
  jdv_handle_request(table_handle, "grid/rows", list(offset = 0L, limit = 2L))
  jdv_handle_request(
    tree_handle,
    "object/children",
    list(path = list(), offset = 0L, limit = 10L)
  )
  expect_error(
    jdv_handle_request(tree_handle, "object/open", list(path = list())),
    class = "jdv_error_method_not_found"
  )
  expect_identical(handle_registry_snapshot(), before)
  expect_true(exists(ordinary$id, envir = .jdv_state$entries, inherits = FALSE))
  expect_identical(jdv_notifications(), character())

  jdv_handle_close(tree_handle)
  expect_error(
    jdv_handle_request(child, "object/children", list(path = list())),
    class = "jdv_error_view_not_found"
  )
  expect_identical(handle_registry_snapshot(), before)
  expect_identical(jdv_notifications(), character())

  jdv_handle_close(table_handle)
  jdv_handle_close(child)
})

test_that("handles work without a session and survive ordinary close", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  expect_identical(.jdv_session_owner(), "none")

  handle <- jdv_handle(data.frame(value = c(2L, 1L)), mode = "paged")
  expect_identical(.jdv_session_owner(), "none")
  descriptor <- jdv_handle_descriptor(handle)
  expect_type(descriptor, "character")
  expect_length(descriptor, 1L)
  expect_identical(.jdv_session_owner(), "none")

  ordinary <- jdv_register(data.frame(value = 9L), mode = "paged")
  jdv_notifications()
  jdv_close()
  jdv_notifications()
  expect_identical(.jdv_session_owner(), "embedded")
  expect_error(
    jdv_handle_request(handle, "grid/rows", list(offset = 0L, limit = 2L)),
    NA
  )
  jdv_disconnect()
  expect_identical(.jdv_session_owner(), "none")
  expect_error(
    jdv_handle_request(handle, "grid/rows", list(offset = 0L, limit = 2L)),
    NA
  )
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_true(ordinary$generation >= 1L)
  jdv_handle_close(handle)
})

test_that("handles remain independent while a viewer transport is connected", {
  skip_on_cran()
  skip_on_os("windows")
  skip_if_not_installed("callr")
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local mock host")

  jdv_disconnect()
  socket_directory <- jdv_test_uds_directory()
  on.exit(unlink(socket_directory, recursive = TRUE), add = TRUE)
  socket_path <- tempfile("jdv-handle-", tmpdir = socket_directory)
  ready_path <- tempfile("jdv-handle-ready-")
  script <- test_path("fixtures", "transport-host.py")
  host <- callr::r_bg(
    function(script, python, socket_path, ready_path) {
      output <- system2(
        python,
        c(
          shQuote(script),
          "--socket",
          shQuote(socket_path),
          "--ready",
          shQuote(ready_path),
          "--result",
          shQuote(tempfile()),
          "--scenario",
          "silent"
        ),
        stdout = TRUE,
        stderr = TRUE
      )
      if (!is.null(attr(output, "status")) && attr(output, "status") != 0) {
        stop(paste(output, collapse = "\n"))
      }
    },
    args = list(
      script = script,
      python = python,
      socket_path = socket_path,
      ready_path = ready_path
    ),
    supervise = TRUE
  )
  on.exit(
    {
      try(jdv_disconnect(), silent = TRUE)
      if (host$is_alive()) {
        host$kill()
      }
      try(host$wait(), silent = TRUE)
      unlink(c(socket_path, ready_path))
    },
    add = TRUE
  )

  deadline <- Sys.time() + 10
  while (!file.exists(ready_path) && Sys.time() < deadline) {
    Sys.sleep(0.01)
  }
  expect_true(file.exists(ready_path))
  jdv_connect(socket_path)
  before <- handle_registry_snapshot()
  expect_identical(before$owner, "transport")

  handle <- jdv_handle(data.frame(value = 1:2), mode = "paged")
  expect_silent(jdv_handle_descriptor(handle))
  expect_silent(jdv_handle_request(
    handle,
    "grid/rows",
    list(offset = 0L, limit = 2L)
  ))
  expect_identical(handle_registry_snapshot(), before)

  registered <- jdv_handle_register(handle, title = "registered handle")
  expect_true(exists(
    registered$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  ))
  expect_length(.jdv_state$queue, 0L)
  expect_identical(.jdv_state$queue_bytes, 0)

  jdv_disconnect()
  expect_silent(jdv_handle_request(
    handle,
    "grid/rows",
    list(offset = 0L, limit = 2L)
  ))
  jdv_handle_close(handle)
})

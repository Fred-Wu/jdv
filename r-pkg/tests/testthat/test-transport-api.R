transport_rpc_json <- function(value) {
  jsonlite::fromJSON(value, simplifyVector = FALSE)
}

transport_rpc_call <- function(
  method,
  params = list(),
  id = 1,
  extra = list()
) {
  request <- c(list(id = id, method = method, params = params), extra)
  jdv_rpc(.jdv_json_encode(request))
}

expect_transport_rpc_code <- function(response, expected) {
  parsed <- transport_rpc_json(response)
  expect_identical(parsed$error$code, expected)
  invisible(parsed)
}

transport_status_summary <- function() {
  status <- tryCatch(.jdv_transport_status(), error = identity)
  if (inherits(status, "error")) {
    return(conditionMessage(status))
  }
  if (is.null(status)) {
    return("NULL")
  }
  paste(
    paste0(
      names(status),
      "=",
      vapply(status, function(value) paste(value, collapse = ","), character(1))
    ),
    collapse = " "
  )
}

run_mock_host <- function(
  socket_path,
  ready_path,
  result_path,
  scenario,
  request_bytes
) {
  python <- Sys.which("python3")
  script <- test_path("fixtures", "transport-host.py")
  callr::r_bg(
    function(
      script,
      python,
      socket_path,
      ready_path,
      result_path,
      scenario,
      request_bytes
    ) {
      output <- system2(
        python,
        c(
          shQuote(script),
          "--socket",
          shQuote(socket_path),
          "--ready",
          shQuote(ready_path),
          "--result",
          shQuote(result_path),
          "--scenario",
          shQuote(scenario),
          "--request-bytes",
          as.character(request_bytes)
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
      ready_path = ready_path,
      result_path = result_path,
      scenario = scenario,
      request_bytes = request_bytes
    ),
    supervise = TRUE
  )
}

wait_for_file <- function(path, timeout = 10) {
  deadline <- Sys.time() + timeout
  while (!file.exists(path) && Sys.time() < deadline) {
    Sys.sleep(0.01)
  }
  file.exists(path)
}

with_mock_transport <- function(
  scenario,
  x,
  request_bytes = 1024^2,
  before_poll = NULL,
  mode = "paged"
) {
  skip_on_os("windows")
  skip_if_not_installed("callr")
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local mock host")

  socket_path <- tempfile("jdv-transport-")
  ready_path <- tempfile("jdv-transport-ready-")
  result_path <- tempfile("jdv-transport-result-")
  host <- run_mock_host(
    socket_path,
    ready_path,
    result_path,
    scenario,
    request_bytes
  )
  old_address <- getOption("jdv.address")
  options(jdv.address = socket_path)
  on.exit(
    {
      try(jdv_close(), silent = TRUE)
      options(jdv.address = old_address)
      if (host$is_alive()) {
        host$kill()
      }
      try(host$wait(), silent = TRUE)
      unlink(c(
        socket_path,
        ready_path,
        result_path,
        paste0(result_path, ".closed")
      ))
    },
    add = TRUE
  )

  expect_true(wait_for_file(ready_path))
  id <- tryCatch(
    jdv_view(x, mode = mode),
    error = function(error) {
      output <- tryCatch(
        host$read_all_output(),
        error = function(e) character()
      )
      stop(
        paste(
          conditionMessage(error),
          "Transport status:",
          transport_status_summary(),
          "Host alive:",
          host$is_alive(),
          "Host output:",
          paste(output, collapse = "\n"),
          sep = "\n"
        ),
        call. = FALSE
      )
    }
  )
  expect_type(id, "character")
  if (!is.null(before_poll)) {
    before_poll()
  }
  deadline <- Sys.time() + 10
  while (!file.exists(result_path) && Sys.time() < deadline) {
    jdv_rpc(NULL)
    Sys.sleep(0.01)
  }
  expect_true(file.exists(result_path))
  if (!file.exists(result_path)) {
    output <- tryCatch(host$read_all_output(), error = function(e) character())
    stop(
      paste(
        "Mock host did not write its result.",
        "Transport status:",
        transport_status_summary(),
        "Host alive:",
        host$is_alive(),
        "Host output:",
        paste(output, collapse = "\n"),
        sep = "\n"
      ),
      call. = FALSE
    )
  }
  received <- jsonlite::fromJSON(result_path, simplifyVector = FALSE)
  received$debug_transport_status <- transport_status_summary()
  expect_identical(received$hello$method, "hello")
  expect_identical(received$open$method, "table/open")
  expect_identical(received$open$params$table, id)
  expect_identical(received$open$params$title, "x")
  if (scenario == "typed-id" && !length(received$responses)) {
    expect_true(FALSE, info = received$debug_transport_status)
  }
  if (scenario != "duplicate-id") {
    expect_length(
      received$responses,
      if (scenario %in% c("large-snapshot", "disconnect")) {
        0L
      } else if (
        scenario %in%
          c(
            "invalid-encoding-cancel",
            "invalid-compression-cancel",
            "invalid-deadline-cancel",
            "malformed-deadline-cancel",
            "expired-cancel"
          )
      ) {
        if (
          scenario %in%
            c("invalid-deadline-cancel", "malformed-deadline-cancel")
        ) {
          3L
        } else {
          2L
        }
      } else if (scenario == "invalid-cancel") {
        2L
      } else {
        1L
      }
    )
  }
  expected_ids <- if (
    scenario %in% c("invalid-deadline-cancel", "malformed-deadline-cancel")
  ) {
    list(NULL, "protected", "followup")
  } else if (
    scenario %in%
      c(
        "invalid-encoding-cancel",
        "invalid-compression-cancel",
        "expired-cancel"
      )
  ) {
    list("protected", "followup")
  } else if (scenario == "invalid-cancel") {
    list(NULL, "must-survive")
  } else {
    list(
      if (scenario == "maximum-frame") {
        "maximum-frame"
      } else if (scenario == "numeric-id") {
        1e15
      } else if (scenario == "typed-id") {
        1L
      } else if (scenario %in% c("cancel", "expired")) {
        "followup"
      } else if (scenario == "invalid-control") {
        "invalid-control"
      } else if (scenario == "invalid-cancel") {
        "must-survive"
      } else if (scenario == "cancel-id-reuse") {
        "followup"
      } else if (scenario == "empty-registry-close") {
        "close-table"
      } else {
        "mock-rows-1"
      }
    )
  }
  if (!scenario %in% c("large-snapshot", "disconnect", "duplicate-id")) {
    expect_identical(lapply(received$responses, `[[`, "id"), expected_ids)
  }
  if (scenario == "fragmented") {
    expect_identical(
      received$responses[[1]]$result$data$row_index,
      list(1L, 2L)
    )
  }

  if (scenario %in% c("disconnect", "duplicate-id")) {
    if (scenario == "duplicate-id") {
      expect_true(received$disconnected)
      expect_true(length(received$responses) <= 1L)
      if (length(received$responses)) {
        expect_identical(received$responses[[1]]$error$code, "invalid_request")
      }
    }
    cleanup_deadline <- Sys.time() + 5
    while (
      (!is.null(.jdv_transport_status()) ||
        length(ls(.jdv_state$entries, all.names = TRUE)) > 0L) &&
        Sys.time() < cleanup_deadline
    ) {
      jdv_rpc(NULL)
      Sys.sleep(0.01)
    }
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
    expect_null(.jdv_transport_status())
    return(invisible(received))
  }

  if (scenario == "empty-registry-close") {
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
    expect_identical(jdv_close(), character())
    expect_true(wait_for_file(paste0(result_path, ".closed"), timeout = 5))
    expect_null(jsonlite::fromJSON(
      paste0(result_path, ".closed"),
      simplifyVector = FALSE
    ))
    expect_null(.jdv_transport_status())
    return(invisible(received))
  }

  expect_identical(jdv_close(id), id)
  expect_true(wait_for_file(paste0(result_path, ".closed"), timeout = 5))
  closed <- jsonlite::fromJSON(
    paste0(result_path, ".closed"),
    simplifyVector = FALSE
  )
  expect_identical(closed$method, "table/closed")
  expect_identical(closed$params$table, id)
  expect_identical(.jdv_transport_status(), NULL)
  invisible(received)
}

test_that("the local viewer sends hello/open, serves rows, and closes", {
  received <- with_mock_transport("fragmented", data.frame(value = 11:13))
  expect_identical(received$responses[[1]]$result$data$row_index, list(1L, 2L))
})

test_that("the largest allowed request frame can arrive in one write", {
  with_mock_transport(
    "maximum-frame",
    data.frame(value = 11:13),
    request_bytes = .jdv_max_request_bytes()
  )
})

test_that("host EOF closes every registry entry", {
  with_mock_transport("disconnect", data.frame(value = 11:13))
})

test_that("a finalizer cannot unload an active transport callback", {
  skip_on_os("windows")
  skip_if_not_installed("callr")
  skip_if(
    !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
    "Active unload requires an installed package"
  )
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local mock host")
  socket_path <- tempfile("jdv-active-unload-")
  ready_path <- tempfile("jdv-active-unload-ready-")
  result_path <- tempfile("jdv-active-unload-result-")
  host <- run_mock_host(
    socket_path,
    ready_path,
    result_path,
    "active-unload",
    1024^2
  )
  on.exit(
    {
      if (host$is_alive()) {
        host$kill()
      }
      try(host$wait(), silent = TRUE)
      unlink(c(socket_path, ready_path, result_path))
    },
    add = TRUE
  )
  expect_true(wait_for_file(ready_path))

  child <- callr::r(
    function(libpath, address, result_path) {
      .libPaths(libpath)
      suppressPackageStartupMessages(loadNamespace("jdv"))
      old_namespace <- asNamespace("jdv")
      poll <- get("jdv_rpc", envir = old_namespace)
      assign("jdv_old_namespace", old_namespace, envir = .GlobalEnv)
      assign("jdv_unload_armed", FALSE, envir = .GlobalEnv)
      assign("jdv_unload_reload_error", NULL, envir = .GlobalEnv)
      assign("jdv_unload_method_calls", 0L, envir = .GlobalEnv)
      assign("jdv_unload_attempts", 0L, envir = .GlobalEnv)
      assign("jdv_unload_can_unload", NULL, envir = .GlobalEnv)
      assign("jdv_unload_status", NULL, envir = .GlobalEnv)
      assign("jdv_unload_finalizer_ran", FALSE, envir = .GlobalEnv)
      assign("jdv_unload_parse_succeeded", FALSE, envir = .GlobalEnv)
      finalizer <- local({
        function(e) {
          assign("jdv_unload_finalizer_ran", TRUE, envir = .GlobalEnv)
          parsed <- .Call(
            get("C_jdv_json_parse", envir = old_namespace),
            '{"method":"table/schema","params":{}}',
            1024^2
          )
          assign(
            "jdv_unload_parse_succeeded",
            is.list(parsed),
            envir = .GlobalEnv
          )
          assign(
            "jdv_unload_can_unload",
            .Call(get("C_jdv_transport_can_unload", envir = old_namespace)),
            envir = .GlobalEnv
          )
          assign(
            "jdv_unload_status",
            get(".jdv_transport_status", envir = old_namespace)(),
            envir = .GlobalEnv
          )
          suppressWarnings(unloadNamespace("jdv"))
          reload_error <- tryCatch(loadNamespace("jdv"), error = identity)
          assign("jdv_unload_reload_error", reload_error, envir = .GlobalEnv)
        }
      })
      token <- new.env(parent = emptyenv())
      reg.finalizer(token, finalizer, onexit = TRUE)
      assign(
        "col_display.jdv_unload_vector",
        function(x, ...) {
          assign(
            "jdv_unload_method_calls",
            get("jdv_unload_method_calls", envir = .GlobalEnv) + 1L,
            envir = .GlobalEnv
          )
          if (isTRUE(get("jdv_unload_armed", envir = .GlobalEnv))) {
            assign("jdv_unload_armed", FALSE, envir = .GlobalEnv)
            assign(
              "jdv_unload_attempts",
              get("jdv_unload_attempts", envir = .GlobalEnv) + 1L,
              envir = .GlobalEnv
            )
            gc()
          }
          format(as.integer(x), ...)
        },
        envir = .GlobalEnv
      )
      value <- data.frame(
        value = structure(11:13, class = c("jdv_unload_vector", "integer"))
      )
      options(jdv.address = address)
      jdv::jdv_view(value, mode = "paged")
      rm(token)
      assign("jdv_unload_armed", TRUE, envir = .GlobalEnv)
      deadline <- Sys.time() + 10
      while (
        !file.exists(result_path) &&
          "jdv" %in% loadedNamespaces() &&
          Sys.time() < deadline
      ) {
        try(poll(NULL), silent = TRUE)
        Sys.sleep(0.01)
      }
      while (!file.exists(result_path) && Sys.time() < deadline) {
        Sys.sleep(0.01)
      }
      list(
        namespace_loaded = "jdv" %in% loadedNamespaces(),
        dll_loaded = "jdv" %in% names(getLoadedDLLs()),
        method_calls = get("jdv_unload_method_calls", envir = .GlobalEnv),
        unload_attempts = get("jdv_unload_attempts", envir = .GlobalEnv),
        finalizer_ran = isTRUE(get("jdv_unload_finalizer_ran", .GlobalEnv)),
        parse_succeeded = isTRUE(get("jdv_unload_parse_succeeded", .GlobalEnv)),
        can_unload = get("jdv_unload_can_unload", envir = .GlobalEnv),
        status = get("jdv_unload_status", envir = .GlobalEnv),
        reload_rejected = inherits(
          get("jdv_unload_reload_error", envir = .GlobalEnv),
          "error"
        ),
        task_callback_present = any(grepl(
          "^jdv_transport_",
          getTaskCallbackNames()
        )),
        registry_entries = length(ls(old_namespace$.jdv_state$entries))
      )
    },
    args = list(
      libpath = .libPaths(),
      address = socket_path,
      result_path = result_path
    )
  )
  expect_true(wait_for_file(result_path))
  host_result <- jsonlite::fromJSON(result_path, simplifyVector = FALSE)
  expect_true(host_result$disconnected)
  expect_identical(child$method_calls, 2L)
  expect_identical(child$unload_attempts, 1L)
  expect_true(child$finalizer_ran)
  expect_true(child$parse_succeeded)
  expect_false(child$can_unload)
  expect_true(child$status$busy)
  expect_length(host_result$responses, 0L)
  expect_false(child$namespace_loaded)
  expect_true(child$dll_loaded)
  expect_true(child$reload_rejected)
  expect_false(child$task_callback_present)
  expect_identical(child$registry_entries, 0L)
})

test_that("close-all stops an active transport with an empty registry", {
  with_mock_transport("empty-registry-close", data.frame(value = 11:13))
})

test_that("multi-megabyte row responses are fully framed", {
  old_options <- options(
    jdv.max_work_bytes = Inf,
    jdv.max_message_bytes = 32 * 1024^2
  )
  on.exit(options(old_options), add = TRUE)
  value <- strrep("z", 2 * 1024^2)
  received <- with_mock_transport(
    "large-response",
    data.frame(value = c(value, value))
  )
  rows <- received$responses[[1]]$result$data$columns[[1]]$data$values
  expect_length(rows, 2L)
  expect_identical(nchar(rows[[1]], type = "bytes"), as.integer(2 * 1024^2))
  expect_identical(rows[[1]], rows[[2]])
})

test_that(
  "large forced snapshots send every value beyond request node limits",
  {
    old_options <- options(
      jdv.max_work_bytes = Inf,
      jdv.max_message_bytes = 32 * 1024^2
    )
    on.exit(options(old_options), add = TRUE)
    received <- with_mock_transport(
      "large-snapshot",
      data.frame(first = rep("a", 50000), second = rep("b", 50000)),
      mode = "snapshot"
    )
    expect_gt(received$open_wire_bytes, 500 * 1024)
    expect_identical(received$open$params$nrow, 50000L)
    expect_identical(received$snapshot_value_count, 100000L)
    expect_gt(received$snapshot_node_count, 100000L)
  }
)

test_that("safe numeric response ids remain valid when JSON uses an exponent", {
  received <- with_mock_transport("numeric-id", data.frame(value = 11:13))
  expect_identical(received$responses[[1]]$id, 1e15)
})

test_that("a host that does not read cannot block a large open indefinitely", {
  skip_on_os("windows")
  skip_if_not_installed("callr")
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local mock host")
  socket_path <- tempfile("jdv-transport-silent-")
  ready_path <- tempfile("jdv-transport-ready-")
  result_path <- tempfile("jdv-transport-result-")
  host <- run_mock_host(socket_path, ready_path, result_path, "silent", 1024^2)
  old_address <- getOption("jdv.address")
  old_timeout <- getOption("jdv.transport.send_timeout_ms")
  options(jdv.address = socket_path, jdv.transport.send_timeout_ms = 100)
  on.exit(
    {
      try(jdv_close(), silent = TRUE)
      options(
        jdv.address = old_address,
        jdv.transport.send_timeout_ms = old_timeout
      )
      if (host$is_alive()) {
        host$kill()
      }
      try(host$wait(), silent = TRUE)
      unlink(c(
        socket_path,
        ready_path,
        result_path,
        paste0(result_path, ".closed")
      ))
    },
    add = TRUE
  )

  expect_true(wait_for_file(ready_path))
  started <- proc.time()[["elapsed"]]
  error <- tryCatch(
    jdv_view(data.frame(value = strrep("x", 8 * 1024^2)), mode = "snapshot"),
    error = identity
  )
  elapsed <- proc.time()[["elapsed"]] - started
  expect_s3_class(error, "error")
  expect_lt(elapsed, 3)
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  jdv_rpc(NULL)
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
})

test_that("cancelled and expired queued work receive no response", {
  with_mock_transport("cancel", data.frame(value = 11:13))
  with_mock_transport(
    "expired",
    data.frame(value = 11:13),
    before_poll = function() Sys.sleep(0.3)
  )
})

test_that(
  "validly framed requests with invalid parameters get an error reply",
  {
    received <- with_mock_transport(
      "invalid-control",
      data.frame(value = 11:13)
    )
    expect_identical(received$responses[[1]]$error$code, "invalid_request")
  }
)

test_that("an invalid cancel id does not cancel a valid queued request", {
  received <- with_mock_transport("invalid-cancel", data.frame(value = 11:13))
  expect_identical(received$responses[[1]]$error$code, "invalid_request")
  expect_identical(received$responses[[2]]$id, "must-survive")
})

test_that(
  "invalid and expired cancel controls do not cancel pending requests",
  {
    with_mock_transport("invalid-encoding-cancel", data.frame(value = 11:13))
    with_mock_transport("invalid-compression-cancel", data.frame(value = 11:13))
    with_mock_transport("invalid-deadline-cancel", data.frame(value = 11:13))
    with_mock_transport("expired-cancel", data.frame(value = 11:13))
    received <- with_mock_transport("typed-id", data.frame(value = 11:13))
    expect_identical(received$responses[[1]]$id, 1L)
  }
)

test_that("duplicate live request ids close the transport", {
  with_mock_transport("duplicate-id", data.frame(value = 11:13))
})

test_that("synchronous expired requests return a typed error", {
  registered <- jdv_register(data.frame(value = 1), mode = "paged")
  on.exit(.jdv_close_internal(registered$id), add = TRUE)
  response <- transport_rpc_call(
    "table/schema",
    list(table = registered$id, generation = 1),
    extra = list(deadline = 1)
  )
  expect_transport_rpc_code(response, "expired")
})

test_that("explicit polling without a viewer connection is a no-op", {
  expect_null(jdv_rpc(NULL))
  expect_null(jdv_rpc())
})

test_that("closing an embedding-only registration does not connect", {
  registered <- jdv_register(data.frame(value = 1), mode = "paged")
  on.exit(
    {
      .jdv_close_internal(registered$id)
      .jdv_state$outbox <- list()
    },
    add = TRUE
  )
  expect_identical(jdv_close(registered$id), registered$id)
  expect_identical(jdv_close(), character())
  expect_null(.jdv_transport_status())
  expect_null(.jdv_state$transport_task_callback)
})

test_that("a failed connection leaves the registry unchanged", {
  skip_on_os("windows")
  old_address <- getOption("jdv.address")
  options(jdv.address = tempfile("jdv-missing-socket-"))
  on.exit(options(jdv.address = old_address), add = TRUE)
  before <- ls(.jdv_state$entries, all.names = TRUE)
  expect_error(jdv_view(data.frame(value = 1), title = "connect-failure"))
  expect_identical(ls(.jdv_state$entries, all.names = TRUE), before)
  expect_null(.jdv_transport_status())
})

test_that("viewer discovery follows the user cache and address precedence", {
  old_options <- options(c("jdv.address", "jdv.discovery_path"))
  old_env <- Sys.getenv(
    c("JDV_ADDRESS", "XDG_CACHE_HOME", "LOCALAPPDATA"),
    unset = NA_character_
  )
  on.exit(
    {
      options(old_options)
      for (name in names(old_env)) {
        if (is.na(old_env[[name]])) {
          Sys.unsetenv(name)
        } else {
          do.call(Sys.setenv, setNames(list(old_env[[name]]), name))
        }
      }
    },
    add = TRUE
  )

  discovery_dir <- tempfile("jdv-cache-")
  dir.create(discovery_dir)
  discovery_file <- file.path(discovery_dir, "discovery.json")
  options(jdv.address = NULL, jdv.discovery_path = NULL)
  Sys.unsetenv("JDV_ADDRESS")
  if (identical(.Platform$OS.type, "windows")) {
    Sys.setenv(LOCALAPPDATA = discovery_dir)
    expected <- file.path(discovery_dir, "jdv", "discovery.json")
  } else if (identical(Sys.info()[["sysname"]], "Darwin")) {
    expected <- file.path(
      path.expand("~"),
      "Library",
      "Caches",
      "jdv",
      "discovery.json"
    )
  } else {
    Sys.setenv(XDG_CACHE_HOME = discovery_dir)
    expected <- file.path(discovery_dir, "jdv", "discovery.json")
  }
  expect_identical(.jdv_discovery_path(), expected)

  options(jdv.discovery_path = discovery_file)
  writeLines('{"socketPath":"unix:///tmp/jdv-mock"}', discovery_file)
  expect_identical(.jdv_resolve_address(), "unix:///tmp/jdv-mock")
  Sys.setenv(JDV_ADDRESS = "tcp://127.0.0.1:43123")
  expect_identical(.jdv_resolve_address(), "tcp://127.0.0.1:43123")
  options(jdv.address = "unix:///tmp/option-address")
  expect_identical(.jdv_resolve_address(), "unix:///tmp/option-address")
  unlink(discovery_dir, recursive = TRUE)
})

test_that("cancel request ids use the same strict raw-token rules", {
  for (request in c(
    '{"method":"cancel","params":{"id":1.0}}',
    '{"method":"cancel","params":{"id":1e0}}',
    '{"method":"cancel","params":{"id":9007199254740992}}'
  )) {
    expect_transport_rpc_code(jdv_rpc(request), "invalid_request")
  }
  expect_null(jdv_rpc('{"method":"cancel","params":{"id":1}}'))
})

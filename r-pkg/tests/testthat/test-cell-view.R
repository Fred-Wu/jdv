local({
  socket_directory <- jdv_test_uds_directory()
  on.exit(unlink(socket_directory, recursive = TRUE), add = TRUE)
  state <- .jdv_state
  saved_outbox <- state$outbox
  on.exit(state$outbox <- saved_outbox, add = TRUE)
  rpc <- function(view, path, method = "object/open") {
    request <- list(
      id = 1,
      method = method,
      params = list(
        view = view$id %||% view$view,
        generation = view$generation %||% 1,
        path = path
      )
    )
    .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
  }
  cell <- function(row = 1, column = 0) {
    list(kind = "cell", row_index = row, column = column)
  }
  index <- function(i = 1) list(type = "index", index = i)
  frame <- function(column) {
    structure(
      list(value = column),
      class = "data.frame",
      row.names = .set_row_names(column_size(column))
    )
  }
  close <- function(view) .jdv_close_internal(view$id %||% view$view)

  test_that("drillable schemas use an explicit class allowlist", {
    skip_if_not_installed("vctrs")
    allowed <- list(
      list(1),
      I(list(1)),
      vctrs::list_of(1L),
      data.frame(a = 1),
      matrix(1)
    )
    denied <- list(
      1,
      I(1),
      as.POSIXlt("2020-01-01", tz = "UTC"),
      structure(list(1), class = c("unknown", "AsIs")),
      structure(list(1), class = c("AsIs", "unknown")),
      vctrs::new_rcrd(list(a = 1))
    )
    expect_true(all(vapply(allowed, column_drillable, logical(1))))
    expect_false(any(vapply(denied, column_drillable, logical(1))))
    for (mode in c("snapshot", "paged")) {
      root <- jdv_register(frame(list(1)), mode = mode)
      descriptor <- .jdv_json_parse(root$open)$params
      expect_true(descriptor$columns[[1]]$drillable)
      expect_true(descriptor$capabilities$children)
      close(root)
    }
  })

  test_that("rejecting classed lists does not dispatch dim methods", {
    value <- structure(list(1, 2), class = "cell_bad_dim")
    calls <- 0L
    with_column_method(
      "dim",
      "cell_bad_dim",
      function(x) {
        calls <<- calls + 1L
        stop("must not dispatch")
      },
      {
        expect_false(column_drillable(value))
        expect_identical(calls, 0L)
      }
    )
  })

  test_that("snapshots retain source references only for drillable columns", {
    plain <- jdv_register(data.frame(a = 1:2), mode = "snapshot")
    on.exit(close(plain), add = TRUE)
    entry <- get(plain$id, state$entries)
    expect_null(entry$source)
    expect_null(entry$holder)
    expect_null(entry$fingerprint)
    expect_false(.jdv_json_parse(plain$open)$params$capabilities$children)
    source <- frame(list(list(a = 1), list(b = 2)))
    root <- jdv_register(source, mode = "snapshot")
    on.exit(close(root), add = TRUE)
    entry <- get(root$id, state$entries)
    expect_identical(entry$source, source)
    expect_true(.Call(C_jdv_tree_same, entry$source, source))
    expect_null(entry$holder)
    expect_identical(entry$fingerprint, .jdv_fingerprint(source))
    expect_null(rpc(root, list(), "view/schema")$error)
    opened <- rpc(root, list(cell(2)))$result
    expect_identical(opened$parent, root$id)
    expect_identical(get(opened$view, state$entries)$tree_value, list(b = 2))
    expect_length(opened$path, 0)
  })

  test_that("cell paths use original rows and preserve structural values", {
    source <- structure(
      list(
        key = c(3L, 1L, 2L),
        values = I(list(list(a = 30L), list(a = 10L), list(a = 20L)))
      ),
      class = "data.frame",
      row.names = .set_row_names(3L)
    )
    for (mode in c("snapshot", "paged")) {
      root <- jdv_register(source, mode = mode)
      on.exit(close(root), add = TRUE)
      if (mode == "paged") {
        response <- jdv_rpc(.jdv_json_encode(list(
          id = 2,
          method = "table/rows",
          params = list(
            view = root$id,
            generation = 1,
            sort = list(list(col = 0, desc = FALSE)),
            offset = 0,
            limit = 3
          )
        )))
        expect_null(.jdv_json_parse(response)$error)
      } else {
        expect_equal(
          snapshot_indices(
            snapshot_table(source),
            sort = list(list(col = 0, desc = FALSE))
          ),
          c(2, 3, 1)
        )
      }
      opened <- rpc(root, list(cell(1, 1), index()))$result
      expect_identical(get(opened$view, state$entries)$tree_value, 30L)
    }
    for (column in list(data.frame(a = 1:2, b = 3:4), matrix(1:6, 2))) {
      root <- jdv_register(frame(column), mode = "snapshot")
      on.exit(close(root), add = TRUE)
      opened <- rpc(root, list(cell(2)))$result
      expect_identical(opened$kind, "grid")
      expect_equal(opened$data$row_index, list(1))
      child <- get(opened$view, state$entries)
      expect_equal(child$nrow, 1)
      expect_equal(child$ncol, ncol(column))
    }
  })

  test_that(
    "cell validation rejects malformed mixed and non-drillable selectors",
    {
      root <- jdv_register(frame(list(list(a = 1))), mode = "paged")
      on.exit(close(root), add = TRUE)
      bad <- list(
        list(),
        list(cell(0)),
        list(cell(2)),
        list(cell(1, 1)),
        list(cell(1.5)),
        list(cell(column = "0")),
        list(index()),
        list(c(cell(), list(type = "index", index = 1))),
        list(cell(), cell()),
        list(cell(), c(index(), cell())),
        rep(list(cell()), 33)
      )
      for (path in bad) {
        expect_identical(rpc(root, path)$error$code, "invalid_request")
      }
      expect_identical(
        rpc(root, list(), "object/children")$error$code,
        "unsupported"
      )
      plain <- jdv_register(data.frame(a = 1))
      on.exit(close(plain), add = TRUE)
      expect_identical(rpc(plain, list(cell()))$error$code, "invalid_request")
      tree <- jdv_register(list(1))
      on.exit(close(tree), add = TRUE)
      expect_identical(
        rpc(tree, list(c(index(), cell())))$error$code,
        "invalid_request"
      )
      expect_identical(
        rpc(
          root,
          list(cell(), list(type = "binding", name = "gone"))
        )$error$code,
        "unavailable"
      )
    }
  )

  test_that(
    "captured cells and suffix lookup do not dispatch list subset methods",
    {
      env <- new.env(parent = emptyenv())
      env$value <- 1L
      hits <- 0L
      makeActiveBinding(
        "active",
        function() {
          hits <<- hits + 1L
          2L
        },
        env
      )
      delayedAssign(
        "promise",
        {
          hits <<- hits + 1L
          3L
        },
        assign.env = env
      )
      root <- jdv_register(frame(list(env)))
      on.exit(close(root), add = TRUE)
      opened <- rpc(root, list(cell()))$result
      expect_identical(get(opened$view, state$entries)$tree_value, env)
      for (name in c("active", "promise")) {
        expect_identical(
          rpc(
            root,
            list(cell(), list(type = "binding", name = name))
          )$error$code,
          "unavailable"
        )
      }
      expect_equal(hits, 0)
      state$entries[[root$id]]$source[[1]][[1]] <- list(replaced = TRUE)
      expect_identical(get(opened$view, state$entries)$tree_value, env)
      close(root)
      expect_false(exists(opened$view, state$entries, inherits = FALSE))
      expect_identical(rpc(root, list(cell()))$error$code, "view_not_found")
    }
  )

  test_that(
    "list extraction bypasses subset dispatch and cell counts toward path depth",
    {
      root <- jdv_register(frame(I(list(list(answer = 42L)))))
      on.exit(close(root), add = TRUE)
      with_column_method("[", "AsIs", function(...) stop("must not dispatch"), {
        opened <- rpc(root, list(cell()))$result
        expect_identical(
          get(opened$view, state$entries)$tree_value,
          list(answer = 42L)
        )
      })
      value <- 42L
      for (i in seq_len(31)) {
        value <- list(value)
      }
      deep <- jdv_register(frame(list(value)))
      on.exit(close(deep), add = TRUE)
      path <- c(list(cell()), rep(list(index()), 31))
      opened <- rpc(deep, path)$result
      expect_identical(get(opened$view, state$entries)$tree_value, 42L)
      expect_identical(
        rpc(deep, c(path, list(index())))$error$code,
        "invalid_request"
      )
      stale <- deep
      stale$generation <- 2
      expect_identical(rpc(stale, list(cell()))$error$code, "stale_generation")
      denied <- jdv_register(frame(structure(
        list(1),
        class = c("unknown", "AsIs")
      )))
      on.exit(close(denied), add = TRUE)
      expect_identical(rpc(denied, list(cell()))$error$code, "invalid_request")
    }
  )

  test_that("structural cell getter failures are unavailable", {
    column <- structure(
      data.frame(x = 1:2),
      class = c("cell_bad_frame", "data.frame")
    )
    root <- jdv_register(frame(column), mode = "paged")
    on.exit(close(root), add = TRUE)
    with_column_method(
      "[",
      "cell_bad_frame",
      function(...) stop("cell getter failed"),
      {
        expect_identical(rpc(root, list(cell()))$error$code, "unavailable")
      }
    )
  })

  test_that(
    "the root descendant cap includes nested mixed grid and tree children",
    {
      old <- options(jdv.max_tables = 64)
      on.exit(options(old), add = TRUE)
      root <- jdv_register(frame(list(list(data.frame(x = 1), list(7)))))
      on.exit(close(root), add = TRUE)
      branch <- rpc(root, list(cell()))$result
      grid <- rpc(branch, list(index()))$result
      for (i in seq_len(30)) {
        opened <- rpc(branch, list(index(2)))
        expect_null(opened$error)
      }
      expect_equal(.jdv_tree_descendant_count(get(root$id, state$entries)), 32)
      expect_identical(rpc(branch, list(index(2)))$error$code, "limit_exceeded")
      close(grid)
      expect_null(rpc(branch, list(index(2)))$error)
      expect_equal(.jdv_tree_descendant_count(get(root$id, state$entries)), 32)
      parent <- get(root$id, state$entries)
      child <- get(branch$view, state$entries)
      child$parent_generation <- 99
      expect_identical(
        rpc(branch, list(index(2)))$error$code,
        "stale_generation"
      )
      child$parent_generation <- parent$generation
    }
  )

  test_that("child eviction notifications survive final response rollback", {
    old <- options(jdv.max_tables = 2)
    on.exit(options(old), add = TRUE)
    for (value in list(list(1), data.frame(x = 1))) {
      for (fail in c(FALSE, TRUE)) {
        anchor <- jdv_register(list(anchor = 1))
        parent <- jdv_register(frame(list(value)))
        on.exit(close(parent), add = TRUE)
        namespace <- asNamespace("jdv")
        original <- get(".jdv_json_encode", namespace)
        if (fail) {
          replacement <- function(x, ...) {
            if (is.list(x$result) && !is.null(x$result$parent)) {
              stop("injected response failure")
            }
            original(x, ...)
          }
          unlockBinding(".jdv_json_encode", namespace)
          assign(".jdv_json_encode", replacement, namespace)
          lockBinding(".jdv_json_encode", namespace)
        }
        response <- tryCatch(rpc(parent, list(cell())), finally = {
          unlockBinding(".jdv_json_encode", namespace)
          assign(".jdv_json_encode", original, namespace)
          lockBinding(".jdv_json_encode", namespace)
        })
        expect_identical(!is.null(response$error), fail)
        messages <- lapply(state$outbox, .jdv_json_parse)
        expect_equal(
          sum(vapply(
            messages,
            function(x) identical(x$params$view, anchor$id),
            logical(1)
          )),
          1
        )
        expect_false(exists(anchor$id, state$entries, inherits = FALSE))
        if (fail) {
          expect_length(get(parent$id, state$entries)$children, 0)
        }
        close(parent)
        state$outbox <- list()
      }
    }
  })

  test_that("active JSONL hosts receive eviction, notification-only and cascade events in order", {
    skip_on_cran()
    skip_if_not_installed("callr")
    skip_if_not_installed("jsonlite")
    skip_on_os("windows")
    skip_if(!nzchar(Sys.which("python3")))
    for (scenario in c(
      "success",
      "encode_failure",
      "send_failure",
      "disconnect"
    )) {
      for (grid_child in c(FALSE, TRUE)) {
        directory <- tempfile("cell-", tmpdir = socket_directory)
        dir.create(directory)
        socket <- file.path(directory, "socket")
        ready <- file.path(directory, "ready")
        result <- file.path(directory, "result")
        control <- file.path(directory, "control")
        host <- callr::r_bg(
          function(script, python, paths, scenario) {
            args <- c(
              shQuote(script),
              unlist(Map(
                function(name, value) c(paste0("--", name), shQuote(value)),
                names(paths),
                paths
              )),
              "--scenario",
              scenario
            )
            output <- system2(python, args, stdout = TRUE, stderr = TRUE)
            if (!is.null(attr(output, "status"))) {
              stop(paste(output, collapse = "\n"))
            }
          },
          args = list(
            script = test_path("fixtures", "transport-cell-host.py"),
            python = Sys.which("python3"),
            paths = list(
              socket = socket,
              ready = ready,
              result = result,
              control = control
            ),
            scenario = scenario
          ),
          supervise = TRUE
        )
        old <- options(
          jdv.address = socket,
          jdv.max_tables = 2,
          jdv.max_message_bytes = 4096
        )
        namespace <- asNamespace("jdv")
        original <- get(".jdv_json_encode", namespace)
        cleanup <- function() {
          unlockBinding(".jdv_json_encode", namespace)
          assign(".jdv_json_encode", original, namespace)
          lockBinding(".jdv_json_encode", namespace)
          try(jdv_close(), silent = TRUE)
          options(old)
          if (host$is_alive()) {
            host$kill()
          }
          unlink(directory, recursive = TRUE)
        }
        tryCatch(
          {
            wait <- function(path, poll = FALSE) {
              deadline <- Sys.time() + 15
              while (!file.exists(path) && Sys.time() < deadline) {
                if (poll) {
                  jdv_rpc()
                }
                Sys.sleep(0.01)
              }
              expect_true(file.exists(path))
            }
            wait(ready)
            anchor <- jdv_view(list(anchor = 1), title = NULL)
            value <- if (grid_child) data.frame(x = 1) else list(1)
            parent <- jdv_view(
              frame(list(value)),
              title = NULL,
              mode = "snapshot"
            )
            if (scenario == "encode_failure") {
              unlockBinding(".jdv_json_encode", namespace)
              assign(
                ".jdv_json_encode",
                function(x, ...) {
                  if (
                    is.list(x) && is.list(x$result) && !is.null(x$result$parent)
                  ) {
                    stop("injected final response failure")
                  }
                  original(x, ...)
                },
                namespace
              )
              lockBinding(".jdv_json_encode", namespace)
            }
            wait(paste0(control, ".stage"), TRUE)
            parent_entry <- get(parent, state$entries)
            if (scenario == "success") {
              # Replacing the child queues an eviction for a notification-only RPC.
              replacement <- .jdv_tree_register_child(list(2), parent_entry)
            } else if (scenario == "send_failure") {
              state$outbox <- list(original(
                list(
                  method = "view/closed",
                  params = list(view = "fault", reason = strrep("x", 6000))
                ),
                limit = 10000
              ))
            }
            file.create(control)
            wait(result, TRUE)
            host$wait()
            .jdv_transport_housekeeping()
            expect_null(host$get_result())
            messages <- jsonlite::fromJSON(
              result,
              simplifyVector = FALSE
            )$messages
            file.copy(
              result,
              file.path(
                tempdir(),
                paste0("jdv-cell-wire-", scenario, "-", grid_child, ".json")
              ),
              overwrite = TRUE
            )
            methods <- vapply(
              messages,
              function(x) x$method %||% "response",
              character(1)
            )
            closed <- Filter(
              function(x) identical(x$method, "view/closed"),
              messages
            )
            expect_identical(closed[[1]]$params$view, anchor)
            expect_equal(
              sum(vapply(
                closed,
                function(x) identical(x$params$view, anchor),
                logical(1)
              )),
              1
            )
            response <- Filter(function(x) identical(x$id, "open"), messages)[[
              1
            ]]
            expect_identical(
              !is.null(response$error),
              scenario == "encode_failure"
            )
            expect_lt(
              which(methods == "view/closed")[[1]],
              which(vapply(
                messages,
                function(x) identical(x$id, "open"),
                logical(1)
              ))
            )
            if (scenario == "success") {
              expect_length(closed, 3)
              expect_true(utils::tail(
                Filter(function(x) identical(x$id, "close"), messages),
                1
              )[[1]]$result$closed)
              expect_length(state$outbox, 0)
            } else if (scenario %in% c("send_failure", "disconnect")) {
              expect_false(isTRUE(.jdv_transport_status()$connected))
              expect_length(ls(state$entries), 0)
              expect_length(state$outbox, 0)
            }
          },
          finally = cleanup()
        )
      }
    }
  })
})

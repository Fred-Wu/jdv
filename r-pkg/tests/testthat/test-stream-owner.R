test_that("export moves once and output ownership is independent", {
  with_arrow_owner(function(owner) {
    source <- owner$stream()
    token <- jdv:::.jdv_stream_move(source)
    expect_type(token, "environment")
    expect_identical(parent.env(token), emptyenv())
    expect_error(source$get_schema(), "released|NULL")
    expect_error(jdv:::.jdv_stream_move(source), "released|valid|NULL")
    schema <- jdv:::.jdv_stream_schema(token)
    empty <- jdv:::.jdv_stream_next(token)
    array <- jdv:::.jdv_stream_next(token)
    expect_identical(jdv:::.jdv_stream_info(empty)$value, "0")
    expect_identical(jdv:::.jdv_stream_info(array)$value, "3")
    expect_null(jdv:::.jdv_stream_next(token))
    expect_equal(owner$counts(), c(0, 0, 0, 1))
    expect_true(jdv:::.jdv_stream_close(token))
    expect_false(jdv:::.jdv_stream_close(token))
    expect_identical(jdv:::.jdv_stream_info(schema)$value, "+s")
    expect_identical(jdv:::.jdv_stream_info(array)$value, "3")
    expect_equal(owner$counts(), c(1, 0, 0, 1))
    expect_true(jdv:::.jdv_stream_close(schema))
    expect_true(jdv:::.jdv_stream_close(empty))
    expect_true(jdv:::.jdv_stream_close(array))
    expect_equal(owner$counts(), c(1, 1, 2, 0))
    expect_false(jdv:::.jdv_stream_close(array))
    expect_error(jdv:::.jdv_stream_info(token), "closed|stale")
    expect_error(jdv:::.jdv_stream_schema(array), "closed|wrong kind")
    expect_error(jdv:::.jdv_stream_close(1L), "token")
    expect_equal(unname(jdv:::.jdv_stream_status()), c(0L, 0L, 0L, 0L))
  })
})

test_that("releaseable error outputs release once after copying error text", {
  with_arrow_owner(function(owner) {
    for (mode in 1:2) {
      source <- owner$stream(mode = mode)
      token <- jdv:::.jdv_stream_move(source)
      before <- owner$counts()
      if (mode == 1) {
        expect_error(
          jdv:::.jdv_stream_next(token),
          "original array producer error"
        )
      } else {
        expect_error(
          jdv:::.jdv_stream_schema(token),
          "original schema producer error"
        )
      }
      expected <- if (mode == 1) c(0, 0, 1, 0) else c(0, 1, 0, 0)
      expect_equal(owner$counts() - before, expected)
      expect_true(jdv:::.jdv_stream_close(token))
    }
    expect_equal(owner$counts(), c(2, 1, 1, 0))
  })
})

test_that(
  "callback jumps clean pending outputs and restore the operation guard",
  {
    with_arrow_owner(function(owner) {
      source <- owner$stream(
        hook = function(event) {
          if (event == "next") stop("intentional producer callback jump")
        }
      )
      token <- jdv:::.jdv_stream_move(source)
      expect_error(
        jdv:::.jdv_stream_next(token),
        "intentional producer callback jump"
      )
      expect_equal(owner$counts(), c(0, 0, 1, 1))
      expect_identical(jdv:::.jdv_stream_status()[["busy"]], 0L)
      expect_true(jdv:::.jdv_stream_close(token))
      expect_equal(owner$counts(), c(1, 0, 1, 0))
    })
  }
)

test_that("release reentry is idempotent and cannot register another stream", {
  with_arrow_owner(function(owner) {
    state <- new.env(parent = emptyenv())
    spare <- owner$stream()
    source <- owner$stream(
      hook = function(event) {
        if (event == "stream_release") {
          expect_false(jdv:::.jdv_stream_close(state$token))
          expect_error(jdv:::.jdv_stream_move(spare), "producer callback")
          expect_true(getExportedValue(
            "nanoarrow",
            "nanoarrow_pointer_is_valid"
          )(spare))
        }
      }
    )
    state$token <- jdv:::.jdv_stream_move(source)
    expect_true(jdv:::.jdv_stream_close(state$token))
    expect_equal(owner$counts(), c(1, 0, 0, 1))
    expect_identical(jdv:::.jdv_stream_status()[["busy"]], 0L)
    second <- jdv:::.jdv_stream_move(spare)
    expect_true(jdv:::.jdv_stream_close(second))
    expect_equal(owner$counts(), c(2, 0, 0, 0))
  })
})

test_that(
  "a jumping release is not retried and leaves registry guards usable",
  {
    with_arrow_owner(function(owner) {
      source <- owner$stream(
        hook = function(event) {
          if (event == "stream_release") stop("intentional release jump")
        }
      )
      token <- jdv:::.jdv_stream_move(source)
      expect_error(jdv:::.jdv_stream_close(token), "intentional release jump")
      expect_false(jdv:::.jdv_stream_close(token))
      expect_equal(owner$counts(), c(1, 0, 0, 0))
      expect_identical(jdv:::.jdv_stream_status()[["busy"]], 0L)
      second <- jdv:::.jdv_stream_move(owner$stream())
      expect_true(jdv:::.jdv_stream_close(second))
      expect_equal(owner$counts(), c(2, 0, 0, 0))
    })
  }
)

test_that("a nanoarrow producer and its export dependency survive GC", {
  skip_if_not_installed("nanoarrow")
  counter <- new.env(parent = emptyenv())
  counter$n <- 0L
  token <- local({
    producer <- getExportedValue(
      "nanoarrow",
      "as_nanoarrow_array_stream"
    )(data.frame(x = 1:3, y = c("a", "b", "c")))
    producer <- getExportedValue("nanoarrow", "array_stream_set_finalizer")(
      producer,
      function() counter$n <- counter$n + 1L
    )
    jdv:::.jdv_stream_move(producer)
  })
  on.exit(jdv:::.jdv_stream_cleanup(), add = TRUE)
  invisible(gc())
  expect_identical(counter$n, 0L)
  schema <- jdv:::.jdv_stream_schema(token)
  array <- jdv:::.jdv_stream_next(token)
  expect_identical(jdv:::.jdv_stream_info(schema)$value, "+s")
  expect_identical(jdv:::.jdv_stream_info(array)$value, "3")
  expect_true(jdv:::.jdv_stream_close(token))
  expect_identical(counter$n, 1L)
  expect_identical(jdv:::.jdv_stream_info(array)$value, "3")
  expect_true(jdv:::.jdv_stream_close(schema))
  expect_true(jdv:::.jdv_stream_close(array))
  invisible(gc())
  expect_identical(counter$n, 1L)
})

test_that(
  "an Arrow Table producer survives GC and releases independent outputs",
  {
    skip_if_not_installed("arrow")
    skip_if_not_installed("nanoarrow")
    counter <- new.env(parent = emptyenv())
    counter$n <- 0L
    token <- local({
      table <- getExportedValue("arrow", "Table")$create(x = 1:3)
      reader <- getExportedValue("arrow", "as_record_batch_reader")(table)
      producer <- getExportedValue("nanoarrow", "as_nanoarrow_array_stream")(
        reader
      )
      producer <- getExportedValue("nanoarrow", "array_stream_set_finalizer")(
        producer,
        function() counter$n <- counter$n + 1L
      )
      jdv:::.jdv_stream_move(producer)
    })
    on.exit(jdv:::.jdv_stream_cleanup(), add = TRUE)
    invisible(gc())
    schema <- jdv:::.jdv_stream_schema(token)
    array <- jdv:::.jdv_stream_next(token)
    expect_identical(counter$n, 0L)
    expect_true(jdv:::.jdv_stream_close(token))
    expect_identical(counter$n, 1L)
    expect_identical(jdv:::.jdv_stream_info(schema)$value, "+s")
    expect_identical(jdv:::.jdv_stream_info(array)$value, "3")
    expect_true(jdv:::.jdv_stream_close(schema))
    expect_true(jdv:::.jdv_stream_close(array))
    invisible(gc())
    expect_identical(counter$n, 1L)
  }
)

test_that(
  "nanoarrow handles an ordinary R finalizer error without double release",
  {
    skip_if_not_installed("nanoarrow")
    counter <- new.env(parent = emptyenv())
    counter$n <- 0L
    producer <- getExportedValue(
      "nanoarrow",
      "as_nanoarrow_array_stream"
    )(data.frame(x = 1))
    producer <- getExportedValue("nanoarrow", "array_stream_set_finalizer")(
      producer,
      function() {
        counter$n <- counter$n + 1L
        stop("intentional R producer finalizer error")
      }
    )
    token <- jdv:::.jdv_stream_move(producer)
    expect_true(jdv:::.jdv_stream_close(token))
    expect_false(jdv:::.jdv_stream_close(token))
    invisible(gc())
    expect_identical(counter$n, 1L)
  }
)

test_that(
  "cleanup requested from a producer is deferred without returning a stale token",
  {
    with_arrow_owner(function(owner) {
      source <- owner$stream(
        hook = function(event) {
          if (event == "next") {
            expect_identical(.Call(jdv:::C_jdv_arrow_cleanup), -1L)
          }
        }
      )
      token <- jdv:::.jdv_stream_move(source)
      other <- jdv:::.jdv_stream_move(owner$stream())
      expect_error(jdv:::.jdv_stream_next(token), "cleanup was requested")
      expect_false(jdv:::.jdv_stream_close(token))
      expect_false(jdv:::.jdv_stream_close(other))
      expect_equal(owner$counts(), c(2, 0, 1, 0))
      expect_identical(jdv:::.jdv_stream_status()[["busy"]], 0L)
    })
  }
)

test_that(
  "namespace and direct DLL unload release independent outputs exactly once",
  {
    skip_if(
      !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
      "A real unload requires an installed package"
    )
    with_arrow_owner(function(owner) {
      for (mode in c("namespace", "dyn", "library")) {
        result <- callr::r(
          function(path, mode) {
            ns <- loadNamespace("jdv")
            dll <- dyn.load(path)
            methods <- getDLLRegisteredRoutines(dll)[[".Call"]]
            allocate <- getExportedValue(
              "nanoarrow",
              "nanoarrow_allocate_array_stream"
            )
            source <- allocate()
            .Call(methods$owner_init, source, 3L, 0L, NULL)
            token <- get(".jdv_stream_move", ns)(source)
            schema <- get(".jdv_stream_schema", ns)(token)
            array <- get(".jdv_stream_next", ns)(token)
            old_close <- get(".jdv_stream_close", ns)
            old_info <- get(".jdv_stream_info", ns)
            old_status <- get(".jdv_stream_status", ns)
            lib <- dirname(find.package("jdv"))
            dll_path <- getLoadedDLLs()[["jdv"]][["path"]]
            if (mode == "namespace") {
              unloadNamespace("jdv")
              for (fun in list(
                function() old_close(token),
                function() old_info(token),
                old_status
              )) {
                message <- tryCatch(
                  {
                    fun()
                    "unexpected success"
                  },
                  error = conditionMessage
                )
                stopifnot(grepl("shutting down", message))
              }
            } else if (mode == "dyn") {
              dyn.unload(dll_path)
            } else {
              library.dynam.unload("jdv", find.package("jdv"))
            }
            counts <- function() .Call(methods$owner_counts)
            stopifnot(identical(counts(), c(1L, 1L, 1L, 0L)))
            invisible(gc())
            stopifnot(identical(counts(), c(1L, 1L, 1L, 0L)))
            if (mode != "namespace") {
              # Remove the old namespace without invoking its stale native helpers.
              # Its DLL has already gone; only a fresh process is supported here.
              return(TRUE)
            }
            ns <- loadNamespace("jdv", lib.loc = lib)
            stopifnot(identical(get(".jdv_stream_close", ns)(token), FALSE))
            error <- tryCatch(
              get(".jdv_stream_schema", ns)(token),
              error = conditionMessage
            )
            stopifnot(is.character(error), grepl("closed|stale", error))
            fresh <- allocate()
            .Call(methods$owner_init, fresh, 1L, 0L, NULL)
            next_token <- get(".jdv_stream_move", ns)(fresh)
            stopifnot(!identical(token, next_token))
            stopifnot(get(".jdv_stream_close", ns)(next_token))
            rm(token, schema, array, source)
            invisible(gc())
            stopifnot(identical(counts(), c(2L, 1L, 1L, 0L)))
            unloadNamespace("jdv")
            TRUE
          },
          args = list(path = owner$path, mode = mode),
          libpath = .libPaths()
        )
        expect_true(result)
      }
    })
  }
)

test_that(
  "raw unload from a producer callback is rejected before unloading code",
  {
    skip_if(
      !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
      "A real unload requires an installed package"
    )
    with_arrow_owner(function(owner) {
      result <- callr::r(
        function(path) {
          ns <- loadNamespace("jdv")
          dll <- dyn.load(path)
          methods <- getDLLRegisteredRoutines(dll)[[".Call"]]
          source <- getExportedValue(
            "nanoarrow",
            "nanoarrow_allocate_array_stream"
          )()
          seen <- new.env(parent = emptyenv())
          hook <- function(event) {
            if (event == "next") {
              seen$error <- tryCatch(
                {
                  dyn.unload(getLoadedDLLs()[["jdv"]][["path"]])
                  "unexpected success"
                },
                error = conditionMessage
              )
            }
          }
          .Call(methods$owner_init, source, 3L, 0L, hook)
          token <- get(".jdv_stream_move", ns)(source)
          array <- get(".jdv_stream_next", ns)(token)
          stopifnot(
            grepl("Cannot unload", seen$error),
            "jdv" %in% names(getLoadedDLLs())
          )
          stopifnot(
            get(".jdv_stream_close", ns)(array),
            get(".jdv_stream_close", ns)(token)
          )
          stopifnot(identical(.Call(methods$owner_counts), c(1L, 0L, 1L, 0L)))
          TRUE
        },
        args = list(path = owner$path),
        libpath = .libPaths()
      )
      expect_true(result)
    })
  }
)

test_that(
  "registry preserves tokens until cleanup and releases every preservation",
  {
    with_arrow_owner(function(owner) {
      observed <- new.env(parent = emptyenv())
      observed$n <- 0L
      tokens <- local({
        stream <- jdv:::.jdv_stream_move(owner$stream(lengths = 3L))
        list(
          stream,
          jdv:::.jdv_stream_schema(stream),
          jdv:::.jdv_stream_next(stream)
        )
      })
      for (token in tokens) {
        reg.finalizer(token, function(x) observed$n <- observed$n + 1L)
      }
      rm(tokens, token)
      invisible(gc())
      expect_identical(observed$n, 0L)
      expect_equal(owner$counts(), c(0, 0, 0, 1))
      expect_identical(.Call(jdv:::C_jdv_arrow_cleanup), 0L)
      invisible(gc())
      expect_identical(observed$n, 3L)
      expect_equal(owner$counts(), c(1, 1, 1, 0))
      expect_identical(.Call(jdv:::C_jdv_arrow_cleanup), 0L)
    })
  }
)

test_that(
  "namespace unload during a callback defers cleanup until the callback unwinds",
  {
    skip_if(
      !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
      "A real unload requires an installed package"
    )
    with_arrow_owner(function(owner) {
      result <- callr::r(
        function(path) {
          ns <- loadNamespace("jdv")
          dll <- dyn.load(path)
          methods <- getDLLRegisteredRoutines(dll)[[".Call"]]
          source <- getExportedValue(
            "nanoarrow",
            "nanoarrow_allocate_array_stream"
          )()
          hook <- function(event) {
            if (event == "next") suppressWarnings(unloadNamespace("jdv"))
          }
          .Call(methods$owner_init, source, 3L, 0L, hook)
          token <- get(".jdv_stream_move", ns)(source)
          error <- tryCatch(
            get(".jdv_stream_next", ns)(token),
            error = conditionMessage
          )
          stopifnot(is.character(error), grepl("cleanup was requested", error))
          stopifnot(
            !"jdv" %in% loadedNamespaces(),
            "jdv" %in% names(getLoadedDLLs())
          )
          stopifnot(identical(.Call(methods$owner_counts), c(1L, 0L, 1L, 0L)))
          ns <- loadNamespace("jdv")
          stopifnot(identical(get(".jdv_stream_close", ns)(token), FALSE))
          stopifnot(identical(get(".jdv_stream_status", ns)()[["busy"]], 0L))
          unloadNamespace("jdv")
          stopifnot(!"jdv" %in% names(getLoadedDLLs()))
          TRUE
        },
        args = list(path = owner$path),
        libpath = .libPaths()
      )
      expect_true(result)
    })
  }
)

test_that("raw unload blocks new native work from foreign release callbacks", {
  skip_if(
    !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
    "A real unload requires an installed package"
  )
  with_arrow_owner(function(owner) {
    result <- callr::r(
      function(path) {
        ns <- loadNamespace("jdv")
        dll <- dyn.load(path)
        methods <- getDLLRegisteredRoutines(dll)[[".Call"]]
        allocate <- getExportedValue(
          "nanoarrow",
          "nanoarrow_allocate_array_stream"
        )
        spare <- allocate()
        .Call(methods$owner_init, spare, 1L, 0L, NULL)
        seen <- new.env(parent = emptyenv())
        hook <- function(event) {
          if (event == "stream_release") {
            seen$move <- tryCatch(
              get(".jdv_stream_move", ns)(spare),
              error = conditionMessage
            )
            seen$transport <- tryCatch(
              get(".jdv_transport_connect", ns)("unused"),
              error = conditionMessage
            )
          }
        }
        source <- allocate()
        .Call(methods$owner_init, source, 3L, 0L, hook)
        token <- get(".jdv_stream_move", ns)(source)
        dyn.unload(getLoadedDLLs()[["jdv"]][["path"]])
        stopifnot(
          grepl("being unloaded", seen$move),
          grepl("being unloaded", seen$transport)
        )
        stopifnot(identical(.Call(methods$owner_counts), c(1L, 0L, 0L, 1L)))
        stopifnot(getExportedValue("nanoarrow", "nanoarrow_pointer_is_valid")(
          spare
        ))
        spare$release()
        invisible(gc())
        stopifnot(identical(.Call(methods$owner_counts), c(2L, 0L, 0L, 0L)))
        TRUE
      },
      args = list(path = owner$path),
      libpath = .libPaths()
    )
    expect_true(result)
  })
})

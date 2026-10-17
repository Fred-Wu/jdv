test_that("argument errors carry jdv_error_invalid_argument", {
  jdv_disconnect()
  withr::defer(jdv_disconnect())
  err <- expect_error(
    jdv_view(data.frame(a = 1), track = NA),
    class = "jdv_error_invalid_argument"
  )
  expect_s3_class(err, "jdv_error")
  expect_identical(err$code, "invalid_argument")
  expect_error(jdv_close(1), class = "jdv_error_invalid_argument")
  expect_error(jdv_connect(c("a", "b")), class = "jdv_error_invalid_argument")
  expect_error(
    jdv_binding("x", env = list()),
    class = "jdv_error_invalid_argument"
  )
  withr::local_options(jdv.address = c("a", "b"))
  expect_error(jdv_connect(), class = "jdv_error_invalid_argument")
})

test_that("an unreachable viewer is connect_failed", {
  skip_on_os("windows")
  jdv_disconnect()
  withr::defer(jdv_disconnect())
  withr::local_options(jdv.address = tempfile("jdv-missing-socket-"))
  expect_error(jdv_connect(), class = "jdv_error_connect_failed")
  expect_error(jdv_view(data.frame(a = 1)), class = "jdv_error_connect_failed")

  withr::local_options(jdv.address = NULL)
  withr::local_envvar(JDV_ADDRESS = NA)
  withr::local_options(jdv.discovery_path = tempfile("jdv-no-discovery-"))
  expect_error(jdv_connect(), class = "jdv_error_connect_failed")
  path <- tempfile("jdv-discovery-")
  writeLines("{}", path)
  withr::defer(unlink(path))
  withr::local_options(jdv.discovery_path = path)
  expect_error(jdv_connect(), class = "jdv_error_connect_failed")
})

test_that("an embedded session and a connection exclude each other", {
  jdv_disconnect()
  withr::defer(jdv_disconnect())
  jdv_register(data.frame(a = 1))
  expect_error(jdv_connect("unix:///tmp/jdv-none"), class = "jdv_error_in_use")
  expect_error(jdv_view(data.frame(a = 1)), class = "jdv_error_in_use")
})

test_that("sending without a connection is not_connected", {
  jdv_disconnect()
  expect_error(.jdv_transport_send("{}"), class = "jdv_error_not_connected")
})

test_that("query errors carry their protocol code class", {
  jdv_disconnect()
  withr::defer(jdv_disconnect())
  env <- new.env()
  expect_error(
    jdv_register(mtcars, binding = list(name = 1, env = env)),
    class = "jdv_error_invalid_argument"
  )
  env$x <- data.frame(a = 1)
  err <- expect_error(
    jdv_register(mtcars, binding = list(name = "x", env = env)),
    class = "jdv_error_invalid_request"
  )
  expect_s3_class(err, "jdv_query_error")
  expect_error(
    jdv_register(mtcars, binding = list(name = "absent", env = env)),
    class = "jdv_error_unavailable"
  )
})

test_that("only protocol codes reach a viewer as error codes", {
  jdv_disconnect()
  withr::defer(jdv_disconnect())
  testthat::local_mocked_bindings(
    .jdv_process_request = function(parsed, request_id) {
      jdv_abort("invalid_argument", "An R API only error.")
    }
  )
  response <- jsonlite::fromJSON(jdv_rpc(
    '{"id":1,"method":"view/schema","params":{}}'
  ))
  expect_identical(response$error$code, "r_error")
  testthat::local_mocked_bindings(
    .jdv_process_request = function(parsed, request_id) {
      jdv_abort("in_use", "Busy.")
    }
  )
  response <- jsonlite::fromJSON(jdv_rpc(
    '{"id":2,"method":"view/schema","params":{}}'
  ))
  expect_identical(response$error$code, "in_use")
})

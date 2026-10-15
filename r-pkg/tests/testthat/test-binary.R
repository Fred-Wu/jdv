binary_test_request <- function(max_bytes = 100, generation = 1) {
  .jdv_json_encode(list(
    id = "binary-request",
    method = "table/rows",
    params = list(
      view = "binary-view",
      generation = generation,
      max_bytes = max_bytes
    )
  ))
}

test_that("binary handler values remain private to the transport", {
  payload <- as.raw(c(0, 10, 255, 1))
  local_mocked_bindings(
    .jdv_process_request = function(request, request_id) {
      warning("binary warning")
      .jdv_binary_result(
        list(
          view = request$params$view,
          generation = request$params$generation
        ),
        payload
      )
    },
    .package = "jdv"
  )
  public <- .jdv_json_parse(jdv_rpc(binary_test_request()))
  expect_identical(public$error$code, "unsupported")
  expect_type(jdv_rpc(binary_test_request()), "character")
  packet <- .jdv_rpc_internal(binary_test_request(), allow_binary = TRUE)
  expect_s3_class(packet, "jdv_binary_packet")
  expect_identical(names(packet), c("header", "payload"))
  expect_identical(packet$payload, payload)
  header <- .jdv_json_parse(packet$header)
  expect_identical(header$id, "binary-request")
  expect_identical(header$result$view, "binary-view")
  expect_identical(header$result$generation, 1)
  expect_identical(header$result$transfer$encoding, "arrow-ipc")
  expect_identical(header$result$transfer$byte_length, 4)
  expect_identical(unlist(header$warnings), "binary warning")
  expect_identical(.jdv_state$rpc_depth, 0L)
})

test_that("binary budgets and identities fail before producing a packet", {
  value <- .jdv_binary_result(
    list(view = "binary-view", generation = 1),
    as.raw(1:4)
  )
  local_mocked_bindings(
    .jdv_process_request = function(...) value,
    .package = "jdv"
  )
  error_code <- function(request = binary_test_request()) {
    response <- .jdv_rpc_internal(request, allow_binary = TRUE)
    expect_type(response, "character")
    .jdv_json_parse(response)$error$code
  }
  expect_identical(error_code(binary_test_request(3)), "limit_exceeded")
  for (invalid in list(-1, 1.5, "4", TRUE, NA_real_, NULL, 2^53)) {
    expect_identical(
      error_code(binary_test_request(invalid)),
      "invalid_request"
    )
  }
  value$metadata$view <- "wrong"
  expect_identical(error_code(), "invalid_request")
  value$metadata$view <- "binary-view"
  value$metadata$generation <- 2
  expect_identical(error_code(), "invalid_request")
  value$metadata$generation <- 1
  value$metadata$transfer$byte_length <- 3
  expect_identical(error_code(), "invalid_request")
  value <- .jdv_binary_result(list(view = "binary-view", generation = 1), raw())
  packet <- .jdv_rpc_internal(binary_test_request(0), allow_binary = TRUE)
  expect_s3_class(packet, "jdv_binary_packet")
  expect_identical(packet$payload, raw())
  absent <- .jdv_json_parse(binary_test_request())
  absent$params$max_bytes <- NULL
  expect_s3_class(
    .jdv_rpc_internal(.jdv_json_encode(absent), allow_binary = TRUE),
    "jdv_binary_packet"
  )
  absent$params$view <- ""
  value$metadata$view <- ""
  expect_identical(error_code(.jdv_json_encode(absent)), "invalid_request")
  value$metadata$view <- "binary-view"
  expect_identical(
    error_code(binary_test_request(generation = 2^53)),
    "invalid_request"
  )
  value$metadata$padding <- strrep("x", 65536)
  expect_identical(error_code(), "limit_exceeded")
  value <- list(
    view = "binary-view",
    generation = 1,
    transfer = list(encoding = "arrow-ipc", byte_length = 0)
  )
  expect_identical(error_code(), "invalid_request")
  expect_error(
    .jdv_binary_result(list(transfer = list()), raw()),
    class = "jdv_query_error"
  )
  expect_error(
    .jdv_binary_result(list(view = "x"), "bytes"),
    class = "jdv_query_error"
  )
})

test_that("native binary callbacks validate before sending and recover for the next request", {
  skip_on_cran()
  skip_if_not_installed("jsonlite")
  skip_if_not_installed("callr")
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local binary peer")
  fixture_dir <- tempfile("jdv-binary-fixture-")
  dir.create(fixture_dir)
  on.exit(unlink(fixture_dir, recursive = TRUE), add = TRUE)
  fixture_dir <- normalizePath(fixture_dir, winslash = "/", mustWork = TRUE)
  fixture_source <- file.path(fixture_dir, "binaryfixture.c")
  file.copy(test_path("fixtures", "binaryfixture.c"), fixture_source)
  fixture_path <- file.path(
    fixture_dir,
    paste0("binaryfixture", .Platform$dynlib.ext)
  )
  compiled <- system2(
    file.path(R.home("bin"), "R"),
    c("CMD", "SHLIB", "-o", shQuote(fixture_path), shQuote(fixture_source)),
    stdout = TRUE,
    stderr = TRUE
  )
  if (!is.null(attr(compiled, "status"))) {
    stop(paste(compiled, collapse = "\n"))
  }
  fixture <- dyn.load(fixture_path)
  failing_raw <- getDLLRegisteredRoutines(fixture)[[".Call"]][[
    "new_failing_raw"
  ]]
  new_header <- getDLLRegisteredRoutines(fixture)[[".Call"]][["new_header"]]
  on.exit(
    {
      invisible(gc())
      dyn.unload(fixture_path)
    },
    add = TRUE,
    after = FALSE
  )
  ready <- tempfile("jdv-binary-ready-")
  result <- tempfile("jdv-binary-result-")
  host <- callr::r_bg(
    function(python, script, ready, result) {
      output <- system2(
        python,
        c(shQuote(script), shQuote(ready), shQuote(result)),
        stdout = TRUE,
        stderr = TRUE
      )
      if (!is.null(attr(output, "status"))) stop(paste(output, collapse = "\n"))
    },
    args = list(python, test_path("fixtures", "binary-host.py"), ready, result),
    supervise = TRUE
  )
  on.exit(
    {
      try(.Call(C_jdv_transport_close), silent = TRUE)
      try(.Call(C_jdv_transport_cleanup), silent = TRUE)
      if (host$is_alive()) {
        host$kill()
      }
      unlink(c(ready, result))
    },
    add = TRUE
  )
  deadline <- Sys.time() + 10
  while (!file.exists(ready) && Sys.time() < deadline) {
    Sys.sleep(0.01)
  }
  expect_true(file.exists(ready))
  address <- readLines(ready, warn = FALSE)
  lifetimes <- new.env(parent = emptyenv())
  lifetimes$created <- 0L
  lifetimes$collected <- 0L
  finalized <- function(e) lifetimes$collected <- lifetimes$collected + 1L
  callback <- function(message) {
    request <- .jdv_json_parse(message)
    case <- request$params$case
    metadata <- list(
      view = request$params$view,
      generation = request$params$generation
    )
    bytes <- as.raw(c(0, 10, 255, 1))
    if (case == "raw_error") {
      bytes <- .Call(failing_raw)
    }
    if (case == "empty") {
      bytes <- raw()
    }
    if (case == "whole_limit") {
      bytes <- raw(10 * 1024^2)
    }
    response <- .jdv_response(
      request$id,
      result = c(
        metadata,
        list(
          transfer = list(encoding = "arrow-ipc", byte_length = length(bytes))
        )
      )
    )
    if (case == "wrong_id") {
      response$id <- "wrong"
    }
    if (case == "wrong_view") {
      response$result$view <- "wrong"
    }
    if (case == "wrong_generation") {
      response$result$generation <- 2
    }
    if (case == "wrong_length") {
      response$result$transfer$byte_length <- 3
    }
    if (case == "wrong_encoding") {
      response$result$transfer$encoding <- "other"
    }
    if (case == "header_limit") {
      response$result$padding <- strrep("x", 65536)
    }
    if (case == "method_header") {
      response$method <- "invalid"
    }
    header <- .jdv_json_encode(response)
    if (case == "scalar_header_error") {
      return(.Call(new_header, header, 0L))
    }
    if (case == "scalar_transfer") {
      return(header)
    }
    if (case == "scalar_newline") {
      return(paste0('{"id":', request$id, ',\n"result":{}}'))
    }
    if (case == "scalar_cr") {
      return(paste0('{"id":', request$id, ',\r"result":{}}'))
    }
    if (case == "null") {
      return(NULL)
    }
    if (case == "integer") {
      return(1L)
    }
    packet <- structure(
      list(header = header, payload = bytes),
      class = "jdv_binary_packet"
    )
    if (case == "header_error") {
      packet$header <- .Call(new_header, header, 0L)
    }
    if (case == "header_once") {
      packet$header <- .Call(new_header, header, 2L)
    }
    if (case == "wrong_marker") {
      class(packet) <- "wrong"
    }
    if (case == "wrong_fields") {
      names(packet) <- c("header", "bytes")
    }
    if (case == "wrong_payload") {
      packet$payload <- "wrong"
    }
    if (case == "invalid_header") {
      packet$header <- "{"
    }
    if (case == "newline_header") {
      packet$header <- paste0(header, "\n")
    }
    lifetime <- new.env(parent = emptyenv())
    reg.finalizer(lifetime, finalized)
    attr(packet, "lifetime") <- lifetime
    lifetimes$created <- lifetimes$created + 1L
    packet
  }
  .Call(
    C_jdv_transport_connect,
    address,
    callback,
    function() NULL,
    .jdv_transport_limits()
  )
  deadline <- Sys.time() + 30
  while (!file.exists(result) && Sys.time() < deadline) {
    .Call(C_jdv_transport_poll)
    Sys.sleep(0.01)
  }
  expect_true(file.exists(result))
  if (file.exists(result)) {
    received <- jsonlite::fromJSON(result, simplifyVector = FALSE)
    expect_true(received$ok)
    expect_identical(received$cases, 28L)
    expect_identical(received$valid_packets, 32L)
    expect_identical(received$errors, 24L)
    expect_true(received$ordered)
  }
  host$wait(5000)
  expect_false(host$is_alive())
  expect_no_error(host$get_result())
  invisible(gc())
  expect_gt(lifetimes$created, 0L)
  expect_identical(lifetimes$collected, lifetimes$created)
})

test_that("bounded binary backpressure and peer disconnect terminate without JSON in the body", {
  skip_on_cran()
  skip_if_not_installed("jsonlite")
  skip_if_not_installed("callr")
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local binary peer")
  for (mode in c("timeout", "disconnect")) {
    ready <- tempfile("jdv-binary-send-ready-")
    result <- tempfile("jdv-binary-send-result-")
    host <- callr::r_bg(
      function(python, script, ready, result, mode) {
        output <- system2(
          python,
          c(shQuote(script), shQuote(ready), shQuote(result), mode),
          stdout = TRUE,
          stderr = TRUE
        )
        if (!is.null(attr(output, "status"))) {
          stop(paste(output, collapse = "\n"))
        }
      },
      args = list(
        python,
        test_path("fixtures", "binary-send-failure.py"),
        ready,
        result,
        mode
      ),
      supervise = TRUE
    )
    on.exit(
      {
        try(.Call(C_jdv_transport_close), silent = TRUE)
        try(.Call(C_jdv_transport_cleanup), silent = TRUE)
        if (host$is_alive()) {
          host$kill()
        }
        unlink(c(ready, result, paste0(result, ".sender-closed")))
      },
      add = TRUE
    )
    deadline <- Sys.time() + 10
    while (!file.exists(ready) && Sys.time() < deadline) {
      Sys.sleep(0.01)
    }
    expect_true(file.exists(ready))
    payload <- raw(9 * 1024^2)
    payload[] <- as.raw(120)
    callback <- function(message) {
      request <- .jdv_json_parse(message)
      value <- .jdv_binary_result(
        list(
          view = request$params$view,
          generation = request$params$generation
        ),
        payload
      )
      .jdv_binary_packet(value, request, request$id, character())
    }
    disconnected <- 0L
    limits <- .jdv_transport_limits()
    limits$send_timeout_ms <- 100L
    .Call(
      C_jdv_transport_connect,
      readLines(ready, warn = FALSE),
      callback,
      function() disconnected <<- disconnected + 1L,
      limits
    )
    deadline <- Sys.time() + 15
    while (!file.exists(result) && Sys.time() < deadline) {
      .Call(C_jdv_transport_poll)
      if (mode == "timeout" && !.Call(C_jdv_transport_status)$connected) {
        writeLines("closed", paste0(result, ".sender-closed"))
      }
      Sys.sleep(0.01)
    }
    expect_true(file.exists(result))
    .Call(C_jdv_transport_poll)
    .Call(C_jdv_transport_cleanup)
    expect_false(.Call(C_jdv_transport_status)$connected)
    expect_identical(disconnected, 1L)
    if (file.exists(result)) {
      received <- jsonlite::fromJSON(result)
      expect_true(received$only_body)
      expect_gt(received$received, 0)
      if (mode == "timeout") {
        expect_true(received$sender_closed)
        expect_lt(received$complete_frames, received$requested_frames)
      } else {
        expect_true(received$partial)
        expect_identical(received$received, 1024L)
      }
    }
    host$wait(5000)
    expect_no_error(host$get_result())
    unlink(c(ready, result, paste0(result, ".sender-closed")))
  }
})

test_that(
  "the real R callback flushes lifecycle events before binary and later JSONL",
  {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    python <- Sys.which("python3")
    skip_if(!nzchar(python), "python3 is required for the local binary peer")
    ready <- tempfile("jdv-binary-rpc-ready-")
    result <- tempfile("jdv-binary-rpc-result-")
    host <- callr::r_bg(
      function(python, script, ready, result) {
        output <- system2(
          python,
          c(shQuote(script), shQuote(ready), shQuote(result)),
          stdout = TRUE,
          stderr = TRUE
        )
        if (!is.null(attr(output, "status"))) {
          stop(paste(output, collapse = "\n"))
        }
      },
      args = list(
        python,
        test_path("fixtures", "binary-rpc-host.py"),
        ready,
        result
      ),
      supervise = TRUE
    )
    original_outbox <- .jdv_state$outbox
    original_options <- options(jdv.address = NULL)
    on.exit(
      {
        .jdv_close_internal(notify = FALSE)
        try(.Call(C_jdv_transport_close), silent = TRUE)
        try(.Call(C_jdv_transport_cleanup), silent = TRUE)
        .jdv_state$outbox <- original_outbox
        options(original_options)
        if (host$is_alive()) {
          host$kill()
        }
        unlink(c(ready, result))
      },
      add = TRUE
    )
    deadline <- Sys.time() + 10
    while (!file.exists(ready) && Sys.time() < deadline) {
      Sys.sleep(0.01)
    }
    expect_true(file.exists(ready))
    options(jdv.address = readLines(ready, warn = FALSE))
    spare <- jdv_register(data.frame(x = 0), mode = "paged")
    original <- .jdv_process_request
    removed <- FALSE
    local_mocked_bindings(
      .jdv_process_request = function(request, request_id) {
        if (identical(request$method, "table/rows")) {
          if (!removed) {
            removed <<- TRUE
            .jdv_close_internal(spare$id, notify = TRUE)
          }
          warning("binary integration warning")
          return(.jdv_binary_result(
            list(
              view = request$params$view,
              generation = request$params$generation
            ),
            as.raw(c(0, 10, 255, 1))
          ))
        }
        original(request, request_id)
      },
      .package = "jdv"
    )
    jdv_view(data.frame(x = 1:3), mode = "paged")
    deadline <- Sys.time() + 15
    while (!file.exists(result) && Sys.time() < deadline) {
      jdv_rpc(NULL)
      Sys.sleep(0.01)
    }
    expect_true(file.exists(result))
    if (file.exists(result)) {
      received <- jsonlite::fromJSON(result)
      expect_true(received$ok)
      expect_true(received$ordered)
      expect_identical(received$closed, spare$id)
    }
    host$wait(5000)
    expect_no_error(host$get_result())
    expect_length(.jdv_state$outbox, 0L)
  }
)

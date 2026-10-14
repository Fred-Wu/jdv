.jdv_cache_dir <- function() {
  if (identical(.Platform$OS.type, "windows")) {
    root <- Sys.getenv("LOCALAPPDATA", unset = "")
    if (!nzchar(root)) {
      root <- file.path(path.expand("~"), "AppData", "Local")
    }
    return(file.path(root, "jdv"))
  }
  if (identical(Sys.info()[["sysname"]], "Darwin")) {
    return(file.path(path.expand("~"), "Library", "Caches", "jdv"))
  }
  root <- Sys.getenv("XDG_CACHE_HOME", unset = "")
  if (nzchar(root)) {
    return(file.path(root, "jdv"))
  }
  file.path(path.expand("~"), ".cache", "jdv")
}

.jdv_discovery_path <- function() {
  path <- getOption("jdv.discovery_path")
  if (is.null(path)) {
    path <- file.path(.jdv_cache_dir(), "discovery.json")
  }
  if (
    !is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path)
  ) {
    stop(
      "Option 'jdv.discovery_path' must be one non-empty path.",
      call. = FALSE
    )
  }
  path
}

.jdv_resolve_address <- function() {
  address <- getOption("jdv.address")
  if (!is.null(address)) {
    if (
      !is.character(address) ||
        length(address) != 1L ||
        is.na(address) ||
        !nzchar(address)
    ) {
      stop("Option 'jdv.address' must be one non-empty address.", call. = FALSE)
    }
    return(address)
  }
  address <- Sys.getenv("JDV_ADDRESS", unset = "")
  if (nzchar(address)) {
    return(address)
  }

  path <- .jdv_discovery_path()
  info <- file.info(path)
  if (is.na(info$size) || isTRUE(info$isdir) || info$size > 65536) {
    stop(
      "The viewer discovery file is missing or exceeds 64 KiB.",
      call. = FALSE
    )
  }
  bytes <- readBin(path, what = "raw", n = 65536L)
  discovery <- .jdv_json_parse(rawToChar(bytes))
  address <- discovery$socketPath
  if (
    !is.character(address) ||
      length(address) != 1L ||
      is.na(address) ||
      !nzchar(address)
  ) {
    stop("The viewer discovery file has no valid socketPath.", call. = FALSE)
  }
  address
}

.jdv_transport_limits <- function() {
  list(
    queue_messages = as.integer(.jdv_option_limit(
      "jdv.transport.queue_messages",
      256,
      1
    )),
    queue_bytes = as.integer(.jdv_option_limit(
      "jdv.transport.queue_bytes",
      16 * 1024^2,
      1024
    )),
    max_request_bytes = as.integer(.jdv_max_request_bytes()),
    max_message_bytes = as.integer(.jdv_max_message_bytes()),
    max_receive_bytes = as.integer(min(
      .Machine$integer.max,
      max(64 * 1024, .jdv_max_request_bytes() + 1)
    )),
    max_drain_requests = as.integer(.jdv_option_limit(
      "jdv.transport.max_drain_requests",
      8,
      1
    )),
    send_timeout_ms = as.integer(.jdv_option_limit(
      "jdv.transport.send_timeout_ms",
      1000,
      1
    ))
  )
}

.jdv_transport_status <- function() {
  if (isTRUE(.jdv_state$unloading) || is.null(.jdv_state$transport)) {
    return(NULL)
  }
  status <- .Call(C_jdv_transport_status)
  .jdv_assert_active()
  status
}

.jdv_transport_remove_task_callback <- function(
  name = .jdv_state$transport_task_callback
) {
  if (is.null(name)) {
    return(invisible(NULL))
  }
  try(removeTaskCallback(name), silent = TRUE)
  if (identical(.jdv_state$transport_task_callback, name)) {
    .jdv_state$transport_task_callback <- NULL
  }
  invisible(NULL)
}

.jdv_transport_task_callback <- function(expr, value, ok, visible) {
  if (isTRUE(.jdv_state$unloading)) {
    return(FALSE)
  }
  if (is.null(.jdv_state$transport)) {
    .jdv_transport_remove_task_callback()
    return(FALSE)
  }
  try(.Call(C_jdv_transport_cleanup), silent = TRUE)
  if (is.null(.jdv_state$transport)) {
    .jdv_transport_remove_task_callback()
    return(FALSE)
  }
  TRUE
}

.jdv_transport_install_task_callback <- function(epoch) {
  .jdv_assert_active()
  if (!is.null(.jdv_state$transport_task_callback)) {
    return(invisible(NULL))
  }
  name <- paste0("jdv_transport_", Sys.getpid(), "_", epoch)
  addTaskCallback(.jdv_transport_task_callback, name = name)
  if (isTRUE(.jdv_state$unloading)) {
    try(removeTaskCallback(name), silent = TRUE)
    .jdv_assert_active()
  }
  .jdv_state$transport_task_callback <- name
  invisible(NULL)
}

.jdv_transport_disconnect <- function(epoch) {
  if (!identical(.jdv_state$transport_epoch, epoch)) {
    return(invisible(NULL))
  }
  .jdv_close_internal(notify = FALSE)
  .jdv_state$outbox <- list()
  .jdv_state$transport <- NULL
  .jdv_state$transport_limits <- NULL
  .jdv_state$transport_hello <- FALSE
  .jdv_transport_remove_task_callback()
  invisible(NULL)
}

.jdv_transport_request <- function(message, epoch) {
  if (isTRUE(.jdv_state$unloading)) {
    return(NULL)
  }
  request <- tryCatch(.jdv_json_parse(message), error = function(e) e)
  if (inherits(request, "error") || !is.list(request)) {
    return(jdv_rpc(message))
  }
  request_id <- tryCatch(.jdv_request_id(request$id), error = function(e) NULL)
  if (is.null(request_id)) {
    return(jdv_rpc(message))
  }

  transport_error <- function(code, message) {
    error <- structure(
      list(message = message, call = NULL, code = code),
      class = c("jdv_rpc_error", "error", "condition")
    )
    .jdv_json_encode_error(.jdv_response(request_id, error = error))
  }
  if (!identical(.jdv_state$transport_epoch, epoch)) {
    return(transport_error("stale_generation", "The connection is stale."))
  }

  deadline <- request$deadline
  if (
    is.numeric(deadline) &&
      length(deadline) == 1L &&
      !is.na(deadline) &&
      is.finite(deadline) &&
      deadline < as.numeric(Sys.time())
  ) {
    return(transport_error("expired", "The request expired before execution."))
  }

  method <- request$method
  if (
    is.character(method) &&
      length(method) == 1L &&
      method %in% c("table/rows", "view/schema", "view/close")
  ) {
    params <- request$params
    if (
      is.list(params) &&
        is.character(params$view) &&
        length(params$view) == 1L &&
        !is.na(params$view) &&
        is.numeric(params$generation) &&
        !is.object(params$generation) &&
        length(params$generation) == 1L &&
        !is.na(params$generation) &&
        is.finite(params$generation) &&
        params$generation >= 1 &&
        params$generation == floor(params$generation)
    ) {
      id <- params$view
      if (!exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
        return(transport_error("view_not_found", "The view is not open."))
      }
      entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
      if (entry$closed) {
        return(transport_error("view_not_found", "The view is closed."))
      }
      if (
        !identical(as.numeric(entry$generation), as.numeric(params$generation))
      ) {
        return(transport_error(
          "stale_generation",
          "The table generation is stale."
        ))
      }
    }
  }

  tryCatch(
    jdv_rpc(message),
    error = function(error) {
      if (isTRUE(.jdv_state$unloading)) {
        return(NULL)
      }
      request_id <- tryCatch(
        .jdv_request_id(request$id),
        error = function(e) NULL
      )
      if (is.null(request_id)) {
        return(NULL)
      }
      .jdv_json_encode_error(.jdv_response(request_id, error = error))
    }
  )
}

.jdv_transport_connect <- function(address = NULL) {
  .jdv_assert_active()
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$connected)) {
    return(invisible(NULL))
  }
  if (!is.null(status) && isTRUE(status$pending_cleanup)) {
    stop(
      "The previous viewer connection is still being cleaned up.",
      call. = FALSE
    )
  }
  if (!is.null(.jdv_state$transport)) {
    .jdv_transport_disconnect(.jdv_state$transport_epoch)
  }
  if (is.null(address)) {
    address <- .jdv_resolve_address()
  }

  .jdv_state$transport_epoch <- .jdv_state$transport_epoch + 1L
  epoch <- .jdv_state$transport_epoch
  request_callback <- local({
    callback_epoch <- epoch
    function(message) .jdv_transport_request(message, callback_epoch)
  })
  disconnect_callback <- local({
    callback_epoch <- epoch
    function() .jdv_transport_disconnect(callback_epoch)
  })
  .jdv_assert_active()
  .Call(
    C_jdv_transport_connect,
    address,
    request_callback,
    disconnect_callback,
    .jdv_transport_limits()
  )
  .jdv_assert_active()
  status <- .Call(C_jdv_transport_status)
  .jdv_assert_active()
  if (!isTRUE(status$connected)) {
    .jdv_transport_disconnect(epoch)
    stop("The viewer transport disconnected during setup.", call. = FALSE)
  }
  .jdv_state$transport_limits <- list(
    max_receive_frames = status$max_receive_frames,
    max_receive_bytes = status$max_receive_bytes,
    queue_messages = status$queue_messages_limit,
    queue_bytes = status$queue_bytes_limit,
    max_request_bytes = status$max_request_bytes
  )
  .jdv_state$transport <- TRUE
  .jdv_state$transport_hello <- FALSE
  .jdv_transport_install_task_callback(epoch)
  invisible(NULL)
}

.jdv_transport_housekeeping <- function() {
  if (
    !isTRUE(.jdv_state$unloading) &&
      !is.null(.jdv_state$transport_task_callback)
  ) {
    .Call(C_jdv_transport_housekeeping)
  }
  invisible(NULL)
}

.jdv_hello <- function() {
  .jdv_state$session_counter <- .jdv_state$session_counter + 1L
  list(
    method = "hello",
    params = list(
      protocol = 1L,
      session = paste0("r-", Sys.getpid(), "-", .jdv_state$session_counter),
      pid = as.integer(Sys.getpid()),
      r_version = as.character(getRversion()),
      jdv_version = as.character(utils::packageVersion("jdv")),
      limits = .jdv_state$transport_limits
    )
  )
}

.jdv_transport_send <- function(messages) {
  .jdv_assert_active()
  if (!length(messages)) {
    return(invisible(NULL))
  }
  if (is.null(.jdv_state$transport)) {
    stop("The viewer transport is not connected.", call. = FALSE)
  }
  messages <- enc2utf8(as.character(messages))
  .jdv_assert_active()
  .Call(C_jdv_transport_send, messages)
  .jdv_assert_active()
  invisible(NULL)
}

#' Open a table in the local jdv viewer
#'
#' @param x A data frame or matrix.
#' @param title Display title. When omitted, the expression passed as `x` is
#'   used; explicitly passing `NULL` creates an independent table slot.
#' @param mode One of `"auto"`, `"snapshot"`, or `"paged"`.
#' @param collation String ordering policy, `"C"` or `"locale"`.
#' @return The view id, invisibly.
#' @details
#' The viewer connection is opened on the first call. An address can be set in
#' `options(jdv.address = ...)` or `JDV_ADDRESS`; otherwise jdv reads
#' `discovery.json` from the user cache directory. The discovery file is limited
#' to 64 KiB and contains a `socketPath` string. Local Unix-domain sockets and
#' Windows named pipes are used by default; TCP is available only when an
#' explicit address selects it. The connection is closed after the last table is
#' closed.
#'
#' The event gate dispatches only when `sys.nframe() == 0`. This practical
#' function-frame check is not a guarantee that R is idle: on Windows, a timer
#' can run during top-level computation while the function-frame count is zero.
#' A request that reaches an interrupt while running fails with `interrupted`
#' and is never retried automatically. While a sort or filter runs, the event
#' gate restores the interrupt-suspension state it found before calling R
#' methods. If interrupts were already suspended on entry, R may defer Ctrl-C
#' during a long sort or filter until a later check; use the viewer's busy state
#' as an indication that the request is still running. A bare top-level
#' `browser()` can service requests; a frontend waiting inside a function frame,
#' such as a function that calls `browser()`, must let that frame unwind or
#' explicitly call `jdv_rpc(NULL)` before queued work can progress. Windows GUI
#' and Esc behavior have not been validated. Windows named pipes must use
#' byte-type mode; message-type pipes are unsupported, and Windows transport
#' behavior has not yet been exercised on a Windows host. Named-pipe ACLs are
#' not hardened, and an explicitly selected TCP endpoint has no authentication.
#' Registry entries created with [jdv_register()] share this process-wide
#' registry and are also released if the viewer disconnects. Package unload
#' stops the event source and pending work before releasing table references.
#' @export
jdv_view <- function(
  x,
  title = NULL,
  mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale")
) {
  .jdv_assert_active()
  if (missing(title)) {
    title <- deparse1(substitute(x))
  }
  source <- jdv_source(x)
  x <- source$data
  mode <- match.arg(mode)
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$pending_cleanup)) {
    stop(
      "The previous viewer connection is still being cleaned up.",
      call. = FALSE
    )
  }
  if (!is.null(status) && isTRUE(status$busy)) {
    stop("Cannot open a table while a viewer request is active.", call. = FALSE)
  }
  if (!is.null(status) && !isTRUE(status$connected)) {
    .jdv_transport_disconnect(.jdv_state$transport_epoch)
  }
  was_connected <- !is.null(status) && isTRUE(status$connected)
  had_entries <- length(ls(.jdv_state$entries, all.names = TRUE)) > 0L
  .jdv_transport_connect()
  .jdv_assert_active()
  registered <- tryCatch(
    if (missing(collation)) {
      jdv_register(x, title = title, mode = mode)
    } else {
      jdv_register(x, title = title, mode = mode, collation = collation)
    },
    error = function(error) {
      if (!isTRUE(.jdv_state$unloading) && !was_connected && !had_entries) {
        try(.Call(C_jdv_transport_close), silent = TRUE)
        .jdv_transport_housekeeping()
      }
      stop(error)
    }
  )
  .jdv_assert_active()
  messages <- c(
    if (!isTRUE(.jdv_state$transport_hello)) .jdv_json_encode(.jdv_hello()),
    registered$notifications,
    registered$open
  )
  registered_entry <- get(
    registered$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  )
  .jdv_assert_active()
  tryCatch(
    .jdv_transport_send(messages),
    error = function(error) {
      .jdv_close_internal(
        registered$id,
        notify = FALSE,
        expected = registered_entry
      )
      if (!isTRUE(.jdv_state$unloading)) {
        try(.Call(C_jdv_transport_close), silent = TRUE)
        .jdv_transport_housekeeping()
      }
      stop(error)
    }
  )
  .jdv_state$transport_hello <- TRUE
  invisible(registered$id)
}

#' Close one or all tables in the local jdv viewer
#'
#' @param id Optional view id returned by `jdv_view()`. When omitted, all active
#'   tables are closed.
#' @return The ids that were closed, invisibly.
#' @details
#' Closing the last table stops the transport event source and closes the local
#' connection. A close requested from inside a viewer callback is safe; native
#' source cleanup is deferred until the callback returns.
#' @export
jdv_close <- function(id = NULL) {
  .jdv_assert_active()
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  if (
    !is.null(id) &&
      (!is.character(id) || length(id) != 1L || is.na(id) || !nzchar(id))
  ) {
    stop("'id' must be NULL or one non-empty view id.", call. = FALSE)
  }
  ids <- if (is.null(id)) {
    ls(.jdv_state$entries, all.names = TRUE)
  } else if (exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
    id
  } else {
    character()
  }
  if (!length(ids)) {
    if (is.null(id)) {
      .jdv_assert_active()
      .Call(C_jdv_transport_close)
      .jdv_assert_active()
      .jdv_transport_housekeeping()
    }
    return(invisible(character()))
  }

  for (table_id in ids) {
    .jdv_close_internal(table_id, notify = TRUE)
  }
  notifications <- if (length(.jdv_state$outbox)) {
    unname(unlist(.jdv_state$outbox, use.names = FALSE))
  } else {
    character()
  }
  .jdv_state$outbox <- list()
  .jdv_assert_active()
  status <- .jdv_transport_status()
  send_error <- NULL
  if (!is.null(status) && isTRUE(status$connected)) {
    send_error <- tryCatch(
      {
        .jdv_transport_send(notifications)
        .jdv_assert_active()
        NULL
      },
      error = identity
    )
    if (
      !is.null(send_error) || !length(ls(.jdv_state$entries, all.names = TRUE))
    ) {
      .jdv_assert_active()
      .Call(C_jdv_transport_close)
    }
  } else if (!length(ls(.jdv_state$entries, all.names = TRUE))) {
    .jdv_state$transport <- NULL
  }
  if (inherits(send_error, "error")) {
    stop(send_error)
  }
  invisible(ids)
}

# Fixtures deliberately exercise user methods with and without side effects.
spike <- new.env(parent = globalenv())
spike_marker <- function(value) {
  cat("SPIKE|", value, "\n", sep = "")
  flush.console()
}

spike_native <- function(name, ...) .Call(spike$symbols[[name]], ...)

spike_stop <- function() spike_native("spike_stop")
spike_poll <- function() spike_native("spike_poll")
spike_status <- function() spike_native("spike_status")
spike_arm <- function(delay = 100L, code = "a") {
  spike_native("spike_arm", as.integer(delay), code)
}

format.spike_column <- function(x, ...) {
  spike$format_calls <- spike$format_calls + 1L
  action <- spike$action
  if (action == "r") {
    if (.Platform$OS.type == "windows") {
      spike_arm(100L, "a")
    }
    spike_marker("METHOD_WAIT")
    Sys.sleep(0.5)
  }
  if (action == "e") {
    stop("spike method error")
  }
  if (action == "w") {
    warning("spike method warning")
  }
  if (action == "i") {
    spike_marker("INTERRUPT_WAIT")
    Sys.sleep(5)
  }
  if (action == "s") {
    runif(1)
    options(width = getOption("width") + 1L)
    assign("spike_user_side_effect", TRUE, envir = globalenv())
  }
  if (action %in% c("c", "k", "h")) {
    spike_stop()
    if (action == "h") {
      spike$close_source_active <- spike_status()[["source_active"]]
      spike_marker(paste0("CLOSE_WAIT|", spike$close_source_active))
      Sys.sleep(0.25)
    }
    if (action == "k") stop("error after self-close")
  }
  if (action == "t") {
    spike_native(
      "spike_start",
      spike$fd,
      spike$callback,
      match(spike$mode, c("direct", "poll", "task", "gated")) - 1L
    )
  }
  if (action == "p") {
    spike_poll()
  }
  as.character(unclass(x))
}

xtfrm.spike_column <- function(x) {
  spike$xtfrm_calls <- spike$xtfrm_calls + 1L
  as.numeric(unclass(x))
}

spike_callback <- function(code) {
  spike$action <- code
  spike_marker(paste0("METHOD_BEGIN|", code))
  column <- structure(c(3, 1, 2), class = "spike_column")
  evaluate <- function() {
    spike$display <- format(column)
    spike$keys <- xtfrm(column)
  }
  warnings <- character()
  if (isTRUE(spike$collect_warnings)) {
    withCallingHandlers(
      evaluate(),
      warning = function(w) {
        warnings <<- c(warnings, conditionMessage(w))
        invokeRestart("muffleWarning")
      }
    )
  } else {
    evaluate()
  }
  spike$responses[[length(spike$responses) + 1L]] <- list(
    code = code,
    warnings = unname(as.list(warnings))
  )
  spike_marker(paste0("METHOD_DONE|", code))
  invisible(NULL)
}

spike_setup <- function(dll_path, fd = -1L, mode = "direct") {
  stopifnot(mode %in% c("direct", "poll", "task", "gated"))
  stopifnot(requireNamespace("jsonlite", quietly = TRUE))
  spike$dll <- dyn.load(dll_path)
  spike$symbols <- lapply(
    c(
      "spike_start",
      "spike_stop",
      "spike_poll",
      "spike_arm",
      "spike_status",
      "spike_gate_fault"
    ),
    function(name) getNativeSymbolInfo(name, spike$dll)$address
  )
  names(spike$symbols) <- c(
    "spike_start",
    "spike_stop",
    "spike_poll",
    "spike_arm",
    "spike_status",
    "spike_gate_fault"
  )
  spike$mode <- mode
  spike$fd <- as.integer(fd)
  spike$format_calls <- 0L
  spike$xtfrm_calls <- 0L
  spike$outer_warnings <- 0L
  spike$task_errors <- 0L
  spike$collect_warnings <- FALSE
  spike$responses <- list()
  spike$callback <- spike_callback
  spike_native(
    "spike_start",
    spike$fd,
    spike$callback,
    match(mode, c("direct", "poll", "task", "gated")) - 1L
  )
  if (mode == "task") {
    addTaskCallback(
      function(expr, value, ok, visible) {
        tryCatch(
          spike_poll(),
          error = function(e) {
            spike$task_errors <- spike$task_errors + 1L
            spike_marker("TASK_ERROR")
          }
        )
        TRUE
      },
      name = "jdv-event-spike"
    )
  }
  set.seed(1729)
  invisible(NULL)
}

spike_warning_state <- function() {
  if (exists("last.warning", envir = baseenv(), inherits = FALSE)) {
    get("last.warning", envir = baseenv(), inherits = FALSE)
  } else {
    NULL
  }
}

spike_capture <- function() {
  spike$before <- list(
    rng = get(".Random.seed", envir = globalenv()),
    options = options(),
    warnings = spike_warning_state()
  )
  invisible(NULL)
}

spike_report <- function(path) {
  state <- spike_status()
  result <- list(
    mode = spike$mode,
    r_version = R.version.string,
    platform = R.version$platform,
    native = as.list(state),
    format_calls = spike$format_calls,
    xtfrm_calls = spike$xtfrm_calls,
    outer_warnings = spike$outer_warnings,
    task_errors = spike$task_errors,
    rng_unchanged = identical(
      spike$before$rng,
      get(".Random.seed", globalenv())
    ),
    options_unchanged = identical(spike$before$options, options()),
    warnings_unchanged = identical(
      spike$before$warnings,
      spike_warning_state()
    ),
    warning_names = names(spike_warning_state()),
    user_global_changed = exists(
      "spike_user_side_effect",
      globalenv(),
      inherits = FALSE
    ),
    close_source_active = spike$close_source_active,
    callbacks_after_interrupt = spike$callbacks_after_interrupt,
    responses = spike$responses,
    callbacks = getTaskCallbackNames()
  )
  writeLines(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null"), path)
  spike_marker("REPORT_DONE")
  invisible(result)
}

spike_teardown <- function() {
  if ("jdv-event-spike" %in% getTaskCallbackNames()) {
    removeTaskCallback("jdv-event-spike")
  }
  spike_stop()
  stopifnot(spike_status()[["busy"]] == 0L)
  dyn.unload(spike$dll[["path"]])
  spike$symbols <- NULL
  spike$dll <- NULL
  spike_marker("UNLOADED")
  invisible(NULL)
}

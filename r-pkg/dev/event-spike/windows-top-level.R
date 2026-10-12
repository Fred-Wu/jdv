# Run with Rscript --vanilla FILE DLL MODE SCENARIO OUTPUT.
# The measured for loop must stay at file top level, outside source()/local().
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 4L, .Platform$OS.type == "windows")
dll <- args[[1L]]
mode <- args[[2L]]
scenario <- args[[3L]]
output <- args[[4L]]
source(file.path("r-pkg", "dev", "event-spike", "fixtures.R"))
original_callback <- spike_callback
phase <- "setup"
callback_contexts <- list()
spike_callback <- function(code) {
  callback_contexts[[length(callback_contexts) + 1L]] <<- list(
    code = code,
    phase = phase,
    iteration = if (exists("j", envir = globalenv(), inherits = FALSE)) {
      j
    } else {
      NULL
    },
    gate_depth = spike_status()[["wrapped_nframe"]]
  )
  original_callback(code)
}
spike_setup(dll, mode = mode)
spike_capture()
snapshots <- list()
observations <- list(recovery = "none", entry_nframe = sys.nframe())
stopifnot(observations$entry_nframe == 0L)

if (scenario == "top_loop") {
  phase <- "before_for"
  spike_arm(100L, "a")
  spike_marker("LOOP_WAIT")
  phase <- "top_level_for"
  for (j in seq_len(50000000L)) {
    spike_loop_value <- j
  }
  phase <- "after_for"
  spike_marker("LOOP_DONE")
  snapshots$loop_boundary <- as.list(spike_status())
  phase <- "after_for_sleep"
  Sys.sleep(0.3)
} else if (scenario == "sleep") {
  phase <- "top_level_sleep"
  spike_arm(100L, "a")
  spike_marker("SLEEP_WAIT")
  Sys.sleep(0.6)
  spike_marker("SLEEP_DONE")
  snapshots$sleep_boundary <- as.list(spike_status())
} else if (scenario == "lifecycle") {
  phase <- "before_close"
  spike_arm(300L, "a")
  spike_stop()
  snapshots$after_stop <- as.list(spike_status())
} else {
  stop("Unknown scenario")
}

snapshots$before_recovery <- as.list(spike_status())
if (snapshots$before_recovery$pending > 0L) {
  # Rscript has no idle REPL here: observe timer nudge, then use explicit poll.
  phase <- "rscript_nudge_sleep"
  spike_arm(100L, "~")
  Sys.sleep(0.3)
  snapshots$after_timer_nudge <- as.list(spike_status())
  observations$recovery <- "timer_nudge_during_Rscript_sleep"
  if (snapshots$after_timer_nudge$pending > 0L) {
    phase <- "explicit_poll"
    spike_poll()
    observations$recovery <- "timer_nudge_then_explicit_poll"
  }
}
state <- spike_report(file.path(output, "state.json"))
assertions <- list(
  entry_has_no_function_frame = observations$entry_nframe == 0L,
  guard_clear = state$native$busy == 0L && state$native$closing == 0L,
  no_duplicate_requests = state$native$executed ==
    if (scenario == "lifecycle") 0L else 1L,
  every_execution_cleaned = state$native$cleanups == state$native$executed,
  no_pending_requests = state$native$pending == 0L,
  methods_once = state$format_calls == if (scenario == "lifecycle") 0L else 1L,
  no_bare_probe_in_replacement = mode != "gated_restore" ||
    state$native$bare_evaluations == 0L
)
if (scenario == "sleep" && mode != "direct") {
  assertions$sleep_defers <- snapshots$sleep_boundary$executed == 0L &&
    snapshots$sleep_boundary$pending == 1L &&
    snapshots$sleep_boundary$wrapped_nframe > 0L
}
observations$callback_contexts <- callback_contexts
observations$callback_during_top_level_for <- any(vapply(
  callback_contexts,
  function(x) {
    x$phase == "top_level_for" &&
      !is.null(x$iteration) &&
      x$iteration < 50000000L
  },
  logical(1L)
))
observations$gate_zero_during_top_level_for <- any(vapply(
  callback_contexts,
  function(x) {
    x$phase == "top_level_for" &&
      !is.null(x$iteration) &&
      x$iteration < 50000000L &&
      x$gate_depth == 0L
  },
  logical(1L)
))
spike_stop()
after_stop <- spike_status()
assertions$native_source_stopped <- after_stop[["source_active"]] == 0L &&
  after_stop[["configured"]] == 0L
spike_teardown()
phase <- "after_unload"
Sys.sleep(0.6)
assertions$no_callback_after_unload <- length(callback_contexts) ==
  state$native$executed
assertions$dll_unloaded <- !any(vapply(
  getLoadedDLLs(),
  function(x) identical(x[["path"]], normalizePath(dll, winslash = "/")),
  logical(1L)
))
writeLines(
  jsonlite::toJSON(
    list(
      frontend = "Rscript",
      mode = mode,
      scenario = scenario,
      status = "observed",
      state = state,
      snapshots = snapshots,
      observations = observations,
      assertions = assertions,
      passed = all(unlist(assertions))
    ),
    auto_unbox = TRUE,
    null = "null"
  ),
  file.path(output, "result.json")
)
stopifnot(all(unlist(assertions)))

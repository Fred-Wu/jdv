# R_PROFILE_USER startup fixture; never use --vanilla for this frontend.
source(file.path(
  Sys.getenv("SPIKE_ROOT"),
  "r-pkg",
  "dev",
  "event-spike",
  "fixtures.R"
))
sink(file.path(Sys.getenv("SPIKE_CASE"), "transcript.txt"))
original_callback <- spike_callback
spike_callback <- function(code) {
  original_callback(code)
  state <- spike_status()
  spike_stop()
  stopped <- spike_status()
  writeLines(
    jsonlite::toJSON(
      list(
        frontend = "Rgui",
        mode = spike$mode,
        scenario = "prompt",
        status = "observed",
        r_version = R.version.string,
        native = as.list(state),
        source_after_stop = as.list(stopped),
        assertions = list(
          method_completed_once = spike$format_calls == 1L &&
            spike$xtfrm_calls == 1L,
          source_stopped = stopped[["source_active"]] == 0L
        ),
        observations = list(
          lifecycle = "source_stop_then_process_exit; no in-callback DLL unload",
          gate_depth = state[["wrapped_nframe"]],
          esc_interrupt = "unverified"
        ),
        passed = spike$format_calls == 1L &&
          spike$xtfrm_calls == 1L &&
          stopped[["source_active"]] == 0L
      ),
      auto_unbox = TRUE
    ),
    file.path(Sys.getenv("SPIKE_CASE"), "result.json")
  )
  # Unloading an executing callback is unsupported. Process exit releases it.
  q("no", status = 0L, runLast = FALSE)
}
spike_setup(Sys.getenv("SPIKE_DLL"), mode = Sys.getenv("SPIKE_MODE"))
spike_capture()
spike_marker("STARTUP_ARMED")
spike_arm(1000L, "a")

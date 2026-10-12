# Build the standalone experiment into a temporary directory, never into src/.
spike_build <- function(
  source_dir = file.path("r-pkg", "dev", "event-spike"),
  output = tempfile("jdv-event-spike-build-")
) {
  source_dir <- normalizePath(source_dir, mustWork = TRUE)
  dir.create(output, recursive = TRUE)
  output <- normalizePath(output, mustWork = TRUE)
  source <- file.path(output, "event_spike.c")
  stopifnot(file.copy(file.path(source_dir, "event_spike.c"), source))
  old_libs <- Sys.getenv("PKG_LIBS", unset = NA_character_)
  if (.Platform$OS.type == "windows") {
    on.exit(
      {
        if (is.na(old_libs)) {
          Sys.unsetenv("PKG_LIBS")
        } else {
          Sys.setenv(PKG_LIBS = old_libs)
        }
      },
      add = TRUE
    )
    Sys.setenv(
      PKG_LIBS = paste(if (is.na(old_libs)) "" else old_libs, "-luser32")
    )
  }
  dll <- file.path(output, paste0("jdv_spike", .Platform$dynlib.ext))
  r <- file.path(
    R.home("bin"),
    if (.Platform$OS.type == "windows") "R.exe" else "R"
  )
  log <- file.path(output, "build.log")
  status <- system2(
    r,
    c("CMD", "SHLIB", "-o", shQuote(dll), shQuote(source)),
    stdout = log,
    stderr = log
  )
  if (status != 0L) {
    stop("Build failed; see ", log)
  }
  message("Standalone DLL: ", dll)
  dll
}

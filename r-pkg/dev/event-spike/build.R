# Build the standalone experiment into a temporary directory, never into src/.
spike_build <- function(
  source_dir = file.path("r-pkg", "dev", "event-spike"),
  output = tempfile("jdv-event-spike-build-")
) {
  source_dir <- normalizePath(source_dir, winslash = "/", mustWork = TRUE)
  if (!dir.exists(output)) {
    dir.create(output, recursive = TRUE)
  }
  output <- normalizePath(output, winslash = "/", mustWork = TRUE)
  source_name <- "event_spike.c"
  source <- file.path(output, source_name)
  stopifnot(file.copy(file.path(source_dir, "event_spike.c"), source))
  old_directory <- getwd()
  on.exit(setwd(old_directory), add = TRUE)
  setwd(output)
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
  dll_name <- paste0("jdv_spike", .Platform$dynlib.ext)
  r <- normalizePath(
    file.path(
      R.home("bin"),
      if (.Platform$OS.type == "windows") "R.exe" else "R"
    ),
    winslash = "/",
    mustWork = TRUE
  )
  log <- file.path(output, "build.log")
  # R CMD SHLIB feeds paths into make and its shell on Windows. Keep build
  # operands relative so drive letters, backslashes, and spaces never enter it.
  status <- system2(
    r,
    c("CMD", "SHLIB", "-o", dll_name, source_name),
    stdout = "build.log",
    stderr = "build.log"
  )
  if (status != 0L) {
    stop("Build failed; see ", log)
  }
  dll <- normalizePath(
    file.path(output, dll_name),
    winslash = "/",
    mustWork = TRUE
  )
  message("Standalone DLL: ", dll)
  dll
}

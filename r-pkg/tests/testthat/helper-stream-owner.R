# The independent producer DLL keeps counters readable after a real jdv unload.
# A setup helper owns its build, load and cleanup for each test invocation.
with_arrow_owner <- function(code) {
  skip_on_cran()
  skip_if_not_installed("nanoarrow")
  work <- tempfile("jdv-owner-fixture-")
  dir.create(work)
  work <- normalizePath(work, winslash = "/", mustWork = TRUE)
  on.exit(unlink(work, recursive = TRUE), add = TRUE)
  file.copy(test_path("fixtures", "ownerfixture.c"), work)
  include <- normalizePath(
    system.file("include", package = "nanoarrow"),
    winslash = "/",
    mustWork = TRUE
  )
  old <- Sys.getenv("PKG_CPPFLAGS", unset = NA_character_)
  on.exit(
    if (is.na(old)) {
      Sys.unsetenv("PKG_CPPFLAGS")
    } else {
      Sys.setenv(PKG_CPPFLAGS = old)
    },
    add = TRUE
  )
  Sys.setenv(PKG_CPPFLAGS = paste0("-I", shQuote(include)))
  output <- file.path(work, paste0("ownerfixture", .Platform$dynlib.ext))
  log <- system2(
    file.path(R.home("bin"), "R"),
    c(
      "CMD",
      "SHLIB",
      "-o",
      shQuote(output),
      shQuote(file.path(work, "ownerfixture.c"))
    ),
    stdout = TRUE,
    stderr = TRUE
  )
  if (!is.null(attr(log, "status"))) {
    stop(paste(log, collapse = "\n"))
  }
  producers <- list()
  dll <- dyn.load(output)
  on.exit(
    {
      current <- getLoadedDLLs()[["jdv"]]
      if (!is.null(current)) {
        cleanup <- getDLLRegisteredRoutines(current)[[".Call"]][[
          "C_jdv_arrow_cleanup"
        ]]
        if (!is.null(cleanup)) try(.Call(cleanup), silent = TRUE)
      }
      valid <- nanoarrow::nanoarrow_pointer_is_valid
      for (pointer in producers) {
        if (isTRUE(valid(pointer))) try(pointer$release(), silent = TRUE)
      }
      dyn.unload(output)
    },
    add = TRUE,
    after = FALSE
  )
  symbols <- getDLLRegisteredRoutines(dll)[[".Call"]]
  stream <- function(lengths = c(0L, 3L), mode = 0L, hook = NULL) {
    allocate <- nanoarrow::nanoarrow_allocate_array_stream
    pointer <- allocate()
    .Call(
      symbols$owner_init,
      pointer,
      as.integer(lengths),
      as.integer(mode),
      hook
    )
    producers[[length(producers) + 1L]] <<- pointer
    pointer
  }
  counts <- function() .Call(symbols$owner_counts)
  code(list(path = output, symbols = symbols, stream = stream, counts = counts))
}

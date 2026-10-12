# Standalone builder regression; real compilation plus a simulated Windows branch.
args <- commandArgs(trailingOnly = TRUE)
output <- if (length(args)) args[[1L]] else tempfile("jdv builder checks ")
dir.create(output, recursive = TRUE, showWarnings = FALSE)
output <- normalizePath(output, winslash = "/", mustWork = TRUE)
source_dir <- normalizePath(
  "r-pkg/dev/event-spike",
  winslash = "/",
  mustWork = TRUE
)
builder <- new.env(parent = globalenv())
sys.source(file.path(source_dir, "build.R"), envir = builder)
original_directory <- getwd()
commands <- list()
builder$system2 <- function(command, args, stdout, stderr) {
  commands[[length(commands) + 1L]] <<- list(directory = getwd(), args = args)
  stopifnot(identical(args[[5L]], "event_spike.c"))
  stopifnot(identical(args[[4L]], paste0("jdv_spike", .Platform$dynlib.ext)))
  stopifnot(identical(stdout, "build.log"), identical(stderr, "build.log"))
  base::system2(command, args, stdout = stdout, stderr = stderr)
}

existing_output <- file.path(output, "existing output with spaces")
dir.create(existing_output)
warnings <- character()
dll <- withCallingHandlers(
  builder$spike_build(source_dir, existing_output),
  warning = function(w) warnings <<- c(warnings, conditionMessage(w))
)
stopifnot(
  !length(warnings),
  file.exists(dll),
  identical(getwd(), original_directory)
)
stopifnot(identical(dll, normalizePath(dll, winslash = "/", mustWork = TRUE)))
stopifnot(identical(commands[[1L]]$directory, existing_output))

bad_source <- file.path(output, "invalid source")
dir.create(bad_source)
writeLines(
  "#error intentional standalone builder test failure",
  file.path(bad_source, "event_spike.c")
)
failure_output <- file.path(output, "failed output with spaces")
error <- tryCatch(
  builder$spike_build(bad_source, failure_output),
  error = identity
)
stopifnot(
  inherits(error, "error"),
  grepl("Build failed", conditionMessage(error))
)
stopifnot(
  identical(getwd(), original_directory),
  file.exists(file.path(failure_output, "build.log"))
)

check_windows_branch <- function(prior_libs, fail) {
  original_libs <- Sys.getenv("PKG_LIBS", unset = NA_character_)
  on.exit({
    if (is.na(original_libs)) {
      Sys.unsetenv("PKG_LIBS")
    } else {
      Sys.setenv(PKG_LIBS = original_libs)
    }
  })
  if (is.na(prior_libs)) {
    Sys.unsetenv("PKG_LIBS")
  } else {
    Sys.setenv(PKG_LIBS = prior_libs)
  }
  simulated <- new.env(parent = globalenv())
  sys.source(file.path(source_dir, "build.R"), envir = simulated)
  simulated$.Platform <- modifyList(
    .Platform,
    list(OS.type = "windows", dynlib.ext = ".dll")
  )
  simulated_bin <- file.path(output, "simulated R bin with spaces")
  dir.create(simulated_bin, showWarnings = FALSE)
  file.create(file.path(simulated_bin, "R.exe"))
  simulated$R.home <- function(component) simulated_bin
  seen <- NULL
  simulated$system2 <- function(command, args, stdout, stderr) {
    seen <<- list(
      directory = getwd(),
      args = args,
      libraries = Sys.getenv("PKG_LIBS")
    )
    stopifnot(identical(
      args,
      c("CMD", "SHLIB", "-o", "jdv_spike.dll", "event_spike.c")
    ))
    stopifnot(!any(grepl("[/\\\\:]", args)))
    stopifnot(grepl("-luser32", seen$libraries, fixed = TRUE))
    stopifnot(identical(stdout, "build.log"), identical(stderr, "build.log"))
    if (fail) {
      stop("simulated Windows process launch failure")
    }
    file.create("jdv_spike.dll")
    0L
  }
  folder <- tempfile("simulated Windows output with spaces ", tmpdir = output)
  result <- tryCatch(
    simulated$spike_build(source_dir, folder),
    error = identity
  )
  stopifnot(identical(getwd(), original_directory))
  stopifnot(identical(
    Sys.getenv("PKG_LIBS", unset = NA_character_),
    prior_libs
  ))
  stopifnot(identical(seen$directory, normalizePath(folder, winslash = "/")))
  if (fail) {
    stopifnot(
      inherits(result, "error"),
      grepl("simulated Windows", conditionMessage(result))
    )
  } else {
    stopifnot(file.exists(result))
  }
  invisible(NULL)
}
for (prior_libs in list(NA_character_, "-lexample")) {
  for (fail in c(FALSE, TRUE)) {
    check_windows_branch(prior_libs, fail)
  }
}
writeLines(dll, file.path(output, "dll-path.txt"))
saveRDS(commands, file.path(output, "actual-commands.rds"))
cat(
  "Builder regression passed; Windows process execution remains unverified.\n"
)
cat("Real DLL and logs: ", output, "\n", sep = "")

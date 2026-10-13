run_native_json_validation <- function() {
  package_root <- normalizePath(file.path(getwd(), "r-pkg"), mustWork = TRUE)
  if (!file.exists(file.path(package_root, "DESCRIPTION"))) {
    stop("Run this script from the repository root.", call. = FALSE)
  }

  build_dir <- tempfile("jdv-native-json-")
  dir.create(build_dir)
  dir.create(file.path(build_dir, "cjson"))
  on.exit(unlink(build_dir, recursive = TRUE), add = TRUE)

  makevars <- if (.Platform$OS.type == "windows") {
    "Makevars.win"
  } else {
    "Makevars"
  }
  source_files <- c(
    "init.c",
    "int64.c",
    "int64.h",
    "json.c",
    "json.h",
    "loop.c",
    makevars,
    "transport.c",
    "transport.h"
  )
  copied <- file.copy(file.path(package_root, "src", source_files), build_dir)
  if (!all(copied)) {
    stop(
      "Could not copy native sources into the temporary build directory.",
      call. = FALSE
    )
  }
  if (
    !all(file.copy(
      file.path(package_root, "src", "cjson", c("cJSON.c", "cJSON.h")),
      file.path(build_dir, "cjson")
    ))
  ) {
    stop(
      "Could not copy cJSON sources into the temporary build directory.",
      call. = FALSE
    )
  }

  old_dir <- setwd(build_dir)
  on.exit(setwd(old_dir), add = TRUE)
  old_cppflags <- Sys.getenv("PKG_CPPFLAGS", unset = NA_character_)
  Sys.setenv(PKG_CPPFLAGS = "-Icjson")
  on.exit(
    {
      if (is.na(old_cppflags)) {
        Sys.unsetenv("PKG_CPPFLAGS")
      } else {
        Sys.setenv(PKG_CPPFLAGS = old_cppflags)
      }
    },
    add = TRUE
  )

  r_bin <- file.path(R.home("bin"), "R")
  dll_name <- paste0("jdv", .Platform$dynlib.ext)
  output <- system2(
    r_bin,
    c(
      "CMD",
      "SHLIB",
      "-o",
      dll_name,
      "init.c",
      "int64.c",
      "json.c",
      "transport.c",
      "loop.c",
      "cjson/cJSON.c"
    ),
    stdout = TRUE,
    stderr = TRUE
  )
  status <- attr(output, "status")
  if (!is.null(status) && status != 0L) {
    stop(paste(output, collapse = "\n"), call. = FALSE)
  }

  dll_path <- file.path(build_dir, paste0("jdv", .Platform$dynlib.ext))
  dll <- dyn.load(dll_path)
  on.exit(dyn.unload(dll_path), add = TRUE)
  parse <- getNativeSymbolInfo("C_jdv_json_parse", dll)$address
  expected_routines <- c(
    paste0(
      "C_jdv_int64_",
      c("is_na", "values", "rank", "order", "eq", "between")
    ),
    "C_jdv_json_parse",
    "C_jdv_json_encode",
    paste0(
      "C_jdv_transport_",
      c(
        "connect",
        "send",
        "poll",
        "close",
        "status",
        "can_unload",
        "housekeeping"
      )
    )
  )
  registered_routines <- names(getDLLRegisteredRoutines(dll)[[".Call"]])
  can_unload <- getNativeSymbolInfo("C_jdv_transport_can_unload", dll)$address
  if (
    !setequal(expected_routines, registered_routines) ||
      !isTRUE(.Call(can_unload))
  ) {
    stop(
      "Native routine registration or idle unload checks failed.",
      call. = FALSE
    )
  }

  accepts <- function(json, max_bytes = 1e6) {
    !inherits(
      tryCatch(.Call(parse, json, max_bytes), error = identity),
      "error"
    )
  }

  accepted <- c(
    '{"id":0}',
    '{"id":"request-1"}',
    '{"id":1,"method":"cancel","params":{"id":0}}',
    '{"id":1,"method":"cancel","params":{"id":"request-2"}}'
  )
  rejected <- c(
    '{"id":1.0}',
    '{"id":1e0}',
    '{"id":-1}',
    '{"id":null}',
    '{"id":9007199254740992}',
    '{"id":1,"method":"cancel","params":{"id":1.0}}',
    '{"id":1,"method":"cancel","params":{"\\u0069d":1e0}}',
    '{"id":1,"method":"cancel","params":{"id":9007199254740992}}',
    '{"id":1,"id":2}',
    paste0(strrep("[", 129), "0", strrep("]", 129))
  )

  if (
    !all(vapply(accepted, accepts, logical(1))) ||
      any(vapply(rejected, accepts, logical(1)))
  ) {
    stop("Native JSON validation cases failed.", call. = FALSE)
  }

  message("Native JSON validation cases passed.")
}

run_native_json_validation()

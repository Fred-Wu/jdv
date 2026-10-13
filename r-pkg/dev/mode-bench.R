#!/usr/bin/env Rscript

# Reproducible child-process benchmark for Snapshot/Paged/auto mode decisions.
# Run through mode-bench.py so each phase gets an isolated RSS high-water mark.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2L) {
  stop("Usage: mode-bench.R CASE PHASE [TMPDIR]", call. = FALSE)
}
case <- args[[1L]]
phase <- args[[2L]]
tmpdir <- if (length(args) >= 3L) args[[3L]] else tempdir()

bench_lib <- Sys.getenv("JDV_BENCH_LIB", "")
if (nzchar(bench_lib)) {
  .libPaths(c(bench_lib, .libPaths()))
}
if (!requireNamespace("jdv", quietly = TRUE)) {
  stop("Package jdv is not installed in the selected library.", call. = FALSE)
}
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("The benchmark requires the jsonlite Suggests package.", call. = FALSE)
}

ns <- asNamespace("jdv")
get_ns <- function(name) get(name, envir = ns, inherits = FALSE)
timer_ms <- function(expr) unname(system.time(force(expr))[['elapsed']]) * 1000

gc_silently <- function() invisible(utils::capture.output(gc()))

measure_encoder <- function(encode, value, limit, repetitions) {
  warmup <- encode(value, limit)
  warmup_bytes <- nchar(warmup, type = "bytes")
  rm(warmup)
  gc_silently()
  elapsed <- system.time({
    for (i in seq_len(repetitions)) {
      encoded <- encode(value, limit)
    }
  })[['elapsed']]
  bytes <- nchar(encoded, type = "bytes")
  rm(encoded)
  gc_silently()
  list(
    warmup_bytes = warmup_bytes,
    bytes = bytes,
    repetitions = repetitions,
    milliseconds_per_call = elapsed * 1000 / repetitions
  )
}

make_input <- function(name) {
  set.seed(20261013)
  if (name == "zero_col_800m") {
    x <- structure(
      list(),
      class = "data.frame",
      row.names = c(NA_integer_, -800000000L)
    )
    return(x)
  }
  if (name == "giant_cell_auto") {
    return(data.frame(
      blob = paste0(strrep("x", 11 * 1024^2)),
      stringsAsFactors = FALSE
    ))
  }
  if (name == "giant_late_auto") {
    rows <- 512L
    sample_size <- 256L
    sample_rows <- unique(as.integer(
      floor(
        (seq_len(sample_size) - 1) *
          (as.double(rows) - 1) /
          max(1, sample_size - 1)
      ) +
        1
    ))
    giant_row <- setdiff(33L:rows, sample_rows)[[1L]]
    value <- rep("small", rows)
    value[[giant_row]] <- strrep("x", 11 * 1024^2)
    x <- data.frame(blob = value, stringsAsFactors = FALSE)
    attr(x, "bench_giant_row") <- giant_row
    attr(x, "bench_sample_size") <- sample_size
    return(x)
  }
  if (name == "matrix_2m_x8") {
    return(matrix(runif(2000000L * 8L), nrow = 2000000L, ncol = 8L))
  }
  if (startsWith(name, "encoder_")) {
    rows <- as.integer(sub("^encoder_", "", name))
    return(structure(unname(runif(rows)), class = "jdv_json_array"))
  }
  if (startsWith(name, "numeric_")) {
    rows <- as.integer(sub("^numeric_", "", name))
    value <- runif(rows)
    value[seq.int(97L, rows, by = 997L)] <- NA_real_
    return(data.frame(value = value))
  }
  if (startsWith(name, "mixed_")) {
    cells <- as.integer(sub("^mixed_", "", name))
    rows <- cells %/% 5L
    id <- seq_len(rows)
    group <- (id - 1L) %% 100L
    value <- runif(rows)
    value[seq.int(89L, rows, by = 991L)] <- NA_real_
    return(data.frame(
      number = value,
      integer = as.integer(id %% 100003L),
      group = factor(group, levels = 0:99),
      text = sprintf("g%03d", group),
      flag = id %% 2L == 0L,
      stringsAsFactors = FALSE
    ))
  }
  if (grepl("^strings_(low|high)_(C|locale)$", name)) {
    parts <- strsplit(name, "_", fixed = TRUE)[[1L]]
    cardinality <- if (parts[[2L]] == "low") 100L else 100000L
    rows <- 300000L
    dictionary <- sprintf("key%06d", seq_len(cardinality))
    value <- dictionary[sample.int(cardinality, rows, replace = TRUE)]
    value[seq.int(113L, rows, by = 997L)] <- NA_character_
    attr(value, "bench_collation") <- parts[[3L]]
    return(data.frame(value = value, stringsAsFactors = FALSE))
  }
  if (identical(name, "strings_1100000_low_locale")) {
    rows <- 1100000L
    dictionary <- sprintf("key%06d", seq_len(100L))
    value <- dictionary[sample.int(100L, rows, replace = TRUE)]
    value[seq.int(113L, rows, by = 997L)] <- NA_character_
    return(data.frame(value = value, stringsAsFactors = FALSE))
  }
  stop("Unknown benchmark case: ", name, call. = FALSE)
}

numeric_token_estimate <- function(snapshot, content) {
  token_widths <- function(x, digits) {
    x <- as.double(x)
    x <- x[is.finite(x)]
    if (!length(x)) {
      return(0)
    }
    integer_fast <- x == trunc(x) &
      x >= -.Machine$integer.max - 1 &
      x <= .Machine$integer.max
    rendered <- character(length(x))
    rendered[integer_fast] <- sprintf("%.0f", x[integer_fast])
    rendered[!integer_fast] <- sprintf(
      paste0("%1.", digits, "g"),
      x[!integer_fast]
    )
    sum(nchar(rendered, type = "bytes"))
  }
  values <- sort_keys <- numeric()
  for (j in seq_along(snapshot$columns)) {
    column <- snapshot$columns[[j]]
    encoded <- content$data$columns[[j]]
    if (!is.null(encoded$values) && is.numeric(column$data$values)) {
      values <- c(values, as.double(column$data$values))
    }
    if (!is.null(encoded$sortKey) && is.numeric(column$data$sortKey)) {
      sort_keys <- c(sort_keys, as.double(column$data$sortKey))
    }
  }
  all_tokens <- c(values, sort_keys)
  all_tokens <- all_tokens[is.finite(all_tokens)]
  if (!length(all_tokens)) {
    return(list(numeric_tokens = 0L))
  }
  fallback <- 0L
  for (value in all_tokens[is.finite(all_tokens)]) {
    text15 <- sprintf("%1.15g", value)
    if (!identical(as.double(text15), value)) fallback <- fallback + 1L
  }
  list(
    numeric_tokens = length(all_tokens),
    fifteen_digit_token_bytes = token_widths(all_tokens, 15L),
    seventeen_digit_token_bytes = token_widths(all_tokens, 17L),
    adaptive_15_17_token_bytes = token_widths(all_tokens, 15L) +
      sum(vapply(
        all_tokens[is.finite(all_tokens)],
        function(value) {
          text15 <- sprintf("%1.15g", value)
          if (as.double(text15) == value) {
            0
          } else {
            nchar(sprintf("%1.17g", value), type = "bytes") -
              nchar(text15, type = "bytes")
          }
        },
        numeric(1L)
      )),
    seventeen_digit_fallback_count = fallback
  )
}

input_started <- proc.time()[["elapsed"]]
x <- make_input(case)
input_ms <- (proc.time()[["elapsed"]] - input_started) * 1000
collation <- if (grepl("_(C|locale)$", case)) {
  sub("^.*_(C|locale)$", "\\1", case)
} else {
  "C"
}
work_budget_bytes <- as.double(Sys.getenv("JDV_BENCH_WORK_BYTES", 64 * 1024^2))
cache_budget_bytes <- as.double(Sys.getenv(
  "JDV_BENCH_CACHE_BYTES",
  32 * 1024^2
))
query_row_limit <- as.double(Sys.getenv("JDV_BENCH_QUERY_ROWS", "1000000"))
input_summary <- list(
  case = case,
  phase = phase,
  r_version = R.version.string,
  jdv_version = as.character(utils::packageVersion("jdv")),
  jsonlite_version = as.character(utils::packageVersion("jsonlite")),
  platform = R.version$platform,
  rows = if (is.data.frame(x) || is.matrix(x)) {
    as.double(nrow(x))
  } else {
    as.double(length(x))
  },
  columns = if (is.data.frame(x) || is.matrix(x)) {
    as.integer(ncol(x))
  } else {
    NA_integer_
  },
  cells_estimate = if (is.data.frame(x) || is.matrix(x)) {
    as.double(nrow(x)) * max(1, as.double(ncol(x)))
  } else {
    as.double(length(x))
  },
  input_object_bytes = as.double(object.size(x)),
  input_prepare_ms = input_ms,
  collation = collation,
  work_budget_bytes = work_budget_bytes,
  cache_budget_bytes = cache_budget_bytes,
  query_row_limit = query_row_limit
)

max_message <- as.double(Sys.getenv("JDV_BENCH_MAX_MESSAGE", 256 * 1024^2))
options(
  jdv.max_message_bytes = 10 * 1024^2,
  jdv.max_request_bytes = 1024^2,
  jdv.max_page_rows = 2000L,
  jdv.max_tables = 64L,
  jdv.max_work_bytes = work_budget_bytes,
  jdv.max_cache_bytes = cache_budget_bytes,
  jdv.max_query_rows = query_row_limit,
  jdv.snapshot_max_cells = as.double(Sys.getenv(
    "JDV_BENCH_SNAPSHOT_CELLS",
    "10000"
  )),
  jdv.collation = collation
)

prof_path <- file.path(tmpdir, paste0("rprofmem-", case, "-", phase, ".out"))
profile <- identical(Sys.getenv("JDV_BENCH_RPROFMEM", "0"), "1")
if (profile) {
  utils::Rprofmem(prof_path, threshold = 0)
}
profile_stopped <- FALSE
stop_profile <- function() {
  if (profile && !profile_stopped) {
    utils::Rprofmem(NULL)
    profile_stopped <<- TRUE
  }
}
metrics <- list(status = "ok")
if (phase == "prepare") {
  metrics$operation_ms <- 0
} else if (phase == "encoder") {
  if (!inherits(x, "jdv_json_array")) {
    metrics$status <- "skipped_encoder_requires_encoder_case"
  } else {
    repetitions <- as.integer(Sys.getenv("JDV_BENCH_ENCODER_REPETITIONS", "12"))
    encode <- get_ns(".jdv_json_encode")
    warmup <- encode(x, max_message)
    warmup_bytes <- nchar(warmup, type = "bytes")
    rm(warmup)
    gc_silently()
    encode_times <- numeric(repetitions)
    encoded_bytes <- integer(repetitions)
    for (i in seq_len(repetitions)) {
      elapsed <- system.time(encoded <- encode(x, max_message))[["elapsed"]]
      encode_times[[i]] <- elapsed * 1000
      encoded_bytes[[i]] <- nchar(encoded, type = "bytes")
    }
    metrics$encoder_repetitions <- repetitions
    metrics$encoder_bytes <- unique(encoded_bytes)
    metrics$encoder_warmup_bytes <- warmup_bytes
    metrics$encoder_median_ms <- median(encode_times)
    metrics$encoder_mean_ms <- mean(encode_times)
    metrics$encoder_min_ms <- min(encode_times)
    metrics$encoder_max_ms <- max(encode_times)
    metrics$encoder_times_ms <- encode_times
    rm(encoded)
    gc_silently()
  }
} else if (phase == "snapshot" && nrow(x) > 10000000) {
  metrics$status <- "skipped_guard_large_row_count"
} else if (phase == "snapshot") {
  snap <- NULL
  metrics$channel_extract_ms <- timer_ms({
    snap <- get_ns("snapshot_table")(x, collation = collation)
  })
  content <- NULL
  row_names <- get_ns(".jdv_explicit_row_names")(x)
  metrics$payload_build_ms <- timer_ms({
    content <- list(
      mode = "snapshot",
      source = NULL,
      holder = NULL,
      fingerprint = NULL,
      nrow = snap$nrow,
      ncol = snap$ncol,
      schema = snap$schema,
      row_names = row_names,
      data = list(
        row_index = get_ns(".jdv_json_values")(seq_len(snap$nrow)),
        row_names = if (is.null(row_names)) {
          NULL
        } else {
          get_ns(".jdv_json_values")(row_names)
        },
        columns = lapply(
          snap$columns,
          get_ns(".jdv_json_column"),
          snapshot = TRUE
        )
      ),
      collation = collation
    )
  })
  descriptor <- get_ns(".jdv_descriptor")(content, "t-bench", 1, "bench")
  encoded_result <- measure_encoder(
    get_ns(".jdv_json_encode"),
    descriptor,
    max_message,
    repetitions = 5L
  )
  metrics$cjson_ms <- encoded_result$milliseconds_per_call
  metrics$cjson_repetitions <- encoded_result$repetitions
  metrics$snapshot_bytes <- as.double(encoded_result$bytes)
  metrics$output_limit_default_bytes <- 10 * 1024^2
  metrics$sort_key_columns <- sum(vapply(
    content$data$columns,
    function(column) !is.null(column$sortKey),
    logical(1L)
  ))
  numeric_estimate <- numeric_token_estimate(snap, content)
  metrics$numeric_token_estimate <- numeric_estimate
  if (
    any(vapply(
      snap$columns,
      function(column) {
        column$schema$type %in% c("string", "factor", "int64") &&
          !is.null(column$data$display)
      },
      logical(1L)
    ))
  ) {
    displayed <- unserialize(serialize(descriptor, NULL))
    for (j in seq_along(snap$columns)) {
      column <- snap$columns[[j]]
      if (
        column$schema$type %in% c("string", "factor", "int64") &&
          !is.null(column$data$display)
      ) {
        displayed$params$data$columns[[j]]$display <- get_ns(
          ".jdv_json_values"
        )(column$data$display)
      }
    }
    displayed_result <- measure_encoder(
      get_ns(".jdv_json_encode"),
      displayed,
      max_message,
      repetitions = 1L
    )
    metrics$bytes_with_text_display <- as.double(displayed_result$bytes)
    metrics$bytes_saved_by_display_omission <- metrics$bytes_with_text_display -
      metrics$snapshot_bytes
  }
} else if (phase %in% c("format", "rank")) {
  if (!is.data.frame(x) && !is.matrix(x)) {
    metrics$status <- paste0("skipped_channel_case_", phase)
  } else if (!ncol(x)) {
    metrics$status <- paste0("skipped_zero_column_", phase)
  } else {
    column <- if (is.matrix(x)) x[, 1L] else x[[1L]]
    metrics$column_type <- typeof(column)
    metrics$column_class <- class(column)
    metrics$column_length <- length(column)
    if (phase == "format") {
      formatted <- NULL
      metrics$format_ms <- timer_ms({
        formatted <- get_ns("col_display")(column)
      })
      metrics$formatted_count <- length(formatted)
      metrics$formatted_bytes <- as.double(sum(nchar(
        formatted,
        type = "bytes"
      )))
    } else {
      sort_key <- NULL
      metrics$rank_ms <- timer_ms({
        sort_key <- get_ns("col_sort_key")(column, collation = collation)
      })
      metrics$sort_key_type <- typeof(sort_key)
      metrics$sort_key_length <- length(sort_key)
      metrics$sort_key_object_bytes <- as.double(object.size(sort_key))
      metrics$sort_key_na_count <- sum(is.na(sort_key))
    }
  }
} else if (phase == "paged") {
  holder <- NULL
  metrics$register_probe_ms <- timer_ms({
    holder <- get_ns("paged_table")(x, collation = collation)
  })
  page <- NULL
  metrics$channel_extract_ms <- timer_ms({
    page <- get_ns("query_page")(holder, offset = 0L, limit = 200L)
  })
  response <- NULL
  metrics$payload_build_ms <- timer_ms({
    page$data$columns <- lapply(page$data$columns, get_ns(".jdv_page_column"))
    page$data$row_index <- get_ns(".jdv_json_values")(page$data$row_index)
    if (!is.null(page$data$row_names)) {
      page$data$row_names <- get_ns(".jdv_json_values")(page$data$row_names)
    }
    result <- list(
      table = "t-bench",
      generation = 1,
      total = page$total,
      total_unfiltered = page$total_unfiltered,
      offset = page$offset,
      limit = page$limit,
      data = page$data
    )
    response <- get_ns(".jdv_response")(1, result = result)
  })
  encoded_result <- measure_encoder(
    get_ns(".jdv_json_encode"),
    response,
    max_message,
    repetitions = 25L
  )
  metrics$cjson_ms <- encoded_result$milliseconds_per_call
  metrics$cjson_repetitions <- encoded_result$repetitions
  metrics$page_bytes <- as.double(encoded_result$bytes)
  metrics$page_rows <- length(page$data$row_index)
  metrics$page_output_limit_default_bytes <- 10 * 1024^2
  # Also time the public end-to-end path in an independently cleared holder.
  registered <- jdv::jdv_register(x, mode = "paged", collation = collation)
  request <- sprintf(
    paste0(
      '{"id":1,"method":"table/rows","params":',
      '{"table":"%s","generation":1,"offset":0,"limit":200}}'
    ),
    registered$id
  )
  rpc_result <- NULL
  metrics$public_jdv_rpc_ms <- timer_ms({
    rpc_result <- jdv::jdv_rpc(request)
  })
  metrics$public_jdv_rpc_bytes <- if (is.character(rpc_result)) {
    as.double(nchar(rpc_result, type = "bytes"))
  } else {
    NA_real_
  }
  if (case == "zero_col_800m") {
    tail_request <- sprintf(
      paste0(
        '{"id":2,"method":"table/rows","params":',
        '{"table":"%s","generation":1,"offset":799999998,"limit":2}}'
      ),
      registered$id
    )
    tail_response <- NULL
    metrics$tail_two_row_rpc_ms <- timer_ms({
      tail_response <- jdv::jdv_rpc(tail_request)
    })
    metrics$tail_two_row_rpc_bytes <- if (is.character(tail_response)) {
      as.double(nchar(tail_response, type = "bytes"))
    } else {
      NA_real_
    }
    parsed_tail <- if (is.character(tail_response)) {
      tryCatch(
        jsonlite::fromJSON(tail_response, simplifyVector = FALSE),
        error = function(e) NULL
      )
    } else {
      NULL
    }
    metrics$tail_two_row_error_code <- if (is.null(parsed_tail$error)) {
      NULL
    } else {
      parsed_tail$error$code
    }
    metrics$tail_two_row_indices <- if (is.null(parsed_tail$result)) {
      NULL
    } else {
      unlist(parsed_tail$result$data$row_index, use.names = FALSE)
    }
  }
} else if (phase == "sort" && ncol(x) == 0L) {
  metrics$status <- "skipped_zero_column_sort"
} else if (phase == "sort") {
  registered <- NULL
  metrics$register_probe_ms <- timer_ms({
    registered <- jdv::jdv_register(x, mode = "paged", collation = collation)
  })
  make_rows_request <- function(request_id, sort_json = "") {
    sort_field <- if (nzchar(sort_json)) {
      paste0(',"sort":[', sort_json, "]")
    } else {
      ""
    }
    sprintf(
      paste0(
        '{"id":%d,"method":"table/rows","params":',
        '{"table":"%s","generation":1,"offset":0,"limit":200%s}}'
      ),
      request_id,
      registered$id,
      sort_field
    )
  }
  parse_rpc <- function(response) {
    if (!is.character(response)) {
      return(NULL)
    }
    tryCatch(
      jsonlite::fromJSON(response, simplifyVector = FALSE),
      error = function(e) NULL
    )
  }
  unsorted <- NULL
  metrics$unsorted_rpc_ms <- timer_ms({
    unsorted <- jdv::jdv_rpc(make_rows_request(1L))
  })
  unsorted_parsed <- parse_rpc(unsorted)
  metrics$unsorted_rpc_bytes <- if (is.character(unsorted)) {
    as.double(nchar(unsorted, type = "bytes"))
  } else {
    NA_real_
  }
  metrics$unsorted_row_count <- if (is.null(unsorted_parsed$result)) {
    0L
  } else {
    length(unsorted_parsed$result$data$row_index)
  }
  sort_json <- '{"col":0,"desc":false}'
  cold <- NULL
  metrics$sorted_cold_rpc_ms <- timer_ms({
    cold <- jdv::jdv_rpc(make_rows_request(2L, sort_json))
  })
  entry <- get(".jdv_state", envir = ns, inherits = FALSE)$entries[[
    registered$id
  ]]
  metrics$cache_bytes_after_sorted_cold <- entry$holder$cache_bytes
  cold_parsed <- parse_rpc(cold)
  metrics$sorted_cold_rpc_bytes <- if (is.character(cold)) {
    as.double(nchar(cold, type = "bytes"))
  } else {
    NA_real_
  }
  metrics$sorted_cold_error_code <- if (is.null(cold_parsed$error)) {
    NULL
  } else {
    cold_parsed$error$code
  }
  metrics$sorted_first_row_index <- if (is.null(cold_parsed$result)) {
    NULL
  } else {
    cold_parsed$result$data$row_index[[1L]]
  }
  warm <- NULL
  metrics$sorted_warm_rpc_ms <- timer_ms({
    warm <- jdv::jdv_rpc(make_rows_request(3L, sort_json))
  })
  metrics$cache_bytes_after_sorted_warm <- entry$holder$cache_bytes
  warm_parsed <- parse_rpc(warm)
  metrics$sorted_warm_rpc_bytes <- if (is.character(warm)) {
    as.double(nchar(warm, type = "bytes"))
  } else {
    NA_real_
  }
  metrics$sorted_warm_error_code <- if (is.null(warm_parsed$error)) {
    NULL
  } else {
    warm_parsed$error$code
  }
} else if (phase == "auto") {
  registered <- NULL
  metrics$register_auto_ms <- timer_ms({
    registered <- jdv::jdv_register(x, mode = "auto", collation = collation)
  })
  entry <- get(".jdv_state", envir = ns, inherits = FALSE)$entries[[
    registered$id
  ]]
  metrics$selected_mode <- entry$mode
  metrics$open_bytes <- as.double(nchar(registered$open, type = "bytes"))
  metrics$snapshot_cell_threshold <- getOption("jdv.snapshot_max_cells")
  if (case == "giant_late_auto") {
    metrics$giant_row <- attr(x, "bench_giant_row", exact = TRUE)
    metrics$estimator_sample_size <- attr(x, "bench_sample_size", exact = TRUE)
    metrics$giant_row_in_probe <- metrics$giant_row <= 32L
  }
  if (case == "giant_cell_auto") {
    request <- sprintf(
      paste0(
        '{"id":2,"method":"table/rows","params":',
        '{"table":"%s","generation":1,"offset":0,"limit":1}}'
      ),
      registered$id
    )
    page <- NULL
    metrics$giant_cell_page_ms <- timer_ms({
      page <- jdv::jdv_rpc(request)
    })
    metrics$giant_cell_page_status <- if (is.null(page)) {
      "null"
    } else {
      "response"
    }
    metrics$giant_cell_page_bytes <- if (is.character(page)) {
      as.double(nchar(page, type = "bytes"))
    } else {
      NA_real_
    }
    parsed_page <- if (is.character(page)) {
      tryCatch(
        jsonlite::fromJSON(page, simplifyVector = FALSE),
        error = function(e) NULL
      )
    } else {
      NULL
    }
    metrics$giant_cell_page_error_code <- if (is.null(parsed_page$error)) {
      NULL
    } else {
      parsed_page$error$code
    }
  }
  if (case == "zero_col_800m") {
    forced_error <- tryCatch(
      {
        jdv::jdv_register(x, mode = "snapshot", collation = collation)
        NULL
      },
      error = conditionMessage
    )
    metrics$forced_snapshot_error <- forced_error
  }
} else {
  stop("Unknown phase: ", phase, call. = FALSE)
}

stop_profile()
if (profile && file.exists(prof_path)) {
  lines <- readLines(prof_path, warn = FALSE)
  sizes <- suppressWarnings(as.numeric(sub(" .*", "", lines)))
  sizes <- sizes[is.finite(sizes)]
  metrics$rprofmem_allocation_count <- length(sizes)
  metrics$rprofmem_allocated_bytes <- sum(sizes)
  metrics$rprofmem_largest_allocation_bytes <- if (length(sizes)) {
    max(sizes)
  } else {
    0
  }
}

output <- c(input_summary, metrics)
cat(as.character(jsonlite::toJSON(
  output,
  auto_unbox = TRUE,
  null = "null",
  na = "null",
  digits = 17
)))
cat("\n")

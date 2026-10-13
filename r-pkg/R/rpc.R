# The registry is deliberately independent of the transport so embedding and
# local-viewer calls use the same table engine.
.jdv_state <- local({
  state <- new.env(parent = emptyenv())
  state$entries <- new.env(hash = TRUE, parent = emptyenv())
  state$titles <- new.env(hash = TRUE, parent = emptyenv())
  state$next_id <- 0
  state$sequence <- 0
  state$outbox <- list()
  state$rpc_depth <- 0L
  state$transport <- NULL
  state$transport_limits <- NULL
  state$transport_epoch <- 0L
  state$transport_hello <- FALSE
  state$session_counter <- 0L
  state$transport_task_callback <- NULL
  state$unloading <- FALSE
  state
})

.jdv_assert_active <- function() {
  if (isTRUE(.jdv_state$unloading)) {
    stop("The jdv namespace is shutting down.", call. = FALSE)
  }
  invisible(NULL)
}

jdv_json_array <- function(x = list()) {
  if (!is.list(x) || !is.null(names(x))) {
    stop("JSON arrays must be unnamed lists.", call. = FALSE)
  }
  structure(x, class = "jdv_json_array")
}

jdv_json_object <- function(x = list()) {
  if (!is.list(x) || (length(x) && is.null(names(x)))) {
    stop("JSON objects must be named lists.", call. = FALSE)
  }
  structure(x, class = "jdv_json_object")
}

.jdv_json_values <- function(x) structure(unname(x), class = "jdv_json_array")

.jdv_option_limit <- function(
  name,
  default,
  minimum = 1,
  allow_infinite = FALSE
) {
  value <- getOption(name, default)
  if (
    !is.numeric(value) ||
      length(value) != 1L ||
      is.object(value) ||
      is.na(value) ||
      (!is.finite(value) && !(allow_infinite && identical(value, Inf))) ||
      value != floor(value) ||
      value < minimum ||
      (value > .Machine$integer.max &&
        !(allow_infinite && identical(value, Inf)))
  ) {
    query_error("invalid_request", paste0("Invalid option: ", name, "."))
  }
  as.numeric(value)
}

.jdv_max_message_bytes <- function() {
  .jdv_option_limit("jdv.max_message_bytes", 10 * 1024^2, 1024)
}

.jdv_max_request_bytes <- function() {
  .jdv_option_limit("jdv.max_request_bytes", 1024^2, 128)
}

.jdv_max_work_bytes <- function() {
  .jdv_option_limit("jdv.max_work_bytes", Inf, 1024, allow_infinite = TRUE)
}

.jdv_derived_work_bytes <- function(output_bytes) {
  # Six bytes per output byte covers retained channel copies and transient
  # encoder structures in the measured Snapshot workload; the 4 MiB floor
  # preserves the former 64 MiB allowance at the 10 MiB default.
  6 * as.double(output_bytes) + 4 * 1024^2
}

.jdv_page_work_bytes <- function() {
  min(
    .Machine$integer.max,
    .jdv_derived_work_bytes(.jdv_max_message_bytes()),
    .jdv_max_work_bytes()
  )
}

.jdv_snapshot_work_bytes <- function() {
  output_bytes <- min(.jdv_snapshot_max_bytes(), .jdv_max_message_bytes())
  min(
    .Machine$integer.max,
    .jdv_derived_work_bytes(output_bytes),
    .jdv_max_work_bytes()
  )
}

.jdv_snapshot_max_bytes <- function() {
  .jdv_option_limit("jdv.snapshot_max_bytes", 10 * 1024^2, 1024)
}

.jdv_max_cache_bytes <- function() {
  .jdv_option_limit("jdv.max_cache_bytes", 32 * 1024^2, 1024)
}

.jdv_max_query_rows <- function() {
  .jdv_option_limit("jdv.max_query_rows", Inf, 1, allow_infinite = TRUE)
}

.jdv_json_encode <- function(
  x,
  limit = .jdv_max_message_bytes(),
  work_limit = .jdv_page_work_bytes()
) {
  tryCatch(
    .Call(C_jdv_json_encode, x, as.numeric(limit), as.numeric(work_limit)),
    error = function(e) {
      if (identical(conditionMessage(e), "jdv_json_output_limit")) {
        .jdv_budget_error(
          "JSON message exceeds the configured output byte limit.",
          "output",
          auto_fallback = TRUE
        )
      }
      if (identical(conditionMessage(e), "jdv_json_work_limit")) {
        .jdv_budget_error(
          "JSON construction exceeds the configured work byte budget.",
          "native_work",
          auto_fallback = TRUE
        )
      }
      stop(e)
    }
  )
}

.jdv_json_encode_error <- function(x) {
  # Control responses have a separate, fixed allowance so the engine can
  # report a work-budget failure even when the request exhausted that budget.
  .jdv_json_encode(
    x,
    limit = max(1024, .jdv_max_message_bytes()),
    work_limit = 64 * 1024
  )
}

.jdv_json_parse <- function(x) {
  tryCatch(
    .Call(C_jdv_json_parse, enc2utf8(x), .jdv_max_request_bytes()),
    error = function(e) {
      message <- conditionMessage(e)
      code <- if (identical(message, "jdv_json_input_limit")) {
        "limit_exceeded"
      } else {
        "invalid_request"
      }
      query_error(
        code,
        if (code == "limit_exceeded") {
          "JSON request exceeds the byte limit."
        } else {
          "Invalid JSON request."
        }
      )
    }
  )
}

.jdv_title_key <- function(title) {
  paste0(
    "title:",
    paste(as.integer(charToRaw(enc2utf8(title))), collapse = "-")
  )
}

.jdv_fingerprint <- function(x) {
  classes <- lapply(seq_len(ncol(x)), function(j) {
    value <- if (is.matrix(x)) x[integer(), j] else x[[j]]
    class(value)
  })
  list(nrow = nrow(x), ncol = ncol(x), names = colnames(x), classes = classes)
}

.jdv_check_fingerprint <- function(entry) {
  if (is.null(entry$source)) {
    return(invisible(TRUE))
  }
  current <- tryCatch(.jdv_fingerprint(entry$source), error = function(e) NULL)
  if (!identical(current, entry$fingerprint)) {
    query_error(
      "schema_changed",
      "Table dimensions, column names, or column classes changed; register it again."
    )
  }
  invisible(TRUE)
}

.jdv_schema_fields <- function(schema) {
  # A schema is an extensible descriptor. Consumers ignore fields they do
  # not recognize; future optional fields such as drillable remain legal.
  for (field in c("class", "levels")) {
    if (!is.null(schema[[field]])) {
      schema[[field]] <- .jdv_json_values(schema[[field]])
    }
  }
  schema
}

.jdv_schema <- function(schemas) lapply(schemas, .jdv_schema_fields)

.jdv_json_column <- function(column, snapshot = FALSE) {
  data <- column$data
  out <- list()
  if (!is.null(data$values)) {
    out$values <- .jdv_json_values(data$values)
  }
  if (!is.null(data$display)) {
    omit <- FALSE
    if (
      column$schema$type %in% c("string", "factor", "int64") &&
        !is.null(data$values) &&
        !is.null(data$na)
    ) {
      keep <- !data$na
      omit <- identical(
        unname(data$display[keep]),
        unname(data$values[keep])
      ) &&
        all(data$display[!keep] == "NA")
    }
    if (!omit) out$display <- .jdv_json_values(data$display)
  }
  if (
    !is.null(data$sortKey) &&
      !column$schema$type %in% c("boolean", "integer", "number")
  ) {
    out$sortKey <- .jdv_json_values(data$sortKey)
  }
  if (!is.null(data$special)) {
    out$special <- .jdv_json_values(data$special)
  }
  if (!is.null(data$na)) {
    out$na <- .jdv_json_values(data$na)
  }
  if (snapshot && length(column$errors)) out$errors <- column$errors
  out
}

.jdv_page_column <- function(column) {
  list(
    schema = .jdv_schema_fields(column$schema),
    data = .jdv_json_column(column),
    errors = column$errors
  )
}

.jdv_open_content <- function(x, mode, collation, limits = list()) {
  work_limit <- if (mode == "snapshot") {
    limits$snapshot_work_bytes %||% .jdv_snapshot_work_bytes()
  } else {
    limits$page_work_bytes %||% .jdv_page_work_bytes()
  }
  work_budget <- .jdv_budget(work_limit, auto_fallback = TRUE)
  if (mode == "snapshot") {
    snapshot <- snapshot_table(
      x,
      collation = collation,
      limits = limits,
      budget = work_budget
    )
    row_names <- .jdv_explicit_row_names(x)
    return(list(
      mode = mode,
      source = NULL,
      holder = NULL,
      fingerprint = NULL,
      nrow = snapshot$nrow,
      ncol = snapshot$ncol,
      schema = snapshot$schema,
      row_names = row_names,
      data = list(
        row_index = .jdv_json_values(seq_len(snapshot$nrow)),
        row_names = if (is.null(row_names)) {
          NULL
        } else {
          .jdv_json_values(row_names)
        },
        columns = lapply(snapshot$columns, .jdv_json_column, snapshot = TRUE)
      ),
      work_used = work_budget$used,
      work_limit = work_budget$limit,
      collation = collation
    ))
  }
  holder <- paged_table(
    x,
    collation = collation,
    limits = limits,
    budget = work_budget
  )
  list(
    mode = mode,
    source = x,
    holder = holder,
    fingerprint = .jdv_fingerprint(x),
    nrow = holder$nrow,
    ncol = holder$ncol,
    schema = holder$schema,
    row_names = NULL,
    data = NULL,
    work_used = work_budget$used,
    work_limit = work_budget$limit,
    collation = collation
  )
}

.jdv_explicit_row_names <- function(x) {
  if (is.data.frame(x)) {
    if (.row_names_info(x, type = 1L) > 0L) rownames(x) else NULL
  } else {
    rownames(x)
  }
}

.jdv_descriptor <- function(content, id, generation, title) {
  params <- list(
    table = id,
    generation = generation,
    title = title,
    mode = content$mode,
    collation = content$collation,
    nrow = content$nrow,
    ncol = content$ncol,
    row_names = content$row_names,
    columns = .jdv_schema(content$schema)
  )
  if (content$mode == "snapshot") {
    params$data <- content$data
  }
  list(method = "table/open", params = params)
}

.jdv_install <- function(content, title, id, generation) {
  entry <- new.env(parent = emptyenv())
  entry$id <- id
  entry$title <- title
  entry$generation <- generation
  entry$mode <- content$mode
  entry$source <- content$source
  entry$holder <- content$holder
  entry$fingerprint <- content$fingerprint
  entry$nrow <- content$nrow
  entry$ncol <- content$ncol
  entry$schema <- content$schema
  entry$collation <- content$collation
  entry$inflight <- 0L
  entry$close_pending <- FALSE
  entry$closed <- FALSE
  .jdv_state$sequence <- .jdv_state$sequence + 1
  entry$sequence <- .jdv_state$sequence
  entry
}

.jdv_close_entry <- function(entry) {
  entry$closed <- TRUE
  if (entry$inflight > 0L) {
    entry$close_pending <- TRUE
  } else {
    if (!is.null(entry$holder) && !entry$holder$closed) {
      query_dispose(entry$holder)
    }
    entry$holder <- NULL
    entry$source <- NULL
    entry$fingerprint <- NULL
    entry$close_pending <- FALSE
  }
  invisible(NULL)
}

.jdv_close_internal <- function(id = NULL, notify = FALSE, expected = NULL) {
  ids <- if (is.null(id)) ls(.jdv_state$entries, all.names = TRUE) else id
  for (key in ids) {
    if (exists(key, envir = .jdv_state$entries, inherits = FALSE)) {
      entry <- get(key, envir = .jdv_state$entries, inherits = FALSE)
      if (!is.null(expected) && !identical(entry, expected)) {
        next
      }
      rm(list = key, envir = .jdv_state$entries)
      if (notify) {
        event <- list(
          method = "table/closed",
          params = list(table = entry$id, generation = entry$generation)
        )
        .jdv_state$outbox[[length(.jdv_state$outbox) + 1L]] <- .jdv_json_encode(
          event
        )
        outbox_limit <- max(64L, 4L * .jdv_option_limit("jdv.max_tables", 64))
        if (length(.jdv_state$outbox) > outbox_limit) {
          .jdv_state$outbox <- utils::tail(.jdv_state$outbox, outbox_limit)
        }
      }
      title_key <- if (is.null(entry$title)) {
        NULL
      } else {
        .jdv_title_key(entry$title)
      }
      if (
        !is.null(title_key) &&
          exists(title_key, envir = .jdv_state$titles, inherits = FALSE) &&
          identical(
            get(title_key, envir = .jdv_state$titles, inherits = FALSE)$id,
            entry$id
          )
      ) {
        rm(list = title_key, envir = .jdv_state$titles)
      }
      .jdv_close_entry(entry)
    }
  }
  invisible(NULL)
}

#' Register a table for a transport-independent viewer
#'
#' @param x A data frame or matrix.
#' @param title Optional title. Reusing a non-NULL title replaces its table
#'   generation; NULL titles always create independent tables.
#' @param mode One of `"auto"`, `"snapshot"`, or `"paged"`.
#' @param collation String ordering policy, `"C"` or `"locale"`. When omitted,
#'   `getOption("jdv.collation", "C")` supplies the default; an explicit
#'   argument takes precedence.
#' @details
#' Re-registering a title that is still active reuses its table ID and
#' increments its generation. Closing that table removes the title association,
#' so a later registration starts with a new ID and generation one. Re-register
#' after changing values held by a reference object because the lightweight
#' fingerprint does not detect value-only changes. Paged tables capture
#' `getOption("jdv.max_page_rows", 2000)` at registration; changing the option
#' takes effect after re-registering the table. `jdv.max_work_bytes` and
#' `jdv.max_query_rows` are unlimited by default for full sort/filter work;
#' `jdv.max_cache_bytes` defaults to 32 MiB and `jdv.snapshot_max_bytes` to 10
#' MiB. Snapshot construction, registration probes, pages, and JSON encoding
#' retain separate finite derived budgets. Auto mode also uses
#' `jdv.snapshot_max_cells` (default 10,000) and caps the snapshot byte estimate
#' by `jdv.max_message_bytes`; if Snapshot-only row-name metadata or snapshot
#' construction exceeds its budget, Auto retries registration as Paged. Page,
#' work, cache, and query-row settings are captured when a table is registered.
#' Snapshot and page work allowances are each the smaller of `INT_MAX`, six
#' times their output allowance plus 4 MiB, and a finite `jdv.max_work_bytes`
#' setting. Snapshot uses the smaller of `jdv.snapshot_max_bytes` and
#' `jdv.max_message_bytes`; page work uses `jdv.max_message_bytes`. When
#' `jdv.max_work_bytes` is finite, query work, page extraction, and response
#' encoding share that per-operation allowance. In the event-loop request path,
#' Interrupt behavior depends on R's suspension state when a transport callback
#' begins; if interrupts were already suspended, a long sort or filter may not
#' stop promptly. The viewer UI should show that R is busy. These estimates do
#' not bound total process memory, source storage, arbitrary user method
#' allocations, R allocator and GC overhead, or transient R-internal string
#' conversion and sorting scratch.
#' @return
#' A list containing a table `id`, its `open` JSON message, and any pending
#' transport notifications as JSON strings in `notifications` (for example, a
#' `table/closed` message emitted when the registry evicts an older table).
#' @export
jdv_register <- function(
  x,
  title = NULL,
  mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale")
) {
  .jdv_assert_active()
  mode <- match.arg(mode)
  if (missing(collation)) {
    collation <- getOption("jdv.collation", "C")
  }
  collation <- match.arg(collation, c("C", "locale"))
  if (!is.null(title)) {
    title <- query_string(title, 4096L)
  }
  if (!is.data.frame(x) && !is.matrix(x)) {
    query_error("invalid_request", "Expected a data frame or matrix.")
  }
  max_tables <- .jdv_option_limit("jdv.max_tables", 64)
  limits <- list(
    page_rows = .jdv_option_limit("jdv.max_page_rows", 2000),
    work_bytes = .jdv_max_work_bytes(),
    page_work_bytes = .jdv_page_work_bytes(),
    snapshot_work_bytes = .jdv_snapshot_work_bytes(),
    cache_bytes = .jdv_max_cache_bytes(),
    query_rows = .jdv_max_query_rows()
  )
  max_message <- .jdv_max_message_bytes()
  .jdv_metadata_budget(
    x,
    min(max_message, limits$page_work_bytes),
    snapshot = FALSE
  )
  actual_mode <- mode
  if (mode == "auto") {
    cells <- as.double(nrow(x)) * max(1, as.double(ncol(x)))
    snapshot_cells <- .jdv_option_limit("jdv.snapshot_max_cells", 10000, 0)
    estimate_limit <- min(max_message, .jdv_snapshot_max_bytes())
    estimate <- if (cells <= snapshot_cells) {
      .jdv_estimate_snapshot_bytes(x, cells, estimate_limit)
    } else {
      estimate_limit + 1
    }
    actual_mode <- if (cells <= snapshot_cells && estimate <= estimate_limit) {
      "snapshot"
    } else {
      "paged"
    }
  }
  if (actual_mode == "snapshot") {
    tryCatch(
      .jdv_metadata_budget(
        x,
        min(max_message, limits$snapshot_work_bytes),
        snapshot = TRUE,
        auto_fallback_row_names = mode == "auto"
      ),
      error = function(e) {
        if (mode == "auto" && isTRUE(e$details$auto_fallback)) {
          actual_mode <<- "paged"
        } else {
          stop(e)
        }
      }
    )
  }
  if (actual_mode == "snapshot" && 2 * as.double(nrow(x)) + 1 > max_message) {
    query_error(
      "limit_exceeded",
      "Snapshot row indices cannot fit within the JSON message byte limit."
    )
  }
  content <- tryCatch(
    .jdv_open_content(x, actual_mode, collation, limits),
    error = function(e) {
      if (
        mode == "auto" &&
          actual_mode == "snapshot" &&
          inherits(e, "jdv_query_error") &&
          isTRUE(e$details$auto_fallback)
      ) {
        actual_mode <<- "paged"
        .jdv_open_content(x, actual_mode, collation, limits)
      } else {
        stop(e)
      }
    }
  )
  .jdv_assert_active()
  title_key <- if (is.null(title)) NULL else .jdv_title_key(title)
  previous <- if (
    !is.null(title_key) &&
      exists(title_key, envir = .jdv_state$titles, inherits = FALSE)
  ) {
    get(title_key, envir = .jdv_state$titles, inherits = FALSE)
  } else {
    NULL
  }
  id <- if (is.null(title)) {
    paste0(
      "t-",
      format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
    )
  } else if (!is.null(previous)) {
    previous$id
  } else {
    paste0(
      "t-",
      format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
    )
  }
  generation <- if (is.null(previous)) 1 else previous$generation + 1
  descriptor <- .jdv_descriptor(content, id, generation, title)
  open <- tryCatch(
    .jdv_json_encode(
      descriptor,
      max_message,
      max(1, content$work_limit - content$work_used)
    ),
    error = function(e) {
      if (
        mode == "auto" &&
          content$mode == "snapshot" &&
          inherits(e, "jdv_query_error") &&
          identical(e$code, "limit_exceeded")
      ) {
        content <<- .jdv_open_content(x, "paged", collation, limits)
        previous <<- if (
          !is.null(title_key) &&
            exists(title_key, envir = .jdv_state$titles, inherits = FALSE)
        ) {
          get(title_key, envir = .jdv_state$titles, inherits = FALSE)
        } else {
          NULL
        }
        id <<- if (is.null(title)) {
          paste0(
            "t-",
            format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
          )
        } else if (!is.null(previous)) {
          previous$id
        } else {
          paste0(
            "t-",
            format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
          )
        }
        generation <<- if (is.null(previous)) 1 else previous$generation + 1
        descriptor <<- .jdv_descriptor(content, id, generation, title)
        .jdv_json_encode(
          descriptor,
          max_message,
          max(1, content$work_limit - content$work_used)
        )
      } else {
        stop(e)
      }
    }
  )
  .jdv_assert_active()
  old <- if (exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
    get(id, envir = .jdv_state$entries, inherits = FALSE)
  } else {
    NULL
  }
  .jdv_assert_active()
  active <- length(ls(.jdv_state$entries, all.names = TRUE))
  while (active > max_tables || (is.null(old) && active >= max_tables)) {
    candidates <- lapply(
      setdiff(ls(.jdv_state$entries, all.names = TRUE), id),
      function(key) get(key, envir = .jdv_state$entries, inherits = FALSE)
    )
    oldest <- candidates[[
      which.min(vapply(candidates, `[[`, numeric(1L), "sequence"))
    ]]
    .jdv_close_internal(oldest$id, notify = TRUE)
    .jdv_assert_active()
    active <- active - 1L
  }
  .jdv_assert_active()
  entry <- .jdv_install(content, title, id, generation)
  committed <- FALSE
  on.exit(
    if (!committed && isTRUE(.jdv_state$unloading)) {
      .jdv_close_internal(id, expected = entry)
    },
    add = TRUE
  )
  .jdv_assert_active()
  if (is.null(title)) {
    .jdv_state$next_id <- .jdv_state$next_id + 1
  }
  if (is.null(previous) && !is.null(title)) {
    .jdv_state$next_id <- .jdv_state$next_id + 1
  }
  assign(id, entry, envir = .jdv_state$entries)
  if (!is.null(title_key)) {
    assign(
      title_key,
      list(id = id, generation = generation),
      envir = .jdv_state$titles
    )
  }
  .jdv_assert_active()
  if (!is.null(old)) {
    .jdv_close_entry(old)
  }
  notifications <- if (length(.jdv_state$outbox)) {
    unname(unlist(.jdv_state$outbox, use.names = FALSE))
  } else {
    character()
  }
  .jdv_state$outbox <- list()
  .jdv_assert_active()
  committed <- TRUE
  list(id = id, open = open, notifications = notifications)
}

.jdv_fields <- function(x, allowed, required = allowed) {
  fields <- names(x)
  if (
    !is.list(x) ||
      (is.object(x) && !inherits(x, "jdv_json_object")) ||
      is.null(fields) ||
      anyNA(fields) ||
      any(!nzchar(fields)) ||
      anyDuplicated(fields) ||
      any(!required %in% fields)
  ) {
    query_error("invalid_request", "Invalid RPC object fields.")
  }
  invisible(x)
}

.jdv_request_id <- function(id) {
  if (
    is.character(id) &&
      length(id) == 1L &&
      !is.na(id) &&
      nchar(id, type = "bytes") <= 128L
  ) {
    return(id)
  }
  if (
    typeof(id) %in% c("integer", "double") &&
      !is.object(id) &&
      length(id) == 1L &&
      !is.na(id) &&
      is.finite(id) &&
      id >= 0 &&
      id == floor(id) &&
      id < 2^53
  ) {
    return(unname(id))
  }
  query_error(
    "invalid_request",
    "Request id must be a string or a safe integer."
  )
}

.jdv_id_key <- function(id) {
  paste0(
    typeof(id),
    ":",
    paste(as.integer(charToRaw(enc2utf8(as.character(id)))), collapse = "-")
  )
}

.jdv_rpc_entry <- function(id, generation) {
  if (!is.character(id) || length(id) != 1L || is.na(id)) {
    query_error("invalid_request", "Table id must be one string.")
  }
  if (!exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
    query_error("table_not_found", "Table is not registered.")
  }
  entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
  generation <- query_integer(generation, "generation", 1)
  if (generation != entry$generation) {
    query_error(
      "stale_generation",
      "The table generation is no longer current."
    )
  }
  if (entry$closed) {
    query_error("table_not_found", "Table is closed.")
  }
  entry$inflight <- entry$inflight + 1L
  entry
}

.jdv_release_entry <- function(entry) {
  entry$inflight <- entry$inflight - 1L
  if (entry$inflight == 0L && entry$close_pending) {
    .jdv_close_entry(entry)
  }
  invisible(NULL)
}

.jdv_process_request <- function(request, request_id) {
  .jdv_fields(
    request,
    c("id", "method", "params", "encoding", "compression", "deadline"),
    c("method")
  )
  method <- query_string(request$method, 128L)
  if (!is.null(request$encoding) && !identical(request$encoding, "json")) {
    query_error("unsupported", "Unsupported message encoding.")
  }
  if (
    !is.null(request$compression) && !identical(request$compression, "none")
  ) {
    query_error("unsupported", "Unsupported message compression.")
  }
  now <- as.numeric(Sys.time())
  if (!is.null(request$deadline)) {
    deadline <- request$deadline
    if (
      !typeof(deadline) %in% c("integer", "double") ||
        is.object(deadline) ||
        length(deadline) != 1L ||
        is.na(deadline) ||
        !is.finite(deadline)
    ) {
      query_error(
        "invalid_request",
        "deadline must be one finite Unix timestamp in seconds."
      )
    }
    if (deadline < now) {
      query_error("expired", "Request deadline has expired.")
    }
  }
  if (method == "wake") {
    return(NULL)
  }
  if (method == "cancel") {
    params <- request$params
    .jdv_fields(params, "id")
    invisible(.jdv_request_id(params$id))
    # Synchronous RPC has no queued request to cancel. The transport queue
    # matches this notification against pending IDs before execution.
    return(NULL)
  }
  if (is.null(request_id)) {
    query_error(
      "invalid_request",
      "Requests that expect a response need an id."
    )
  }
  params <- request$params
  if (method %in% c("table/rows", "table/schema", "table/close")) {
    .jdv_fields(
      params,
      c("table", "generation", "offset", "limit", "sort", "filter", "cols"),
      c("table", "generation")
    )
    entry <- .jdv_rpc_entry(params$table, params$generation)
    on.exit(.jdv_release_entry(entry), add = TRUE)
    if (method == "table/close") {
      current <- if (
        exists(entry$id, envir = .jdv_state$entries, inherits = FALSE)
      ) {
        get(entry$id, envir = .jdv_state$entries, inherits = FALSE)
      } else {
        NULL
      }
      if (!identical(current, entry)) {
        query_error(
          "stale_generation",
          "The table generation is no longer current."
        )
      }
      .jdv_close_internal(entry$id, expected = entry)
      return(list(
        table = entry$id,
        generation = entry$generation,
        closed = TRUE
      ))
    }
    .jdv_check_fingerprint(entry)
    if (method == "table/schema") {
      return(list(
        table = entry$id,
        generation = entry$generation,
        nrow = entry$nrow,
        ncol = entry$ncol,
        columns = .jdv_schema(entry$schema)
      ))
    }
    if (entry$mode != "paged" || is.null(entry$holder)) {
      query_error(
        "unsupported",
        "Snapshot tables are cached by the host and have no row RPC."
      )
    }
    sort <- if (is.null(params$sort)) list() else params$sort
    filter <- params$filter
    cols <- params$cols
    offset <- if (is.null(params$offset)) 0 else params$offset
    limit <- if (is.null(params$limit)) 200 else params$limit
    budget <- .jdv_budget(entry$holder$limits$page_work_bytes)
    result <- query_page(
      entry$holder,
      offset,
      limit,
      sort,
      filter,
      cols,
      budget
    )
    work_used <- budget$used
    result$data$columns <- lapply(result$data$columns, .jdv_page_column)
    output <- list(
      table = entry$id,
      generation = entry$generation,
      total = result$total,
      total_unfiltered = result$total_unfiltered,
      offset = result$offset,
      limit = result$limit,
      data = within(result$data, {
        row_index <- .jdv_json_values(row_index)
        if (!is.null(row_names)) row_names <- .jdv_json_values(row_names)
      })
    )
    attr(output, "jdv_work_budget") <- budget
    return(output)
  }
  query_error("method_not_found", "Unknown RPC method.")
}

.jdv_response <- function(
  id,
  result = NULL,
  error = NULL,
  warnings = character()
) {
  response <- list(id = id)
  if (is.null(error)) {
    response$result <- result
  } else {
    response$error <- list(
      code = error$code %||% "r_error",
      message = substr(conditionMessage(error), 1L, 1024L)
    )
    if (!is.null(error$details)) response$error$details <- error$details
  }
  response$warnings <- .jdv_json_values(warnings)
  response
}

.jdv_trim_page <- function(page, limit) {
  count <- min(as.integer(limit), length(page$data$row_index))
  take <- function(x) {
    if (is.null(x) || !(json_is_array(x) || inherits(x, "jdv_json_array"))) {
      return(x)
    }
    structure(x[seq_len(count)], class = class(x))
  }
  page$data$row_index <- take(page$data$row_index)
  page$data$row_names <- take(page$data$row_names)
  page$data$columns <- lapply(page$data$columns, function(column) {
    for (channel in names(column$data)) {
      column$data[[channel]] <- take(column$data[[channel]])
    }
    column
  })
  page$limit <- count
  page
}

`%||%` <- function(x, y) if (is.null(x)) y else x

#' Process a viewer request or poll the local transport
#'
#' With no argument or `NULL`, explicitly poll the active transport and process
#' at most the configured drain batch. This recovery path bypasses the event
#' gate and does not run reentrantly. A JSON request string is handled
#' synchronously as an embedding API and remains independent of the transport.
#' Notifications such as `wake` and `cancel` return `NULL`.
#'
#' @param request One JSON request string, or `NULL` to poll the active viewer.
#' @return A JSON response string or NULL for a notification.
#' @export
jdv_rpc <- function(request = NULL) {
  .jdv_assert_active()
  if (is.null(request)) {
    if (.jdv_state$rpc_depth > 0L) {
      stop("RPC re-entry is not supported.", call. = FALSE)
    }
    .jdv_transport_housekeeping()
    .jdv_assert_active()
    if (is.null(.jdv_state$transport)) {
      return(invisible(NULL))
    }
    .Call(C_jdv_transport_poll)
    .jdv_assert_active()
    return(invisible(NULL))
  }
  parsed <- tryCatch(.jdv_json_parse(request), error = function(e) e)
  .jdv_assert_active()
  if (inherits(parsed, "error")) {
    return(.jdv_json_encode_error(.jdv_response(NULL, error = parsed)))
  }
  request_id <- NULL
  if (is.list(parsed) && "id" %in% names(parsed)) {
    request_id <- tryCatch(.jdv_request_id(parsed$id), error = function(e) e)
    if (inherits(request_id, "error")) {
      return(.jdv_json_encode_error(.jdv_response(NULL, error = request_id)))
    }
  }
  if (.jdv_state$rpc_depth > 0L) {
    return(.jdv_json_encode_error(.jdv_response(
      request_id,
      error = structure(
        list(
          message = "RPC re-entry is not supported.",
          call = NULL,
          code = "r_error"
        ),
        class = c("jdv_rpc_error", "error", "condition")
      )
    )))
  }
  .jdv_state$rpc_depth <- .jdv_state$rpc_depth + 1L
  on.exit(.jdv_state$rpc_depth <- .jdv_state$rpc_depth - 1L, add = TRUE)
  warnings <- character()
  warning_count <- 0L
  record_warning <- function(warning) {
    warning_count <<- warning_count + 1L
    if (length(warnings) < 100L) {
      warnings <<- c(warnings, substr(conditionMessage(warning), 1L, 512L))
    }
    invokeRestart("muffleWarning")
  }
  result <- tryCatch(
    withCallingHandlers(
      .jdv_process_request(parsed, request_id),
      warning = record_warning
    ),
    interrupt = function(e) {
      structure(
        list(
          message = "Request interrupted.",
          call = NULL,
          code = "interrupted"
        ),
        class = c("jdv_rpc_error", "error", "condition")
      )
    },
    error = function(e) e
  )
  .jdv_assert_active()
  if (is.null(request_id)) {
    return(NULL)
  }
  work_budget <- if (is.list(result)) attr(result, "jdv_work_budget") else NULL
  if (is.list(result)) {
    attr(result, "jdv_work_budget") <- NULL
  }
  response <- if (inherits(result, "error")) {
    if (!inherits(result, "jdv_query_error")) {
      code <- if (!is.null(result$code)) result$code else "r_error"
      result <- structure(
        list(message = conditionMessage(result), call = NULL, code = code),
        class = c("jdv_rpc_error", "error", "condition")
      )
    }
    .jdv_response(request_id, error = result, warnings = warnings)
  } else {
    if (is.null(result)) {
      return(NULL)
    }
    .jdv_response(request_id, result = result, warnings = warnings)
  }
  if (warning_count > length(warnings)) {
    response$warnings <- .jdv_json_values(c(
      warnings,
      "Additional warnings were omitted."
    ))
  }
  encode_response <- function(value) {
    tryCatch(
      .jdv_json_encode(
        value,
        work_limit = if (is.environment(work_budget)) {
          .jdv_budget_remaining(work_budget)
        } else {
          if (inherits(result, "error")) {
            64 * 1024
          } else {
            .jdv_page_work_bytes()
          }
        }
      ),
      error = function(e) e
    )
  }
  encoded <- encode_response(response)
  if (
    inherits(encoded, "jdv_query_error") &&
      encoded$code == "limit_exceeded" &&
      !inherits(result, "error") &&
      identical(parsed$method, "table/rows") &&
      is.list(result) &&
      is.list(result$data) &&
      !is.null(result$data$row_index)
  ) {
    page_limit <- query_integer(result$limit, "limit")
    while (page_limit > 1) {
      page_limit <- max(1, floor(page_limit / 2))
      response <- .jdv_response(
        request_id,
        result = .jdv_trim_page(result, page_limit),
        warnings = warnings
      )
      if (warning_count > length(warnings)) {
        response$warnings <- .jdv_json_values(c(
          warnings,
          "Additional warnings were omitted."
        ))
      }
      encoded <- encode_response(response)
      if (!inherits(encoded, "error")) {
        return(encoded)
      }
      if (
        !inherits(encoded, "jdv_query_error") ||
          encoded$code != "limit_exceeded"
      ) {
        break
      }
    }
  }
  if (!inherits(encoded, "error")) {
    return(encoded)
  }
  limit_failure <- inherits(encoded, "jdv_query_error") &&
    identical(encoded$code, "limit_exceeded")
  fallback_code <- if (limit_failure && !inherits(result, "error")) {
    "limit_exceeded"
  } else if (
    inherits(result, "error") &&
      is.character(result$code) &&
      length(result$code) == 1L &&
      grepl("^[a-z][a-z0-9_]{0,63}$", result$code)
  ) {
    result$code
  } else {
    "r_error"
  }
  fallback_message <- if (identical(fallback_code, "limit_exceeded")) {
    "Response exceeds the byte limit."
  } else {
    "Response could not be encoded."
  }
  fallback <- .jdv_response(
    request_id,
    error = structure(
      list(message = fallback_message, code = fallback_code),
      class = c("jdv_rpc_error", "error", "condition")
    )
  )
  .jdv_json_encode_error(fallback)
}

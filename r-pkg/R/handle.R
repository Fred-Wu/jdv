# Private state for handles is separate from the viewer registry.
.jdv_handle_registry <- local({
  state <- new.env(parent = emptyenv())
  state$next_id <- 0
  state
})

.jdv_handle_id <- function(root) {
  .jdv_handle_registry$next_id <- .jdv_handle_registry$next_id + 1
  root$sequence <- root$sequence + 1
  paste0(
    "h-",
    format(.jdv_handle_registry$next_id, scientific = FALSE, trim = TRUE)
  )
}

.jdv_handle_finalizer <- function(object) .jdv_handle_close_state(object$state)

.jdv_handle_wrapper <- function(state, parent = NULL) {
  handle <- new.env(parent = emptyenv())
  handle$state <- state
  # Keeping the parent wrapper alive also keeps its finalizer from closing a
  # live child's ancestry.
  handle$parent <- parent
  class(handle) <- "jdv_handle"
  reg.finalizer(handle, .jdv_handle_finalizer, onexit = TRUE)
  handle
}

.jdv_handle_state <- function(handle, allow_closed = FALSE) {
  if (
    !is.environment(handle) ||
      !inherits(handle, "jdv_handle") ||
      !exists("state", envir = handle, inherits = FALSE) ||
      !is.environment(handle$state)
  ) {
    jdv_abort("invalid_argument", "handle must be a jdv_handle object.")
  }
  state <- handle$state
  if (!allow_closed && isTRUE(state$closed)) {
    query_error("view_not_found", "The handle is closed.")
  }
  state
}

.jdv_handle_state_close <- function(state) {
  if (isTRUE(state$closed)) {
    return(invisible(NULL))
  }
  state$closed <- TRUE
  children <- state$children
  state$children <- list()
  for (child in children) {
    .jdv_handle_state_close(child)
  }
  entry <- state$entry
  if (!is.null(entry)) {
    if (entry$inflight > 0L) {
      entry$closed <- TRUE
      entry$close_pending <- TRUE
    } else {
      .jdv_handle_release_entry(entry)
      state$entry <- NULL
    }
  }
  invisible(NULL)
}

.jdv_handle_release_entry <- function(entry) {
  .jdv_close_entry(entry)
  entry$data <- NULL
  entry$row_names <- NULL
  invisible(NULL)
}

.jdv_handle_check_source <- function(entry) {
  if (!identical(entry$mode, "tree")) {
    .jdv_check_fingerprint(entry)
  }
  invisible(NULL)
}

.jdv_handle_close_state <- function(state) {
  try(.jdv_handle_state_close(state), silent = TRUE)
  invisible(NULL)
}

.jdv_handle_new_state <- function(entry, root, parent = NULL) {
  state <- new.env(parent = emptyenv())
  state$entry <- entry
  state$root <- root
  state$parent <- parent
  state$children <- list()
  state$closed <- FALSE
  state$inflight <- 0L
  state
}

.jdv_handle_assert_current <- function(state, check_busy = TRUE) {
  cursor <- state
  while (!is.null(cursor)) {
    if (isTRUE(cursor$closed) || is.null(cursor$entry)) {
      query_error(
        "view_not_found",
        "The handle or one of its parents is closed."
      )
    }
    cursor <- cursor$parent
  }
  if (check_busy && state$inflight > 0L) {
    query_error("in_use", "A request is already running for this handle.")
  }
  invisible(NULL)
}

.jdv_handle_validate_max_bytes <- function(max_bytes) {
  if (
    !is.numeric(max_bytes) ||
      is.object(max_bytes) ||
      length(max_bytes) != 1L ||
      !is.null(dim(max_bytes)) ||
      is.na(max_bytes) ||
      !is.finite(max_bytes) ||
      max_bytes != floor(max_bytes) ||
      max_bytes < 1 ||
      max_bytes > .Machine$integer.max
  ) {
    jdv_abort(
      "invalid_argument",
      "max_bytes must be one positive finite integer."
    )
  }
  min(as.double(max_bytes), .jdv_max_message_bytes())
}

.jdv_handle_encode <- function(
  value,
  max_bytes,
  work_limit = .jdv_page_work_bytes()
) {
  .jdv_json_encode(value, limit = max_bytes, work_limit = work_limit)
}

.jdv_handle_descriptor_value <- function(entry) {
  if (identical(entry$mode, "tree")) {
    descriptor <- .jdv_tree_descriptor(
      entry$id,
      entry$generation,
      entry$title,
      parent = entry$parent_entry,
      value = entry$tree_value,
      reason = if (is.null(entry$parent_entry)) "register" else "child"
    )
  } else {
    descriptor <- .jdv_descriptor(
      list(
        mode = entry$mode,
        collation = entry$collation,
        nrow = entry$nrow,
        ncol = entry$ncol,
        row_names = entry$row_names,
        schema = entry$schema,
        data = entry$data
      ),
      entry$id,
      entry$generation,
      entry$title,
      if (is.null(entry$parent_entry)) "register" else "child"
    )
  }
  params <- descriptor$params
  params$view <- entry$id
  params$generation <- entry$generation
  if (!is.null(entry$parent_entry)) {
    params$parent <- entry$parent_entry$id
    params$path <- jdv_json_array()
  }
  if (!is.null(params$capabilities)) {
    params$capabilities$refresh <- FALSE
    params$capabilities$track <- FALSE
  }
  params
}

.jdv_handle_install_grid <- function(
  x,
  mode,
  collation,
  id,
  parent_entry = NULL,
  title = NULL,
  sequence = 0
) {
  built <- .jdv_grid_content(x, mode, collation)
  content <- built$content
  # Handles keep a source even for snapshots so every operation can check the
  # schema fingerprint while the snapshot payload remains fixed.
  content$source <- x
  content$fingerprint <- .jdv_fingerprint(x)
  entry <- .jdv_install(
    content,
    title = NULL,
    id = id,
    generation = 1,
    captured = x,
    intent = list(mode = mode, collation = collation),
    sequence = sequence
  )
  entry$title <- title
  entry$parent_entry <- parent_entry
  entry$parent <- if (is.null(parent_entry)) NULL else parent_entry$id
  entry$children <- character()
  entry$row_names <- content$row_names
  entry$data <- content$data
  entry
}

.jdv_handle_install <- function(
  x,
  mode,
  collation,
  root,
  parent_state = NULL,
  parent_wrapper = NULL,
  title = NULL
) {
  .jdv_assert_active()
  source <- jdv_source(x)
  if (identical(source$access, "sequential")) {
    query_error(
      "unsupported",
      "Sequential sources are not supported by handles."
    )
  }
  id <- .jdv_handle_id(root)
  if (identical(source$kind, "grid")) {
    entry <- .jdv_handle_install_grid(
      source$data,
      mode,
      collation,
      id,
      if (is.null(parent_state)) NULL else parent_state$entry,
      title,
      root$sequence
    )
  } else {
    if (is.null(parent_state) && !is.list(x)) {
      query_error(
        "unsupported",
        "Root handles support data frames, matrices, and lists."
      )
    }
    entry <- .jdv_tree_new_entry(
      source$data,
      id,
      1,
      title,
      parent = if (is.null(parent_state)) NULL else parent_state$entry,
      sequence = root$sequence
    )
    entry$intent_mode <- mode
    entry$intent_collation <- collation
  }
  if (!is.null(parent_state)) {
    tryCatch(
      .jdv_handle_assert_current(parent_state, check_busy = FALSE),
      error = function(error) {
        .jdv_handle_release_entry(entry)
        stop(error)
      }
    )
    if (
      .jdv_tree_descendant_count_handle(parent_state$root$handle_state) >=
        .jdv_tree_children_limit
    ) {
      .jdv_handle_release_entry(entry)
      query_error(
        "limit_exceeded",
        "Handle lineage already has the maximum number of descendants."
      )
    }
  }
  state <- .jdv_handle_new_state(entry, root, parent_state)
  wrapper <- .jdv_handle_wrapper(state, parent_wrapper)
  if (is.null(parent_state)) {
    root$handle_state <- state
  } else {
    parent_state$children[[length(parent_state$children) + 1L]] <- state
  }
  wrapper
}

#' Create an isolated jdv handle
#'
#' A handle captures a data frame, matrix, or list for local queries. Handle
#' queries do not use the viewer registry, its table limit, or the notification
#' queue, and they work whether or not a viewer connection or embedded session
#' exists. Handles do not track variable bindings or refresh values. Recreate a
#' handle after changing the captured object. A handle is valid only in the
#' current R session; saving it, moving it to another process, or serializing
#' and restoring it is not supported. Treat the returned environment as opaque.
#'
#' [jdv_handle_descriptor()] returns the JSON descriptor that corresponds to the
#' parameters of a normal `view/open` message. A Snapshot descriptor contains
#' the complete captured table and does not support `grid/rows`. Use
#' `mode = "paged"` when queries should return bounded row pages.
#'
#' [jdv_handle_request()] accepts `"grid/rows"` for paged table handles and
#' `"object/children"` for list handles. Its `params` argument is a named list
#' using the corresponding protocol parameters: `offset`, `limit`, `sort`,
#' `filter`, and zero-based `cols` for rows; or typed `path`, `offset`, `limit`,
#' and `attributes` for children. The handle supplies `view` and `generation`
#' itself, so callers must not include those fields. Other methods signal
#' `method_not_found`; use [jdv_handle_open()] to create a child handle.
#'
#' `max_bytes` limits the encoded JSON result. When a row or child page is too
#' large, jdv reduces its number of rows or children until the result fits. It
#' does not remove selected columns. A descriptor is never truncated; if it does
#' not fit, the call signals `limit_exceeded`. Snapshot descriptors include all
#' table data, so use a paged handle for a bounded preview. The limit must be a
#' positive integer number of bytes and counts the UTF-8 JSON string, not R
#' attributes.
#'
#' A child opened with [jdv_handle_open()] captures the selected value at that
#' path. Closing a handle closes its children; closing a child leaves its parent
#' and siblings open. Keeping a child alive also keeps its parent alive. Garbage
#' collection closes unreachable handles. Table handles check their captured
#' schema on each operation and signal `schema_changed` if dimensions, column
#' names, or column classes change. They do not detect value-only changes or
#' follow rebinding of the original variable. They retain their source for this
#' check even when the descriptor is a Snapshot. Sequential sources, including
#' Arrow and Polars sources, signal `unsupported`. A closed handle signals
#' `view_not_found`; closing an already closed handle succeeds. A root handle
#' can have at most 32 live descendants at once.
#'
#' [jdv_handle_register()] registers the captured value as a regular view. It
#' uses the captured value directly, without resolving the handle's path again.
#' The handle's mode and collation intent are used when those arguments are
#' `NULL` (the default). The returned view has its own lifetime and does not
#' track a variable binding.
#'
#' The JSON strings returned by descriptor and request operations contain the
#' result object only, without an RPC envelope. Errors are raised as jdv
#' conditions; see [jdv_errors]. For example, a child handle can be opened at a
#' list element with a typed path:
#'
#' ```
#' tree <- jdv_handle(list(items = list(answer = 42L)))
#' child <- jdv_handle_open(tree, list(list(type = "index", index = 1L)))
#' child_descriptor <- jdv_handle_descriptor(child)
#' jdv_handle_close(child)
#' jdv_handle_close(tree)
#' ```
#'
#' @param x A data frame, matrix, or list.
#' @param mode For [jdv_handle()], the table mode: `"auto"`, `"snapshot"`, or
#'   `"paged"`. The default `"auto"` uses the same selection rules as
#'   [jdv_register()]. For [jdv_handle_register()], an explicit mode overrides
#'   the handle's original intent; `NULL` (the default) inherits that intent.
#' @param collation For [jdv_handle()], the table collation: `"C"` or
#'   `"locale"`; by default the value of the `jdv.collation` option, or `"C"`
#'   when unset. Lists do not use this setting. For [jdv_handle_register()], an
#'   explicit value overrides the handle's original intent; `NULL` (the default)
#'   inherits that intent.
#' @param handle A handle returned by [jdv_handle()] or [jdv_handle_open()].
#' @param title Optional title for a view registered from a handle. If omitted,
#'   or `NULL`, the handle's title is reused.
#' @param max_bytes Maximum encoded JSON result size in bytes. The effective
#'   maximum is also bounded by `jdv.max_message_bytes`.
#' @param method Either `"grid/rows"` or `"object/children"`.
#' @param params A named list of parameters for `method`.
#' @param path A non-empty typed object path as used by `object/open`.
#' @return
#' [jdv_handle()] and [jdv_handle_open()] return a `jdv_handle` object.
#' [jdv_handle_register()] returns the same `id` and `generation` list as
#' [jdv_register()]. [jdv_handle_descriptor()] and [jdv_handle_request()] return
#' a length-one JSON string. [jdv_handle_close()] returns `invisible(NULL)`.
#' @examples
#' handle <- jdv_handle(mtcars, mode = "paged")
#' descriptor <- jdv_handle_descriptor(handle)
#' preview <- jdv_handle_request(
#'   handle,
#'   "grid/rows",
#'   list(offset = 0L, limit = 10L, cols = 0:3),
#'   max_bytes = 64 * 1024
#' )
#' jdv_handle_close(handle)
#' @seealso [jdv_spec], [jdv_errors]
#' @export
jdv_handle <- function(
  x,
  mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale")
) {
  .jdv_assert_active()
  mode <- if (missing(mode)) {
    "auto"
  } else {
    .jdv_match_arg(mode, c("auto", "snapshot", "paged"), "mode")
  }
  collation <- if (missing(collation)) {
    getOption("jdv.collation", "C")
  } else {
    .jdv_match_arg(collation, c("C", "locale"), "collation")
  }
  collation <- .jdv_match_arg(collation, c("C", "locale"), "collation")
  root <- new.env(parent = emptyenv())
  root$sequence <- 0
  .jdv_handle_install(x, mode, collation, root)
}

#' @rdname jdv_handle
#' @export
jdv_handle_register <- function(
  handle,
  title = NULL,
  mode = NULL,
  collation = NULL
) {
  .jdv_assert_active()
  state <- .jdv_handle_state(handle)
  .jdv_handle_assert_current(state)
  entry <- state$entry
  mode <- if (is.null(mode)) {
    entry$intent_mode %||% "auto"
  } else {
    .jdv_match_arg(mode, c("auto", "snapshot", "paged"), "'mode'")
  }
  collation <- if (is.null(collation)) {
    entry$intent_collation
  } else {
    .jdv_match_arg(collation, c("C", "locale"), "'collation'")
  }
  if (!is.null(title)) {
    title <- query_string(title, 4096L)
  } else {
    title <- entry$title
  }
  state$inflight <- state$inflight + 1L
  entry$inflight <- entry$inflight + 1L
  on.exit(
    {
      entry$inflight <- max(0L, entry$inflight - 1L)
      state$inflight <- max(0L, state$inflight - 1L)
      if (isTRUE(entry$close_pending) && entry$inflight == 0L) {
        .jdv_handle_release_entry(entry)
        state$entry <- NULL
      }
    },
    add = TRUE
  )
  .jdv_handle_check_source(entry)
  .jdv_handle_assert_current(state, check_busy = FALSE)
  value <- if (identical(entry$mode, "tree")) {
    entry$tree_value
  } else {
    entry$captured
  }
  registered <- .jdv_register_internal(
    value,
    title,
    mode,
    collation,
    tracking = NULL
  )
  .jdv_assert_active()
  if (
    identical(.jdv_session_owner(), "transport") && .jdv_state$rpc_depth == 0L
  ) {
    .jdv_transport_flush()
  }
  list(id = registered$id, generation = registered$generation)
}

#' @rdname jdv_handle
#' @export
jdv_handle_descriptor <- function(
  handle,
  max_bytes = getOption("jdv.max_message_bytes", 10 * 1024^2)
) {
  .jdv_assert_active()
  state <- .jdv_handle_state(handle)
  .jdv_handle_assert_current(state)
  max_bytes <- .jdv_handle_validate_max_bytes(max_bytes)
  entry <- state$entry
  state$inflight <- state$inflight + 1L
  entry$inflight <- entry$inflight + 1L
  on.exit(
    {
      state$inflight <- max(0L, state$inflight - 1L)
      entry$inflight <- max(0L, entry$inflight - 1L)
      if (isTRUE(entry$close_pending) && entry$inflight == 0L) {
        .jdv_handle_release_entry(entry)
        state$entry <- NULL
      }
    },
    add = TRUE
  )
  .jdv_handle_check_source(entry)
  .jdv_handle_assert_current(state, check_busy = FALSE)
  encoded <- tryCatch(
    .jdv_handle_encode(.jdv_handle_descriptor_value(entry), max_bytes),
    jdv_error = function(error) {
      if (identical(error$details$kind, "output")) {
        query_error("limit_exceeded", "Handle descriptor exceeds max_bytes.")
      }
      stop(error)
    }
  )
  .jdv_handle_assert_current(state, check_busy = FALSE)
  encoded
}

#' @rdname jdv_handle
#' @export
jdv_handle_request <- function(
  handle,
  method,
  params = list(),
  max_bytes = getOption("jdv.max_message_bytes", 10 * 1024^2)
) {
  .jdv_assert_active()
  state <- .jdv_handle_state(handle)
  .jdv_handle_assert_current(state)
  if (
    !is.character(method) ||
      is.object(method) ||
      !is.null(dim(method)) ||
      length(method) != 1L ||
      is.na(method) ||
      !nzchar(method)
  ) {
    jdv_abort("invalid_argument", "method must be one non-empty string.")
  }
  if (!method %in% c("grid/rows", "object/children")) {
    query_error(
      "method_not_found",
      "Use jdv_handle_open() to open a child handle."
    )
  }
  max_bytes <- .jdv_handle_validate_max_bytes(max_bytes)
  if (identical(params, list())) {
    names(params) <- character()
    params <- jdv_json_object(params)
  }
  if (
    !is.list(params) ||
      (is.object(params) && !inherits(params, "jdv_json_object")) ||
      is.null(names(params)) ||
      anyNA(names(params)) ||
      any(!nzchar(names(params))) ||
      anyDuplicated(names(params))
  ) {
    query_error("invalid_request", "params must be a named list.")
  }
  if (any(names(params) %in% c("view", "generation"))) {
    query_error(
      "invalid_request",
      "view and generation are supplied by the handle."
    )
  }
  if (method == "grid/rows" && identical(state$entry$mode, "tree")) {
    query_error("unsupported", "grid/rows requires a table handle.")
  }
  if (method == "object/children" && !identical(state$entry$mode, "tree")) {
    query_error("unsupported", "object/children requires a tree handle.")
  }
  state$inflight <- state$inflight + 1L
  entry <- state$entry
  entry$inflight <- entry$inflight + 1L
  on.exit(
    {
      entry$inflight <- max(0L, entry$inflight - 1L)
      state$inflight <- max(0L, state$inflight - 1L)
      if (isTRUE(entry$close_pending) && entry$inflight == 0L) {
        .jdv_handle_release_entry(entry)
        state$entry <- NULL
      }
    },
    add = TRUE
  )
  .jdv_handle_check_source(entry)
  full_params <- c(list(view = entry$id, generation = entry$generation), params)
  if (method == "grid/rows") {
    result <- .jdv_request_table_rows(entry, full_params)
    .jdv_handle_assert_current(state, check_busy = FALSE)
    budget <- attr(result, "jdv_work_budget", exact = TRUE)
    attr(result, "jdv_work_budget") <- NULL
    while (TRUE) {
      encoded <- tryCatch(
        .jdv_handle_encode(
          result,
          max_bytes,
          if (is.null(budget)) {
            .jdv_page_work_bytes()
          } else {
            max(1, budget$limit - budget$used)
          }
        ),
        error = function(error) error
      )
      if (!inherits(encoded, "error")) {
        .jdv_handle_assert_current(state, check_busy = FALSE)
        return(encoded)
      }
      if (
        !inherits(encoded, "jdv_error") ||
          !identical(encoded$details$kind, "output")
      ) {
        stop(encoded)
      }
      count <- length(result$data$source_row)
      if (count <= 1L) {
        query_error("limit_exceeded", "A row page cannot fit within max_bytes.")
      }
      result <- .jdv_trim_page(result, max(1L, floor(count / 2)))
    }
  }
  result <- .jdv_request_object_children(entry, full_params)
  .jdv_handle_assert_current(state, check_busy = FALSE)
  while (TRUE) {
    encoded <- tryCatch(
      .jdv_handle_encode(result, max_bytes),
      error = function(error) error
    )
    if (!inherits(encoded, "error")) {
      .jdv_handle_assert_current(state, check_busy = FALSE)
      return(encoded)
    }
    if (
      !inherits(encoded, "jdv_error") ||
        !identical(encoded$details$kind, "output")
    ) {
      stop(encoded)
    }
    count <- length(result$children)
    if (count <= 1L) {
      query_error("limit_exceeded", "A child page cannot fit within max_bytes.")
    }
    count <- max(1L, floor(count / 2))
    result$children <- structure(
      result$children[seq_len(count)],
      class = class(result$children)
    )
  }
}

#' @rdname jdv_handle
#' @export
jdv_handle_open <- function(
  handle,
  path,
  mode = c("auto", "snapshot", "paged"),
  collation = c("C", "locale")
) {
  .jdv_assert_active()
  state <- .jdv_handle_state(handle)
  .jdv_handle_assert_current(state)
  mode <- if (missing(mode)) {
    "auto"
  } else {
    .jdv_match_arg(mode, c("auto", "snapshot", "paged"), "mode")
  }
  collation <- if (missing(collation)) {
    getOption("jdv.collation", "C")
  } else {
    .jdv_match_arg(collation, c("C", "locale"), "collation")
  }
  collation <- .jdv_match_arg(collation, c("C", "locale"), "collation")
  entry <- state$entry
  state$inflight <- state$inflight + 1L
  entry$inflight <- entry$inflight + 1L
  on.exit(
    {
      state$inflight <- max(0L, state$inflight - 1L)
      entry$inflight <- max(0L, entry$inflight - 1L)
      if (isTRUE(entry$close_pending) && entry$inflight == 0L) {
        .jdv_handle_release_entry(entry)
        state$entry <- NULL
      }
    },
    add = TRUE
  )
  .jdv_handle_check_source(entry)
  resolved_path <- .jdv_resolve_object_path(entry, path)
  .jdv_handle_assert_current(state, check_busy = FALSE)
  if (!length(resolved_path$path)) {
    query_error("invalid_request", "object/open requires a non-empty path.")
  }
  if (
    .jdv_tree_descendant_count_handle(state$root$handle_state) >=
      .jdv_tree_children_limit
  ) {
    query_error(
      "limit_exceeded",
      "Handle lineage already has the maximum number of descendants."
    )
  }
  value <- resolved_path$resolved$value
  source <- jdv_source(value)
  if (identical(source$access, "sequential")) {
    query_error(
      "unsupported",
      "Sequential sources are not supported by handles."
    )
  }
  .jdv_handle_assert_current(state, check_busy = FALSE)
  title <- .jdv_child_title(entry, resolved_path$path, resolved_path$resolved)
  .jdv_handle_install(
    value,
    mode,
    collation,
    state$root,
    state,
    parent_wrapper = handle,
    title = title
  )
}

.jdv_tree_descendant_count_handle <- function(state) {
  children <- Filter(function(child) !isTRUE(child$closed), state$children)
  state$children <- children
  if (!length(children)) {
    return(0L)
  }
  sum(vapply(
    children,
    function(child) 1L + .jdv_tree_descendant_count_handle(child),
    integer(1L)
  ))
}

#' @rdname jdv_handle
#' @export
jdv_handle_close <- function(handle) {
  state <- .jdv_handle_state(handle, allow_closed = TRUE)
  .jdv_handle_state_close(state)
  invisible(NULL)
}

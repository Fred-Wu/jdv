.jdv_tree_path_limit <- 32L
.jdv_tree_page_limit <- 500L
.jdv_tree_text_limit <- 1000L
.jdv_tree_children_limit <- 32L

.jdv_tree_info <- function(x) .Call(C_jdv_tree_info, x)

.jdv_tree_names <- function(x) {
  tryCatch(.Call(C_jdv_tree_names, x), error = function(error) character())
}

.jdv_tree_vector_names <- function(x, indices) {
  if (!length(indices)) {
    return(character())
  }
  .Call(C_jdv_tree_vector_names, x, as.double(indices[[1L]]), length(indices))
}

.jdv_tree_storage_type <- function(info) {
  if (identical(info$type, "s4")) info$storage_type else info$type
}

.jdv_tree_step <- function(step) {
  if (is.list(step) && "kind" %in% names(step)) {
    query_error(
      "invalid_request",
      "Cell steps are only allowed first in grid paths."
    )
  }
  .jdv_fields(step, c("type", "index", "name"), "type")
  type <- query_string(step$type, 16L)
  if (identical(type, "index")) {
    .jdv_fields(step, c("type", "index"), c("type", "index"))
    index <- query_integer(step$index, "path index", 1)
    return(list(type = type, index = index))
  }
  if (type %in% c("binding", "slot", "attr")) {
    .jdv_fields(step, c("type", "name"), c("type", "name"))
    name <- query_string(step$name, .jdv_tree_text_limit)
    return(list(type = type, name = name))
  }
  query_error("invalid_request", "Unknown typed tree path step.")
}

.jdv_tree_path <- function(path) {
  if (
    !is.list(path) ||
      (is.object(path) && !inherits(path, "jdv_json_array")) ||
      !is.null(names(path)) ||
      length(path) > .jdv_tree_path_limit
  ) {
    query_error("invalid_request", "Tree path must be a bounded array.")
  }
  lapply(path, .jdv_tree_step)
}

.jdv_tree_same_reference <- function(x, y) {
  info <- .jdv_tree_info(x)
  isTRUE(info$reference) && isTRUE(.Call(C_jdv_tree_same, x, y))
}

.jdv_tree_ancestry <- function(entry) {
  values <- list(entry$tree_value)
  parent <- entry$parent_entry
  while (!is.null(parent)) {
    values[[length(values) + 1L]] <- parent$tree_value
    parent <- parent$parent_entry
  }
  values
}

.jdv_tree_resolve <- function(root, path, ancestry = list()) {
  value <- root
  seen <- c(list(root), ancestry)
  for (step in path) {
    kind <- step$type
    index <- if (identical(kind, "index")) step$index else 0L
    name <- if (!identical(kind, "index")) step$name else ""
    found <- tryCatch(
      .Call(C_jdv_tree_child, value, kind, index, name),
      error = function(error) {
        list(status = "error", value = NULL, message = conditionMessage(error))
      }
    )
    if (
      !identical(found$status, "value") && !identical(found$status, "forced")
    ) {
      return(list(status = found$status, value = NULL, seen = seen))
    }
    value <- found$value
    if (
      any(vapply(
        seen,
        function(previous) .jdv_tree_same_reference(value, previous),
        logical(1L)
      ))
    ) {
      return(list(status = "cycle", value = NULL, seen = seen))
    }
    seen[[length(seen) + 1L]] <- value
  }
  list(status = "value", value = value, seen = seen)
}

.jdv_tree_class <- function(info) {
  klass <- info$class
  if (!length(klass)) {
    klass <- if (isTRUE(info$is_matrix)) {
      c("matrix", "array")
    } else if (isTRUE(info$is_array)) {
      "array"
    } else {
      switch(
        info$type,
        double = "numeric",
        closure = "function",
        builtin = "function",
        special = "function",
        null = "NULL",
        symbol = "name",
        language = "call",
        info$type
      )
    }
  }
  klass <- lapply(
    as.list(klass),
    function(item) {
      if (is.na(item)) "" else enc2utf8(substr(item, 1L, .jdv_tree_text_limit))
    }
  )
  .jdv_json_values(klass)
}

.jdv_tree_scalar_preview <- function(x) {
  if (
    !isTRUE(
      .jdv_tree_info(x)$type %in%
        c("logical", "integer", "double", "complex", "character", "raw")
    )
  ) {
    return(NULL)
  }
  info <- .jdv_tree_info(x)
  n <- as.integer(min(5, max(0, info$length)))
  if (!n) {
    return(character())
  }
  vapply(
    seq_len(n),
    function(i) {
      scalar <- .Call(C_jdv_tree_child, x, "index", as.double(i), "")
      if (!identical(scalar$status, "value")) {
        return("<unavailable>")
      }
      text <- .Call(C_jdv_tree_scalar_text, scalar$value)
      if (length(text) != 1L || is.na(text)) {
        "NA"
      } else {
        enc2utf8(substr(text, 1L, 160L))
      }
    },
    character(1L),
    USE.NAMES = FALSE
  )
}

.jdv_tree_summary <- function(x, depth = 0L) {
  info <- .jdv_tree_info(x)
  type <- info$type
  count <- if (identical(type, "environment")) {
    length(base::ls(envir = x, all.names = TRUE))
  } else {
    max(0, info$length)
  }
  class_text <- if (length(info$class)) {
    paste(
      vapply(
        info$class,
        function(item) {
          if (is.na(item)) "" else substr(item, 1L, .jdv_tree_text_limit)
        },
        character(1L)
      ),
      collapse = "/"
    )
  } else {
    type
  }
  preview <- if (depth < 3L) .jdv_tree_scalar_preview(x) else NULL
  text <- paste0(class_text, " (", format(count, scientific = FALSE), ")")
  if (!is.null(preview) && length(preview)) {
    text <- paste0(text, ": ", paste(preview, collapse = ", "))
  }
  enc2utf8(substr(text, 1L, .jdv_tree_text_limit))
}

.jdv_tree_child_names <- function(x, type) {
  if (identical(type, "environment")) {
    return(base::ls(envir = x, all.names = TRUE))
  }
  if (identical(type, "s4")) {
    return(.jdv_tree_names(x))
  }
  if (type %in% c("list", "expression", "pairlist", "dots")) {
    count <- .jdv_tree_info(x)$length
    if (count <= 0 || count > .Machine$integer.max) {
      return(character())
    }
    return(as.character(seq_len(as.integer(count))))
  }
  if (
    type %in% c("logical", "integer", "double", "complex", "character", "raw")
  ) {
    count <- .jdv_tree_info(x)$length
    if (count <= 0 || count > .Machine$integer.max) {
      return(character())
    }
    return(as.character(seq_len(as.integer(count))))
  }
  .jdv_tree_names(x)
}

.jdv_tree_total <- function(x, type) {
  if (identical(type, "environment")) {
    return(length(base::ls(envir = x, all.names = TRUE)))
  }
  info <- .jdv_tree_info(x)
  storage_type <- .jdv_tree_storage_type(info)
  if (
    storage_type %in%
      c(
        "list",
        "expression",
        "pairlist",
        "dots",
        "logical",
        "integer",
        "double",
        "complex",
        "character",
        "raw"
      )
  ) {
    n <- info$length
    if (n < 0) {
      query_error(
        "limit_exceeded",
        "Pairlist is cyclic or exceeds the safe traversal limit."
      )
    }
    return(n + length(.jdv_tree_names(x)))
  }
  length(.jdv_tree_names(x))
}

.jdv_tree_step_for <- function(x, type, label, index) {
  if (identical(type, "environment")) {
    return(list(type = "binding", name = label))
  }
  if (identical(type, "s4")) {
    return(list(type = "slot", name = label))
  }
  list(type = "attr", name = label)
}

.jdv_tree_list_children <- function(x, path, offset, limit, ancestry = list()) {
  info <- .jdv_tree_info(x)
  storage_type <- .jdv_tree_storage_type(info)
  base_length <- max(0, info$length)
  total <- .jdv_tree_total(x, info$type)
  start <- min(offset, total)
  indices <- if (start >= total || limit == 0L) {
    integer()
  } else {
    seq.int(start + 1L, min(total, start + limit))
  }
  labels <- if (identical(info$type, "environment")) {
    names <- .jdv_tree_child_names(x, info$type)
    if (!length(indices)) character() else names[indices]
  } else if (
    storage_type %in%
      c(
        "list",
        "expression",
        "pairlist",
        "dots",
        "logical",
        "integer",
        "double",
        "complex",
        "character",
        "raw"
      )
  ) {
    attr_names <- .jdv_tree_names(x)
    vector_names <- tryCatch(
      .jdv_tree_vector_names(x, indices[indices <= base_length]),
      error = function(error) character()
    )
    if (!length(indices)) character() else vapply(
      indices,
      function(i) {
        if (i <= base_length) {
          if (length(vector_names) == length(indices[indices <= base_length])) {
            candidate <- vector_names[[
              match(i, indices[indices <= base_length])
            ]]
            if (!is.na(candidate)) return(candidate)
          }
          paste0("[", i, "]")
        } else {
          attr_names[[i - base_length]]
        }
      },
      character(1L),
      USE.NAMES = FALSE
    )
  } else {
    names <- .jdv_tree_child_names(x, info$type)
    if (!length(indices)) character() else names[indices]
  }
  children <- lapply(indices, function(i) {
    label <- labels[[i - start]]
    indexed <- storage_type %in%
      c(
        "list",
        "expression",
        "pairlist",
        "dots",
        "logical",
        "integer",
        "double",
        "complex",
        "character",
        "raw"
      ) &&
      i <= base_length
    step <- if (indexed) {
      list(type = "index", index = i)
    } else {
      .jdv_tree_step_for(x, info$type, label, i)
    }
    child_path <- c(path, list(step))
    name_too_long <- !identical(step$type, "index") &&
      nchar(step$name, type = "chars") > .jdv_tree_text_limit
    got <- if (name_too_long) {
      list(status = "unavailable", value = NULL)
    } else {
      tryCatch(
        .Call(
          C_jdv_tree_child,
          x,
          step$type,
          if (identical(step$type, "index")) as.double(step$index) else 0,
          if (!identical(step$type, "index")) step$name else ""
        ),
        error = function(error) list(status = "error", value = NULL)
      )
    }
    unavailable <- if (
      identical(got$status, "value") || identical(got$status, "forced")
    ) {
      NULL
    } else {
      switch(
        got$status,
        unavailable = if (name_too_long) "path_limit" else "unavailable",
        delayed = "delayed_binding",
        active = "active_binding",
        missing = "missing_binding",
        unbound = "unavailable",
        s4_data_opaque = "opaque_data_slot",
        promise = "promise",
        error = "unavailable",
        "unavailable"
      )
    }
    child_value <- got$value
    child_info <- NULL
    cycle <- is.null(unavailable) &&
      any(vapply(
        c(ancestry, list(x)),
        function(previous) .jdv_tree_same_reference(child_value, previous),
        logical(1L)
      ))
    if (cycle) {
      unavailable <- "cycle"
    }
    summary <- unavailable
    has_children <- FALSE
    if (is.null(unavailable)) {
      metadata <- tryCatch(
        {
          child_info <- .jdv_tree_info(child_value)
          list(
            summary = .jdv_tree_summary(child_value, length(child_path)),
            has_children = length(child_path) < .jdv_tree_path_limit &&
              .jdv_tree_total(child_value, child_info$type) > 0L
          )
        },
        error = function(error) NULL
      )
      if (is.null(metadata)) {
        unavailable <- "unavailable"
        summary <- unavailable
        child_info <- NULL
      } else {
        summary <- metadata$summary
        has_children <- metadata$has_children
      }
    }
    child <- list(
      index = as.double(i),
      label = enc2utf8(substr(label, 1L, .jdv_tree_text_limit)),
      class = if (is.null(child_info)) {
        .jdv_json_values(list())
      } else {
        .jdv_tree_class(child_info)
      },
      summary = enc2utf8(substr(summary, 1L, .jdv_tree_text_limit)),
      has_children = has_children,
      viewable = is.null(unavailable)
    )
    if (!name_too_long) {
      child$path <- .jdv_json_values(lapply(child_path, jdv_json_object))
    }
    if (!is.null(unavailable)) child$unavailable <- unavailable
    child
  })
  list(
    children = .jdv_json_values(lapply(children, jdv_json_object)),
    total_children = as.double(total)
  )
}

.jdv_tree_entry_is_current <- function(entry) {
  exists(entry$id, envir = .jdv_state$entries, inherits = FALSE) &&
    identical(
      get(entry$id, envir = .jdv_state$entries, inherits = FALSE),
      entry
    ) &&
    !entry$closed
}

.jdv_tree_descendant_count <- function(entry) {
  ids <- entry$children %||% character()
  total <- 0L
  for (id in ids) {
    if (!exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
      next
    }
    child <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    if (
      isTRUE(child$closed) ||
        !identical(child$parent_entry, entry) ||
        !identical(child$parent_generation, entry$generation)
    ) {
      next
    }
    total <- total + 1L + .jdv_tree_descendant_count(child)
  }
  total
}

.jdv_tree_descriptor <- function(id, generation, title, parent = NULL) {
  capabilities <- stats::setNames(
    as.list(c(TRUE, FALSE, FALSE, TRUE, FALSE, TRUE, TRUE)),
    c("seek", "sort", "filter", "known_total", "next", "children", "refresh")
  )
  params <- list(
    view = id,
    kind = "tree",
    access = "random",
    encoding = "r-json",
    capabilities = jdv_json_object(capabilities),
    generation = generation,
    title = title,
    path = jdv_json_array()
  )
  if (!is.null(parent)) {
    params$parent <- parent$id
  }
  list(method = "view/open", params = jdv_json_object(params))
}

.jdv_tree_new_entry <- function(x, id, generation, title, parent = NULL) {
  entry <- new.env(parent = emptyenv())
  entry$id <- id
  entry$title <- title
  entry$generation <- generation
  entry$mode <- "tree"
  entry$source <- x
  entry$tree_value <- x
  entry$captured <- x
  entry$holder <- NULL
  entry$fingerprint <- NULL
  entry$nrow <- NULL
  entry$ncol <- NULL
  entry$schema <- NULL
  entry$collation <- NULL
  entry$parent <- if (is.null(parent)) NULL else parent$id
  entry$parent_entry <- parent
  entry$parent_generation <- if (is.null(parent)) NULL else parent$generation
  entry$children <- character()
  entry$inflight <- 0L
  entry$close_pending <- FALSE
  entry$closed <- FALSE
  .jdv_state$sequence <- .jdv_state$sequence + 1
  entry$sequence <- .jdv_state$sequence
  entry
}

.jdv_tree_register <- function(x, title = NULL, parent = NULL) {
  .jdv_assert_active()
  if (!is.null(title)) {
    title <- query_string(title, 4096L)
  }
  title_key <- if (is.null(title)) NULL else .jdv_title_key(title)
  previous <- if (
    !is.null(title_key) &&
      exists(title_key, envir = .jdv_state$titles, inherits = FALSE)
  ) {
    get(title_key, envir = .jdv_state$titles, inherits = FALSE)
  } else {
    NULL
  }
  id <- if (!is.null(previous)) {
    previous$id
  } else {
    paste0(
      "v-",
      format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
    )
  }
  generation <- if (is.null(previous)) 1 else previous$generation + 1
  if (!is.null(parent)) {
    if (!.jdv_tree_entry_is_current(parent)) {
      query_error("view_not_found", "Parent view is no longer active.")
    }
    if (
      .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
        .jdv_tree_children_limit
    ) {
      query_error(
        "limit_exceeded",
        "Parent view already has the maximum number of children."
      )
    }
  }
  descriptor <- .jdv_tree_descriptor(id, generation, title, parent)
  open <- .jdv_json_encode(descriptor, .jdv_max_message_bytes())
  .jdv_assert_active()

  if (
    !is.null(previous) &&
      exists(id, envir = .jdv_state$entries, inherits = FALSE)
  ) {
    old <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    .jdv_close_children(old, notify = TRUE)
    .jdv_close_entry(old)
  }
  pins <- character()
  cursor <- parent
  while (!is.null(cursor)) {
    pins <- c(pins, cursor$id)
    cursor <- cursor$parent_entry
  }
  max_tables <- .jdv_option_limit("jdv.max_tables", 64)
  active <- length(ls(.jdv_state$entries, all.names = TRUE))
  while (
    active >= max_tables &&
      !exists(id, envir = .jdv_state$entries, inherits = FALSE)
  ) {
    candidates <- lapply(
      setdiff(ls(.jdv_state$entries, all.names = TRUE), c(id, pins)),
      function(key) get(key, envir = .jdv_state$entries, inherits = FALSE)
    )
    if (!length(candidates)) {
      query_error(
        "limit_exceeded",
        "No unpinned view can be evicted for this child."
      )
    }
    oldest <- candidates[[
      which.min(vapply(candidates, `[[`, numeric(1L), "sequence"))
    ]]
    .jdv_close_internal(oldest$id, notify = TRUE)
    active <- length(ls(.jdv_state$entries, all.names = TRUE))
  }
  .jdv_assert_active()
  if (!is.null(parent) && !.jdv_tree_entry_is_current(parent)) {
    query_error(
      "view_not_found",
      "Parent view was closed while opening the child."
    )
  }

  entry <- .jdv_tree_new_entry(x, id, generation, title, parent)
  if (is.null(previous)) {
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
  if (!is.null(parent)) {
    if (
      !.jdv_tree_entry_is_current(parent) ||
        !identical(parent$generation, entry$parent_generation) ||
        .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
          .jdv_tree_children_limit
    ) {
      .jdv_close_internal(id, expected = entry)
      query_error(
        "view_not_found",
        "Parent view changed while opening the child."
      )
    }
    parent$children <- c(parent$children, id)
  }
  list(id = id, generation = generation, open = open, descriptor = descriptor)
}

.jdv_tree_register_child <- function(
  x,
  parent,
  mode = "auto",
  collation = NULL
) {
  .jdv_assert_not_refreshing()
  if (!.jdv_tree_entry_is_current(parent)) {
    query_error("view_not_found", "Parent view is no longer active.")
  }
  if (
    .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
      .jdv_tree_children_limit
  ) {
    query_error(
      "limit_exceeded",
      "Parent view already has the maximum number of children."
    )
  }
  source <- jdv_source(x)
  if (identical(source$kind, "tree")) {
    return(.jdv_tree_register(source$data, parent = parent))
  }

  old_pins <- .jdv_state$eviction_pins
  cursor <- parent
  while (!is.null(cursor)) {
    .jdv_state$eviction_pins <- unique(c(.jdv_state$eviction_pins, cursor$id))
    cursor <- cursor$parent_entry
  }
  on.exit(.jdv_state$eviction_pins <- old_pins, add = TRUE)
  registered <- .jdv_register_internal(
    x,
    title = NULL,
    mode = mode,
    collation = collation,
    emit = FALSE
  )
  child <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
  committed <- FALSE
  on.exit(
    if (!committed) .jdv_close_internal(child$id, expected = child),
    add = TRUE
  )
  if (
    !.jdv_tree_entry_is_current(parent) ||
      .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
        .jdv_tree_children_limit
  ) {
    query_error(
      "view_not_found",
      "Parent view changed while opening the child."
    )
  }
  child$parent <- parent$id
  child$parent_entry <- parent
  child$parent_generation <- parent$generation
  child$children <- character()
  child$path <- list()
  parsed <- .jdv_json_parse(
    registered$open,
    limit = max(1024, .jdv_max_message_bytes())
  )
  parsed$params$parent <- parent$id
  parsed$params$path <- jdv_json_array()
  registered$open <- .jdv_json_encode(parsed)
  if (
    !.jdv_tree_entry_is_current(parent) ||
      !identical(parent$generation, child$parent_generation)
  ) {
    query_error(
      "view_not_found",
      "Parent view changed while opening the child."
    )
  }
  parent$children <- c(parent$children, child$id)
  committed <- TRUE
  registered
}

.jdv_tree_lineage_root <- function(entry) {
  cursor <- entry
  repeat {
    if (!.jdv_tree_entry_is_current(cursor)) {
      query_error("view_not_found", "Parent lineage is no longer active.")
    }
    parent <- cursor$parent_entry
    if (is.null(parent)) {
      return(cursor)
    }
    if (!identical(cursor$parent_generation, parent$generation)) {
      query_error("stale_generation", "Parent lineage generation changed.")
    }
    cursor <- parent
  }
}

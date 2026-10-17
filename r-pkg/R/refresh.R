# Registrations and refreshes must not interleave: user methods run while a
# replacement is built, and a second registry mutation then could not be
# reconciled. close and disconnect stay allowed and are re-checked at commit.
.jdv_assert_not_refreshing <- function() {
  if (isTRUE(.jdv_state$refreshing)) {
    query_error(
      "in_use",
      "A view refresh is in progress; register or refresh after it completes."
    )
  }
  invisible(NULL)
}

# Build the descriptor and its JSON for a rebuilt grid. An automatic mode falls
# back to Paged when the Snapshot message does not fit, as registration does.
.jdv_refresh_grid_open <- function(
  content,
  built,
  x,
  mode,
  collation,
  id,
  generation,
  title,
  parent
) {
  describe <- function(content) {
    descriptor <- .jdv_descriptor(content, id, generation, title)
    if (!is.null(parent)) {
      descriptor$params$parent <- parent$id
      descriptor$params$path <- jdv_json_array()
    }
    descriptor
  }
  encode <- function(content, descriptor) {
    .jdv_json_encode(
      descriptor,
      built$max_message,
      max(1, content$work_limit - content$work_used)
    )
  }
  descriptor <- describe(content)
  open <- tryCatch(
    encode(content, descriptor),
    error = function(e) {
      if (
        mode == "auto" &&
          content$mode == "snapshot" &&
          inherits(e, "jdv_query_error") &&
          identical(e$code, "limit_exceeded")
      ) {
        content <<- .jdv_open_content(x, "paged", collation, built$limits)
        descriptor <<- describe(content)
        encode(content, descriptor)
      } else {
        stop(e)
      }
    }
  )
  list(content = content, open = open)
}

# Rebuild one view from `value` and publish it as the next generation of the
# same id. This is the single update transaction: manual view/refresh uses it
# with the captured value, and tracked updates can pass a current value.
#
# Nothing in the registry changes until the replacement is complete and the
# entry, generation, and parent are re-checked. A close or disconnect issued
# by a user method during construction is honored; the closed view is not
# revived. Returns the view/refresh result.
.jdv_update_view <- function(entry, value, mode, collation) {
  .jdv_assert_active()
  .jdv_assert_not_refreshing()
  if (identical(entry$mode, "sequential")) {
    query_error(
      "unsupported",
      "Sequential views cannot be refreshed because a stream cannot be rewound."
    )
  }
  id <- entry$id
  previous <- entry$generation
  generation <- previous + 1
  title <- entry$title
  parent <- entry$parent_entry
  parent_generation <- entry$parent_generation
  session <- .jdv_state$session_counter
  check_current <- function() {
    .jdv_assert_active()
    current <- if (exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
      get(id, envir = .jdv_state$entries, inherits = FALSE)
    } else {
      NULL
    }
    if (
      is.null(current) ||
        isTRUE(entry$closed) ||
        !identical(.jdv_state$session_counter, session) ||
        identical(.jdv_session_owner(), "none")
    ) {
      query_error("view_not_found", "The view was closed while refreshing.")
    }
    if (!identical(current, entry) || !identical(entry$generation, previous)) {
      query_error(
        "stale_generation",
        "The table generation changed while refreshing."
      )
    }
    if (
      !is.null(parent) &&
        (!.jdv_tree_entry_is_current(parent) ||
          !identical(parent$generation, parent_generation))
    ) {
      query_error(
        "view_not_found",
        "Parent view changed while refreshing the child."
      )
    }
    invisible(NULL)
  }
  check_current()

  .jdv_state$refreshing <- TRUE
  on.exit(.jdv_state$refreshing <- FALSE, add = TRUE)
  source <- jdv_source(value)
  .jdv_assert_active()
  value <- source$data
  if (identical(source$access, "sequential")) {
    query_error(
      "unsupported",
      "Sequential sources cannot be refreshed because a stream cannot be rewound."
    )
  }
  if (identical(source$kind, "tree")) {
    descriptor <- .jdv_tree_descriptor(id, generation, title, parent)
    open <- .jdv_json_encode(descriptor, .jdv_max_message_bytes())
    replacement <- .jdv_tree_new_entry(value, id, generation, title, parent)
  } else {
    collation_intent <- collation
    if (is.null(collation)) {
      collation <- getOption("jdv.collation", "C")
    }
    collation <- match.arg(collation, c("C", "locale"))
    mode <- mode %||% "auto"
    built <- .jdv_grid_content(value, mode, collation)
    .jdv_assert_active()
    prepared <- .jdv_refresh_grid_open(
      built$content,
      built,
      value,
      mode,
      collation,
      id,
      generation,
      title,
      parent
    )
    open <- prepared$open
    replacement <- .jdv_install(
      prepared$content,
      title,
      id,
      generation,
      captured = value,
      intent = list(mode = mode, collation = collation_intent)
    )
    replacement$children <- character()
    if (!is.null(parent)) {
      replacement$parent <- parent$id
      replacement$parent_entry <- parent
      replacement$parent_generation <- parent_generation
      replacement$path <- list()
    }
  }
  committed <- FALSE
  on.exit(if (!committed) .jdv_close_entry(replacement), add = TRUE)
  result <- list(
    view = id,
    previous_generation = previous,
    generation = generation,
    refreshed = TRUE
  )
  check_current()

  assign(id, replacement, envir = .jdv_state$entries)
  committed <- TRUE
  if (!is.null(title)) {
    title_key <- .jdv_title_key(title)
    if (
      exists(title_key, envir = .jdv_state$titles, inherits = FALSE) &&
        identical(
          get(title_key, envir = .jdv_state$titles, inherits = FALSE)$id,
          id
        )
    ) {
      assign(
        title_key,
        list(id = id, generation = generation),
        envir = .jdv_state$titles
      )
    }
  }
  # Publish the replacement before releasing the old generation. Releasing
  # children or the old entry can run stream callbacks, and a callback that
  # closes the refreshed view must queue its view/closed after this view/open
  # so the host never keeps a generation R no longer has. The old parent
  # generation gets no view/closed because the new view/open supersedes it;
  # its children then close deepest first with parent_closed. A notification
  # overflow ends the session mid-way; the old generation is still released.
  released <- FALSE
  on.exit(
    if (!released) {
      try(.jdv_close_children(entry, notify = FALSE), silent = TRUE)
      try(.jdv_close_entry(entry), silent = TRUE)
    },
    add = TRUE
  )
  .jdv_notify(open)
  .jdv_close_children(entry, notify = TRUE)
  .jdv_close_entry(entry)
  released <- TRUE
  result
}

# Manual view/refresh: rebuild from the value captured at registration.
.jdv_refresh_view <- function(entry) {
  .jdv_update_view(
    entry,
    entry$captured,
    entry$intent_mode,
    entry$intent_collation
  )
}

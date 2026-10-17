# Snapshot and restore the notification session so a test file cannot leak
# queued messages or an embedded session into the next one.
save_notification_session <- function() {
  state <- .jdv_state
  list(
    queue = state$queue,
    queue_bytes = state$queue_bytes,
    queue_max_messages = state$queue_max_messages,
    queue_max_bytes = state$queue_max_bytes,
    embedded = state$embedded
  )
}

restore_notification_session <- function(saved) {
  state <- .jdv_state
  state$queue <- saved$queue
  state$queue_bytes <- saved$queue_bytes
  state$queue_max_messages <- saved$queue_max_messages
  state$queue_max_bytes <- saved$queue_max_bytes
  state$embedded <- saved$embedded
  invisible(NULL)
}

# Register a value for an embedded host and return the id, generation, the
# view/open message for that view as `open`, and any other notifications
# (excluding hello) as `notifications`.
register_view <- function(...) {
  registered <- jdv_register(...)
  messages <- if (identical(.jdv_session_owner(), "embedded")) {
    jdv_notifications()
  } else {
    character()
  }
  parsed <- lapply(messages, .jdv_json_parse, limit = .jdv_max_message_bytes())
  is_open <- vapply(
    parsed,
    function(message) {
      identical(message$method, "view/open") &&
        identical(message$params$view, registered$id)
    },
    logical(1L)
  )
  is_hello <- vapply(
    parsed,
    function(message) identical(message$method, "hello"),
    logical(1L)
  )
  open <- messages[is_open]
  c(
    registered,
    list(
      open = if (length(open)) open[[length(open)]] else NULL,
      notifications = messages[!is_open & !is_hello]
    )
  )
}

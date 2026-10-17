notification_methods <- function(messages) {
  vapply(
    messages,
    function(message) .jdv_json_parse(message)$method,
    "",
    USE.NAMES = FALSE
  )
}

notification_views <- function(messages) {
  vapply(
    messages,
    function(message) .jdv_json_parse(message)$params$view %||% NA_character_,
    "",
    USE.NAMES = FALSE
  )
}

refresh_json <- function(view, generation = NULL, extra = list()) {
  params <- c(
    list(
      view = if (is.list(view)) view$id else view,
      generation = generation %||% view$generation
    ),
    extra
  )
  request <- list(id = "refresh-1", method = "view/refresh", params = params)
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

refresh_open <- function(view, path) {
  request <- list(
    id = "open-1",
    method = "object/open",
    params = list(view = view$id, generation = view$generation, path = path)
  )
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

refresh_new_session <- function(.env = parent.frame()) {
  jdv_disconnect()
  withr::defer(jdv_disconnect(), envir = .env)
  invisible(NULL)
}

refresh_entry <- function(id) {
  get(id, envir = .jdv_state$entries, inherits = FALSE)
}

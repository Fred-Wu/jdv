.onLoad <- function(libname, pkgname) {
  if (!isTRUE(.Call(C_jdv_transport_can_unload))) {
    stop(
      "A previous jdv transport callback is still shutting down.",
      call. = FALSE
    )
  }
}

.onUnload <- function(libpath) {
  .jdv_state$unloading <- TRUE
  .jdv_transport_housekeeping()
  .Call(C_jdv_transport_close)
  .jdv_transport_remove_task_callback()
  .jdv_close_internal(notify = FALSE)
  .jdv_state$outbox <- list()
  .jdv_state$transport <- NULL
  .jdv_state$transport_hello <- FALSE
  if (!isTRUE(.Call(C_jdv_transport_can_unload))) {
    warning(
      paste(
        "The jdv native library remains loaded while native calls are active;",
        "an idle reload/unload can release it later."
      ),
      call. = FALSE
    )
    return(invisible(NULL))
  }
  library.dynam.unload("jdv", libpath)
}

transport_pty <- new.env(parent = emptyenv())

transport_pty_marker <- function(value) {
  cat("JDV_PTY|", value, "\n", sep = "")
  flush.console()
}

format.transport_pty_column <- function(x, ...) {
  if (length(x) <= 32L) {
    transport_pty$probe_max <- max(transport_pty$probe_max, length(x))
    return(rep("probe", length(x)))
  }

  transport_pty$calls <- transport_pty$calls + 1L
  transport_pty$active <- transport_pty$active + 1L
  transport_pty$max_active <- max(
    transport_pty$max_active,
    transport_pty$active
  )
  call <- transport_pty$calls
  transport_pty_marker(paste0("METHOD_BEGIN|", length(x), "|", call))
  on.exit(
    {
      transport_pty$active <- transport_pty$active - 1L
      transport_pty_marker(paste0("METHOD_EXIT|", call))
    },
    add = TRUE
  )

  if (transport_pty$scenario == "interrupt" && call == 1L) {
    Sys.sleep(1.5)
  }
  if (transport_pty$scenario == "reentry") {
    Sys.sleep(0.4)
  }
  if (transport_pty$scenario == "close") {
    invisible(jdv_close())
    transport_pty$closed_in_method <- TRUE
  }

  paste0("value-", unclass(x))
}

transport_pty_open <- function(address, scenario) {
  stopifnot(is.character(address), length(address) == 1L, nzchar(address))
  options(jdv.address = address)
  transport_pty$scenario <- scenario
  transport_pty$calls <- 0L
  transport_pty$probe_max <- 0L
  transport_pty$active <- 0L
  transport_pty$max_active <- 0L
  transport_pty$closed_in_method <- FALSE
  values <- structure(
    seq_len(256L),
    class = c("transport_pty_column", "numeric")
  )
  id <- jdv_view(
    data.frame(value = values),
    title = "transport PTY probe",
    mode = "paged"
  )
  transport_pty$id <- id
  invisible(id)
}

transport_pty_report <- function(path) {
  writeLines(
    jsonlite::toJSON(
      list(
        calls = transport_pty$calls,
        probe_max = transport_pty$probe_max,
        max_active = transport_pty$max_active,
        closed_in_method = transport_pty$closed_in_method,
        transport = getFromNamespace(".jdv_transport_status", "jdv")()
      ),
      auto_unbox = TRUE,
      null = "null"
    ),
    path
  )
  transport_pty_marker("REPORT_DONE")
  invisible(NULL)
}

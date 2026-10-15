# Binary values are private handler results, never public RPC return values.
.jdv_binary_integer <- function(value, name, minimum = 0) {
  value <- query_integer(value, name, minimum)
  if (value >= 2^53) {
    query_error("invalid_request", paste0(name, " must be a safe integer."))
  }
  value
}

.jdv_binary_result <- function(metadata, payload) {
  if (
    !is.list(metadata) ||
      is.object(metadata) ||
      is.null(names(metadata)) ||
      anyNA(names(metadata)) ||
      any(!nzchar(names(metadata))) ||
      anyDuplicated(names(metadata)) ||
      "transfer" %in% names(metadata) ||
      typeof(payload) != "raw" ||
      is.object(payload)
  ) {
    query_error("invalid_request", "Invalid binary result metadata or payload.")
  }
  metadata$transfer <- list(
    encoding = "arrow-ipc",
    byte_length = as.double(length(payload))
  )
  structure(
    list(metadata = metadata, payload = payload),
    class = "jdv_binary_result"
  )
}

.jdv_binary_body_cap <- function(params) {
  cap <- max(0, min(.jdv_max_message_bytes(), 10 * 1024^2) - (64 * 1024 + 4))
  if ("max_bytes" %in% names(params)) {
    cap <- min(cap, .jdv_binary_integer(params$max_bytes, "max_bytes"))
  }
  cap
}

.jdv_binary_packet <- function(result, request, request_id, warnings) {
  if (!identical(names(result), c("metadata", "payload"))) {
    query_error("invalid_request", "Invalid binary result fields.")
  }
  metadata <- result$metadata
  payload <- result$payload
  if (!is.list(metadata) || typeof(payload) != "raw" || is.object(payload)) {
    query_error("invalid_request", "Invalid binary result payload.")
  }
  params <- request$params
  if (
    !is.list(params) ||
      !is.character(params$view) ||
      length(params$view) != 1L ||
      is.na(params$view) ||
      !nzchar(params$view) ||
      !identical(metadata$view, params$view)
  ) {
    query_error(
      "invalid_request",
      "Binary result view does not match its request."
    )
  }
  generation <- .jdv_binary_integer(params$generation, "generation", 1)
  if (.jdv_binary_integer(metadata$generation, "generation", 1) != generation) {
    query_error(
      "invalid_request",
      "Binary result generation does not match its request."
    )
  }
  n <- as.double(length(payload))
  transfer <- metadata$transfer
  if (
    !is.list(transfer) ||
      !identical(names(transfer), c("encoding", "byte_length")) ||
      !identical(transfer$encoding, "arrow-ipc") ||
      .jdv_binary_integer(transfer$byte_length, "byte_length") != n
  ) {
    query_error("invalid_request", "Invalid binary transfer declaration.")
  }
  whole_cap <- min(.jdv_max_message_bytes(), 10 * 1024^2)
  raw_cap <- .jdv_binary_body_cap(params)
  if (n > raw_cap) {
    query_error("limit_exceeded", "Binary payload exceeds the byte limit.")
  }
  header <- .jdv_json_encode(
    .jdv_response(request_id, result = metadata, warnings = warnings),
    limit = min(64 * 1024, whole_cap - n - 4)
  )
  structure(
    list(header = header, payload = payload),
    class = "jdv_binary_packet"
  )
}

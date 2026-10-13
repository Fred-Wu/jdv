args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) {
  stop("usage: export-numbers.R OUTPUT_DIRECTORY", call. = FALSE)
}

output_directory <- args[[1L]]
dir.create(output_directory, recursive = TRUE, showWarnings = FALSE)
encode <- getFromNamespace(".jdv_json_encode", "jdv")

set.seed(20261013)
bits <- as.raw(sample.int(256L, 8L * 100000L, replace = TRUE) - 1L)
connection <- rawConnection(bits, open = "rb")
values <- readBin(
  connection,
  what = double(),
  n = length(bits) %/% 8L,
  size = 8L,
  endian = .Platform$endian
)
close(connection)
values <- values[is.finite(values) & values != 0]

writeLines(
  encode(structure(values, class = "jdv_json_array")),
  file.path(output_directory, "numbers.json"),
  useBytes = TRUE
)
writeBin(
  values,
  file.path(output_directory, "expected-little-endian.bin"),
  size = 8L,
  endian = "little"
)

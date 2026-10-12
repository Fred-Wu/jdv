# Run from the repository root; the package copy is generated, never hand edited.
args <- commandArgs(trailingOnly = TRUE)
root <- normalizePath(if (length(args)) args[[1L]] else ".", mustWork = TRUE)
source <- file.path(root, "spec", "query-fixtures.json")
target <- file.path(root, "r-pkg", "inst", "spec", "query-fixtures.json")
if (!file.exists(source)) {
  stop("Canonical query fixture was not found.")
}
dir.create(dirname(target), recursive = TRUE, showWarnings = FALSE)
if (!file.copy(source, target, overwrite = TRUE)) {
  stop("Could not copy the fixture.")
}
stopifnot(identical(
  readBin(source, "raw", n = file.info(source)$size),
  readBin(target, "raw", n = file.info(target)$size)
))

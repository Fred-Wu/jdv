root <- normalizePath(file.path(getwd(), "r-pkg"), mustWork = TRUE)
if (!file.exists(file.path(root, "DESCRIPTION"))) {
  stop("Run this script from the repository root.", call. = FALSE)
}
devtools::test(root, filter = "transport")

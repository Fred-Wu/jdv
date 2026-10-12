# Run from the repository root; build and check artifacts live outside the source tree.
pkg <- normalizePath("r-pkg", mustWork = TRUE)
work <- tempfile("jdv-check-")
dir.create(work)
message("Validation directory: ", work)

devtools::document(pkg)
devtools::test(pkg, stop_on_failure = TRUE)
tarball <- devtools::build(pkg, path = work)
result <- devtools::check_built(
  tarball,
  check_dir = work,
  cran = TRUE,
  incoming = FALSE,
  remote = FALSE,
  error_on = "warning"
)
print(result)

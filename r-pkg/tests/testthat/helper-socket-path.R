# macOS sockaddr_un permits at most 103 path bytes. Keep socket endpoints out
# of nested R CMD check tempdirs; other evidence files can use normal tempdir().
jdv_test_uds_directory <- function() {
  root <- if (.Platform$OS.type == "windows") tempdir() else "/tmp"
  directory <- tempfile("jdv-", tmpdir = root)
  if (!dir.create(directory, mode = "0700")) {
    stop("Could not create a short Unix socket test directory.")
  }
  directory
}

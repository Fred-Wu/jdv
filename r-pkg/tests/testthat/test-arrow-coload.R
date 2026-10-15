# Keep both namespaces loaded for the remainder of this test process.
test_that("Arrow and nanoarrow coexist with the table registry", {
  skip_if_not_installed("arrow")
  skip_if_not_installed("nanoarrow")
  loadNamespace("arrow")
  loadNamespace("nanoarrow")
  table <- arrow::arrow_table(x = 1:3)
  expect_equal(as.data.frame(table), data.frame(x = 1:3))
  registered <- jdv_register(data.frame(x = 1:3), mode = "snapshot")
  on.exit(.jdv_close_internal(registered$id, notify = FALSE), add = TRUE)
  expect_type(registered$open, "character")
  expect_length(registered$open, 1L)
  expect_true(all(c("jdv", "arrow", "nanoarrow") %in% names(getLoadedDLLs())))
})

test_that("bundled native libraries have no conflicting exported symbols", {
  skip_on_cran()
  skip_if_not(identical(Sys.info()[["sysname"]], "Linux"))
  skip_if_not_installed("arrow")
  skip_if_not_installed("nanoarrow")
  nm <- Sys.which("nm")
  skip_if(!nzchar(nm), "ELF symbol inspection requires nm")
  loadNamespace("arrow")
  loadNamespace("nanoarrow")
  dlls <- getLoadedDLLs()
  exported <- function(name) {
    lines <- system2(
      nm,
      c("-D", "--defined-only", shQuote(dlls[[name]][["path"]])),
      stdout = TRUE,
      stderr = TRUE
    )
    expect_null(attr(lines, "status"))
    fields <- strsplit(trimws(lines[nzchar(trimws(lines))]), "[[:space:]]+")
    unique(sub(
      "@.*$",
      "",
      vapply(fields, function(x) utils::tail(x, 1L), character(1L))
    ))
  }
  own <- exported("jdv")
  expect_contains(own, "R_init_jdv")
  expect_true(all(own %in% c("R_init_jdv", "R_unload_jdv")))
  expect_length(intersect(own, exported("arrow")), 0L)
  expect_length(intersect(own, exported("nanoarrow")), 0L)
})

test_that("the native library registers no callable routines", {
  dll <- getLoadedDLLs()[["jdv"]]
  expect_s3_class(dll, "DLLInfo")
  expect_false(dll[["dynamicLookup"]])
  expect_length(getDLLRegisteredRoutines(dll)[[".Call"]], 0L)
  expect_error(getNativeSymbolInfo("cJSON_Version", PACKAGE = "jdv"))
})

test_that("the package can unload and load repeatedly in a fresh session", {
  skip_if(
    !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
    "Native unload/load requires an installed package"
  )
  result <- callr::r(
    function() {
      for (i in seq_len(3L)) {
        loadNamespace("jdv")
        stopifnot("jdv" %in% names(getLoadedDLLs()))
        unloadNamespace("jdv")
        stopifnot(!"jdv" %in% names(getLoadedDLLs()))
      }
      TRUE
    },
    libpath = .libPaths()
  )
  expect_true(result)
})

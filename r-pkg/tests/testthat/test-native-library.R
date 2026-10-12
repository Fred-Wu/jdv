test_that("the native library registers only its private integer64 routines", {
  dll <- getLoadedDLLs()[["jdv"]]
  expect_s3_class(dll, "DLLInfo")
  expect_false(dll[["dynamicLookup"]])
  expect_setequal(
    names(getDLLRegisteredRoutines(dll)[[".Call"]]),
    paste0(
      "C_jdv_int64_",
      c("is_na", "values", "rank", "order", "eq", "between")
    )
  )
  expect_error(.Call("C_jdv_int64_values", int64_fixture("1"), PACKAGE = "jdv"))
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

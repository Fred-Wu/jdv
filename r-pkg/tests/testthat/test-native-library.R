test_that("the native library registers only its private routines", {
  dll <- getLoadedDLLs()[["jdv"]]
  expect_s3_class(dll, "DLLInfo")
  expect_false(dll[["dynamicLookup"]])
  expect_setequal(
    names(getDLLRegisteredRoutines(dll)[[".Call"]]),
    c(
      paste0(
        "C_jdv_int64_",
        c("is_na", "values", "rank", "order", "eq", "between")
      ),
      paste0(
        "C_jdv_arrow_",
        c(
          "move",
          "schema",
          "next",
          "close",
          "info",
          "cleanup",
          "status",
          "open",
          "page"
        )
      ),
      "C_jdv_json_parse",
      "C_jdv_json_encode",
      paste0(
        "C_jdv_tree_",
        c("info", "child", "same", "scalar_text", "names", "vector_names")
      ),
      paste0(
        "C_jdv_transport_",
        c(
          "connect",
          "send",
          "poll",
          "close",
          "status",
          "can_unload",
          "housekeeping",
          "cleanup"
        )
      )
    )
  )
  expect_identical(names(getDLLRegisteredRoutines(dll)[[".C"]]), "R_unload_jdv")
  expect_identical(
    getDLLRegisteredRoutines(dll)[[".C"]][["R_unload_jdv"]][["numParameters"]],
    1L
  )
  expect_identical(
    getDLLRegisteredRoutines(dll)[[".Call"]][["C_jdv_json_encode"]][[
      "numParameters"
    ]],
    3L
  )
  expect_true(.Call(C_jdv_transport_can_unload))
  expect_error(.Call("C_jdv_int64_values", int64_fixture("1"), PACKAGE = "jdv"))
  expect_error(getNativeSymbolInfo("cJSON_Version", PACKAGE = "jdv"))
})

test_that("the registered unload hook is safe to call repeatedly", {
  dll <- getLoadedDLLs()[["jdv"]]
  unload_hook <- getDLLRegisteredRoutines(dll)[[".C"]][["R_unload_jdv"]]

  expect_no_error(.C(unload_hook, 0L))
  expect_true(.Call(C_jdv_transport_can_unload))
  expect_no_error(.C(unload_hook, 0L))
  expect_true(.Call(C_jdv_transport_can_unload))
})

test_that("the package can unload and load repeatedly in a fresh session", {
  skip_on_cran()
  skip_if_not_installed("callr")
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

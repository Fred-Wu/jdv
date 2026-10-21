test_that("tree index extraction preserves class formatting attributes", {
  values <- list(
    instant = as.POSIXct(
      c("2020-01-02 03:04:05", "2020-01-03 04:05:06"),
      tz = "Pacific/Auckland"
    ),
    duration = structure(c(60, 120), class = "difftime", units = "mins"),
    category = factor(c("a", "b"), levels = c("a", "b"))
  )

  for (value in values) {
    extracted <- .Call(C_jdv_tree_child, value, "index", 2, "")
    expect_identical(extracted$status, "value")
    expect_identical(class(extracted$value), class(value))
    for (attribute in setdiff(names(attributes(value)), "class")) {
      expect_identical(
        attr(extracted$value, attribute),
        attr(value, attribute),
        info = paste("attribute", attribute)
      )
    }
  }

  named <- structure(1:2, names = c("one", "two"), marker = "kept")
  extracted <- .Call(C_jdv_tree_child, named, "index", 1, "")
  expect_identical(attr(extracted$value, "marker"), "kept")
  expect_null(names(extracted$value))

  matrix_value <- structure(
    matrix(1:4, nrow = 2, dimnames = list(c("r1", "r2"), c("c1", "c2"))),
    marker = "kept"
  )
  matrix_element <- .Call(C_jdv_tree_child, matrix_value, "index", 2, "")
  expect_identical(attr(matrix_element$value, "marker"), "kept")
  expect_null(dim(matrix_element$value))
  expect_null(dimnames(matrix_element$value))

  for (name in names(values)) {
    expected <- switch(
      name,
      instant = list(
        class = "POSIXct/POSIXt",
        text = c("2020-01-02 03:04:05", "2020-01-03 04:05:06")
      ),
      duration = list(class = "difftime", text = c("60 mins", "120 mins")),
      category = list(class = "factor", text = c("a", "b"))
    )
    root <- register_view(list(values = values[[name]]))
    on.exit(.jdv_close_internal(root$id), add = TRUE)
    child_page <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
      id = 1,
      method = "object/children",
      params = list(
        view = root$id,
        generation = 1,
        path = list(),
        limit = 10,
        attributes = FALSE
      )
    ))))$result
    expect_identical(
      child_page$children[[1]]$summary,
      paste0(expected$class, " (2): ", paste(expected$text, collapse = ", "))
    )

    opened_vector <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
      id = 2,
      method = "object/open",
      params = list(
        view = root$id,
        generation = 1,
        path = list(list(type = "index", index = 1))
      )
    ))))$result
    expect_identical(unlist(opened_vector$class), class(values[[name]]))

    element_page <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
      id = 3,
      method = "object/children",
      params = list(
        view = opened_vector$view,
        generation = opened_vector$generation,
        path = list(),
        limit = 10,
        attributes = FALSE
      )
    ))))$result
    expect_length(element_page$children, 2)
    expect_identical(
      vapply(element_page$children, `[[`, "", "summary"),
      paste0(expected$class, " (1): ", expected$text)
    )

    opened_scalar <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
      id = 4,
      method = "object/open",
      params = list(
        view = root$id,
        generation = 1,
        path = list(
          list(type = "index", index = 1),
          list(type = "index", index = 2)
        )
      )
    ))))$result
    expect_identical(unlist(opened_scalar$class), class(values[[name]]))
    expect_identical(opened_scalar$type, typeof(values[[name]]))
    scalar_entry <- get(
      opened_scalar$view,
      envir = .jdv_state$entries,
      inherits = FALSE
    )
    expect_identical(
      .jdv_tree_summary(scalar_entry$tree_value),
      paste0(expected$class, " (1): ", expected$text[[2]])
    )
    .jdv_close_internal(opened_scalar$view)
    .jdv_close_internal(opened_vector$view)
    .jdv_close_internal(root$id)
  }
})

test_that("tree index extraction drops time-series parameters", {
  values <- list(ts = ts(1:10), mts = ts(cbind(first = 1:10, second = 11:20)))
  values <- lapply(values, function(value) {
    attr(value, "marker") <- "kept"
    value
  })

  for (value in values) {
    original_tsp <- tsp(value)
    extracted <- .Call(C_jdv_tree_child, value, "index", 2, "")
    expect_identical(extracted$status, "value")
    expect_identical(class(extracted$value), class(value))
    expect_null(tsp(extracted$value))
    expect_identical(attr(extracted$value, "marker"), "kept")
    expect_identical(tsp(value), original_tsp)
  }

  value <- values$ts
  root <- register_view(list(values = value))
  on.exit(.jdv_close_internal(root$id), add = TRUE)
  original_tsp <- tsp(value)
  opened <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
    id = 1,
    method = "object/open",
    params = list(
      view = root$id,
      generation = 1,
      path = list(
        list(type = "index", index = 1),
        list(type = "index", index = 2)
      )
    )
  ))))$result
  scalar_entry <- get(opened$view, envir = .jdv_state$entries, inherits = FALSE)
  expect_null(tsp(scalar_entry$tree_value))
  expect_identical(attr(scalar_entry$tree_value, "marker"), "kept")
  root_entry <- get(root$id, envir = .jdv_state$entries, inherits = FALSE)
  expect_identical(tsp(root_entry$tree_value$values), original_tsp)
  .jdv_close_internal(opened$view)
})

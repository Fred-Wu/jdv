local({
  rpc <- function(method, params) {
    request <- list(id = 1, method = method, params = params)
    .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
  }

  open_grid_cell <- function(parent, row = 1L, extra = list()) {
    params <- c(
      list(
        view = parent$id,
        generation = parent$generation %||% 1,
        path = list(list(kind = "cell", row_index = row, column = 0L))
      ),
      extra
    )
    rpc("object/open", params)
  }

  test_that("grid child views honor mode and collation options", {
    old_option <- getOption("jdv.collation")
    old_snapshot_cells <- getOption("jdv.snapshot_max_cells")
    on.exit(options(jdv.collation = old_option), add = TRUE)
    on.exit(options(jdv.snapshot_max_cells = old_snapshot_cells), add = TRUE)
    options(jdv.collation = "locale")

    source <- data.frame(
      payload = I(list(
        data.frame(value = 1:2),
        matrix(1:4, nrow = 2L),
        data.frame(value = 3:4)
      ))
    )
    parent <- jdv_register(source, mode = "paged", collation = "C")
    on.exit(.jdv_close_internal(parent$id), add = TRUE)

    explicit_paged <- open_grid_cell(
      parent,
      row = 1L,
      extra = list(mode = "paged", collation = "C")
    )
    expect_null(explicit_paged$error)
    paged_entry <- get(explicit_paged$result$view, .jdv_state$entries)
    expect_identical(paged_entry$mode, "paged")
    expect_identical(paged_entry$collation, "C")
    expect_identical(explicit_paged$result$kind, "grid")

    explicit_snapshot <- open_grid_cell(
      parent,
      row = 2L,
      extra = list(mode = "snapshot", collation = "locale")
    )
    expect_null(explicit_snapshot$error)
    snapshot_entry <- get(explicit_snapshot$result$view, .jdv_state$entries)
    expect_identical(snapshot_entry$mode, "snapshot")
    expect_identical(snapshot_entry$collation, "locale")
    expect_identical(explicit_snapshot$result$kind, "grid")

    options(jdv.snapshot_max_cells = 1L)
    defaulted <- open_grid_cell(parent, row = 3L)
    expect_null(defaulted$error)
    default_entry <- get(defaulted$result$view, .jdv_state$entries)
    expect_identical(default_entry$mode, "paged")
    expect_identical(default_entry$collation, "locale")
  })

  test_that("tree children ignore valid grid options", {
    parent <- jdv_register(list(child = list(value = 1L)))
    on.exit(.jdv_close_internal(parent$id), add = TRUE)
    response <- rpc(
      "object/open",
      list(
        view = parent$id,
        generation = parent$generation %||% 1,
        path = list(list(type = "index", index = 1)),
        mode = "paged",
        collation = "locale"
      )
    )
    expect_null(response$error)
    child <- get(response$result$view, .jdv_state$entries)
    expect_identical(child$mode, "tree")
    expect_null(child$collation)
  })

  test_that("object open strictly validates optional grid options", {
    parent <- jdv_register(data.frame(payload = I(list(data.frame(x = 1L)))))
    on.exit(.jdv_close_internal(parent$id), add = TRUE)
    base <- list(
      view = parent$id,
      generation = parent$generation %||% 1,
      path = list(list(kind = "cell", row_index = 1L, column = 0L))
    )
    invalid <- list(
      list(mode = NULL),
      list(mode = c("snapshot", "paged")),
      list(mode = 1),
      list(mode = "invalid"),
      list(mode = paste(rep("x", 100L), collapse = "")),
      list(collation = NULL),
      list(collation = c("C", "locale")),
      list(collation = FALSE),
      list(collation = "invalid"),
      list(collation = paste(rep("x", 100L), collapse = ""))
    )
    for (extra in invalid) {
      response <- rpc("object/open", c(base, extra))
      expect_identical(response$error$code, "invalid_request")
    }
  })

  test_that("object children do not accept child registration options", {
    parent <- jdv_register(list(child = list(value = 1L)))
    on.exit(.jdv_close_internal(parent$id), add = TRUE)
    base <- list(
      view = parent$id,
      generation = parent$generation %||% 1,
      path = list()
    )
    for (extra in list(list(mode = "paged"), list(collation = "C"))) {
      response <- rpc("object/children", c(base, extra))
      expect_identical(response$error$code, "invalid_request")
    }
  })
})

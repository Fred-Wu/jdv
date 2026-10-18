test_that("closing a parent closes children and close is idempotent", {
  parent <- jdv_handle(list(items = list(answer = 42L)))
  child <- jdv_handle_open(parent, list(list(type = "index", index = 1L)))
  expect_silent(jdv_handle_close(parent))
  expect_silent(jdv_handle_close(parent))
  expect_error(
    jdv_handle_request(child, "object/children", list(path = list())),
    class = "jdv_error_view_not_found"
  )
  expect_silent(jdv_handle_close(child))
})

test_that(
  "a live child keeps its parent alive, while unreachable wrappers finalize",
  {
    parent <- jdv_handle(list(items = list(answer = 42L)))
    parent_state <- parent$state
    child <- jdv_handle_open(parent, list(list(type = "index", index = 1L)))
    child_state <- child$state

    rm(parent)
    invisible(gc())
    expect_false(parent_state$closed)
    expect_silent(jdv_handle_descriptor(child))

    rm(child)
    invisible(gc())
    expect_true(child_state$closed)
    expect_true(parent_state$closed)
  }
)

test_that("unreachable child wrappers are finalized while the parent remains", {
  parent <- jdv_handle(list(items = list(answer = 42L)))
  on.exit(jdv_handle_close(parent), add = TRUE)
  child <- jdv_handle_open(parent, list(list(type = "index", index = 1L)))
  child_state <- child$state

  rm(child)
  invisible(gc())
  expect_true(child_state$closed)
  expect_false(parent$state$closed)
})

test_that("the descendant cap is reusable after a child closes", {
  root <- jdv_handle(as.list(seq_len(33L)))
  on.exit(jdv_handle_close(root), add = TRUE)
  children <- lapply(
    seq_len(32L),
    function(index) {
      jdv_handle_open(root, list(list(type = "index", index = index)))
    }
  )
  expect_error(
    jdv_handle_open(root, list(list(type = "index", index = 33L))),
    class = "jdv_error_limit_exceeded"
  )
  jdv_handle_close(children[[1L]])
  replacement <- jdv_handle_open(root, list(list(type = "index", index = 33L)))
  on.exit(jdv_handle_close(replacement), add = TRUE)
  for (child in children[-1L]) {
    jdv_handle_close(child)
  }
})

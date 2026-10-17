open_messages <- function() {
  parsed <- lapply(jdv_notifications(), .jdv_json_parse)
  Filter(function(message) identical(message$method, "view/open"), parsed)
}

reason_rpc <- function(method, params) {
  request <- list(id = 1, method = method, params = params)
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

reason_new_session <- function(.env = parent.frame()) {
  jdv_disconnect()
  withr::defer(jdv_disconnect(), envir = .env)
  invisible(NULL)
}

test_that(
  "registration sends the register reason, also when replacing a title",
  {
    skip_if_not_installed("withr")
    reason_new_session()
    first <- jdv_register(data.frame(a = 1), title = "t")
    second <- jdv_register(data.frame(a = 1:2), title = "t")
    tree <- jdv_register(list(1), title = "tree")
    tree_again <- jdv_register(list(2), title = "tree")
    expect_identical(first$id, second$id)
    expect_identical(second$generation, 2)
    expect_identical(tree_again$generation, 2)
    opened <- open_messages()
    expect_length(opened, 4L)
    expect_identical(
      vapply(opened, function(message) message$params$reason, ""),
      rep("register", 4L)
    )
  }
)

test_that("object/open sends the child reason for grid and tree children", {
  skip_if_not_installed("withr")
  reason_new_session()
  grid <- jdv_register(
    data.frame(p = I(list(list(1)))),
    title = "grid",
    mode = "paged"
  )
  tree <- jdv_register(list(list(1)))
  jdv_notifications()
  cell <- list(list(kind = "cell", row_index = 1, column = 0))
  step <- list(list(type = "index", index = 1))

  from_grid <- reason_rpc(
    "object/open",
    list(view = grid$id, generation = 1, path = cell)
  )
  from_tree <- reason_rpc(
    "object/open",
    list(view = tree$id, generation = 1, path = step)
  )
  expect_identical(from_grid$result$reason, "child")
  expect_identical(from_tree$result$reason, "child")
  opened <- open_messages()
  expect_identical(
    vapply(opened, function(message) message$params$reason, ""),
    c("child", "child")
  )
})

test_that("view/refresh sends the refresh reason", {
  skip_if_not_installed("withr")
  reason_new_session()
  grid <- jdv_register(data.frame(a = 1))
  tree <- jdv_register(list(1))
  jdv_notifications()
  for (view in list(grid, tree)) {
    refreshed <- reason_rpc(
      "view/refresh",
      list(view = view$id, generation = 1)
    )
    expect_identical(refreshed$result$generation, 2)
  }
  opened <- open_messages()
  expect_identical(
    vapply(opened, function(message) message$params$reason, ""),
    c("refresh", "refresh")
  )
})

test_that("an automatic rebuild of a tracked view sends the tracked reason", {
  skip_if_not_installed("withr")
  skip_if_not(.jdv_track_supported(), "binding tracking needs R 4.6.0 or later")
  reason_new_session()
  env <- new.env()
  env$x <- data.frame(a = 1)
  env$y <- list(1)
  jdv_register(env$x, binding = list(name = "x", env = env))
  jdv_register(env$y, binding = list(name = "y", env = env))
  jdv_notifications()
  env$x <- data.frame(a = 1:2)
  env$y <- list(1, 2)
  jdv_rpc(NULL)
  opened <- open_messages()
  expect_identical(
    vapply(opened, function(message) message$params$reason, ""),
    c("tracked", "tracked")
  )
  # A manual refresh of a tracked view is a refresh.
  refreshed <- reason_rpc(
    "view/refresh",
    list(view = opened[[1L]]$params$view, generation = 2)
  )
  expect_identical(refreshed$result$generation, 3)
  expect_identical(open_messages()[[1L]]$params$reason, "refresh")
})

child_title <- function(view, path) {
  response <- reason_rpc(
    "object/open",
    list(view = view$id, generation = view$generation %||% 1, path = path)
  )
  expect_null(response$error)
  response$result
}

index_step <- function(i) list(type = "index", index = i)

test_that("child titles are built from the parent title and the path", {
  skip_if_not_installed("withr")
  reason_new_session()
  x <- list(
    a = list(1),
    2,
    `a b` = 3,
    dup = 4,
    dup = 5,
    named = c(u = 1, v = 2)
  )
  attr(x, "note") <- list(1)
  view <- jdv_register(x, title = "x")
  title_at <- function(...) child_title(view, list(...))$title

  expect_identical(title_at(index_step(1)), "x$a")
  expect_identical(title_at(index_step(2)), "x[[2]]")
  expect_identical(title_at(index_step(3)), "x$`a b`")
  expect_identical(title_at(index_step(4)), "x[[4]]")
  expect_identical(title_at(index_step(5)), "x[[5]]")
  expect_identical(
    title_at(list(type = "attr", name = "note")),
    "attr(x, \"note\")"
  )

  # A grandchild continues from the child's title.
  child <- child_title(view, list(index_step(1)))
  expect_identical(child$title, "x$a")
  grandchild <- child_title(
    list(id = child$view, generation = child$generation),
    list(index_step(1))
  )
  expect_identical(grandchild$title, "x$a[[1]]")
  named <- child_title(view, list(index_step(6)))
  expect_identical(
    child_title(list(id = named$view), list(index_step(2)))$title,
    "x$named[[\"v\"]]"
  )
})

test_that("child titles cover slots, bindings, and grid cells", {
  skip_if_not_installed("withr")
  reason_new_session()
  setClass("JdvTitleBox", representation(data = "list", `odd name` = "list"))
  withr::defer(removeClass("JdvTitleBox"))
  box <- new("JdvTitleBox", data = list(1), `odd name` = list(2))
  view <- jdv_register(box, title = "s")
  expect_identical(
    child_title(view, list(list(type = "slot", name = "data")))$title,
    "s@data"
  )
  expect_identical(
    child_title(view, list(list(type = "slot", name = "odd name")))$title,
    "s@`odd name`"
  )

  env <- new.env()
  env$val <- list(1)
  env$`my var` <- list(2)
  view <- jdv_register(env, title = "e")
  expect_identical(
    child_title(view, list(list(type = "binding", name = "val")))$title,
    "e$val"
  )
  expect_identical(
    child_title(view, list(list(type = "binding", name = "my var")))$title,
    "e$`my var`"
  )

  cell <- function(row, column) {
    list(kind = "cell", row_index = row, column = column)
  }
  frame <- data.frame(
    id = 1:2,
    p = I(list(list(a = 1), list(a = 2))),
    q = I(list(list(3), list(4)))
  )
  view <- jdv_register(frame, title = "df", mode = "paged")
  expect_identical(child_title(view, list(cell(2, 1)))$title, "df[2, \"p\"]")
  deep <- child_title(view, list(cell(2, 1), index_step(1)))
  expect_identical(deep$title, "df[2, \"p\"]$a")

  odd <- frame[c("p", "q", "q")]
  names(odd) <- c("", "q", "q")
  view <- jdv_register(odd, title = "odd", mode = "paged")
  expect_identical(child_title(view, list(cell(1, 0)))$title, "odd[1, 1]")
  expect_identical(child_title(view, list(cell(1, 2)))$title, "odd[1, 3]")
})

test_that("a child without a parent title has no title, and long ones fit", {
  skip_if_not_installed("withr")
  reason_new_session()
  view <- jdv_register(list(a = list(1)), title = NULL)
  result <- child_title(view, list(index_step(1)))
  expect_null(result$title)
  expect_null(get(result$view, .jdv_state$entries)$title)

  long <- .jdv_child_title(
    list(title = strrep("a", 4094L)),
    list(list(type = "binding", name = "abc")),
    list(containers = list(NULL))
  )
  expect_identical(nchar(long, type = "bytes"), 4096L)

  # Truncation keeps multibyte characters whole.
  wide <- .jdv_child_title(
    list(title = strrep("\u00e9", 2047)),
    list(list(type = "binding", name = "abc")),
    list(containers = list(NULL))
  )
  expect_lte(nchar(wide, type = "bytes"), 4096L)
  expect_true(validUTF8(wide))
  expect_true(startsWith(wide, strrep("\u00e9", 2047)))
})

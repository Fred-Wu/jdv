local({
  # Restore file-owned notification state even when a test fails.
  state <- .jdv_state
  initial_session <- save_notification_session()
  on.exit(restore_notification_session(initial_session), add = TRUE)

  has_binding_api <- getRversion() >= "4.6.0"

  tree_rpc <- function(method, params, id = 1) {
    request <- list(id = id, method = method, params = params)
    .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
  }

  tree_call <- function(view, method, params = list(), id = 1) {
    params$view <- view$id
    params$generation <- if (is.null(view$generation)) 1 else view$generation
    tree_rpc(method, params, id)$result
  }

  test_that(
    "tree descriptors expose bounded typed children and captured values",
    {
      root <- register_view(list(items = list(answer = 42L)))
      on.exit(.jdv_close_internal(root$id), add = TRUE)
      descriptor <- .jdv_json_parse(root$open)$params
      expect_identical(descriptor$kind, "tree")
      expect_identical(descriptor$access, "random")
      expect_length(descriptor$path, 0)
      expect_named(
        descriptor$capabilities,
        c(
          "seek",
          "sort",
          "filter",
          "known_total",
          "next",
          "children",
          "refresh"
        )
      )

      page <- tree_call(
        root,
        "object/children",
        list(path = list(), offset = 0, limit = 10)
      )
      expect_length(page$path, 0)
      expect_equal(page$total_children, 2)
      expect_identical(
        unclass(page$children[[1]]$path[[1]]),
        list(type = "index", index = 1)
      )
      expect_true(page$children[[1]]$has_children)

      opened <- tree_call(
        root,
        "object/open",
        list(path = list(list(type = "index", index = 1)))
      )
      expect_identical(opened$parent, root$id)
      expect_length(opened$path, 0)
      child <- list(id = opened$view, generation = opened$generation)
      child_page <- tree_call(
        child,
        "object/children",
        list(path = list(), offset = 0, limit = 10)
      )
      expect_true(any(vapply(
        child_page$children,
        function(item) item$label == "answer",
        logical(1)
      )))
    }
  )

  test_that("implicit tree classes match base R class semantics", {
    root <- register_view(list(
      numeric = 1.5,
      matrix = matrix(1:4, nrow = 2),
      array = array(1:4, dim = c(2, 2, 1)),
      function_value = identity,
      null = NULL
    ))
    on.exit(.jdv_close_internal(root$id), add = TRUE)

    page <- tree_call(root, "object/children", list(path = list(), limit = 10))
    children <- stats::setNames(
      page$children,
      vapply(page$children, `[[`, "", "label")
    )
    expect_identical(unlist(children$numeric$class), class(1.5))
    expect_identical(unlist(children$matrix$class), class(matrix(1L, 1, 1)))
    expect_identical(
      unlist(children$array$class),
      class(array(1L, dim = c(1, 1, 1)))
    )
    expect_identical(unlist(children$function_value$class), class(identity))
    expect_identical(unlist(children$null$class), class(NULL))
  })

  test_that(
    "tree traversal does not dispatch classed list methods or force bindings",
    {
      `[[.jdvExplosive` <- function(x, i, ...) stop("[[ dispatched")
      length.jdvExplosive <- function(x) stop("length dispatched")
      format.jdvExplosive <- function(x, ...) stop("format dispatched")
      value <- structure(list(child = 1:2), class = "jdvExplosive")
      root <- register_view(value)
      on.exit(.jdv_close_internal(root$id), add = TRUE)
      page <- tree_call(
        root,
        "object/children",
        list(path = list(), offset = 0, limit = 10)
      )
      expect_true(any(vapply(
        page$children,
        function(item) item$label == "child",
        logical(1)
      )))

      counters <- new.env(parent = emptyenv())
      counters$delayed <- 0L
      counters$active <- 0L
      env <- new.env(parent = emptyenv())
      delayedAssign(
        "lazy",
        {
          counters$delayed <- counters$delayed + 1L
          17L
        },
        assign.env = env
      )
      delayedAssign(
        "forced",
        {
          counters$delayed <- counters$delayed + 1L
          23L
        },
        assign.env = env
      )
      force(env$forced)
      makeActiveBinding(
        "active",
        function(value) {
          if (!missing(value)) {
            stop("active binding assignment")
          }
          counters$active <- counters$active + 1L
          99L
        },
        env
      )
      env_view <- register_view(env)
      on.exit(.jdv_close_internal(env_view$id), add = TRUE)
      env_page <- tree_call(
        env_view,
        "object/children",
        list(path = list(), offset = 0, limit = 10)
      )
      lazy <- env_page$children[[
        match("lazy", vapply(env_page$children, `[[`, "", "label"))
      ]]
      active <- env_page$children[[
        match("active", vapply(env_page$children, `[[`, "", "label"))
      ]]
      expect_false(lazy$viewable)
      expect_identical(
        lazy$unavailable,
        if (has_binding_api) "delayed_binding" else "unavailable"
      )
      expect_false(active$viewable)
      expect_identical(active$unavailable, "active_binding")
      expect_identical(counters$delayed, 1L)
      expect_identical(counters$active, 0L)

      forced <- tree_rpc(
        "object/open",
        list(
          view = env_view$id,
          generation = 1,
          path = list(list(type = "binding", name = "forced"))
        )
      )
      if (has_binding_api) {
        expect_identical(forced$result$kind, "tree")
      } else {
        expect_identical(forced$error$code, "unavailable")
        for (name in c("lazy", "forced")) {
          found <- .Call(C_jdv_tree_child, env, "binding", 0, name)
          expect_identical(found$status, "opaque")
          expect_null(found$value)
        }
      }
      expect_identical(counters$delayed, 1L)
      expect_identical(counters$active, 0L)
    }
  )

  test_that("tree paging reads bounded ALTREP prefixes and distinguishes aliases from cycles", {
    root <- register_view(as.integer(seq_len(100000000L)))
    on.exit(.jdv_close_internal(root$id), add = TRUE)
    page <- tree_call(
      root,
      "object/children",
      list(path = list(), offset = 0, limit = 3)
    )
    expect_equal(page$total_children, 100000000)
    expect_identical(
      vapply(page$children, `[[`, "", "summary"),
      c("integer (1): 1", "integer (1): 2", "integer (1): 3")
    )

    shared <- list(value = 1L)
    cyclic <- new.env(parent = emptyenv())
    cyclic$left <- shared
    cyclic$right <- shared
    cyclic$self <- cyclic
    env_view <- register_view(cyclic)
    on.exit(.jdv_close_internal(env_view$id), add = TRUE)
    children <- tree_call(
      env_view,
      "object/children",
      list(path = list(), offset = 0, limit = 10)
    )$children
    by_label <- stats::setNames(children, vapply(children, `[[`, "", "label"))
    if (has_binding_api) {
      expect_true(by_label$left$viewable)
      expect_true(by_label$right$viewable)
      expect_true(by_label$left$has_children)
      expect_false(by_label$self$viewable)
      expect_identical(by_label$self$unavailable, "cycle")
    } else {
      for (child in by_label) {
        expect_false(child$viewable)
        expect_false(child$has_children)
        expect_identical(child$unavailable, "unavailable")
      }
    }
  })

  test_that(
    "tree paths validate and parent close cascades to opened children",
    {
      root <- register_view(list(child = list(value = 1L)))
      empty_open <- tree_rpc(
        "object/open",
        list(view = root$id, generation = 1, path = list())
      )
      expect_identical(empty_open$error$code, "invalid_request")
      opened <- tree_call(
        root,
        "object/open",
        list(path = list(list(type = "index", index = 1)))
      )
      child_id <- opened$view
      response <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
        id = 9,
        method = "view/close",
        params = list(view = root$id, generation = 1)
      ))))
      expect_true(response$result$closed)
      notification <- .jdv_json_parse(tail(.jdv_state$queue, 1)[[1]])
      expect_identical(notification$method, "view/closed")
      expect_identical(notification$params$view, child_id)
      expect_identical(notification$params$reason, "parent_closed")
      stale <- tree_rpc(
        "object/children",
        list(
          view = root$id,
          generation = 1,
          path = list(),
          offset = 0,
          limit = 10
        )
      )
      expect_identical(stale$error$code, "view_not_found")

      active_root <- register_view(list(value = 1L))
      on.exit(.jdv_close_internal(active_root$id), add = TRUE)
      too_deep <- rep(list(list(type = "index", index = 1)), 33)
      request <- list(
        id = 10,
        method = "object/children",
        params = list(
          view = active_root$id,
          generation = 1,
          path = too_deep,
          offset = 0,
          limit = 1
        )
      )
      expect_match(
        .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))$error$message,
        "bounded array"
      )
    }
  )

  test_that("tree child labels preserve duplicate, empty, and absent names", {
    named <- structure(list(1L, 2L, 3L), names = c("same", "", "same"))
    root <- register_view(named)
    on.exit(.jdv_close_internal(root$id), add = TRUE)
    page <- tree_call(
      root,
      "object/children",
      list(path = list(), offset = 0, limit = 10)
    )
    expect_identical(
      vapply(page$children[1:3], `[[`, "", "label"),
      c("same", "", "same")
    )
    expect_identical(
      vapply(page$children[1:3], function(child) child$path[[1]]$index, 0),
      c(1, 2, 3)
    )

    unnamed <- register_view(list(1L, 2L))
    on.exit(.jdv_close_internal(unnamed$id), add = TRUE)
    unnamed_page <- tree_call(
      unnamed,
      "object/children",
      list(path = list(), offset = 0, limit = 10)
    )
    expect_identical(
      vapply(unnamed_page$children[1:2], `[[`, "", "label"),
      c("[1]", "[2]")
    )
  })

  test_that(
    "unaddressable long binding names do not create invalid child paths",
    {
      env <- new.env(parent = emptyenv())
      long_name <- strrep("x", 1001)
      assign(long_name, 1L, envir = env)
      env$ordinary <- 2L
      root <- register_view(env)
      on.exit(.jdv_close_internal(root$id), add = TRUE)

      page <- tree_call(
        root,
        "object/children",
        list(path = list(), limit = 10)
      )
      labels <- vapply(page$children, `[[`, "", "label")
      long_child <- page$children[[match(substr(long_name, 1, 1000), labels)]]
      ordinary <- page$children[[match("ordinary", labels)]]
      expect_false(long_child$viewable)
      expect_false(long_child$has_children)
      expect_identical(long_child$unavailable, "path_limit")
      expect_null(long_child$path)
      expect_identical(ordinary$viewable, has_binding_api)
      if (!has_binding_api) {
        expect_identical(ordinary$unavailable, "unavailable")
      }
      expect_length(ordinary$path, 1)
    }
  )

  test_that(
    "pairlists and S4 storage are traversed without dispatching .Data",
    {
      pairs <- pairlist(NULL, 2L, named = 3L)
      root <- register_view(pairs)
      on.exit(.jdv_close_internal(root$id), add = TRUE)
      page <- tree_call(
        root,
        "object/children",
        list(path = list(), offset = 0, limit = 10)
      )
      expect_gte(page$total_children, 3)
      expect_true(page$children[[1]]$viewable)
      expect_identical(page$children[[1]]$class[[1]], "NULL")

      methods::setClass(
        "jdvTreeListFixture",
        contains = "list",
        slots = c(note = "character")
      )
      object <- methods::new(
        "jdvTreeListFixture",
        .Data = list(first = 11L),
        note = "safe"
      )
      info <- .Call(C_jdv_tree_info, object)
      expect_identical(info$type, "s4")
      expect_identical(info$storage_type, "list")
      indexed <- .Call(C_jdv_tree_child, object, "index", 1, "")
      expect_identical(indexed$status, "value")
      data_slot <- .Call(C_jdv_tree_child, object, "slot", 0, ".Data")
      expect_identical(data_slot$status, "s4_data_opaque")
      note_slot <- .Call(C_jdv_tree_child, object, "slot", 0, "note")
      expect_identical(note_slot$status, "value")
      expect_identical(note_slot$value, "safe")
      s4_root <- register_view(object)
      on.exit(.jdv_close_internal(s4_root$id), add = TRUE)
      s4_page <- tree_call(
        s4_root,
        "object/children",
        list(path = list(), offset = 0, limit = 10)
      )
      expect_true(any(vapply(
        s4_page$children,
        function(child) identical(child$path[[1]]$type, "index"),
        logical(1L)
      )))

      methods::setClass("jdvTreeNullSlotFixture", slots = c(value = "ANY"))
      null_slot <- methods::new("jdvTreeNullSlotFixture", value = NULL)
      result <- .Call(C_jdv_tree_child, null_slot, "slot", 0, "value")
      expect_identical(result$status, "value")
      expect_null(result$value)
    }
  )

  test_that("removed bindings and stale generations have distinct errors", {
    env <- new.env(parent = emptyenv())
    env$item <- 1L
    root <- register_view(env)
    on.exit(.jdv_close_internal(root$id), add = TRUE)
    rm("item", envir = env)
    missing <- tree_rpc(
      "object/open",
      list(
        view = root$id,
        generation = 1,
        path = list(list(type = "binding", name = "item"))
      )
    )
    expect_identical(missing$error$code, "unavailable")

    old <- register_view(list(value = 1L), title = "tree-generation")
    on.exit(.jdv_close_internal(old$id), add = TRUE)
    current <- register_view(list(value = 2L), title = "tree-generation")
    expect_identical(current$id, old$id)
    stale <- tree_rpc(
      "object/children",
      list(view = old$id, generation = 1, path = list(), offset = 0, limit = 1)
    )
    expect_identical(stale$error$code, "stale_generation")
  })

  test_that("object-open uses the output limit instead of the request limit", {
    root <- register_view(list(child = list(value = 1L)))
    on.exit(.jdv_close_internal(root$id), add = TRUE)
    old_options <- options(jdv.max_request_bytes = 128)
    on.exit(options(old_options), add = TRUE)

    request <- .jdv_json_encode(list(
      id = 1,
      method = "object/open",
      params = list(
        view = root$id,
        generation = 1,
        path = list(list(type = "index", index = 1))
      )
    ))
    expect_lte(nchar(request, type = "bytes"), 128)
    raw_response <- jdv_rpc(request)
    expect_gt(nchar(raw_response, type = "bytes"), 128)

    options(jdv.max_request_bytes = old_options$jdv.max_request_bytes)
    response <- .jdv_json_parse(raw_response)
    expect_identical(response$result$parent, root$id)
    expect_true(exists(response$result$view, envir = .jdv_state$entries))
  })

  test_that("failed final object-open encoding rolls back the child", {
    root <- register_view(list(child = list(value = 1L)))
    on.exit(.jdv_close_internal(root$id), add = TRUE)
    namespace <- asNamespace("jdv")
    original <- get(".jdv_json_encode", namespace)
    unlockBinding(".jdv_json_encode", namespace)
    assign(
      ".jdv_json_encode",
      function(x, ...) {
        if (is.list(x) && is.list(x$result) && !is.null(x$result$parent)) {
          stop("injected object-open response encode failure")
        }
        original(x, ...)
      },
      envir = namespace
    )
    lockBinding(".jdv_json_encode", namespace)
    on.exit(
      {
        unlockBinding(".jdv_json_encode", namespace)
        assign(".jdv_json_encode", original, envir = namespace)
        lockBinding(".jdv_json_encode", namespace)
      },
      add = TRUE
    )

    response <- tree_rpc(
      "object/open",
      list(
        view = root$id,
        generation = 1,
        path = list(list(type = "index", index = 1))
      )
    )

    expect_true(!is.null(response$error))
    root_entry <- get(root$id, .jdv_state$entries)
    expect_length(root_entry$children, 0)
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 1)
  })

  test_that(
    "the lineage caps live descendants at 32 and closes grid children",
    {
      root <- register_view(list(
        nested = list(value = 1L),
        table = data.frame(x = 1L)
      ))
      on.exit(.jdv_close_internal(root$id), add = TRUE)
      nested <- tree_call(
        root,
        "object/open",
        list(path = list(list(type = "index", index = 1)))
      )
      nested_view <- list(id = nested$view, generation = nested$generation)
      grandchild <- tree_call(
        nested_view,
        "object/open",
        list(path = list(list(type = "index", index = 1)))
      )
      expect_identical(grandchild$parent, nested$view)

      grid <- tree_call(
        root,
        "object/open",
        list(path = list(list(type = "index", index = 2)))
      )
      expect_identical(grid$kind, "grid")
      expect_identical(grid$parent, root$id)

      for (i in seq_len(29)) {
        opened <- tree_call(
          root,
          "object/open",
          list(path = list(list(type = "attr", name = "names")))
        )
        expect_identical(opened$parent, root$id)
      }
      capped <- tree_rpc(
        "object/open",
        list(
          view = root$id,
          generation = 1,
          path = list(list(type = "attr", name = "names"))
        )
      )
      expect_identical(capped$error$code, "limit_exceeded")
      closed <- tree_rpc("view/close", list(view = root$id, generation = 1))
      expect_true(closed$result$closed)
      expect_false(exists(
        grid$view,
        envir = .jdv_state$entries,
        inherits = FALSE
      ))
    }
  )

  test_that(
    "native scalar child copies survive focused garbage collection pressure",
    {
      skip_on_cran()
      skip_if_not_installed("callr")
      result <- callr::r(
        function() {
          loadNamespace("jdv")
          value <- as.integer(1:3)
          gctorture(TRUE)
          on.exit(gctorture(FALSE), add = TRUE)
          child <- .Call(jdv:::C_jdv_tree_child, value, "index", 2, "")
          text <- .Call(jdv:::C_jdv_tree_scalar_text, child$value)
          list(child = child, text = text)
        },
        libpath = .libPaths()
      )
      expect_identical(result$child$status, "value")
      expect_identical(result$child$value, 2L)
      expect_identical(result$text, "2")
    }
  )
})

sequential_lifetime_next <- function(view, max_rows = 2L) {
  descriptor <- .jdv_json_parse(view$open)$params
  .jdv_rpc_internal(
    .jdv_json_encode(list(
      id = "lifetime-next",
      method = "stream/next",
      params = list(
        view = descriptor$view,
        generation = descriptor$generation,
        max_rows = max_rows
      )
    )),
    allow_binary = TRUE
  )
}

with_sequential_lifetime <- function(code) {
  saved_session <- save_notification_session()
  on.exit(restore_notification_session(saved_session), add = TRUE)
  with_arrow_owner(function(owner) {
    on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
    code(owner)
  })
}

test_that(
  "closing a registered stream releases its schema and partial batch once",
  {
    with_sequential_lifetime(function(owner) {
      fetched <- 0L
      view <- register_view(owner$stream(
        lengths = 7L,
        hook = function(event) if (event == "next") fetched <<- fetched + 1L
      ))
      expect_identical(fetched, 0L)
      expect_equal(owner$counts(), c(0, 0, 0, 1))
      page <- sequential_lifetime_next(view)
      expect_s3_class(page, "jdv_binary_packet")
      metadata <- .jdv_json_parse(page$header)$result
      expect_identical(metadata$first_row, 0)
      expect_identical(metadata$rows_fetched, 2)
      expect_false(metadata$done)
      expect_identical(fetched, 1L)
      expect_equal(owner$counts(), c(0, 0, 0, 1))
      jdv_close(view$id)
      expect_equal(owner$counts(), c(1, 1, 1, 0))
      .jdv_close_internal(view$id, notify = FALSE)
      expect_equal(owner$counts(), c(1, 1, 1, 0))
    })
  }
)

test_that("replacement and eviction release registry-owned carried batches", {
  with_sequential_lifetime(function(owner) {
    old <- register_view(owner$stream(lengths = 7L), title = "lifetime-slot")
    expect_s3_class(sequential_lifetime_next(old), "jdv_binary_packet")
    replacement <- register_view(
      owner$stream(lengths = 7L),
      title = "lifetime-slot"
    )
    expect_identical(replacement$id, old$id)
    expect_identical(.jdv_json_parse(replacement$open)$params$generation, 2)
    expect_equal(owner$counts(), c(1, 1, 1, 1))
    stale <- sequential_lifetime_next(old)
    expect_identical(.jdv_json_parse(stale)$error$code, "stale_generation")
    page <- sequential_lifetime_next(replacement)
    expect_s3_class(page, "jdv_binary_packet")
    expect_identical(.jdv_json_parse(page$header)$result$first_row, 0)
    .jdv_close_internal(replacement$id, notify = FALSE)
    expect_equal(owner$counts(), c(2, 2, 2, 0))

    options_before <- options(jdv.max_tables = 1L)
    on.exit(options(options_before), add = TRUE)
    evicted <- register_view(owner$stream(lengths = 7L))
    expect_s3_class(sequential_lifetime_next(evicted), "jdv_binary_packet")
    retained <- register_view(owner$stream(lengths = 7L))
    expect_false(exists(evicted$id, .jdv_state$entries, inherits = FALSE))
    expect_equal(owner$counts(), c(3, 3, 3, 1))
    .jdv_close_internal(retained$id, notify = FALSE)
    expect_equal(owner$counts(), c(4, 4, 3, 0))
  })
})

test_that(
  "closing a tree parent releases a captured sequential child's carry",
  {
    with_sequential_lifetime(function(owner) {
      parent <- register_view(list(child = owner$stream(lengths = 7L)))
      opened <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
        id = "lifetime-child",
        method = "object/open",
        params = list(
          view = parent$id,
          generation = 1,
          path = list(list(type = "index", index = 1))
        )
      ))))
      expect_null(opened$error)
      expect_identical(opened$result$access, "sequential")
      expect_identical(opened$result$parent, parent$id)
      child <- list(
        id = opened$result$view,
        open = .jdv_json_encode(list(params = opened$result))
      )
      expect_s3_class(sequential_lifetime_next(child), "jdv_binary_packet")
      expect_equal(owner$counts(), c(0, 0, 0, 1))
      jdv_close(parent$id)
      expect_false(exists(child$id, .jdv_state$entries, inherits = FALSE))
      expect_equal(owner$counts(), c(1, 1, 1, 0))
      .jdv_close_internal(parent$id, notify = FALSE)
      expect_equal(owner$counts(), c(1, 1, 1, 0))
    })
  }
)

test_that("get_next may close another carried stream without releasing inside the producer", {
  with_sequential_lifetime(function(owner) {
    other <- register_view(owner$stream(lengths = 7L))
    expect_s3_class(sequential_lifetime_next(other), "jdv_binary_packet")
    during <- NULL
    active <- register_view(owner$stream(
      lengths = 7L,
      hook = function(event) {
        if (event == "next") {
          .jdv_close_internal(other$id, notify = FALSE)
          during <<- owner$counts()
        }
      }
    ))
    expect_s3_class(sequential_lifetime_next(active), "jdv_binary_packet")
    expect_equal(during, c(0, 0, 0, 2))
    expect_false(exists(other$id, .jdv_state$entries, inherits = FALSE))
    expect_equal(owner$counts(), c(1, 1, 1, 1))
    expect_length(.jdv_state$sequential_releases, 0L)
    .jdv_close_internal(active$id, notify = FALSE)
    expect_equal(owner$counts(), c(2, 2, 2, 0))
  })
})

test_that("get_next close or replacement cannot publish bytes from an obsolete registry entry", {
  with_sequential_lifetime(function(owner) {
    view <- NULL
    during <- NULL
    view <- register_view(owner$stream(
      lengths = 7L,
      hook = function(event) {
        if (event == "next") {
          .jdv_close_internal(view$id, notify = FALSE)
          during <<- owner$counts()
        }
      }
    ))
    response <- sequential_lifetime_next(view)
    expect_type(response, "character")
    expect_identical(.jdv_json_parse(response)$error$code, "view_not_found")
    expect_equal(during, c(0, 0, 0, 1))
    expect_equal(owner$counts(), c(1, 1, 1, 0))

    replacement <- NULL
    view <- register_view(
      owner$stream(
        lengths = 7L,
        hook = function(event) {
          if (event == "next") {
            replacement <<- register_view(
              list(current = TRUE),
              title = "lifetime-reentry"
            )
          }
        }
      ),
      title = "lifetime-reentry"
    )
    response <- sequential_lifetime_next(view)
    expect_type(response, "character")
    expect_identical(.jdv_json_parse(response)$error$code, "stale_generation")
    expect_identical(replacement$id, view$id)
    expect_identical(.jdv_json_parse(replacement$open)$params$generation, 2)
    expect_identical(get(view$id, .jdv_state$entries)$mode, "tree")
    expect_equal(owner$counts(), c(2, 2, 2, 0))
    expect_length(.jdv_state$sequential_releases, 0L)
    expect_identical(.jdv_stream_status()[["busy"]], 0L)
  })
})

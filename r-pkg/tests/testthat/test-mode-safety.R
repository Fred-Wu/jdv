set_jdv_options <- function(values) {
  old <- setNames(lapply(names(values), getOption), names(values))
  options(values)
  function() options(old)
}

mode_safety_rpc_json <- function(value) {
  jsonlite::fromJSON(value, simplifyVector = FALSE)
}

mode_safety_rpc_call <- function(method, params, id = 1) {
  request <- jsonlite::toJSON(
    list(id = id, method = method, params = params),
    auto_unbox = TRUE,
    null = "null",
    digits = 17
  )
  mode_safety_rpc_json(jdv_rpc(request))
}

test_that(
  "auto sampling falls back before formatting an unsampled large value",
  {
    .jdv_close_internal()
    on.exit(.jdv_close_internal(), add = TRUE)
    restore <- set_jdv_options(list(jdv.max_work_bytes = 16 * 1024))
    on.exit(restore(), add = TRUE)

    n <- 10000L
    sample_n <- 256L
    sampled <- unique(as.integer(
      floor((seq_len(sample_n) - 1) * (as.double(n) - 1) / (sample_n - 1)) + 1
    ))
    hidden <- setdiff(seq.int(33L, n), sampled)[[1L]]
    value <- rep("x", n)
    value[[hidden]] <- strrep("z", 1024^2)

    registered <- jdv_register(data.frame(value = value), mode = "auto")
    expect_identical(mode_safety_rpc_json(registered$open)$params$mode, "paged")
  }
)

test_that("auto row estimates include compact zero-column row indices", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  x <- structure(
    list(),
    class = "data.frame",
    row.names = c(NA_integer_, -800000000L)
  )
  registered <- jdv_register(x, mode = "auto")
  expect_identical(mode_safety_rpc_json(registered$open)$params$mode, "paged")
  reply <- mode_safety_rpc_call(
    "table/rows",
    list(table = registered$id, generation = 1, offset = 799999997, limit = 3)
  )
  expect_identical(
    reply$result$data$row_index,
    list(799999998L, 799999999L, 800000000L)
  )
})

test_that("auto falls back when only snapshot row names exceed the budget", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- set_jdv_options(list(jdv.max_message_bytes = 1024))
  on.exit(restore(), add = TRUE)

  x <- data.frame(value = 1)
  rownames(x) <- strrep("row", 700)
  expect_error(jdv_register(x, mode = "snapshot"), class = "jdv_query_error")

  registered <- jdv_register(x, mode = "auto")
  descriptor <- mode_safety_rpc_json(registered$open)$params
  expect_identical(descriptor$mode, "paged")
  expect_null(descriptor$row_names)
})

test_that(
  "snapshot source checks reject nested oversized cells before formatting",
  {
    .jdv_close_internal()
    on.exit(.jdv_close_internal(), add = TRUE)
    restore <- set_jdv_options(list(jdv.max_work_bytes = 1024))
    on.exit(restore(), add = TRUE)

    value <- I(list(list(payload = strrep("x", 10000))))
    expect_error(
      jdv_register(data.frame(value = value), mode = "snapshot"),
      class = "jdv_query_error"
    )
  }
)

test_that("oversized user channel results fail the request without downgrade", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  restore <- set_jdv_options(list(jdv.max_work_bytes = 1024^2))
  on.exit(restore(), add = TRUE)

  x <- data.frame(value = structure(1:100, class = "huge_page_format"))
  with_column_method(
    "format",
    "huge_page_format",
    function(x, ...) {
      if (length(x) <= 2L) {
        rep(strrep("x", 600000), length(x))
      } else {
        as.character(x)
      }
    },
    {
      registered <- jdv_register(x, mode = "paged")
      reply <- mode_safety_rpc_call(
        "table/rows",
        list(table = registered$id, generation = 1, offset = 0, limit = 2)
      )
      expect_identical(reply$error$code, "limit_exceeded")
    }
  )
})

test_that("deterministic registration leaves the R random state untouched", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  had_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  if (had_seed) {
    old_seed <- get(".Random.seed", envir = .GlobalEnv)
  }
  on.exit(
    {
      if (had_seed) {
        assign(".Random.seed", old_seed, envir = .GlobalEnv)
      } else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) {
        rm(".Random.seed", envir = .GlobalEnv)
      }
    },
    add = TRUE
  )
  set.seed(2026)
  before <- .Random.seed
  registered <- jdv_register(
    data.frame(number = seq_len(100), text = rep("value", 100)),
    mode = "auto"
  )
  expect_identical(.Random.seed, before)
  expect_false(is.null(registered$open))
})

test_that("a bounded error response survives the minimum work budget", {
  restore <- set_jdv_options(list(jdv.max_work_bytes = 1024))
  on.exit(restore(), add = TRUE)
  response <- mode_safety_rpc_call("not/a/method", list(), id = 1)
  expect_identical(response$error$code, "method_not_found")
})

rpc_fixture_json <- function(x) {
  as.character(jsonlite::toJSON(
    x,
    auto_unbox = TRUE,
    null = "null",
    na = "null",
    digits = NA,
    force = TRUE
  ))
}

rpc_fixture_values <- function(values, prototype) {
  if (is.null(prototype)) {
    return(NULL)
  }
  vapply(
    values,
    function(value) {
      if (is.null(value)) {
        switch(
          typeof(prototype),
          logical = NA,
          integer = NA_integer_,
          double = NA_real_,
          character = NA_character_
        )
      } else {
        switch(
          typeof(prototype),
          logical = as.logical(value),
          integer = as.integer(value),
          double = as.numeric(value),
          character = as.character(value)
        )
      }
    },
    switch(
      typeof(prototype),
      logical = logical(1L),
      integer = integer(1L),
      double = numeric(1L),
      character = character(1L)
    )
  )
}

rpc_fixture_snapshot <- function(open_message, template) {
  params <- open_message$params
  template$nrow <- as.integer(params$nrow)
  template$ncol <- as.integer(params$ncol)
  template$collation <- params$collation
  template$schema <- lapply(params$columns, function(schema) {
    for (field in c("class", "levels")) {
      if (!is.null(schema[[field]])) {
        schema[[field]] <- unlist(schema[[field]], use.names = FALSE)
      }
    }
    schema
  })
  template$columns <- lapply(seq_along(params$data$columns), function(j) {
    wire <- params$data$columns[[j]]
    data <- list()
    for (field in c("values", "display", "sortKey", "special", "na")) {
      if (!is.null(wire[[field]])) {
        data[[field]] <- rpc_fixture_values(
          wire[[field]],
          template$columns[[j]]$data[[field]]
        )
      }
    }
    if (is.null(data$display) && !is.null(data$values)) {
      data$display <- as.character(data$values)
    }
    type <- template$schema[[j]]$type
    data$text <- if (type %in% c("string", "factor", "int64")) {
      data$values
    } else {
      data$display
    }
    list(schema = template$schema[[j]], data = data)
  })
  template
}

rpc_fixture_close <- function(id, generation = 1L) {
  request <- rpc_fixture_json(list(
    id = 1L,
    method = "view/close",
    params = list(view = id, generation = generation)
  ))
  invisible(try(jdv_rpc(request), silent = TRUE))
}

rpc_fixture_page <- function(id, query) {
  request <- rpc_fixture_json(list(
    id = 1L,
    method = "table/rows",
    params = list(
      view = id,
      generation = 1L,
      offset = 0L,
      limit = 200L,
      sort = if (is.null(query$sort)) list() else query$sort,
      filter = query$filter
    )
  ))
  jsonlite::fromJSON(jdv_rpc(request), simplifyVector = FALSE)
}

test_that("public RPC round-trips every shared query fixture", {
  skip_if_not_installed("jsonlite")
  fixture <- jsonlite::fromJSON(
    system.file("spec", "query-fixtures.json", package = "jdv"),
    simplifyVector = FALSE
  )

  local({
    registrations <- character()
    on.exit(lapply(registrations, rpc_fixture_close), add = TRUE)

    with_query_methods({
      for (case in fixture$cases) {
        x <- query_fixture_table(case$columns)
        paged <- jdv_register(x, mode = "paged")
        registrations <- c(registrations, paged$id)
        snapshot <- jdv_register(x, mode = "snapshot")
        registrations <- c(registrations, snapshot$id)

        open_message <- jsonlite::fromJSON(
          snapshot$open,
          simplifyVector = FALSE
        )
        expect_identical(open_message$method, "view/open")
        expect_identical(open_message$params$mode, "snapshot")
        expect_identical(
          as.integer(unlist(
            open_message$params$data$row_index,
            use.names = FALSE
          )),
          seq_len(nrow(x))
        )
        wire_snapshot <- rpc_fixture_snapshot(open_message, snapshot_table(x))

        for (query in case$queries) {
          expected <- as.integer(unlist(query$expected, use.names = FALSE))
          paged_response <- rpc_fixture_page(paged$id, query)
          expect_null(paged_response$error, info = paste(case$name, query$name))
          paged_rows <- as.integer(unlist(
            paged_response$result$data$row_index,
            use.names = FALSE
          ))
          snapshot_rows <- snapshot_indices(
            wire_snapshot,
            sort = if (is.null(query$sort)) list() else query$sort,
            filter = query$filter
          )
          expect_identical(
            paged_rows,
            expected,
            info = paste("paged", case$name, query$name)
          )
          expect_identical(
            snapshot_rows,
            expected,
            info = paste("snapshot", case$name, query$name)
          )
          expect_identical(
            paged_rows,
            snapshot_rows,
            info = paste("mode parity", case$name, query$name)
          )
          expect_identical(paged_response$warnings, list())
        }
      }
    })
  })
})

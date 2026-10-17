test_that("wide tables register and explicitly selected columns render", {
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  width <- 4097L
  column_names <- paste0("column_", seq_len(width))
  frame <- structure(
    rep(list(1L), width),
    names = column_names,
    class = "data.frame",
    row.names = .set_row_names(1L)
  )
  matrix <- matrix(
    1L,
    nrow = 1L,
    ncol = width,
    dimnames = list(NULL, column_names)
  )

  for (mode in c("paged", "snapshot")) {
    for (table in list(frame, matrix)) {
      registered <- jdv_register(table, mode = mode)
      descriptor <- .jdv_json_parse(
        registered$open,
        limit = .jdv_max_message_bytes()
      )$params
      expect_identical(descriptor$ncol, as.double(width))
      if (mode == "paged") {
        request <- list(
          id = 1,
          method = "table/rows",
          params = list(
            view = registered$id,
            generation = 1,
            cols = list(as.double(width - 1L))
          )
        )
        response <- .jdv_json_parse(
          jdv_rpc(.jdv_json_encode(request)),
          limit = .jdv_max_message_bytes()
        )
        expect_null(response$error)
        expect_identical(
          unlist(response$result$data$row_index, use.names = FALSE),
          1
        )
        expect_identical(
          unlist(
            response$result$data$columns[[1L]]$data$display,
            use.names = FALSE
          ),
          "1"
        )
      }
      .jdv_close_internal(registered$id)
    }
  }
})

test_that("wide cell grids and descriptor message limits are honored", {
  width <- 4097L
  nested <- matrix(1L, nrow = 1L, ncol = width)
  source <- data.frame(id = 1L)
  source$packed <- I(nested)
  entry <- list(
    nrow = nrow(source),
    ncol = ncol(source),
    schema = list(list(drillable = FALSE), list(drillable = TRUE)),
    source = source,
    fingerprint = .jdv_fingerprint(source)
  )
  cell_grid <- .jdv_cell_value(entry, list(row_index = 1L, column = 1L))
  expect_identical(dim(cell_grid), c(1L, width))

  old_message_limit <- getOption("jdv.max_message_bytes")
  options(jdv.max_message_bytes = 1024)
  on.exit(options(jdv.max_message_bytes = old_message_limit), add = TRUE)
  .jdv_close_internal()
  on.exit(.jdv_close_internal(), add = TRUE)
  descriptor_table <- structure(
    rep(list(1L), width),
    names = paste0("column_", seq_len(width)),
    class = "data.frame",
    row.names = .set_row_names(1L)
  )
  expect_query_code(
    jdv_register(descriptor_table, mode = "paged"),
    "limit_exceeded"
  )
})

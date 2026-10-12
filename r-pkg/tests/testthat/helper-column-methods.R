with_column_method <- function(generic, class, method, code) {
  table <- get(".__S3MethodsTable__.", envir = asNamespace("base"))
  name <- paste(generic, class, sep = ".")
  had <- exists(name, envir = table, inherits = FALSE)
  previous <- if (had) get(name, envir = table)
  registerS3method(generic, class, method, envir = asNamespace("base"))
  on.exit({
    if (had) {
      assign(name, previous, envir = table)
    } else {
      rm(list = name, envir = table)
    }
  })
  eval(substitute(code), envir = parent.frame())
}

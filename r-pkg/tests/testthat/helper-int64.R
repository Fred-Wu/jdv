# Fixed two's-complement fixtures, independent of the product decimal parser.
int64_fixture <- function(values) {
  hex <- c(
    "0" = "0000000000000000",
    "1" = "0000000000000001",
    "2" = "0000000000000002",
    "3" = "0000000000000003",
    "-1" = "ffffffffffffffff",
    "-2" = "fffffffffffffffe",
    "9007199254740991" = "001fffffffffffff",
    "9007199254740992" = "0020000000000000",
    "9007199254740993" = "0020000000000001",
    "9007199254740994" = "0020000000000002",
    "-9007199254740993" = "ffdfffffffffffff",
    "9223372036854775807" = "7fffffffffffffff",
    "-9223372036854775807" = "8000000000000001"
  )
  words <- unname(hex[values])
  words[is.na(values)] <- "8000000000000000"
  stopifnot(!anyNA(words))
  bytes <- as.raw(unlist(lapply(
    words,
    function(word) {
      as.raw(strtoi(substring(word, seq(15L, 1L, -2L), seq(16L, 2L, -2L)), 16L))
    }
  )))
  structure(
    readBin(
      bytes,
      what = "double",
      n = length(values),
      size = 8L,
      endian = "little"
    ),
    class = "integer64"
  )
}

#' Query semantics and internal R contract
#'
#'
#' This specification describes the internal Paged query engine and its Snapshot
#' reference consumer. All functions below are private to the jdv namespace. The
#' contract defines row selection, ordering, pagination, validation, and shared
#' fixtures for later server and browser consumers.
#'
#' The engine operates on data frames and matrices. Columns are identified by
#' their **zero-based positions**, so duplicate or unusual column names are
#' valid. Returned `row_index` values are the
#' **original one-based R row numbers**.
#'
#'
#' @section Source slicing contract:
#'
#'
#' For a data frame, jdv reads each column with `x[[j]]` and selects rows by
#' applying that column's `[` method. It never calls table-level `[`, including
#' `[.data.table`, `[.tbl_df`, or `[.sf`. For a matrix it selects a column and
#' rows with `x[rows, j]`. Extraction does not call `unclass()` or coerce a
#' source column before its own subset method runs. Filtering and sorting use
#' each full column first; only after the original row indices are fixed does
#' paging slice the requested rows. Classes that need table-level behavior
#' require a future source adapter.
#'
#' Paged registration retains the source object and a fixed initial schema. A
#' request checks a lightweight fingerprint of dimensions, column names, and
#' column classes. It cannot detect value-only mutation through a shared
#' reference; callers must register again after changing values. Re-registration
#' builds a new holder and cache before replacing the current generation.
#'
#'
#' @section Internal entry points:
#'
#'
#' | Function | Result and purpose |
#' | --- | --- |
#' | `paged_table(x, collation = "C", limits = list())` | A `jdv_paged_table` environment holding the source, initial schema, probe diagnostics, and bounded caches. |
#' | `query_indices(holder, sort = list(), filter = NULL)` | Original one-based row numbers after filtering and sorting. |
#' | `query_page(holder, offset = 0L, limit = 200L, sort = list(), filter = NULL, cols = NULL)` | A page with totals, effective pagination, original row numbers, optional row names, and selected column extraction results. |
#' | `query_clear(holder)` | Clear all result caches while retaining the same source and initial schema. Returns the holder invisibly. |
#' | `query_dispose(holder)` | Clear caches and release source/schema references. Subsequent queries fail with `view_not_found`. |
#' | `snapshot_table(x, collation = "C", limits = list())` | Eagerly materialized channels for the independent Snapshot reference consumer. |
#' | `snapshot_indices(snapshot, sort = list(), filter = NULL)` | Reference row selection and stable ordering from those materialized channels. |
#'
#' For example, this internal R request sorts column zero in descending order
#' and returns the first twenty rows, displaying columns zero and two:
#'
#' ```r
#' holder <- jdv:::paged_table(x)
#' page <- jdv:::query_page(
#'   holder,
#'   offset = 0L,
#'   limit = 20L,
#'   sort = list(list(col = 0L, desc = TRUE)),
#'   cols = c(0L, 2L)
#' )
#' ```
#'
#' `sort` is an unnamed list of objects containing exactly `col` and `desc`.
#' `desc` is a required, scalar, nonmissing Boolean. A scalar integer-valued
#' plain R double is a valid selector, as is an R integer; Boolean, complex,
#' classed, nonfinite, missing, fractional, or out-of-range selectors are
#' invalid. Sort columns and page columns must not repeat.
#'
#' The holder's source, initial schema, and collation belong to one fixed table
#' version. Rebuild the holder when source, schema, or the owning registry's
#' generation changes. `query_clear()` alone does not change any of them. The
#' holder itself does not assign table IDs or manage registry generations.
#'
#'
#' @section Bounded registration and requested computation:
#'
#'
#' Registration probes the first 32 rows by default. For a matrix, it slices and
#' probes the first column once and reuses that homogeneous type/schema result
#' for all column positions and names. It retains the original matrix rather
#' than extracting every full column. For a data frame, it probes a finite row
#' slice of each existing column reference. Probe extraction includes display,
#' missingness, values, and sort keys; it does not compute full-column filter
#' text.
#'
#' Registration does not create automatic row names or a full `row_index`
#' vector. Without a sort or filter, original row order is generated when
#' requested. Page display extracts actual requested row slices: `x[rows, j]`
#' for a matrix, or a class-preserving slice of a data-frame column. Display is
#' formatted for that slice, independently of full-column filter text.
#'
#' A filter or sort retrieves only its referenced full source columns and
#' required channels. An `other` text filter requests the full column's
#' `format()` output at that point. It never substitutes a page's display text.
#' Custom subsetting must preserve the column class and requested row count.
#' Atomic S3 classes without a subset method retain their metadata; classes with
#' row-dependent attributes must supply suitable subsetting behavior.
#'
#' Three least-recently-used caches have separate entry limits:
#'
#' | Cache | Default entries | Contents |
#' | --- | ---: | --- |
#' | Source column | 32 | Successfully retrieved full source columns. |
#' | Channel | 32 | Successful full-column channel results, keyed by column and channel. |
#' | Index | 8 | Filtered/sorted row indices, keyed by the validated request. |
#'
#' Hits refresh recency, and insertion evicts the least recent entry beyond the
#' configured count. These are entry limits, not byte or total-memory
#' guarantees; one column or index can still be large. Every request is
#' validated before an index-cache hit can be reused.
#'
#' Failed channel and index computations are not cached. A successfully fetched
#' source column can remain cached after its channel computation fails. A
#' repaired method can therefore succeed on a subsequent channel request without
#' clearing the holder, provided its fixed initial schema permits that
#' operation. A repair that changes a capability rejected by the initial probe
#' requires rebuilding the holder. Probe diagnostics remain attached to the
#' original schema.
#'
#' jdv's own query code does not change RNG or options. Arbitrary class methods
#' can have side effects, and a query boundary is not a transaction around them.
#'
#'
#' @section Validation and default limits:
#'
#'
#' Object fields are strict: missing required fields, duplicate fields, unknown
#' fields, malformed objects, or unknown operators are errors. `NULL` filter
#' means no filtering. JSON objects and arrays correspond to ordinary named and
#' unnamed R lists respectively; no request string is evaluated as R code.
#'
#' | Limit key | Default | Meaning |
#' | --- | ---: | --- |
#' | `probe_rows` | 32 | Maximum registration probe rows. |
#' | `max_columns` | 4096 | Maximum registered table columns. |
#' | `page_rows` | 2000 | Maximum returned rows per page; larger requested limits are clamped. |
#' | `page_columns` | 256 | Maximum selected page columns; excess is an error. |
#' | `sort_columns` | 16 | Maximum sort terms. |
#' | `ast_depth` | 32 | Maximum filter depth, counting the root as depth one. |
#' | `ast_nodes` | 256 | Maximum total filter nodes and maximum factor-membership labels. |
#' | `text_bytes` | 4096 | Maximum UTF-8 bytes in each string argument. |
#' | `filter_bytes` | 65536 | Maximum summed UTF-8 bytes in text/date/datetime/decimal/factor-label arguments. |
#' | `column_cache` | 32 | Source-column cache entries. |
#' | `channel_cache` | 32 | Full-column channel cache entries. |
#' | `index_cache` | 8 | Result-index cache entries. |
#'
#' Internal overrides are supplied as a named plain list of recognized keys and
#' positive scalar integers. Their supported range ends at
#' `.Machine$integer.max`; `ast_depth` has an additional ceiling of 128.
#' Operator names are separately bounded to 32 UTF-8 bytes. Factor-label
#' strings, datetime/date strings, and integer64 decimal strings contribute to
#' the total filter-string budget as well as their individual argument limits.
#'
#' `offset` and `limit` are nonnegative finite scalar integers, with
#' integer-valued plain doubles accepted. Values above `2^53` are rejected.
#' `offset` is zero-based within the filtered/sorted result. `limit = 0` and
#' offsets beyond the result produce an empty page; query validation and
#' total-result computation still apply. A larger limit is clamped to
#' `page_rows`.
#'
#' `cols = NULL` selects every column, preserving source order. It does not
#' bypass `page_columns`: a table with more than 256 columns needs an explicit
#' smaller selection or an appropriate internal limit override. Excess columns
#' are never silently omitted. An empty explicit selection returns no data
#' columns while still returning row indices and totals. Selected columns follow
#' selector order.
#'
#'
#' @section Filter AST:
#'
#'
#' Filter objects use these exact fields:
#'
#' | Operator | Required fields | Supported columns |
#' | --- | --- | --- |
#' | `and`, `or` | `op`, `args` (array of child objects) | Any valid children. |
#' | `not` | `op`, `arg` (one child object) | Any valid child. |
#' | `is_na` | `op`, `col` | Any column with a valid missingness channel. |
#' | `contains`, `starts_with`, `ends_with`, `text_equals` | `op`, `col`, `value` | String, factor, filterable other. |
#' | `eq`, `ne`, `lt`, `le`, `gt`, `ge` | `op`, `col`, `value` | Integer, number, date, datetime; integer64 supports only `eq`. |
#' | `between` | `op`, `col`, `lower`, `upper` | Integer, number, date, datetime, integer64. |
#' | `is_true`, `is_false` | `op`, `col` | Boolean. |
#' | `in` | `op`, `col`, `values` (array of labels) | Factor. |
#'
#' Example:
#'
#' ```json
#' {
#'   "op": "and",
#'   "args": [
#'     {"op": "contains", "col": 2, "value": "ber"},
#'     {"op": "between", "col": 0, "lower": 1, "upper": 3},
#'     {"op": "not", "arg": {"op": "is_na", "col": 4}}
#'   ]
#' }
#' ```
#'
#' Logical operators combine Boolean results elementwise. Empty `and` is true
#' for every row; empty `or` is false. `not` performs ordinary Boolean
#' inversion. Missing source values never match a comparison, membership,
#' Boolean, or text leaf. Consequently, negating such a false leaf includes
#' missing rows: use an explicit `not is_na` condition when that inclusion is
#' unwanted.
#'
#' `is_na` uses the source column's missingness mask, including NaN. It is
#' allowed even when `filterable` is false, provided extraction yields a valid
#' mask. Missing meaning never comes from display labels such as the literal
#' string `"NA"`.
#'
#'
#' @section Text:
#'
#'
#' Text comparison folds **ASCII A-Z only** to a-z with `chartr()` after UTF-8
#' conversion. Non-ASCII characters retain their case: `Ä` and `ä` remain
#' distinct. Matching uses fixed literal strings, not regular expressions.
#' Brackets, dots, and asterisks have no pattern meaning. An empty needle
#' matches every nonmissing text for contains/prefix/suffix operations;
#' `text_equals` with an empty value matches only an empty source string.
#'
#' Text sources are:
#'
#' - String: the original, untruncated character value.
#' - Factor: its label.
#' - Other: `format()` over the complete column, computed and cached on request.
#'
#' Number, integer, Boolean, date, datetime, and integer64 columns do not
#' support text operators. List, matrix, and packed data-frame columns have
#' previews but no text-filter capability. Page display truncation or formatting
#' does not alter the filter source. Factor `in` is exact, case-sensitive label
#' membership and does not use text folding; duplicate labels are harmless and
#' an empty label array matches no rows.
#'
#'
#' @section Numeric values and infinity:
#'
#'
#' Numeric leaves compare source values without display rounding or an equality
#' tolerance. Extremely small distinct finite values remain distinct. `between`
#' includes both endpoints and rejects reversed bounds.
#'
#' Queries accept a finite scalar plain R integer/double or one of these
#' objects:
#'
#' ```json
#' {"special": "pos_inf"}
#' ```
#'
#' ```json
#' {"special": "neg_inf"}
#' ```
#'
#' These are the only nonfinite query tokens. Missing/null, NaN, `"nan"`, and
#' `"na"` queries are rejected. Direct nonfinite R numeric arguments are also
#' rejected; use the explicit token. Source -Inf sorts and compares below every
#' finite value, and source Inf above every finite value. NA and NaN source rows
#' remain false at comparison leaves. Materialized number channels recover
#' infinities from `special`; null values alone do not distinguish all cases.
#'
#'
#' @section Date and datetime:
#'
#'
#' Date operands are strings of exactly `YYYY-MM-DD`. Datetime operands require
#' `YYYY-MM-DDTHH:MM:SS`, optionally followed by decimal fractional seconds and
#' either `Z` or an explicit `+HH:MM`/`-HH:MM` offset. With no offset they use
#' the column's timezone, or the local system timezone when the column has no
#' explicit one. Explicit offsets identify instants independently of that local
#' wall time.
#'
#' Invalid calendar dates are rejected. Hours must be 00-23, minutes/seconds
#' 00-59; offset hours/minutes must be within 00-23/00-59. Whitespace, alternate
#' layouts, and trailing content are invalid. A valid-looking datetime that R
#' cannot represent in the timezone is rejected. Daylight-saving gaps and
#' ambiguities otherwise follow R's platform/timezone parser; these inputs do
#' not have a portable normalization guarantee. Fractional seconds use R's
#' representable timestamp precision. Comparisons use canonical day/second
#' values, independently of decorated class display methods.
#'
#'
#' @section Integer64:
#'
#'
#' Integer64 operands must be canonical decimal strings matching `0` or
#' `-?[1-9][0-9]*`, in the finite range
#' `[-9223372036854775807, 9223372036854775807]`. Numeric operands, plus signs,
#' leading zeros, `-0`, whitespace, exponent notation, missing values, overflow,
#' and the reserved NA value `-9223372036854775808` are invalid.
#'
#' `eq` and inclusive `between` compare the original integer64 bits in C,
#' retaining exact distinctions beyond `2^53`. Other numeric operators are
#' unsupported for integer64. Reversed bounds are invalid, and missing rows
#' compare false. A custom integer64 subclass may decorate display through its
#' format method; values, ordering, and filters remain exact C operations.
#'
#'
#' @section Stable multi-column sort:
#'
#'
#' Terms are applied in array order, with independent ascending/descending
#' flags. If a pair of keys is equal, including two missing keys, comparison
#' continues to the next term. If every term ties, original row number breaks
#' the tie in ascending order. NA and NaN are equivalent missing keys and come
#' last in both directions. The source missingness mask overrides any finite key
#' produced for a missing source value; missing keys themselves also sort last.
#'
#' | Column kind | Comparison keys |
#' | --- | --- |
#' | Plain Boolean/integer/number | Numeric values, including restored infinities. |
#' | Plain string, collation `C` | UTF-8 byte/radix order. Paged uses the original strings; Snapshot uses dense numeric ranks. |
#' | String, collation `locale` | R `xtfrm()` keys under the system locale. |
#' | Factor/ordered factor | Factor level codes, regardless of alphabetical label order. |
#' | Date/POSIXct/POSIXlt | Canonical days/seconds. |
#' | Integer64 | C-generated dense ranks with equal keys for equal values. |
#' | Other sortable class | Its `xtfrm()` keys; nonmissing nonfinite keys or keys outside `[-2^53, 2^53]` become dense ranks. |
#'
#' Paged passes the selected keys to one radix `order()` call with a per-term
#' `decreasing` vector and missing values last. It does not use an order
#' permutation as a sort key, because that would lose ties. Character C sorting
#' avoids an unnecessary full-column rank computation in Paged mode.
#'
#' Snapshot consumers must compare supplied numeric keys rather than
#' JavaScript's raw UTF-16 string order or an independent browser locale
#' collation. In the `utf8-byte-order` fixture, U+E000 sorts before U+1F600 (the
#' grinning-face emoji) under C order, whereas raw JavaScript string comparison
#' can reverse them. Locale keys likewise preserve the originating R locale's
#' comparison rather than requesting a new locale sort in the consumer.
#'
#'
#' @section Page results and channel errors:
#'
#'
#' The page result has these fields:
#'
#' | Field | Meaning |
#' | --- | --- |
#' | `total` | Number of rows matching the filter. |
#' | `total_unfiltered` | Original row count. |
#' | `offset` | Validated requested offset. |
#' | `limit` | Effective row limit after clamping. |
#' | `data$row_index` | Original one-based row numbers for this page. |
#' | `data$row_names` | Selected explicit row-name strings, or `NULL` for automatic/absent row names. |
#' | `data$columns` | Selected columns in requested order; each is an extraction result containing `schema`, `data`, and `errors`. |
#'
#' Page column data requests display, missingness, and values only; it does not
#' contain sort keys or full-column filter text. Display is always character
#' text, with missing display results normalized to `"NA"`. A display failure
#' can yield `<class>` fallback text and column diagnostics. Missingness and
#' semantic values remain independent of display. For a number column, `special`
#' distinguishes NA, NaN, Inf, and -Inf when present. Columns without a plain
#' values representation can return display and missingness without values.
#'
#' Page extraction preserves per-channel downgrade diagnostics. Sort/filter
#' requests that require an unavailable full-column channel instead raise a
#' typed query error. Their condition's `details` can contain the extraction's
#' `schema`, `data`, and `errors`; no failed channel result enters the cache.
#' The initial holder schema is not overwritten by a later extraction result.
#'
#' Snapshot wire encoding may omit `display` for string, factor, and integer64
#' columns only when every nonmissing display value equals its semantic value
#' and every missing display value is the standard string `"NA"`. The
#' missingness mask then reconstructs the omitted missing labels. A
#' class-specific formatter that uses another missing label keeps its `display`
#' channel, including when all rows are missing. Zero-row columns use the same
#' equality checks, with empty comparisons treated as equal.
#'
#' Conditions inherit from `jdv_query_error`, `error`, and `condition`, and
#' expose `code`, `message`, and optional `details`:
#'
#' | Code | Typical cause |
#' | --- | --- |
#' | `invalid_request` | Malformed objects, selectors, directions, operands, or reversed bounds. |
#' | `unsupported` | A valid request uses a column capability/type/operator combination that is unavailable. |
#' | `limit_exceeded` | Registration, page width, sort width, AST, or string budget is exceeded. |
#' | `schema_changed` | A column's full shape/class differs from its probe, subsetting changes class/size, or a required channel returns an invalid/missing result. |
#' | `r_error` | Source access, class methods, or another requested R operation fails. |
#' | `view_not_found` | The holder has been disposed. |
#'
#'
#' @section Independent Snapshot reference and shared fixtures:
#'
#'
#' `snapshot_table()` materializes the column channels, including full filter
#' text. Its reference consumer evaluates filters one row at a time and
#' implements lexicographic scalar comparison with a stable merge sort. It does
#' not call the Paged `order()` or vectorized filter evaluator. Request
#' validation, operand parsing, and ASCII folding are shared so accepted
#' requests have one meaning. Integer64 reference filtering compares canonical
#' decimal strings by sign, digit count, and digits rather than converting them
#' to double.
#'
#' For supported inputs with valid required channels, Paged and Snapshot must
#' return identical original row indices for every sort/filter request. Display
#' strings may differ because R format methods can inspect the whole vector or
#' the requested page when choosing a format.
#'
#' The version 1 query fixture ships with the package. Its `fold` entries record
#' ASCII folding. Each `cases` entry describes typed source columns and
#' `queries` with expected original one-based row indices. Number `special`
#' entries reconstruct nonfinite source values; JSON null means missing data.
#' Factor columns include levels and orderedness; datetime columns include
#' timezone metadata.
#'
#' `example-other` uses a synthetic `query_record` class factory: its fixture
#' `values` array supplies the numeric constructor input, with JSON null
#' becoming R missing data. Its `format()` method returns
#' `paste0("value:", as.numeric(x))`, `xtfrm()` returns `as.numeric(x)`, and
#' missingness follows `is.na(x)`. The class's runtime `values` channel is
#' absent (`NULL`). The JSON fixture's numeric factory input is therefore not an
#' `other` column's wire values or a numeric-filter capability.
#'
#' Locate it with:
#'
#' ```r
#' system.file("spec", "query-fixtures.json", package = "jdv")
#' ```
#'
#' Copyright (c) 2026 jdv authors. Distributed under the repository's MIT
#' license.
#'
#' @seealso [jdv_spec]
#'
#' @name jdv_query_spec

NULL

#' Query protocol and R implementation details
#'
#'
#' This specification is organized into four parts: common query protocol, R
#' producer extension, reference host, and browser viewer. The common query
#' contract defines filter and sort semantics, pagination results, and shared
#' conformance data without requiring R. R-specific source access and private
#' query engine details are identified separately. The reference host and
#' browser viewer consume the same wire semantics.
#'
#' Columns are identified by their **zero-based positions**, so duplicate or
#' unusual column names are valid. On the wire, `source_row` values are
#' **zero-based positions in the original source order**.
#'
#'
#' @section Common protocol: Filter AST:
#'
#'
#' Filter objects use these exact fields:
#'
#' | Operator | Required fields | Supported columns |
#' | --- | --- | --- |
#' | `and`, `or` | `op`, `args` (array of child objects) | Any valid children. |
#' | `not` | `op`, `arg` (one child object) | Any valid child. |
#' | `is_na` | `op`, `col` | Any column with a valid missingness channel. |
#' | `contains`, `starts_with`, `ends_with`, `text_equals` | `op`, `col`, `value` | `string`, `categorical`. |
#' | `eq`, `ne`, `lt`, `le`, `gt`, `ge` | `op`, `col`, `value` | `integer`, `number`, `duration`, `date`, `datetime`; `int64` supports only `eq`. |
#' | `between` | `op`, `col`, `lower`, `upper` | `integer`, `number`, `duration`, `date`, `datetime`, `int64`. |
#' | `is_true`, `is_false` | `op`, `col` | `boolean`. |
#' | `in` | `op`, `col`, `values` (array of labels) | `categorical`. |
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
#' Being displayable and being filterable are separate. Value-based filters are
#' limited to an explicit list of schema `type` values, those in the table
#' above; the schema's `filterable` field is true exactly for them. A column of
#' type `list` or `other` has `filterable` false. It is still displayed, sorted
#' when `sortable` is true, and answers `is_na`, but every other operator fails
#' with `unsupported` ("Column is not filterable."). Mapping source-language
#' values to schema types is producer-specific; see the R column mapping section
#' below for the current R producer.
#'
#'
#' @section Common protocol: Text:
#'
#'
#' Text comparison folds **ASCII A-Z only** to a-z. Non-ASCII characters retain
#' their case: `Ä` and `ä` remain distinct. Matching uses fixed literal strings,
#' not regular expressions. Brackets, dots, and asterisks have no pattern
#' meaning. An empty needle matches every nonmissing text for
#' contains/prefix/suffix operations; `text_equals` with an empty value matches
#' only an empty source string.
#'
#' Text sources are:
#'
#' - String: the original, untruncated character value.
#' - Categorical: its label.
#'
#' Number, integer, Boolean, duration, date, datetime, and `int64` columns do
#' not support text operators, and neither do `other` columns. List and other
#' composite columns may have previews but no text-filter capability. Page
#' display truncation or formatting does not alter the filter source.
#' Categorical `in` is exact, case-sensitive label membership and does not use
#' text folding; duplicate labels are harmless and an empty label array matches
#' no rows.
#'
#'
#' @section Common protocol: Blank and non-blank filters:
#'
#'
#' There is no dedicated blank operator; clients combine existing ones. A
#' text-filterable column has a schema `type` of `string` or `categorical` and
#' `filterable` true. For such a column, blank (missing or empty string) is
#'
#' ```json
#' {"op": "or", "args": [
#'   {"op": "is_na", "col": 2},
#'   {"op": "text_equals", "col": 2, "value": ""}
#' ]}
#' ```
#'
#' and non-blank is `{"op": "not", "arg": ...}` wrapped around it. Any other
#' column type has no text filter source, so `text_equals` fails with
#' `unsupported` ("Column has no text filter source."). Such columns have no
#' empty-string value: blank is `{"op": "is_na", "col": N}` and non-blank is
#' `not` applied to it. `is_na` itself is accepted for every column type.
#'
#'
#' @section Common protocol: Numeric values and infinity:
#'
#'
#' Numeric leaves compare source values without display rounding or an equality
#' tolerance. Extremely small distinct finite values remain distinct. `between`
#' includes both endpoints and rejects reversed bounds.
#'
#' A numeric filter operand is a finite JSON number or one of these objects:
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
#' `"na"` queries are rejected. Source negative infinity sorts and compares
#' below every finite value, and source positive infinity above every finite
#' value. Missing and NaN source rows remain false at comparison leaves.
#' Materialized number channels recover infinities from `special`; null values
#' alone do not distinguish all cases.
#'
#'
#' @section Common protocol: Duration:
#'
#'
#' A column with schema `type` `duration` has a `units` field that is one of
#' `secs`, `mins`, `hours`, `days`, or `weeks`. The supported operators are
#' `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between`, and `is_na`; text, `in`, and
#' Boolean operators fail with `unsupported`.
#'
#' A duration operand is either:
#'
#' - a finite JSON number (or an infinity token as described above) in the
#'   column's own units, so `5` on a column in `mins` means five minutes; or
#' - a string `[-]H:MM:SS[.fff]`: an optional minus sign, one or more digits of
#'   hours, two digits each of minutes and seconds (00-59), and an optional
#'   decimal fraction of seconds. It is converted to seconds and then to the
#'   column's units. Anything else, such as `1:5:00`, `1:60:00`, `1:00`, an
#'   ISO date, or a string with a sign other than `-` or with whitespace, is
#'   `invalid_request`. No date or timezone is involved.
#'
#' Units are converted by these factors: 1 for `secs`, 60 for `mins`, 3600 for
#' `hours`, 86400 for `days`, and 604800 for `weeks` (a week is 7 days).
#' Comparisons are between numeric values in the column's units, without any
#' display rounding: the fractional seconds that the display text shows are not
#' used, so a value displayed as `0:00:01` can be larger than a `0:00:01`
#' operand. A clock-time operand that is not exactly representable in the
#' column's units, such as one second in `mins`, is subject to ordinary
#' floating-point rounding. As for numbers, `NA` and `NaN` never match a
#' comparison, and infinities are restored from `special`.
#'
#'
#' @section Common protocol: Date and datetime:
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
#' layouts, and trailing content are invalid. Comparisons use canonical
#' day/second values, independently of producer-defined display strings.
#'
#'
#' @section Common protocol: `int64`:
#'
#'
#' `int64` operands must be canonical decimal strings matching `0` or
#' `-?[1-9][0-9]*`, in the finite range
#' `[-9223372036854775807, 9223372036854775807]`. Numeric operands, plus signs,
#' leading zeros, `-0`, whitespace, exponent notation, missing values, overflow,
#' and the reserved NA value `-9223372036854775808` are invalid.
#'
#' `eq` and inclusive `between` compare exact integer values, retaining
#' distinctions beyond `2^53`. Other numeric operators are unsupported for
#' `int64`. Reversed bounds are invalid, and missing rows compare false.
#'
#'
#' @section Common protocol: Stable multi-column sort:
#'
#'
#' Terms are applied in array order, with independent ascending/descending
#' flags. If a pair of keys is equal, including two missing keys, comparison
#' continues to the next term. If every term ties, original row number breaks
#' the tie in ascending order. Missing values, including NaN, are equivalent
#' missing keys and come last in both directions. The source missingness mask
#' overrides any finite key produced for a missing source value; missing keys
#' themselves also sort last.
#'
#' | Protocol column type | Comparison keys |
#' | --- | --- |
#' | `boolean`, `integer`, `number`, `duration` | Numeric values, including restored infinities. |
#' | `string`, collation `C` | UTF-8 byte order. |
#' | `string`, collation `locale` | The producer's selected locale order. |
#' | `categorical` | Level order as declared by the schema. |
#' | `date`, `datetime` | Canonical days/seconds. |
#' | `int64` | Exact integer order. |
#' | Other sortable types | Producer-defined order. |
#'
#' Missing keys sort last in both directions. A producer applies the requested
#' terms in array order and uses original source-row position as the final
#' ascending tie-breaker.
#'
#' @section Common protocol: Page results and channel errors:
#'
#'
#' The `grid/rows` protocol result has these fields. Private producer
#' representations may use different field names.
#'
#' | Field | Meaning |
#' | --- | --- |
#' | `total` | Number of rows matching the filter. |
#' | `total_unfiltered` | Original row count. |
#' | `offset` | Validated requested offset. |
#' | `limit` | Effective row limit after clamping. |
#' | `data.source_row` | Zero-based original source positions for this page. |
#' | `data.row_labels` | Selected explicit row-label strings, or `null` when absent. |
#' | `data.columns` | Selected columns in requested order; each contains `schema`, `data`, and `errors`. |
#'
#' Page column data requests display, missingness, and values only; it does not
#' contain sort keys or full-column filter text. Display is always character
#' text, with missing display results normalized to `"NA"`. Missingness and
#' semantic values remain independent of display. For a number or duration
#' column, `special` distinguishes missing, NaN, positive infinity, and negative
#' infinity when present. Columns without a plain values representation can
#' return display and missingness without values.
#'
#' An error object contains a stable `code`, a human-readable `message`, and
#' optional `details`:
#'
#' | Code | Typical cause |
#' | --- | --- |
#' | `invalid_request` | Malformed objects, selectors, directions, operands, or reversed bounds. |
#' | `unsupported` | A valid request uses a column capability/type/operator combination that is unavailable. |
#' | `limit_exceeded` | Registration, page width, sort width, AST, or string budget is exceeded. |
#' | `schema_changed` | The producer detects that the active schema or a required channel no longer matches the view descriptor. |
#' | `producer_error` | The producer fails while accessing data or computing a requested operation. |
#' | `view_not_found` | The view id is missing or closed. |
#'
#'
#'
#' @section R producer extension: Query diagnostics and R conditions:
#'
#'
#' The R producer can downgrade individual page channels and include channel
#' errors in the response. A display failure can yield `<class>` fallback text.
#' Sort/filter requests that require an unavailable full-column channel raise a
#' query error whose details can include the extraction's `schema`, `data`, and
#' `errors`. Failed channel results are not cached, and extraction does not
#' overwrite the registered holder schema. The R package exposes query failures
#' as conditions inheriting from `jdv_query_error`, `jdv_error_<code>`,
#' `jdv_error`, `error`, and `condition` (see [jdv_errors]); these classes are
#' not wire fields.
#'
#'
#' @section R producer extension: Source slicing contract:
#'
#'
#' For a data frame, jdv reads each column with `x[[j]]` and selects rows by
#' applying that column's `[` method. It never calls table-level `[`, including
#' `[.data.table`, `[.tbl_df`, or `[.sf`. For a matrix it selects a column and
#' rows with `x[rows, j]`. Extraction does not call [base::unclass()] or coerce
#' a source column before its own subset method runs. Filtering and sorting use
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
#' @section R producer extension: Internal entry points:
#'
#'
#' | Function | Result and purpose |
#' | --- | --- |
#' | `paged_table(x, collation = "C", limits = list())` | A `jdv_paged_table` environment holding the source, initial schema, probe diagnostics, and bounded caches. |
#' | `query_indices(holder, sort = list(), filter = NULL)` | Original one-based R row numbers after filtering and sorting. |
#' | `query_page(holder, offset = 0L, limit = 200L, sort = list(), filter = NULL, cols = NULL)` | A private R page with totals, effective pagination, one-based `data$row_index`, optional `data$row_names`, and selected column extraction results. |
#' | `query_clear(holder)` | Clear all result caches while retaining the same source and initial schema. Returns the holder invisibly. |
#' | `query_dispose(holder)` | Clear caches and release source/schema references. Subsequent queries fail with `view_not_found`. |
#' | `snapshot_table(x, collation = "C", limits = list())` | Eagerly materialized channels for the independent Snapshot reference consumer. |
#' | `snapshot_indices(snapshot, sort = list(), filter = NULL)` | Reference row selection and stable ordering from those materialized channels. |
#'
#' These are private R representations. `query_page()` retains one-based
#' `data$row_index` and `data$row_names`; Snapshot channel data uses `sortKey`,
#' and R schemas retain `class` plus R type `factor`. At JSON encoding, the
#' producer converts these to the protocol forms `source_row` (zero-based),
#' `row_labels`, `sort_key`, `native_type`, and type `categorical`. The wire
#' conversion does not change the private query result contract.
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
#' @section R producer extension: Bounded registration and requested computation:
#'
#'
#' Registration probes the first 32 rows by default. For a matrix, it slices and
#' probes the first column once and reuses that homogeneous type/schema result
#' for all column positions and names. It retains the original matrix rather
#' than extracting every full column. For a data frame, it probes a finite row
#' slice of each existing column reference, except that attribute-free logical,
#' integer, and double columns whose implicit class dispatches only to the
#' package's default column methods are probed once per type and the result is
#' shared by every such column. Columns with a class, attributes, or any
#' user-defined column method are always probed individually. Probe extraction
#' includes display, missingness, values, and sort keys; it does not compute
#' full-column filter text.
#'
#' Registration does not create automatic row names or a full `source_row`
#' vector. Without a sort or filter, original row order is generated when
#' requested. Page display extracts actual requested row slices: `x[rows, j]`
#' for a matrix, or a class-preserving slice of a data-frame column. Display is
#' formatted for that slice, independently of full-column filter text.
#'
#' A filter or sort retrieves only its referenced full source columns and
#' required channels. A text filter requests the full column's text at that
#' point and never substitutes a page's display text. Custom subsetting must
#' preserve the column class and requested row count. Atomic S3 classes without
#' a subset method retain their metadata; classes with row-dependent attributes
#' must supply suitable subsetting behavior.
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
#' configured count. Independently, each holder keeps its latest successfully
#' computed filtered/sorted row index outside these caches and the
#' `jdv.max_cache_bytes` budget. This lets consecutive pages for one query reuse
#' the index even when the index-cache entry limit or byte budget would evict
#' it. A different query or an unfiltered page releases the latest-index slot;
#' an older result can remain in the LRU index cache if admitted there.
#' `query_clear()`, generation replacement, and view close release both the slot
#' and caches. The retained index can be large, so it adds at most one query
#' result index per open view outside the caches. Cache entry limits are not
#' byte or total-memory guarantees; one column or index can still be large.
#' Every request is validated before an index can be reused.
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
#' @section R producer extension: Validation and default limits:
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
#' `cols = NULL` selects every column, preserving source order, and is not
#' subject to `page_columns`. Before extracting page channels, jdv estimates a
#' row count that fits the selected schemas, page work budget, and JSON message
#' budget. It preserves every selected column and reduces the effective page
#' `limit`; if the fixed schema or one row cannot fit, it returns
#' `limit_exceeded`. Final JSON encoding can shorten the page further for
#' unusually large values or custom formatters. Explicit `cols` arrays remain
#' limited by `page_columns` (256 by default). An empty explicit selection
#' returns no data columns while still returning row indices and totals.
#' Selected columns follow selector order. Table width is otherwise bounded by
#' descriptor and response message budgets rather than a fixed registration
#' column count.
#'
#'
#' @section R producer extension: R date and datetime parsing:
#'
#'
#' A valid-looking datetime that the R producer cannot represent in the selected
#' timezone is rejected. Daylight-saving gaps and ambiguities follow the R
#' platform/timezone parser and have no portable normalization guarantee.
#' Fractional seconds use R's representable timestamp precision.
#'
#'
#' @section R producer extension: R column mapping (informative):
#'
#'
#' This section is informative. It describes how the current R implementation
#' (the jdv package) assigns a schema `type` to a column, and it is not part of
#' the protocol. Which R classes and vectors map to which `type` can change from
#' release to release without a protocol version change. Clients decide behavior
#' from `type`, `filterable`, and `sortable`, never from the producer-defined
#' `native_type` display strings; see the Column types section of [jdv_spec].
#'
#' | R column | Schema `type` | Notes |
#' | --- | --- | --- |
#' | Logical vector without a class | `boolean` | |
#' | Integer vector without a class | `integer` | |
#' | Double vector without a class | `number` | |
#' | Character vector without a class | `string` | |
#' | Factor, including ordered factors | `categorical` | `levels` and `ordered` come from the factor. |
#' | `Date` | `date` | |
#' | `POSIXct` and `POSIXlt` | `datetime` | `tz` is the time-zone setting of the vector. |
#' | [base::difftime()], including classes that extend it such as `hms` | `duration` | `units` is the `units` attribute (always `secs` for `hms`). |
#' | `difftime` whose `units` attribute is missing or not one of the five known units | `other` | The units cannot be converted. |
#' | `integer64` | `int64` | |
#' | List without a class | `list` | Not sortable and not filterable. |
#' | Matrix or data-frame column | `other` | Not sortable and not filterable. |
#' | Complex and raw vectors | `other` | Not sortable and not filterable. |
#' | Any other S3 or S4 class | `other` | Displayed through [base::format()] and sorted through [base::xtfrm()] when sortable; answers `is_na`. |
#'
#' The current R producer fills `native_type` with the character vector returned
#' by [base::class()]. This mapping is informative only; clients treat each
#' string as display text and infer no behavior from it. The R producer maps
#' explicit row names to `row_labels` and sends `null` for automatic row names.
#'
#' An atomic vector wrapped only by [base::I()] is classified by its contents,
#' so `I(1:3)` is an `integer` column. An `I()` list is an `other` column that
#' is sortable and drillable but not filterable. `I()` around a classed vector
#' keeps the classification of that class, so an `I()` factor is `categorical`
#' column and an `I()` `difftime` is a `duration` column.
#'
#' The `drillable` field of the schema is true for unclassed list, `AsIs` list,
#' `vctrs_list_of`, data-frame, and matrix columns. It is false for record
#' columns, `POSIXlt`, other classed lists, S4 objects, and atomic columns.
#'
#' A custom `integer64` subclass may decorate display through its format method;
#' values, ordering, and filters remain exact C operations.
#'
#' For `collation: "locale"`, the R producer uses [base::xtfrm()] keys under the
#' system locale. Its paged sort passes selected keys to one radix
#' [base::order()] call and uses the per-term `decreasing` flags with missing
#' values last. It does not use an order permutation as a sort key because that
#' would lose ties. Character C sorting uses the original strings rather than a
#' full-column rank computation.
#'
#'
#' @section Reference host: Snapshot reference and shared fixtures:
#'
#'
#' `snapshot_table()` materializes the column channels, including full filter
#' text. Its reference consumer evaluates filters one row at a time and
#' implements lexicographic scalar comparison with a stable merge sort. It does
#' not call the Paged [base::order()] or vectorized filter evaluator. Request
#' validation, operand parsing, and ASCII folding are shared so accepted
#' requests have one meaning. Integer64 reference filtering compares canonical
#' decimal strings by sign, digit count, and digits rather than converting them
#' to double.
#'
#' Snapshot consumers compare supplied sort keys rather than recomputing the
#' producer's native ordering. The `utf8-byte-order` fixture records that U+E000
#' sorts before U+1F600 under C order. For string, categorical, and integer64
#' columns, a Snapshot may omit `display` only when every nonmissing display
#' value equals its semantic value and every missing display value is `"NA"`.
#' The missingness mask reconstructs omitted missing labels. If a formatter uses
#' another missing label, `display` remains present, including when all rows are
#' missing. Empty comparisons for zero-row columns count as equal.
#'
#' For supported inputs with valid required channels, Paged and Snapshot must
#' return identical original source-row positions for every sort/filter request.
#' Display strings may differ because R format methods can inspect the whole
#' vector or the requested page when choosing a format.
#'
#' The version 1 query fixture ships with the package as shared conformance data
#' for query semantics. Its `fold` entries record ASCII folding. Each `cases`
#' entry describes typed source columns and `queries` with expected zero-based
#' positions in original source order. An `r` member is only an R test-harness
#' construction hint, not a wire field. Number `special` entries reconstruct
#' nonfinite source values; JSON null means missing data. Factor columns include
#' levels and orderedness; datetime columns include timezone metadata; duration
#' columns include `units`, and an `r` of `hms` marks a vector with the
#' `c("hms", "difftime")` class structure.
#'
#' `example-other` uses a synthetic `query_record` class factory: its fixture
#' `values` array supplies the numeric constructor input, with JSON null
#' becoming R missing data. Its [base::format()] method returns
#' `paste0("value:", as.numeric(x))`, [base::xtfrm()] returns `as.numeric(x)`,
#' and missingness follows `is.na(x)`. The class's runtime `values` channel is
#' absent (`NULL`). The JSON fixture's numeric factory input is therefore not an
#' `other` column's wire values or a numeric-filter capability. Because `other`
#' columns are not filterable, the fixture exercises only display, sorting, and
#' `is_na` for it.
#'
#' Locate it with:
#'
#' ```r
#' system.file("spec", "query-fixtures.json", package = "jdv")
#' ```
#'
#'
#' @section Browser viewer: Consuming query capabilities:
#'
#'
#' A browser viewer builds filter controls from the schema `type` and the
#' operators defined above. It respects `filterable` and `sortable`, and treats
#' an unknown type as display-only while continuing to use the server for
#' filtering and sorting. It preserves the zero-based `source_row` returned by
#' the producer as row identity; a one-based row label shown to a person is
#' presentation only. Producer-defined `native_type` strings are display hints
#' and do not change query behavior. Snapshot viewers use the supplied sort keys
#' instead of JavaScript's raw UTF-16 string order or an independent browser
#' locale collation. In the `utf8-byte-order` fixture, raw JavaScript comparison
#' could reverse the specified order.
#'
#' Copyright (c) 2026 jdv authors. Distributed under the repository's MIT
#' license.
#'
#' @seealso [jdv_spec]
#'
#' @name jdv_query_spec

NULL

# Measuring Snapshot and Paged mode

`mode-bench.py` starts a fresh R process for every case and phase. Point it at
an installed `jdv` library so the measurements cover the package build being
evaluated:

```sh
python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --snapshot-cells 10000,50000,100000
```

The default run compares forced Snapshot and Paged behavior for 10k, 50k, and
100k estimated cells in numeric and mixed tables, plus low- and high-cardinality
strings under both `C` and `locale` collation. It also measures a compact
zero-column data frame with 800 million rows and two large-cell cases.
`giant_cell_auto` puts an 11 MiB value in the first row; with the default
64 MiB work budget its initial Paged probe can return a controlled budget
error, so registration may fail. `giant_late_auto` puts an 11 MiB value at the
first row outside the deterministic 256-row estimate sample and the 32-row
holder probe, then checks that auto registration falls back to Paged within
the default work budget. This demonstrates fallback when a large value is
outside the probe; it does not guarantee registration for every source or
work budget. At the default 64 MiB work budget, forced Snapshot for the 300k
string cases is expected to hit the work limit. To measure those Snapshot
channels with a larger work allowance, use:

```sh
python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --cases strings_low_C,strings_low_locale,strings_high_C,strings_high_locale \
  --phases prepare,snapshot \
  --work-bytes 268435456
```

The 2 million by 8 matrix is opt-in with
`--include-large-matrix` because its Snapshot representation can require a
large amount of memory.

The additional `format`, `rank`, and `sort` phases isolate `col_display()`,
`col_sort_key()`, and actual sorted `jdv_rpc()` behavior. For example, compare
both collations and cardinalities, then exercise the default query-row limit:

```sh
python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --cases strings_low_C,strings_low_locale,strings_high_C,strings_high_locale \
  --phases prepare,format,rank,sort

python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --cases strings_1100000_low_locale \
  --phases prepare,paged,sort
```

The sorted RPC phase reports an unsorted-page baseline, cold and repeated
sorted requests, response status/bytes, first sorted row, and holder cache
bytes. The 1.1 million-row case exceeds the default 1 million-row sort limit;
its unsorted first page remains a separate bounded request. A compact
800-million-row zero-column table can be checked at its tail with:

```sh
python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --cases zero_col_800m \
  --phases prepare,paged,auto
```

To measure the large matrix without attempting its full Snapshot payload:

```sh
python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --cases matrix_2m_x8 \
  --phases prepare,paged,auto
```

To isolate the JSON encoder from table setup and extraction, run a warmup plus
12 repetitions over one prebuilt atomic numeric array:

```sh
python3 r-pkg/dev/mode-bench.py \
  --lib /path/to/jdv-library \
  --cases encoder_100000 \
  --phases prepare,encoder
```

The encoder phase reports each elapsed time, median, output bytes, and child
RSS. Its array construction happens before the encoder timer.

The JSON output reports input preparation separately from the engine phase.
Snapshot channel extraction, R payload construction, and native cJSON encoding
are timed separately. Paged holder probing, page extraction, payload building,
and cJSON encoding are reported separately, with public `jdv_rpc()` time as an
end-to-end reference. The exact Snapshot/page byte counts include the channels
emitted by the current package, including Snapshot sort keys. It also reports
the byte difference from adding eligible text `display` channels back to the
Snapshot payload. Numeric 15-digit, 17-digit, and adaptive 15/17 estimates are
for numeric token bytes only; they do not replace the exact full-message byte
count. These diagnostics and the display-omission comparison run inside the
measured child process, so its peak RSS includes their allocations and the
encoder repetitions. Per-phase RSS is a process high-water mark, not an
isolated cJSON peak measurement.

`wait4` peak RSS and `/proc` high-water RSS include resident memory allocated
through C `malloc`, including cJSON. `wait4_maxrss_kb` is normalized to KiB:
Linux reports `ru_maxrss` in KiB, while macOS reports bytes and the runner
rounds that value up to KiB. Each child measurement also records
`wait4_maxrss_native` and `wait4_maxrss_native_unit`. The runner supports Linux
and macOS; it rejects other platforms rather than assuming their `ru_maxrss`
unit, and Windows is unsupported because this runner uses `fork`/`wait4`.
The macOS unit conversion is covered by focused tests, but the process-level
Darwin path has not been exercised on a macOS host.
The paired `prepare` process has the same input construction and package
startup; subtracting its peak from an engine peak is only a high-water
comparison, not an isolated allocation measurement. Enable `--rprofmem` for
supplemental R allocation counts and sizes. `Rprofmem` is version-dependent
and does not observe C allocations, so use RSS for the combined R and native
peak. The output records R, jdv, jsonlite, and host versions for context.

The runner sets `jdv.max_work_bytes` to 64 MiB, `jdv.max_cache_bytes` to 32
MiB, `jdv.max_query_rows` to 1,000,000, and the message limit to 10 MiB by
default. Override these with `--work-bytes`, `--cache-bytes`, `--query-rows`,
or `--max-message` when isolating a particular budget boundary; each result
records the selected work, cache, and query-row limits.

All temporary logs and allocation profiles are written under a temporary
directory and removed at exit. The runner writes its result JSON to stdout; it
does not change the package or save a benchmark report in the repository.

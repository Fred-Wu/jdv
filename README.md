# jdv: JSON Data Viewer

jdv is an R data viewer and query engine under development. The R package
bundles cJSON and has no required runtime R package dependencies. Optional Arrow
stream support uses `nanoarrow` and, for Arrow objects, `arrow`. Public viewer
APIs are available through `jdv_view()` and `jdv_close()`.

- `r-pkg/`: R package and bundled native code.
- `server/`: reference host for R sessions and browser clients, developed
  alongside the browser interface in `server/web/`.
- `r-pkg/inst/spec/`: shared semantic query fixtures (the protocol is in `?jdv_spec`).
- `tests/`: repository-level validation and integration checks.

## Start the local viewer

With Deno 2.8 or newer, start the reference server from its hosted URL without
cloning the repository:

```sh
deno run -A --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
```

Open the URL from the server's single JSON ready line, then call
`jdv::jdv_view(x)` in R. Data frames and matrices open as tables; other R
objects open in a browsable tree by default. Use a drillable cell's **Open**
button to inspect its captured value as a child view. View breadcrumbs restore
the parent table's query and page. See [server/README.md](server/README.md) for
the browser protocol, connection limits, and platform details.

## Sequential Arrow views

`jdv_view()` can display Arrow `Table` and `RecordBatchReader` objects,
`nanoarrow_array_stream` pointers, and Polars `DataFrame` objects as
forward-only views. These sources require the optional R `nanoarrow` package;
Arrow objects also require `arrow`, and Polars objects require `polars`. The
viewer requests bounded pages with **Load next** and reports an unknown total
while the stream is open. Sequential views do not support random paging,
sorting, or filtering.

The reference server retains opaque Arrow IPC pages so switching views,
reloading, or opening another tab can reuse pages already received. Its default
cache is 256 MiB total and 64 MiB per view. Set `--stream-cache-bytes` or
`--stream-cache-view-bytes` to adjust either limit; set either to `0` to disable
the host cache. Browser display and raw IPC caches have separate bounded
budgets. Once a page is no longer held by either the browser or host, a
forward-only source cannot fetch it again.

On Unix, R connects through a local domain socket; on Windows, the default is a
byte-mode named pipe. Named-pipe ACLs are not hardened. Explicit TCP connections
have no authentication. Windows callback dispatch has been observed inside a
top-level `for` loop because its function-frame count is zero. Windows R GUI,
RStudio, R.app, Esc/Ctrl-C, and other top-level behavior have not been fully
validated; see [the package README](r-pkg/README.md).

## Local development

Install the pinned development tools with [mise](https://mise.jdx.dev/):

```sh
mise install
mise exec -- deno task fmt
mise exec -- deno task lint
mise exec -- deno task check
mise exec -- deno task test:unit
```

`mise.toml` pins Deno 2.9.7 and arf 0.6.0. The unit task does not require R,
arf, or a browser. For the R and browser integration suite, install `jdv` into a
scratch library, select it with `JDV_TEST_R_LIB`, and set `JDV_TEST_BROWSER` to
an existing Chromium executable for Astral. Then run
`mise exec -- deno task test:e2e`. See
[the server test instructions](server/README.md#development) for optional R
packages and browser selection. CI lets Astral acquire its compatible browser;
local tests require the existing `JDV_TEST_BROWSER` executable and disable
automatic downloads.

The manual `Test server` workflow runs formatting, linting, type checks, and
Deno unit tests. The separate manual `E2E test` workflow installs R, jdv,
optional Arrow producers, arf, and Astral-managed Chromium on Ubuntu, Windows,
and macOS. It includes the arf-controlled regressions and the explicit TCP
transport check; the default R connection uses a named pipe on Windows. These
workflows run only when manually dispatched, and their configuration alone does
not establish a passing platform result.

Use usethis for R package development and devtools for documentation, tests,
builds, and checks. Format R files and DESCRIPTION with the installed arity CLI.
From the repository root:

```sh
arity format r-pkg
Rscript r-pkg/dev/check.R
```

The check script builds the source package and runs a CRAN-style check in a
fresh temporary directory. It disables CRAN incoming network checks for local
validation. PDF manual generation is skipped because it needs a TeX toolchain.
Build and check artifacts remain outside the source tree.

To refresh bundled cJSON v1.7.19 without a network connection:

```sh
r-pkg/dev/vendor-cjson.sh --from-patched refs/jgd/r-pkg/src/cjson
```

The script uses Git to apply patches. It verifies the version, reverses the four
recorded local patches, and reapplies them before installing the source. Running
it without arguments fetches the pinned upstream release with the GitHub CLI and
applies the patches.

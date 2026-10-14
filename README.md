# jdv: JSON Data Viewer

jdv is an R data viewer and query engine under development. The R package
bundles cJSON and has no runtime R package dependencies. Public viewer APIs are
available through `jdv_view()` and `jdv_close()`.

- `r-pkg/`: R package and bundled native code.
- `server/`: reference host for R sessions and browser clients, developed
  alongside the browser interface in `server/web/`.
- `spec/`: protocol contracts and shared semantic fixtures.
- `tests/`: repository-level validation and integration checks.

## Start the local viewer

With Deno 2.8 or newer, start the reference server from its hosted URL without
cloning the repository:

```sh
deno run -A --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
```

Open the URL from the server's single JSON ready line, then call
`jdv::jdv_view(x)` in R. Data frames and matrices open as tables; other R
objects open in a browsable tree by default. See
[server/README.md](server/README.md) for the browser protocol, connection
limits, and platform details.

## Local development

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

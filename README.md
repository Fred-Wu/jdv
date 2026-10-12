# jdv: JSON Data Viewer

jdv is an R table engine and data viewer under development. The R package
bundles cJSON and has no runtime R package dependencies. Public viewer APIs
will be added as the engine and transport are developed.

- `r-pkg/`: R package and bundled native code.
- `server/`: reference host for R sessions and browser clients, developed
  alongside the browser interface in `server/web/`.
- `spec/`: protocol contracts and shared semantic fixtures.
- `tests/`: repository-level validation and integration checks.

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

The script uses Git to apply patches. It verifies the version, reverses the four recorded local patches,
and reapplies them before installing the source. Running it without arguments
fetches the pinned upstream release with the GitHub CLI and applies the patches.

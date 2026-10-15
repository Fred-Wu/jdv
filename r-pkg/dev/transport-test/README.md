# Local transport tests

The transport integration tests run the package against a callr-managed local
JSON Lines (JSONL) mock host. The mock uses a Unix-domain socket to verify
`hello`, `view/open`, host-initiated requests, partial and maximum-sized frames,
multi-megabyte output, cancellation and deadline handling, invalid control
messages, duplicate request ids, EOF cleanup, bounded sends, `view/closed`, and
normal transport shutdown. The fixture lives under `tests/testthat/fixtures` so
it is available in source and installed test runs.

Run the focused suite from the repository root with:

```sh
Rscript r-pkg/dev/transport-test/run.R
```

The Unix-domain socket integration case is skipped on Windows. Windows named
pipe and GUI event-loop behavior require a Windows validation run; this local
harness does not claim to validate those paths.

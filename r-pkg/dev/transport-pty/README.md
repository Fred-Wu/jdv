# Interactive transport PTY harness

This Linux development harness uses a real interactive R process attached to a controlling pseudo-terminal and a local Python standard-library TCP or Unix-domain socket peer. It drives the exported `jdv_view()`, `jdv_rpc(NULL)`, and `jdv_close()` APIs. It does not copy transport implementation code.

Build and install the package into an isolated library with the package's `devtools` workflow, then run:

```sh
python3 r-pkg/dev/transport-pty/run.py --lib /path/to/scratch-library --transport uds
python3 r-pkg/dev/transport-pty/run.py --lib /path/to/scratch-library --transport tcp
```

Each R and host subprocess has bounded waits and is terminated and reaped during cleanup. Transcripts and host records are kept in a temporary directory unless `--output` is supplied. The harness reports actual interruption evidence. A successful callback after Ctrl-C is reported as `known_limitation`, not as a delivered interrupt. It never changes the event gate's interrupt-suspension state.

Exit status is 0 when every scenario passes, 1 when any scenario fails, and 2 when there is no failure but at least one scenario is a known limitation.

The harness covers automatic paged-request delivery with a wake notification, method interruption followed by a second request, queueing through an outer sleep and explicit polling after Ctrl-C, non-reentrant sequential callbacks, close from inside a formatting method with a subsequent R command, and idle namespace unload/reload with a second connection. It currently targets Linux because it relies on `pty.fork()` and Unix terminal signal behavior. The socket peer supports both local UDS and loopback TCP.

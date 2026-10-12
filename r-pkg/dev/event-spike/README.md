# Event-loop execution experiment

This standalone C DLL, R fixture, and Python PTY runner compare four paths for
running user-defined `format()` and `xtfrm()` methods. The directory is excluded
from the package build by `^dev$`. There is no new package API, Imports, Rcpp,
C++, or native worker thread. Build products and transcripts stay outside the
repository.

The current proposal for design review is synchronous Snapshot extraction and
Paged reception into a bounded native queue, with execution through a
`busy == 0 && sys.nframe() == 0` gate and host nudges. Explicit synchronous
RPC/poll remains the recovery path for frontends where the gate cannot progress.
This is a practical function-frame gate, not a general proof of prompt waiting,
modal-state exclusion, or transparent user-interrupt propagation. The limits
below require an explicit adoption decision.

## Reproduce

From the repository root, with R, a C compiler, Python 3, and the existing
suggested jsonlite package:

```sh
arity format --check r-pkg/dev/event-spike
python3 r-pkg/dev/event-spike/run.py
```

The default command runs 127 distinct cases: 30 in each original mode and 37 in
`gated`. The evidence recorded here is a 126-case full regression plus the final
two-case targeted interrupt comparison, covering all 127 distinct cases.

```sh
python3 r-pkg/dev/event-spike/run.py --modes gated \
  --scenarios prompt,sleep,readline,browser,browser_eval,reentry,gated_batch,global_mask
python3 r-pkg/dev/event-spike/run.py --modes gated \
  --scenarios gate_error,gate_noninteger,gate_nonscalar,gate_interrupt,gate_interrupt_outer,outer_interrupt
python3 r-pkg/dev/event-spike/run.py --modes direct,poll,task,gated \
  --scenarios top_sleep,top_readline,top_browser,top_browser_eval,top_loop,warning_collected,warning_collected_warn2
```

A fresh `/tmp/jdv-event-spike-*` directory contains `build.log`, `results.json`,
and each case's `transcript.txt`/`state.json`. Fault cases also save
`deferred-state.json` before retry. `--output PATH` requires a new output
directory. The runner copies C into that directory and runs `R CMD SHLIB` there;
it never creates object files in the package source tree.

Each case starts a fresh, genuinely interactive R process with a controlling
PTY and an inherited pipe. An external process supplies request bytes; Ctrl-C
is the PTY terminal interrupt byte. The runner labels states from deliberate
markers and console interaction, rather than a method's call stack. It reads
output while waiting, bounds waits, and terminates/reaps a child after startup
or case failure. The producer thread used by one stress case calls no R API.

## Execution paths

| Mode | Native event entry | R evaluation |
| --- | --- | --- |
| `direct` | Read request bytes | Ungated `R_ToplevelExec` drain |
| `poll` | Queue C-owned bytes only | Explicit poll using `R_UnwindProtect` |
| `task` | Queue C-owned bytes only | Poll inside an R `addTaskCallback` |
| `gated` | Queue bytes, then check the practical frame gate | `R_ToplevelExec` drain only after the gate allows each request |

Reception is limited to 64 bytes per input-handler entry; the queue holds 256
request bytes. Excess requests are counted as dropped. A drain starts at most
eight requests. These bound work counts, not one method's execution time or
native diagnostic I/O wall time. Queue-only reception does not inspect R
objects, including ALTREP objects.

The gate evaluates a prebuilt `sys.nframe()` call with `R_tryEval` in
`R_BaseEnv`, avoiding a function of that name in the global environment. It
requires a nonmissing, nonnegative scalar integer zero and a clear native busy
guard. Every request is checked separately, including after a method returns
from nested event processing. Failed/invalid checks retain the pending request.
Busy nested events only queue bytes.

For this experiment, the handler records both a bare `R_tryEval` measurement
and a measurement inside an additional C-only `R_ToplevelExec` boundary. Their
agreement is checked, and disagreement also defers execution. This tests the
previously unverified assumption that a C top-level boundary necessarily hides
the interrupted expression's function frames. It did not hide them in these
R 4.6.1 observations. The bare diagnostic uses a preserved, prebuilt call and
`R_tryEval`'s own exit boundary, without allocation before that evaluation.

### Short gate interrupt boundary

The wrapped gate uses the interrupt macros from the public
`R_ext/GraphicsDevice.h` header. Their definitions are not copied into this
source. Only the short probe is temporarily suspended. `R_UnwindProtect`
restores the previous publicly declared suspension flag if an allocation/error
jumps before the macro finishes. The enclosing `R_ToplevelExec` contains an exit
from the macro's END when a pending interrupt is delivered. A false return or
invalid result defers the request. Cleanup neither inspects for delivery nor
clears/redispatches private pending-interrupt state. Callback execution is not
wrapped in this temporary suspension.

The test-only one-shot hook can raise an error, produce a nonscalar/noninteger
probe result, or pause inside BEGIN before END. The pause lets the PTY send an
actual SIGINT inside that otherwise very small interval. It is disabled in
normal operation and is not a production API. `gate_failures` records failed
or abnormal/invalid checks; a false `R_ToplevelExec` return does not classify
error versus interrupt.

### Host retry and lifecycle

The runner acts as a host and sends the reserved `~` nudge byte at approximately
50 ms intervals while requests have no terminal completion/drop marker. A
nudge triggers another gate check without adding a request. The receive path
consumes nudge bytes; it does not leave a deferred request represented by a hot
file descriptor. All pending queue work, including work left after an
eight-request drain, needs a later nudge or explicit poll.

A gate failure leaves its request unstarted. A request that has started and
then exits abnormally is marked completed-with-failure and is not automatically
requeued: a method may already have produced side effects. Nudge retries stop
when completion/drop is observed or the source is closed. EOF removes the
input handler and closes its descriptor, stopping automatic retries; already
queued work remains available to an explicit poll.

Normal return/error/interrupt clear the execution guard. Self-close stops the
native source immediately but defers closure release until evaluation cleanup.
The close-and-sleep case checks `source_active=0` inside the method and a broken
pipe on an external write before the method returns. Restart/recursive poll
while busy are rejected. Teardown removes the R task callback, stops the source,
then unloads the DLL. Forced unload of an executing DLL is unsupported.

## Linux evidence

Environment: Ubuntu 24.04.4 LTS, x86_64, R 4.6.1 (2026-06-24), GCC 13.3.0;
observed on 2026-10-12.

- Full regression: `/tmp/jdv-event-spike-_o9ipzdg/`, 126/126 completed checks.
  Original modes each ran 30 cases; gated ran 36, including the original 23.
- Final targeted comparison: `/tmp/jdv-event-spike-11o91ofm/`, 2/2 completed
  checks (`gate_interrupt_outer` and its normal `outer_interrupt` control).
- Earlier gate discovery and fault traces:
  `/tmp/jdv-event-spike-i4ogqt18/` and `/tmp/jdv-event-spike-v08yxjd3/`.

PASS means the experiment completed its observation and resource checks. It
also includes checks that known limitations were recorded; it does not label
every observed path safe for production.

| Situation | Ungated direct | Explicit poll | Task callback | Function-frame gate |
| --- | --- | --- | --- | --- |
| Normal prompt | Runs immediately | Waits for poll | Waits for expression completion | Zero frames; runs immediately |
| Framed `Sys.sleep()` | Runs before outer completion | Waits | Runs after outer completion | Positive frames; waits, then nudge runs it |
| Framed `readline()` | Runs while waiting | Waits | Runs after answer/completion | Positive frames; waits for completion |
| Browser with a suspended function | Runs while debuggee is paused | Waits | Runs after `c` | Positive frames; waits for `c` |
| Evaluate `invisible(42)` inside that browser | Runs while paused | Waits | Runs while debuggee remains paused | Still positive frames; remains pending |
| Bare top-level `Sys.sleep()` / `readline()` | Runs while waiting | Waits | Requires expression completion | One frame; remains pending until return |
| Bare top-level `browser()` | Runs in browser prompt | Waits | Can run after a browser expression | Zero frames; **runs in browser prompt** |
| Top-level 50-million-iteration `for` | POSIX input entry not dispatched until completion | Same | Same | Same; this is an event-loop observation, not a frame-gate proof |
| Nested event during a method's sleep | Guard queues the second request | Queue only | Queue only | Queue only; fresh gate before the next method |
| Method `stop()` / busy restart / recursive poll | Captured; next request works | Unwinds; next poll works | Fixture catches ordinary errors | Captured; next request works |
| Ctrl-C in a method | Captured; can leave interrupted outer work running | Propagates after cleanup | Removes task registration | Callback stops; next request works; tested outer function had already completed |
| Normal Ctrl-C in an outer sleep | Outer stops | Outer stops | Outer stops | Outer stops; next nudge drains pending work |
| Ctrl-C inside short suspended gate while outer sleep is active | Not applicable | Not applicable | Not applicable | Gate fails/defer; **outer sleep continues** |
| EOF / self-close / unload | Resources released | Same | Same, task removed before unload | Same |

Bare and wrapped frame measurements agreed throughout all normal gated cases.
Framed sleep/readline reached seven frames in these fixtures; framed browser
reached six. Bare top-level sleep/readline reached one. A global
`sys.nframe <- function() stop(...)` mask did not execute. Native reception and
drain maxima remained at 64 bytes and eight requests. Burst/continuous producer
cases accounted for every request as executed, pending, or dropped; a console
expression completed while the finite producer was still running.

The 24-request gated batch finished without poll: three bounded drain entries,
24 gate checks, 24 executions, and no extra execution caused by nudges. For
error/noninteger/nonscalar/SIGINT gate faults, the saved pre-retry state had
`executed=0`, `pending=1`, clear busy guard, and suspension flag restored to zero.
The next nudge executed the request exactly once. A subsequent ordinary outer
Ctrl-C still stopped its expression.

The final outer-gate SIGINT case is a separate interrupt limit: before the
injected END exit, the bare depth was seven. The wrapped gate returned invalid,
the request stayed pending, and native cleanup restored the suspension flag;
however, `OUTER_DONE` appeared after the outer sleep. The normal outer-interrupt
control did not reach that marker. The hook enlarges the timing window to make
it measurable; the normal gate does not pause. Its frequency in normal use is
not measured, and this result must not be described as transparent interrupt
propagation.

### Warnings and user side effects

The existing raw-warning cases remain unchanged as counterexamples. Ungated
execution during an outer sleep hid the warning from that expression's handler
and changed `last.warning` after it returned. Warning-at-prompt behavior differed.

The optional R wrapper uses `withCallingHandlers` and `muffleWarning`, collecting
the warning text into the experimental response. In both `warn=0` and `warn=2`
cases, all four paths collected `"spike method warning"`, completed `xtfrm()`,
and preserved the sampled `last.warning`, RNG, and options state. This is
warning handling within the request boundary, not a transaction around user
code. Intentional method changes to RNG/options/globals remain visible in all
modes. Arbitrary S3/S4 methods, ALTREP access, finalizers, external resources,
recursive event loops, and nonterminating methods are not generally isolated
or proved safe by these fixtures.

## Proposal and adoption limits

The newly tested practical frame gate addresses the original framed
sleep/readline/debugger counterexamples without making users poll after every
request in this command-line Linux frontend. Propose synchronous Snapshot
extraction plus Paged bounded reception/queue, per-request frame-zero gate, and
host retry. Preserve explicit RPC/poll as the fallback and let an integrating
frontend choose its own intentional execution boundary.

The proposal is conditional on design review of the observed tradeoffs. Frame
zero does not distinguish the bare browser prompt from normal console waiting.
It also does not exclude all active top-level evaluation on every OS. The short
gate's containment boundary can consume a user interrupt during an outer
calculation. No private context manipulation or pending-interrupt repair is
attempted here. If these limits are unacceptable, synchronous RPC/poll remains
the conservative alternative; generic Paged requests would then wait for a user
or frontend poll, with an explicit UX cost.

A frontend that keeps a function frame active even while waiting can leave the
gate closed indefinitely. More nudges do not fix this liveness limitation;
explicit integration through RPC/poll is needed. Successful Linux recovery and
later's reference approach are empirical support for a practical contract,
not a universal R/frontend execution guarantee. Adoption and transport changes
remain subject to the design review.

## Windows and macOS: unverified

Neither OS was executed here. The Windows branch is uncompiled and unvalidated.
It creates an `HWND_MESSAGE` window and a one-shot `SetTimer` byte on the main
thread, using the same frame gate and drain. This experiment does not provide a
Windows host nudge sender: manually arm `"~"` after a deferral, or repeat a short
one-shot nudge timer from an external host during testing. Nudges must never be
new requests. EOF is a POSIX pipe-specific case.

From the repository root in interactive Rgui with Rtools:

```r
source("r-pkg/dev/event-spike/build.R")
dll_path <- spike_build()
source("r-pkg/dev/event-spike/fixtures.R")
spike_setup(dll_path, mode = "gated")
spike_capture()
spike_arm(300L, "a")
spike_arm(100L, "a"); Sys.sleep(1)
spike_arm(100L, "~")              # retry pending work after returning
spike_arm(500L, "a"); readline("Answer: ")
spike_arm(100L, "~")
local({spike_arm(500L, "a"); browser()}) # test invisible(42), then c
spike_arm(100L, "~")
spike_arm(500L, "a"); browser()   # distinct bare-browser limit
spike_arm(100L, "a"); for (j in seq_len(50000000L)) spike_loop_value <- j
spike$collect_warnings <- TRUE; options(warn = 2); spike_capture()
spike_arm(100L, "w")
spike_report(file.path(tempdir(), "spike-state.json"))
spike_teardown()
```

These are separate scenarios for fresh processes, not one assertion script.
During the frame-free `for`, record whether `WM_TIMER` is dispatched before the
loop completes and whether the gate reads zero while calculation is active.
Windows may pump messages from interrupt checks, allowing such execution; this
is an unverified limit candidate, not a claimed Windows result. Record the
frontend's interrupt control (e.g. Esc in Rgui), callback/queue recovery, source
removal before unload, and a delay after unload. Test request codes `r`, `e`,
`i`, `c`, `k`, `h`, `t`, and `p` separately. The `r` fixture arms a nested timer
on Windows. The macros' short gate pause/fault hook can be configured through
`spike_native("spike_gate_fault", 200L, 0L)` before the event, but its Windows
SIGINT/control behavior is likewise unverified.

The Python runner can be attempted on macOS command-line R. A passing run would
not validate R.app, RStudio, or another frontend's event scheduling/liveness.

## Provenance and primary references

The gate is independently implemented using R public APIs, based on the
approach in r-lib/later's `sys_nframe`/`at_top_level`. The read-only reference is
later DESCRIPTION version `1.4.8.9000`, commit
`f1d988deb5e9fd26b3af5adee6da454ae7386f9d`. No later function body is copied or
transplanted. No GPL R source implementation or interrupt macro definition is
copied, directly or through later. Public R headers are included and used as
APIs. Source provenance is also documented beside `probe_gate` in C.

- [later frame gate](https://github.com/r-lib/later/blob/f1d988deb5e9fd26b3af5adee6da454ae7386f9d/src/later.cpp) and [POSIX retry approach](https://github.com/r-lib/later/blob/f1d988deb5e9fd26b3af5adee6da454ae7386f9d/src/later_posix.cpp): inspected as references; not runtime dependencies.
- [Writing R Extensions: cleanup and condition boundaries](https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Condition-handling-and-cleanup-code): `R_ToplevelExec` contains nonlocal exits, while `R_UnwindProtect` supplies cleanup.
- [Writing R Extensions: meshing event loops](https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Meshing-event-loops): exceptional package use requires handler cleanup. Installed `R_ext/eventloop.h` states that it is not part of the API and may change.
- [R 4.6.1 POSIX source](https://svn.r-project.org/R/tags/R-4-6-1/src/unix/sys-std.c) and [main-loop source](https://svn.r-project.org/R/tags/R-4-6-1/src/main/main.c): consulted for traversal/self-removal, task removal after abnormal exits, and browser task-handler behavior; implementation bodies are not copied.

# Event-loop execution experiment

This standalone C DLL, R fixture, and Python PTY runner compare five paths for
running user-defined `format()` and `xtfrm()` methods. The directory is excluded
from the package build by `^dev$`. There is no new package API, Imports, Rcpp,
C++, or native worker thread. Build products and transcripts stay outside the
repository.

The design reviewer approved the processing conditions below on 2026-10-12.
Snapshot extraction is synchronous inside `jdv_view()`. Paged requests enter a
bounded native queue and run only after a per-request `busy == 0` and
`R_BaseEnv` `sys.nframe() == 0` check, inside `R_ToplevelExec`. The host nudges
only unfinished requests; explicit RPC/poll provides recovery. Warnings are
collected into responses while preserving `last.warning`, including `warn=2`.
This is a practical function-frame gate, not a general proof of prompt waiting,
modal-state exclusion, or transparent user-interrupt propagation. Its documented
limits were accepted by the design reviewer. After the required interrupt
comparison and an independent 41-case Linux rerun, the reviewer approved
`gated_restore` for Phase 5 on 2026-10-12. Started requests that fail with an
interrupt terminate with an error response and are never automatically retried.
Windows and macOS evidence is still required separately.

## Reproduce

From the repository root, with R, a C compiler, Python 3, and the existing
suggested jsonlite package:

```sh
arity format --check r-pkg/dev/event-spike
python3 r-pkg/dev/event-spike/run.py
```

The default command runs 172 distinct cases: 30 in each original nongated mode
and 41 in each gate variant. Historical frame-gate evidence includes a 126-case
regression and a two-case supplement; the interrupt comparison is recorded
separately below.

```sh
python3 r-pkg/dev/event-spike/run.py --modes gated \
  --scenarios prompt,sleep,readline,browser,browser_eval,reentry,gated_batch,global_mask
python3 r-pkg/dev/event-spike/run.py --modes gated \
  --scenarios gate_error,gate_noninteger,gate_nonscalar,gate_interrupt,gate_interrupt_outer,outer_interrupt
python3 r-pkg/dev/event-spike/run.py --modes direct,poll,task,gated \
  --scenarios top_sleep,top_readline,top_browser,top_browser_eval,top_loop,warning_collected,warning_collected_warn2
python3 r-pkg/dev/event-spike/run.py --modes gated,gated_restore \
  --scenarios gate_interrupt_outer,gate_interrupt,outer_interrupt,gate_prior_true,gate_prior_true_error,gate_prior_true_noninteger,gate_prior_true_nonscalar
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
| `gated` | Original BEGIN/END frame-gate control | Per-request gated `R_ToplevelExec` drain; paired diagnostic evaluation retained |
| `gated_restore` | Save/TRUE/evaluate/restore frame gate | The same gated drain, with one evaluation and no END-triggered delivery |

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

For the original `gated` control, the handler records both a bare `R_tryEval` measurement
and a measurement inside an additional C-only `R_ToplevelExec` boundary. Their
agreement is checked, and disagreement also defers execution. This tested the
previously unverified assumption that a C top-level boundary necessarily hides
the interrupted expression's function frames. It did not hide them in these
R 4.6.1 observations. The bare diagnostic uses a preserved, prebuilt call and
`R_tryEval`'s own exit boundary, without allocation before that evaluation.

### Short gate interrupt boundary

The original wrapped gate uses the interrupt macros from the public
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

The `gated_restore` variant instead saves the public `R_interrupts_suspended`
value, sets it to TRUE for `probe_frame_once`, and restores it directly. It uses
no END macro or explicit interrupt delivery, and does not read or write private
pending state. Its `R_UnwindProtect` cleanup restores the saved value on every
exit. The prebuilt base-environment call is evaluated once per probe, with no
bare diagnostic evaluation. Counters distinguish probe calls from the original
control's extra diagnostic calls.

A test-only setter checks restoration when the initial public flag is TRUE as
well as FALSE. TRUE cases use finite pure methods without an interrupt while
TRUE is held, check the saved value, then deliberately return to FALSE and
check an ordinary interrupt. This does not claim delivery while a caller's own
suspension remains active. Neither gate extends its temporary suspension across
callback execution; the original caller's suspension value is inherited.

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

The design reviewer separately reported an independent gated rerun with 37/37
checks passing. That is reviewer-provided evidence, distinct from this
implementation session's runs listed above.

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

## Interrupt-variant comparison: approved replacement

Linux comparison artifacts:

- Primary outer/prompt/fault comparison: `/tmp/jdv-event-spike-vcnbpi7b/`,
  12/12 cases completed checks across the original and replacement gates.
- Original-TRUE restoration: `/tmp/jdv-event-spike-uozr16_g/`, 8/8 completed
  checks, covering normal, injected error, noninteger, and nonscalar results.
- Complete five-mode regression: `/tmp/jdv-event-spike-mbfpqyy0/`, 172/172
  completed checks: 30 per nongated mode and 41 per gate variant. All original
  gated cases remain in this matrix.
- Strengthened prompt comparison: `/tmp/jdv-event-spike-lc8mvg24/`, 2/2
  completed checks after combining the unrelated sleep and marker into one
  top-level expression and asserting actual retry-state values.

The test now records `GATE`/`GATE_SINGLE`, `STARTED`, `METHOD_BEGIN`, and
`COMPLETED` separately. `executed` means a request was dequeued for an execution
attempt, not that its R method began. A gate failure before dequeue retains the
request; any abnormal exit after dequeue is a terminal failure and is not
retried, even if no method entry occurred.

| Actual Ctrl-C during the paused inspection | Original `gated` control | Single-evaluation `gated_restore` |
| --- | --- | --- |
| Outer `Sys.sleep`, positive depth | END delivered the interrupt inside the gate boundary; outer `OUTER_DONE` appeared | Gate returned positive depth and restored the flag; outer `OUTER_DONE` was absent |
| Request state after that outer case | Unstarted, pending one | Unstarted, pending one; later nudge executed exactly once |
| Prompt, zero depth | Gate failure before dequeue; pending one | Gate passed; after dequeue the callback boundary reported a terminal failure before `METHOD_BEGIN` |
| First unrelated user expression | Finite sleep and completion marker succeeded | Same; no R status/diagnostic expression was evaluated first |
| Subsequent recovery | Pending request executed once | Failed started request was not retried; a new distinct request succeeded |
| Saved suspension FALSE/TRUE | Restored in checked normal/error/type/interrupt paths | Same |
| Subsequent ordinary Ctrl-C | Still effective | Still effective |

In the replacement prompt case, the pre-recovery snapshot had `executed=1`,
`failed=1`, `pending=0`, `cleanups=1`, and no method entry. The first unrelated
expression, `local({Sys.sleep(0.1); spike_marker("UNRELATED_DONE")})`, was sent
before `spike_report` or another R diagnostic could consume an interrupt. Its
marker cannot complete as a separate top-level expression after an interrupted
sleep. A saved JSON snapshot after a retry delay retained one execution, one failure,
one cleanup, zero pending requests, and unchanged method counters. Final
assertions also required exactly one `STARTED|a` and `COMPLETED|a` marker and
unchanged `METHOD_BEGIN|a` count. A new request `b` then completed, bringing the
final counts to two attempts and one failure. These checks use actual state and
markers rather than a command sentinel after an R assertion. This is a changed disposition from
the original control, not a gate failure disguised as deferred success.

For the replacement outer case, the pre-retry snapshot had `executed=0`,
`pending=1`, depth seven, and the saved FALSE flag restored. The ordinary outer
interrupt reached its computation rather than the gate's END boundary. The
subsequent nudge produced one execution. Original-TRUE snapshots retained TRUE
on normal return and error/type rejection, and rejected requests remained
unstarted; the fixture then reset FALSE and confirmed ordinary Ctrl-C.

All replacement observations had `bare_evaluations=0`. Normal probes recorded
one evaluation per gate check; the injected pre-evaluation error intentionally
recorded zero. No END macro, explicit `onintr`, private pending-state inspection
or mutation, or copied GPL implementation was added to the replacement path.
The design reviewer approved this replacement on 2026-10-12 and independently
reran all 41 gated_restore cases successfully. Phase 5 uses this restore-only
gate. This evidence does not prove pending-interrupt absence or universal
interrupt transparency; Windows and macOS outcomes remain unverified.


## Approved processing rule and known limits

The design reviewer approved these conditions for transport implementation:

- Snapshot: extract synchronously within the `jdv_view()` call.
- Paged: receive bounded native bytes into the C queue. Before each request,
  require a clear native busy guard and scalar integer zero from
  `R_tryEval(sys.nframe(), R_BaseEnv)`; then evaluate within `R_ToplevelExec`.
  Retain requests while the gate is closed.
- Retry and recovery: the host sends nudges only while requests are unfinished.
  Preserve explicit RPC/poll, including embedded `jdv_rpc`, for frontends that
  cannot progress through the gate.
- Warnings: collect through `withCallingHandlers` and `muffleWarning` into the
  response, preserving `last.warning` even with `warn=2`.

The original framed sleep/readline/debugger counterexamples are addressed by
this practical gate in the tested Linux frontend. The design reviewer accepted
four remaining limits as part of the contract:

1. Bare top-level `browser()` has zero function frames and allows execution at
   its Browse prompt. The reviewer accepted this as comparable to ordinary
   prompting when no function frame is suspended; the gate does not identify
   all modal states.
2. The original BEGIN/END gate can absorb an outer interrupt. The approved
   restore-only gate fixes that checked Linux case. At an idle prompt, an
   interrupt caught after dequeue terminates that request before or during its
   method; respond with an interrupted error and never automatically retry it.
3. Windows may dispatch `WM_TIMER` during frame-free top-level calculation and
   permit execution between calculation steps. This remains an unverified
   limit candidate requiring Windows manual validation.
4. A frontend that keeps a function frame active while waiting can close the
   gate indefinitely. More nudges do not solve this liveness limit; explicit
   RPC/poll integration is the recovery path.

These limits no longer represent unresolved blockers to the design decision.
Successful observations and later's reference approach support a practical
contract, not a universal R/frontend safety guarantee. The required interrupt
verification and design confirmation are complete for the checked Linux cases.

### Approved interrupt variant for transport

External review promoted the interrupt alternative from an optional improvement
to a prerequisite to Phase 5. The independent `gated_restore` experiment below
implements the proposed save/TRUE/evaluate/restore path. It retains the original
BEGIN/END control and all its observed counterexamples. The replacement was
approved after the independent Linux rerun; production
adoption must retain the stated terminal-failure semantics. This experiment
does not implement transport or settle Windows/macOS support.


### Follow-on host, UI, and platform requirements

The host and UI need to represent pending R responses as busy/awaiting R,
stop nudges after terminal completion or disconnect, and display warnings
collected in responses. Windows manual checks must cover timer dispatch during
top-level calculation and interruption. Frontend validation must cover modal
behavior, frame-held waiting, and the explicit RPC/poll fallback; Linux CLI
results cannot establish those outcomes for other frontends or OSes.

Production queues also require request identity, generation, and expiry;
cancelled, expired, or stale requests must be rejected immediately before
execution. A caught method error/interrupt must become an error response to its
requester. Native markers and one-byte request codes here are experiment
instrumentation, not that production protocol.

## Manual Windows and macOS evidence workflow

Windows/macOS results have not been collected in this environment. The workflow
`.github/workflows/event-spike-manual.yaml` runs only with `workflow_dispatch`;
there are no push, pull-request, or scheduled triggers. A human must publish the
reviewed files to the private repository, select **Manual event-loop
observations** in Actions, choose `windows`, `macos`, or `both`, and click **Run
workflow**. The workflow must exist on the default branch for the dispatch UI to
be available. The human monitors the run and downloads the corresponding
`event-spike-<platform>-<attempt>` artifacts; agents do not start or monitor it.
See [GitHub's manual-run instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

The workflow uses current major action releases checked against the official
repositories: [checkout](https://github.com/actions/checkout),
[setup-python](https://github.com/actions/setup-python),
[upload-artifact](https://github.com/actions/upload-artifact), and
[setup-r](https://github.com/r-lib/actions/tree/v2/setup-r). setup-r selects the
Rtools version suitable for the requested release of R and adds its tools to
PATH. The experiment installs only jsonlite and the optional ConPTY driver; it
does not install or test the public package. All scripts use the independent
`R CMD SHLIB` build and write under the artifact directory.

To run on an existing Windows or macOS installation from the repository root:

```sh
python r-pkg/dev/event-spike/run-os.py --output /path/to/fresh/evidence-directory
python r-pkg/dev/event-spike/run-os.py --validate /path/to/fresh/evidence-directory
```

Use a fresh output directory. Windows needs R/Rtools, jsonlite, Python 3.13,
and preferably `python -m pip install 'pywinpty>=3,<4'`. macOS needs command-line
R, jsonlite, Python, and a working compiler. Version ranges and moving runner
labels intentionally select the current platform; the artifact metadata records
the resolved R/toolchain, OS, image version, Python, and run URL for comparison.

### Windows measurements

Each scenario uses a fresh process and compares `direct`, original `gated`, and
approved `gated_restore`:

- **Rscript:** `windows-top-level.R` is passed directly to Rscript as a file.
  Its 50-million-iteration `for` is not wrapped in a function, `local()`, or
  `source()`. Entry `sys.nframe()` must be zero. A one-shot timer supplies exactly
  one `a` request. Record whether the callback ran in the loop, its gate depth,
  and the loop-boundary native counters. Execution during a zero-frame loop is
  an observation of a known limit candidate, not a test failure. Separate sleep
  and lifecycle cases check positive-frame deferral, source stop, cancelling an
  armed timer, DLL unload, and survival after unload.
- **Rterm:** `windows_runner.py` first forces ConPTY using pywinpty's public
  `PtyProcess.spawn`/`Backend.ConPTY` interfaces. If construction/startup fails,
  it records the reason and tries `Rterm --ess --interactive` with an open stdin
  pipe and an isolated console. Each result records the actual driver. Prompt,
  framed sleep/readline/browser, bare browser, self-close, and interrupt cases
  keep emitted records separate from input echo. Framed waits defer under the
  gates; bare browser behavior remains an observation.
- **Recovery:** a deferred request receives a REPL-armed one-shot `~` timer,
  never a second `a`. If that does not progress, use explicit `spike_poll()` and
  record that fallback. Rscript's nudge fires during another sleep and can remain
  deferred, so its explicit poll is recorded separately. Execution/cleanup
  counts and terminal nudge checks detect duplicate requests.
- **Interrupts:** a detached helper attempts `AttachConsole` followed by
  `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` in the child's console. If it cannot
  attach to ConPTY, pywinpty `sendintr()` sends control byte 0x03 instead. Record
  both the attempted method and observed delivery: an API success alone is not
  delivery evidence. The first unrelated expression is one finite sleep plus a
  completion marker, before R diagnostics. Ordinary outer Ctrl-C is the control
  case. Pause-hook gate cases compare outer delivery, request disposition,
  suspension restoration, terminal retry behavior, and resource recovery. If
  delivery cannot be established, mark the interrupt scenario unverified while
  still requiring its resource checks.
- **Rgui:** `R_PROFILE_USER` loads `windows-rgui-profile.R` and arms a delayed
  timer before the first prompt. The callback records the method and gate depth,
  stops the native source, writes JSON, and exits with `q()`. It does not unload
  a DLL whose callback is executing; unload/guard recovery are checked by the
  separate Rscript/Rterm cases. A hard 15-second timeout kills the owned process
  tree. No callback file means this frontend is unverified, not passed. Esc is
  always unverified.

The ConPTY interfaces and backend enum were checked against
[pywinpty's public wrapper](https://github.com/andfoy/pywinpty/blob/main/winpty/ptyprocess.py)
and [backend definitions](https://github.com/andfoy/pywinpty/blob/main/winpty/enums.py).
The detached helper uses the documented constraint that a
[console control event](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)
requires a shared console; CTRL_C_EVENT cannot be targeted to a nonzero process
group. It never broadcasts an interrupt in the runner's shared console.

### macOS measurements and artifact interpretation

macOS executes the existing POSIX `run.py` matrix for all three comparison modes.
R.app, RStudio, and arf are unverified. The native C source is unchanged by this
workflow; no Windows fix is inferred from Linux checks.

`results.json` contains observed cases with assertion results and unverified
cases with explicit reasons. `metadata.json` records the environment; per-case
`transcript.txt`, state snapshots, DLL build logs, and `runner.log` retain the
trace. The workflow uploads evidence even if preparation or assertions fail.
Missing results, empty observations, empty build/transcript files, incomplete
mandatory Rscript comparisons, or failed resource assertions fail validation.
An unavailable optional frontend/interrupt is not counted as an observed pass.

All child waits have timeouts; forced cleanup targets only owned process trees.
The job also has a 25-minute limit. Hard job cancellation can interrupt artifact
upload, so a missing artifact is not a successful run. A human must return the
run URL and downloaded evidence for the OS acceptance record. A green workflow
means the asserted experiments and evidence checks passed; it does not certify
all frontends or universal callback safety.

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

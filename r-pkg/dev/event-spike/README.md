# Event-loop execution experiment

This isolated experiment compares three paths for running user-defined
`format()` and `xtfrm()` methods. It is excluded from the R package build by
the existing `^dev$` rule. It adds no package API or runtime dependency. The C
DLL is built outside the repository and must never be linked into `src/`.

The proposed production rule is to receive bounded native data at event
boundaries and execute R methods only through an explicit, synchronous
RPC/poll call, or a frontend that supplies an equally explicit execution
boundary. Successful event-loop experiments do not establish that arbitrary
methods can safely run whenever an input handler or timer fires.

## Reproduce on Linux

From the repository root, with R, a C compiler, Python 3, and the already
suggested jsonlite package installed:

```sh
arity format --check r-pkg/dev/event-spike
python3 r-pkg/dev/event-spike/run.py
```

The runner creates a new `/tmp/jdv-event-spike-*` directory, copies the C source
there, runs `R CMD SHLIB`, and starts a fresh interactive R process per case.
It uses a real controlling PTY and an inherited pipe file descriptor. Events
come from the external Python process, and Ctrl-C is the terminal interrupt
byte, not an R condition constructed by a fixture. The runner reads PTY output
while waiting; every wait has a deadline and a failed case terminates its child.
No R API is called from the Python producer thread.

For a smaller rerun or a fresh, explicit output directory:

```sh
python3 r-pkg/dev/event-spike/run.py --modes direct,poll,task \
  --scenarios browser_eval,interrupt,interrupt_nested,reentry,eof,burst,continuous
python3 r-pkg/dev/event-spike/run.py --output /tmp/jdv-event-spike-new-run
```

Use a new output directory for each run. `results.json` contains observations
and checks; each case directory contains `transcript.txt` and `state.json`.
`build.log` records the compiler invocation. Outputs are experimental evidence,
not performance benchmarks. Console timing and continuous-producer byte counts
vary between runs.

## Execution paths and bounds

| Mode | Event entry | R method execution |
| --- | --- | --- |
| `direct` | Read pipe bytes, or consume a Windows timer byte | Drain inside `R_ToplevelExec` in the event callback |
| `poll` | Queue C-owned bytes only | An explicit `spike_poll()` call using `R_UnwindProtect` |
| `task` | Queue C-owned bytes only | `spike_poll()` inside an R `addTaskCallback` function |

The POSIX handler receives at most 64 bytes per entry. Each drain executes at
most eight requests per call. The C queue holds 256 request bytes; excess bytes
are counted as dropped. Queue mode does not inspect or allocate R objects at
the event entry, including ALTREP objects. Native diagnostic output is the only
additional instrumentation at that entry. A remaining queue waits for the next
drain; the direct experiment has no separate continuation scheduler.

These are bounds on bytes and request counts. They do not bound the execution
time of one user method or the wall time of native diagnostic I/O. The spike's
overflow counter is an observation mechanism; a production protocol would need
an explicit overload response or backpressure policy.

A busy flag prevents recursive evaluation. Nested events can queue bytes while
a method sleeps. Normal return, error, and interrupt all clear the execution
guard. A close requested inside a method removes its native event source immediately,
then defers closure release until that execution exits. The close-and-sleep
case checks `source_active=0` inside the method and a broken pipe on a later
write, so an apparently recovered guard cannot conceal a readable-FD spin. Restart and recursive poll from a
running method are explicitly rejected.

EOF removes the POSIX input handler and closes its descriptor. Pending bytes
remain available to an explicit drain; EOF is not allowed to leave a readable
handler spinning. Teardown removes the R task callback first, stops the native
source second, and unloads the DLL last. The experiment also tests close followed
by error, close followed by sleep while another byte arrives, and pending queue
work cancelled before unload. It does not support a method forcibly unloading
the currently executing DLL.

## Linux observations

Observed on 2026-10-12, Ubuntu 24.04.4 LTS, x86_64, R 4.6.1 (2026-06-24), GCC
13.3.0. The final run's artifacts are under
`/tmp/jdv-event-spike-l02l_ftn/`. The full run has 23 scenarios in each of three
modes; all 69 cases completed their checks. Each subprocess must complete its observation and cleanup checks for the
runner to report PASS. PASS does not mean that every observed mode is suitable
for production: callback removal and consumed interrupts are recorded outcomes.

The external runner labels the execution state using deliberately placed
markers and its own console interaction. It does not infer idle state from
`sys.calls()`, a prompt string supplied to a method, or callback success.

| Scenario | Direct event execution | Explicit poll | Task callback |
| --- | --- | --- | --- |
| Prompt waiting | Executes without a console expression | Pending until poll | Pending until a normal expression completes |
| `Sys.sleep()` | Executes before the outer expression completes | Pending until poll | Executes after the outer expression completes |
| `readline()` | Executes while waiting for the answer | Pending until poll | Executes after the answer and outer expression complete |
| `browser()`, continued with `c` | Executes while the debuggee is paused | Pending until poll | Executes after continuing the outer expression |
| `browser()`, evaluate `invisible(42)` first | Executes while the debuggee is paused | Remains pending | Executes while the debuggee is still paused |
| Nested event during a method's sleep | Reentry observed; second method deferred | Reentry only queues bytes | Reentry only queues bytes |
| Method `stop()` | Background wrapper catches it; next request works | Error unwinds; next poll works | Fixture catches ordinary errors; callback remains registered |
| Method warning | Warning behavior depends on the interrupted context | Normal warning behavior | Normal warning behavior within the callback |
| Ctrl-C during a method | Wrapper consumes the interrupt; next request works | Interrupt propagates after native cleanup | Callback is removed; pending work recovers through explicit poll |
| Ctrl-C in a method while outer code is active | Interrupted outer expression still completes | Outer expression does not reach its following marker | Method runs after outer completion; interrupt removes callback |
| Ctrl-C in the outer sleep | Outer expression stops; later requests work | Pending work drains through poll | Pending work drains after the next successful expression |
| Pure method state | RNG/options/warning state unchanged in checked cases | Same | Same |
| Method changing RNG/options/globals | Changes remain visible | Changes remain visible | Changes remain visible |
| EOF | Source removed; no repeated EOF events | Same; pending work remains drainable | Same |
| Self-close, error after close, close while sleeping | Guard and source cleanup complete | Same | Same |
| Restart or recursive poll within a method | Rejected, then next request works | Same | Same |
| Callback removal and DLL unload | Source gone; later write gets broken pipe | Same; pending work discarded | Same; task callback removed before DLL unload |
| 300-byte burst | Every byte executed or counted as dropped | Same | Same |
| Continuous producer | Console expression completed during production | Same | Same |

The 300-byte burst observed a receive maximum of 64 bytes and drain maximum of
eight requests. Direct mode counted 12 dropped requests; queue modes counted
44. Continuous runs also accounted for all bytes as executed, pending, or
dropped, and respected both budgets. Counts are specific to these fixtures.

In the outer-handler fixture, the direct method's warning was not seen by the
interrupted expression's `withCallingHandlers` handler. That warning also
changed `last.warning` after the outer expression returned. A warning at an
otherwise idle prompt did not produce the same saved warning state. Therefore,
background wrapping does not give a transparent warning boundary.

After interrupting a task method, `getTaskCallbackNames()` returned an empty
list in the dedicated recovery case. An explicit poll then executed the pending
request with the native guard clear. This is an observed limit of the automatic
path, not a reason to silently consume user interrupts.

## Processing rule proposed for design review

The strongest available boundary is a synchronous call made intentionally by
the user or integrating frontend. Use event callbacks only to receive bounded
native bytes and record pending requests. Calling an R method inside
`R_ToplevelExec` contains nonlocal exits; it does not establish that the
interrupted object or evaluator is at a safe point.

A generic package cannot treat an event firing as proof of outermost console
waiting. The task-callback alternative also does not supply that proof: this
experiment ran it inside a browser REPL while the debuggee remained active, and
an interrupt removed its registration. An idle flag set by a task callback and
used by a later event would not solve either boundary problem. Automatic task
processing needs an explicit participation contract and frontend-specific
constraints before adoption; it is not the proposed default.

For a viewer, this means that synchronous Snapshot extraction can proceed,
while generic Paged event execution needs an explicit poll or a frontend-owned
execution path. This proposal requires design review before transport work.
The spike has not proved arbitrary S3/S4 methods, finalizers, recursive event
loops, or ALTREP accesses safe. Even seemingly simple reads may execute user
code. User methods can alter RNG, options, warning state, global variables,
connections, and external resources; in-process wrappers cannot generally
isolate or undo those effects.

Observed recovery is evidence for these fixtures on this R/frontend/OS. The
reason to select synchronous processing is its explicit call path and ordinary
unwinding contract, not the number of passing tests.

## Windows and macOS

Windows and macOS were not executed in this environment. The Windows branch is
provided as an uncompiled, unvalidated prototype. It creates an `HWND_MESSAGE`
window on the main thread and uses `SetTimer`; each `WM_TIMER` consumes one
C-owned byte and cancels that timer. It uses the same queue and drain guards.
The PTY runner is POSIX-only; Windows manual testing requires an interactive
frontend such as Rgui plus Rtools.

From the repository root in an interactive R console:

```r
source("r-pkg/dev/event-spike/build.R")
dll_path <- spike_build()
source("r-pkg/dev/event-spike/fixtures.R")
spike_setup(dll_path, mode = "direct") # repeat in fresh processes for poll/task
spike_capture()
spike_arm(300L, "a")                  # prompt waiting
spike_arm(100L, "a"); Sys.sleep(1)    # active outer evaluation
spike_arm(500L, "a"); readline("Answer: ")
spike_arm(500L, "a"); browser()      # try invisible(42), then c
spike_arm(100L, "r")                  # method arms another timer, then sleeps
spike_arm(100L, "e")                  # stop, then send another a
spike_arm(100L, "w")                  # warning
spike_arm(100L, "i")                  # interrupt at INTERRUPT_WAIT
spike_arm(100L, "s")                  # intentional RNG/options/global changes
spike_poll()                         # required to drain in poll mode
spike_report(file.path(tempdir(), "spike-state.json"))
spike_teardown()
```

Run each state separately: the examples are a menu of scenarios, not one test
script. In poll mode, arm and allow the timer to fire before calling
`spike_poll()`. In task mode, wait and then complete an expression. During the
interrupt scenario, use the frontend's interrupt control (for example Esc in
Rgui) and record exactly which control was used. Recheck task callback names,
guards, and a subsequent request. Test self-close codes `c`, `k`, and `h` in
separate sessions, and test `t`/`p` for restart/recursive poll rejection. On
Windows, reentrant timer injection for `r` is supplied by the fixture; EOF is a
POSIX pipe-specific scenario. Record window/timer destruction and a delay after
DLL unload. None of these Windows results are claimed here.

The Python runner can be attempted on macOS's command-line R. It does not
validate R.app, IDE, or other frontend event-loop behavior even if that run
passes.

## Primary references

- [Writing R Extensions: condition handling and cleanup](https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Condition-handling-and-cleanup-code): `R_ToplevelExec` introduces a new top-level context that hides the original condition handlers; `R_UnwindProtect` supplies cleanup during ordinary unwinding.
- [Writing R Extensions: meshing event loops](https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Meshing-event-loops): exceptional package use requires handler cleanup; event notification does not identify an evaluator state.
- Installed `R_ext/eventloop.h` explicitly says the interface is not part of the API and can change without notice.
- [R 4.6.1 POSIX event-loop source](https://svn.r-project.org/R/tags/R-4-6-1/src/unix/sys-std.c): the handler traversal saves the next pointer before invoking the current handler, supporting the EOF self-removal used here. This does not establish safety for deleting another queued handler.
- [R 4.6.1 main-loop source](https://svn.r-project.org/R/tags/R-4-6-1/src/main/main.c): task callbacks use protected evaluation and can be removed after an abnormal exit; browser expression completion also reaches the task-handler path. These source observations describe this version, rather than a stable package execution guarantee.

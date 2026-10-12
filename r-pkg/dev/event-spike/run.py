#!/usr/bin/env python3
"""Exercise a real interactive R event loop; logs and build files stay in /tmp."""
import argparse
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import threading
import time

HERE = Path(__file__).resolve().parent
SCENARIOS = [
    "prompt", "sleep", "readline", "browser", "browser_eval", "reentry", "stop", "warning",
    "interrupt", "interrupt_nested", "outer_interrupt", "state_pure", "state_mutation", "outer_handlers",
    "eof", "self_close", "self_close_error", "self_close_wait", "restart", "recursive_poll", "lifetime", "burst", "continuous",
]


def r_string(value):
    return json.dumps(str(value))


class Session:
    def __init__(self, dll, mode, folder):
        self.folder = folder
        self.text = ""
        self.closed = False
        read_fd, self.write_fd = os.pipe()
        os.set_inheritable(read_fd, True)
        pid, master = pty.fork()
        if pid == 0:
            os.close(self.write_fd)
            os.execvp("R", ["R", "--vanilla", "--interactive", "--no-readline"])
        self.pid, self.master = pid, master
        os.close(read_fd)
        try:
            attrs = termios.tcgetattr(master)
            attrs[3] &= ~termios.ECHO
            termios.tcsetattr(master, termios.TCSANOW, attrs)
            self.wait_for("> ", timeout=8)
            self.send(
                f"source({r_string(HERE / 'fixtures.R')}); "
                f"spike_setup({r_string(dll)}, {read_fd}L, {r_string(mode)}); "
                'spike_capture(); spike_marker("READY")\n'
            )
            self.wait_for("SPIKE|READY", timeout=8)
            self.read_for(0.02)
        except BaseException:
            self.close()
            raise

    def send(self, text):
        os.write(self.master, text.encode())

    def event(self, code):
        if self.write_fd is None:
            raise RuntimeError("event source is closed")
        os.write(self.write_fd, code.encode())

    def read_for(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                return
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not chunk:
                return
            self.text += chunk.decode(errors="replace").replace("\r\n", "\n")

    def wait_for(self, marker, start=0, timeout=8):
        deadline = time.monotonic() + timeout
        while marker not in self.text[start:]:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timeout waiting for {marker!r}; tail={self.text[-2000:]!r}")
            self.read_for(min(0.05, deadline - time.monotonic()))
        return self.text.index(marker, start)

    def command(self, expression, timeout=8):
        start = len(self.text)
        self.send(expression + '; spike_marker("COMMAND_DONE")\n')
        self.wait_for("SPIKE|COMMAND_DONE", start=start, timeout=timeout)
        self.read_for(0.02)
        return start

    def trigger(self, code, mode, wait=True):
        start = len(self.text)
        self.event(code)
        self.wait_for(f"SPIKE_NATIVE|RECEIVED|{code}", start=start)
        if mode == "poll":
            self.send('spike_poll()\n')
        elif mode == "task":
            self.send('invisible(1)\n')
        if wait:
            self.wait_for(f"SPIKE|METHOD_DONE|{code}", start=start)
        return start

    def report(self):
        path = self.folder / "state.json"
        self.command(f"spike_report({r_string(path)})")
        return json.loads(path.read_text())

    def close_writer(self):
        if self.write_fd is not None:
            os.close(self.write_fd)
            self.write_fd = None

    def close(self):
        if self.closed:
            return
        self.close_writer()
        try:
            self.send('q("no", status=0, runLast=FALSE)\n')
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                self.read_for(0.02)
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    break
            else:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        except (OSError, ChildProcessError):
            pass
        finally:
            os.close(self.master)
            self.closed = True
            (self.folder / "transcript.txt").write_text(self.text)


def safe_order(text, first, second):
    a, b = text.find(first), text.find(second)
    return a >= 0 and b >= 0 and a < b


def run_case(dll, mode, scenario, folder):
    folder.mkdir()
    session = None
    observations = {}
    assertions = {}
    try:
        session = Session(dll, mode, folder)
        if scenario in ("prompt", "state_pure", "lifetime"):
            session.event("a")
            session.wait_for("SPIKE_NATIVE|RECEIVED|a")
            session.read_for(0.15)
            observations["dispatched_while_idle"] = "SPIKE|METHOD_DONE|a" in session.text
            if mode == "poll":
                session.command("spike_poll()")
            elif mode == "task":
                session.command("invisible(1)")
            session.wait_for("SPIKE|METHOD_DONE|a")
        elif scenario in ("sleep", "readline", "browser", "browser_eval", "outer_handlers"):
            if scenario == "sleep":
                expression = 'local({spike_marker("OUTER_WAIT"); Sys.sleep(0.5); spike_marker("OUTER_DONE")})'
                code = "a"
            elif scenario == "readline":
                expression = 'local({spike_marker("OUTER_WAIT"); readline("SPIKE_READLINE> "); spike_marker("OUTER_DONE")})'
                code = "a"
            elif scenario in ("browser", "browser_eval"):
                expression = 'local({spike_marker("OUTER_WAIT"); browser(); spike_marker("OUTER_DONE")})'
                code = "a"
            else:
                expression = ('withCallingHandlers(local({spike_marker("OUTER_WAIT"); Sys.sleep(0.5); '
                              'spike_marker("OUTER_DONE")}), warning=function(w) '
                              '{spike$outer_warnings <- spike$outer_warnings + 1L})')
                code = "w"
            session.send(expression + "\n")
            session.wait_for("SPIKE|OUTER_WAIT")
            if scenario == "readline":
                session.wait_for("SPIKE_READLINE> ")
            elif scenario in ("browser", "browser_eval"):
                session.wait_for("Browse[1]>")
            session.event(code)
            session.wait_for(f"SPIKE_NATIVE|RECEIVED|{code}")
            session.read_for(0.15)
            if scenario == "browser_eval":
                browser_start = len(session.text)
                session.send("invisible(42)\n")
                session.wait_for("Browse[1]>", start=browser_start)
                session.read_for(0.02)
                observations["dispatched_while_debugger_still_active"] = f"SPIKE|METHOD_DONE|{code}" in session.text
            observations["dispatched_before_resuming_console"] = f"SPIKE|METHOD_DONE|{code}" in session.text
            if scenario == "readline":
                session.send("answer\n")
            elif scenario in ("browser", "browser_eval"):
                session.send("c\n")
            session.wait_for("SPIKE|OUTER_DONE")
            session.read_for(0.03)
            if mode == "poll":
                session.command("spike_poll()")
            session.wait_for(f"SPIKE|METHOD_DONE|{code}")
            observations["dispatched_before_outer_completion"] = safe_order(
                session.text, f"SPIKE|METHOD_DONE|{code}", "SPIKE|OUTER_DONE"
            )
        elif scenario == "reentry":
            session.trigger("r", mode, wait=False)
            session.wait_for("SPIKE|METHOD_WAIT")
            session.event("a")
            session.wait_for("SPIKE|METHOD_DONE|r")
            session.wait_for("SPIKE|METHOD_DONE|a")
        elif scenario in ("stop", "restart", "recursive_poll"):
            code = {"stop": "e", "restart": "t", "recursive_poll": "p"}[scenario]
            session.trigger(code, mode, wait=False)
            session.read_for(0.15)
            session.trigger("a", mode)
        elif scenario in ("warning", "state_mutation"):
            session.trigger("w" if scenario == "warning" else "s", mode)
            session.read_for(0.05)
        elif scenario == "interrupt":
            session.trigger("i", mode, wait=False)
            session.wait_for("SPIKE|INTERRUPT_WAIT")
            session.send("\x03")
            session.read_for(0.15)
            if mode == "task":
                recovery_start = session.trigger("a", mode, wait=False)
                session.read_for(0.2)
                observations["automatic_task_recovery"] = "SPIKE|METHOD_DONE|a" in session.text[recovery_start:]
                session.command("spike$callbacks_after_interrupt <- getTaskCallbackNames(); spike_poll()")
                session.wait_for("SPIKE|METHOD_DONE|a", start=recovery_start)
            else:
                session.trigger("a", mode)
            observations["interrupt_consumed_by_background_wrapper"] = mode == "direct" and "SPIKE_NATIVE|FINISHED|i|0" in session.text
        elif scenario == "interrupt_nested":
            poll = "spike_poll(); " if mode == "poll" else ""
            session.send('local({spike_marker("OUTER_WAIT"); Sys.sleep(0.7); ' + poll + 'spike_marker("OUTER_DONE")})\n')
            session.wait_for("SPIKE|OUTER_WAIT")
            session.event("i")
            session.wait_for("SPIKE|INTERRUPT_WAIT")
            session.send("\x03")
            session.read_for(0.85)
            observations["outer_expression_completed_after_method_interrupt"] = "SPIKE|OUTER_DONE" in session.text
            observations["method_entered_before_outer_completion"] = (
                "SPIKE|OUTER_DONE" not in session.text or safe_order(session.text, "SPIKE|INTERRUPT_WAIT", "SPIKE|OUTER_DONE")
            )
            if mode == "task":
                session.trigger("a", mode, wait=False)
                session.read_for(0.1)
                session.command("spike_poll()")
                session.wait_for("SPIKE|METHOD_DONE|a")
            else:
                session.trigger("a", mode)
        elif scenario == "outer_interrupt":
            session.send('local({spike_marker("OUTER_WAIT"); Sys.sleep(5); spike_marker("OUTER_DONE")})\n')
            session.wait_for("SPIKE|OUTER_WAIT")
            session.event("a")
            session.wait_for("SPIKE_NATIVE|RECEIVED|a")
            session.send("\x03")
            session.read_for(0.1)
            if mode == "poll":
                session.command("spike_poll()")
            elif mode == "task":
                session.command("invisible(1)")
            session.wait_for("SPIKE|METHOD_DONE|a")
            observations["outer_expression_interrupted"] = "SPIKE|OUTER_DONE" not in session.text
            session.trigger("a", mode)
        elif scenario == "eof":
            session.event("a")
            session.wait_for("SPIKE_NATIVE|RECEIVED|a")
            session.close_writer()
            session.read_for(0.1)
            if mode == "poll":
                session.command("spike_poll()")
            elif mode == "task":
                session.command("invisible(1)")
            session.wait_for("SPIKE|METHOD_DONE|a")
            session.command('spike$eof_events <- spike_status()[["events"]]; Sys.sleep(0.15)')
        elif scenario in ("self_close", "self_close_error", "self_close_wait"):
            code = {"self_close": "c", "self_close_error": "k", "self_close_wait": "h"}[scenario]
            session.trigger(code, mode, wait=False)
            if scenario == "self_close_wait":
                session.wait_for("SPIKE|CLOSE_WAIT|0")
                try:
                    session.event("a")
                    observations["close_during_method_releases_fd"] = False
                except BrokenPipeError:
                    observations["close_during_method_releases_fd"] = True
                session.wait_for("SPIKE|METHOD_DONE|h")
            session.read_for(0.15)
        elif scenario in ("burst", "continuous"):
            if scenario == "burst":
                os.write(session.write_fd, b"a" * 300)
                observations["sent_requests"] = 300
                session.read_for(0.25)
            else:
                os.set_blocking(session.write_fd, False)
                sent = [0]
                producing = threading.Event()
                producing.set()
                def produce():
                    deadline = time.monotonic() + 0.4
                    try:
                        while time.monotonic() < deadline:
                            try:
                                sent[0] += os.write(session.write_fd, b"a" * 32)
                            except BlockingIOError:
                                pass
                            time.sleep(0.005)
                    finally:
                        producing.clear()
                producer = threading.Thread(target=produce, daemon=True)
                producer.start()
                session.read_for(0.03)
                session.command('spike_marker("RESPONSIVE")')
                observations["console_completed_during_production"] = producing.is_set()
                session.read_for(0.45)
                producer.join(timeout=1)
                if producer.is_alive():
                    raise RuntimeError("Producer did not finish")
                os.set_blocking(session.write_fd, True)
                observations["sent_requests"] = sent[0]
            session.command('spike$before_drain <- spike_status(); for (j in seq_len(40L)) spike_poll()')
        else:
            raise ValueError(scenario)

        result = session.report()
        native = result["native"]
        assertions["guard_is_clear"] = native["busy"] == 0 and native["closing"] == 0
        assertions["queue_capacity_respected"] = native["pending"] <= 256
        assertions["receive_budget_respected"] = native["max_receive_bytes"] <= 64
        assertions["drain_budget_respected"] = native["max_drain_requests"] <= 8
        if scenario not in ("burst", "continuous"):
            assertions["no_queue_overflow"] = native["dropped"] == 0
        assertions["every_execution_cleaned_up"] = native["cleanups"] == native["executed"]
        if scenario in ("stop", "restart", "recursive_poll", "interrupt", "interrupt_nested"):
            assertions["recovered_after_failure"] = result["xtfrm_calls"] == 1 and native["failed"] >= 1
        if scenario in ("burst", "continuous"):
            assertions["every_byte_accounted_for"] = native["executed"] + native["pending"] + native["dropped"] == observations["sent_requests"]
            assertions["overflow_observed"] = native["dropped"] > 0
            assertions["multiple_event_entries"] = native["events"] > 1
            observations["dropped_requests"] = native["dropped"]
            if scenario == "continuous":
                assertions["console_responds_during_production"] = observations["console_completed_during_production"]
        if scenario == "reentry":
            assertions["real_nested_event_seen"] = native["reentrant"] >= 1
            assertions["both_requests_complete"] = result["xtfrm_calls"] == 2
        if scenario == "eof":
            assertions["eof_detaches_source"] = native["eof"] == 1 and native["source_active"] == 0
            session.command('stopifnot(spike$eof_events == spike_status()[["events"]])')
            assertions["eof_does_not_spin"] = True
        if scenario == "self_close_wait":
            assertions["source_stopped_before_method_returns"] = result["close_source_active"] == 0 and observations["close_during_method_releases_fd"]
        if scenario in ("self_close", "self_close_error", "self_close_wait"):
            assertions["self_close_finishes"] = native["configured"] == 0 and native["source_active"] == 0
        if scenario in ("prompt", "sleep", "readline", "browser", "browser_eval", "reentry", "state_pure", "eof", "lifetime"):
            assertions["pure_method_preserves_rng_options_warnings"] = all(
                result[key] for key in ("rng_unchanged", "options_unchanged", "warnings_unchanged")
            )
        if scenario == "state_mutation":
            assertions["user_side_effects_are_visible"] = (
                not result["rng_unchanged"] and not result["options_unchanged"] and result["user_global_changed"]
            )
        if scenario == "lifetime":
            completed_before_close = session.text.count("SPIKE|METHOD_DONE|a")
            event_start = len(session.text)
            session.event("a")
            session.wait_for("SPIKE_NATIVE|RECEIVED|a", start=event_start)
            session.read_for(0.05)
        session.command("spike_teardown()")
        if scenario == "lifetime":
            completed_after_close = session.text.count("SPIKE|METHOD_DONE|a")
            assertions["closing_discards_pending_queue_work"] = (
                completed_after_close == completed_before_close if mode != "direct" else True
            )
        try:
            session.event("a")
            observations["write_after_unload_is_broken_pipe"] = False
        except (BrokenPipeError, RuntimeError):
            observations["write_after_unload_is_broken_pipe"] = True
        session.command('stopifnot(!"jdv-event-spike" %in% getTaskCallbackNames()); Sys.sleep(0.05)')
        assertions["survived_after_dll_unload"] = True
        return {
            "mode": mode, "scenario": scenario, "state": result,
            "observations": observations, "assertions": assertions,
            "passed": all(assertions.values()), "log": str(folder / "transcript.txt"),
        }
    except Exception as error:
        return {
            "mode": mode, "scenario": scenario, "passed": False,
            "error": str(error), "assertions": assertions, "observations": observations,
            "log": str(folder / "transcript.txt"),
        }
    finally:
        if session is not None:
            session.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--modes", default="direct,poll,task")
    parser.add_argument("--scenarios", default=",".join(SCENARIOS))
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("The PTY runner is POSIX-only; use the Windows manual procedure")
    output = args.output or Path(tempfile.mkdtemp(prefix="jdv-event-spike-"))
    output.mkdir(parents=True, exist_ok=True)
    print(f"Output: {output}", flush=True)
    source = output / "event_spike.c"
    source.write_bytes((HERE / "event_spike.c").read_bytes())
    extension = subprocess.check_output(["Rscript", "-e", "cat(.Platform$dynlib.ext)"], text=True)
    dll = output / ("jdv_spike" + extension)
    build = subprocess.run(["R", "CMD", "SHLIB", "-o", str(dll), str(source)], cwd=output, capture_output=True, text=True)
    (output / "build.log").write_text(build.stdout + build.stderr)
    if build.returncode:
        print(build.stderr, file=sys.stderr)
        return build.returncode
    results = []
    for mode in args.modes.split(","):
        if mode not in ("direct", "poll", "task"):
            parser.error(f"Unknown mode: {mode}")
        for scenario in args.scenarios.split(","):
            if scenario not in SCENARIOS:
                parser.error(f"Unknown scenario: {scenario}")
            result = run_case(dll, mode, scenario, output / f"{mode}-{scenario}")
            results.append(result)
            print(f"{'PASS' if result['passed'] else 'FAIL'} {mode}/{scenario}", flush=True)
            if not result["passed"]:
                print(result.get("error", result["assertions"]), flush=True)
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    passed = sum(result["passed"] for result in results)
    print(f"{passed}/{len(results)} cases passed; see {output / 'results.json'}", flush=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

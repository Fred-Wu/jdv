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
import re
import termios
import threading
import time

HERE = Path(__file__).resolve().parent
GATED_MODES = ("gated", "gated_restore")
MODES = ("direct", "poll", "task") + GATED_MODES
SCENARIOS = [
    "prompt", "sleep", "readline", "browser", "browser_eval", "reentry", "stop", "warning",
    "interrupt", "interrupt_nested", "outer_interrupt", "state_pure", "state_mutation", "outer_handlers",
    "eof", "self_close", "self_close_error", "self_close_wait", "restart", "recursive_poll", "lifetime", "burst", "continuous",
    "top_sleep", "top_readline", "top_browser", "top_browser_eval", "top_loop",
    "warning_collected", "warning_collected_warn2",
    "gated_batch", "global_mask", "gate_error", "gate_noninteger", "gate_nonscalar", "gate_interrupt", "gate_interrupt_outer",
    "gate_prior_true", "gate_prior_true_error", "gate_prior_true_noninteger", "gate_prior_true_nonscalar",
]
GATED_ONLY = {"gated_batch", "global_mask", "gate_error", "gate_noninteger", "gate_nonscalar", "gate_interrupt", "gate_interrupt_outer", "gate_prior_true", "gate_prior_true_error", "gate_prior_true_noninteger", "gate_prior_true_nonscalar"}


def r_string(value):
    return json.dumps(str(value))


class Session:
    def __init__(self, dll, mode, folder):
        self.folder = folder
        self.text = ""
        self.closed = False
        self.mode = mode
        self.auto_nudge = True
        self.requests_sent = 0
        self.last_nudge = 0
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
        if code != "~": self.requests_sent += len(code)

    def outstanding(self):
        complete = self.text.count("SPIKE_NATIVE|COMPLETED|")
        dropped = self.text.count("SPIKE_NATIVE|DROPPED|")
        return max(0, self.requests_sent - complete - dropped)

    def maybe_nudge(self):
        if (self.mode in GATED_MODES and self.auto_nudge and self.write_fd is not None
                and self.outstanding() and time.monotonic() - self.last_nudge >= 0.05):
            try:
                self.event("~")
            except BrokenPipeError:
                self.auto_nudge = False
            self.last_nudge = time.monotonic()

    def read_for(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.maybe_nudge()
            ready, _, _ = select.select([self.master], [], [], min(0.05, max(0, deadline - time.monotonic())))
            if not ready:
                continue
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
        if scenario in ("top_sleep", "top_readline", "top_browser", "top_browser_eval"):
            start = len(session.text)
            if scenario == "top_sleep":
                session.send("Sys.sleep(0.6)\n")
                session.read_for(0.05)
            elif scenario == "top_readline":
                session.send('readline("SPIKE_READLINE> ")\n')
                session.wait_for("SPIKE_READLINE> ", start=start)
            else:
                session.send("browser()\n")
                session.wait_for("Browse[1]>", start=start)
            session.event("a")
            session.wait_for("SPIKE_NATIVE|RECEIVED|a", start=start)
            session.read_for(0.15)
            if scenario == "top_browser_eval":
                browse_start = len(session.text)
                session.send("invisible(42)\n")
                session.wait_for("Browse[1]>", start=browse_start)
                session.read_for(0.02)
            observations["dispatched_while_waiting"] = "SPIKE|METHOD_DONE|a" in session.text[start:]
            if scenario == "top_readline":
                session.send("answer\n")
            elif scenario in ("top_browser", "top_browser_eval"):
                session.send("c\n")
            else:
                session.read_for(0.5)
            if mode == "poll": session.command("spike_poll()")
            elif mode == "task": session.command("invisible(1)")
            session.wait_for("SPIKE|METHOD_DONE|a", start=start)
        elif scenario == "top_loop":
            start = len(session.text)
            session.send('spike_marker("LOOP_WAIT"); for (j in seq_len(50000000L)) spike_loop_value <- j; spike_marker("LOOP_DONE")\n')
            session.wait_for("SPIKE|LOOP_WAIT", start=start)
            session.read_for(0.05)
            session.event("a")
            session.wait_for("SPIKE|LOOP_DONE", start=start, timeout=12)
            session.wait_for("SPIKE_NATIVE|RECEIVED|a", start=start)
            observations["input_dispatched_inside_top_level_loop"] = safe_order(
                session.text[start:], "SPIKE_NATIVE|RECEIVED|a", "SPIKE|LOOP_DONE"
            )
            if mode == "poll": session.command("spike_poll()")
            elif mode == "task": session.command("invisible(1)")
            session.wait_for("SPIKE|METHOD_DONE|a", start=start)
        elif scenario in ("warning_collected", "warning_collected_warn2"):
            session.command('spike$collect_warnings <- TRUE')
            if scenario == "warning_collected_warn2": session.command("options(warn = 2)")
            session.command("spike_capture()")
            session.trigger("w", mode)
        elif scenario == "global_mask":
            session.command('sys.nframe <- function() stop("global mask must not execute")')
            session.trigger("a", mode)
        elif scenario == "gated_batch":
            session.event("a" * 24)
            deadline = time.monotonic() + 8
            while session.outstanding():
                if time.monotonic() >= deadline: raise RuntimeError("Batch did not complete")
                session.read_for(0.05)
            observations["batch_finished_without_poll"] = True
        elif scenario == "gate_interrupt_outer":
            session.auto_nudge = False
            session.command('spike_native("spike_gate_fault", 200L, 0L)')
            session.send('local({spike_marker("OUTER_WAIT"); Sys.sleep(1); spike_marker("OUTER_DONE")})\n')
            session.wait_for("SPIKE|OUTER_WAIT")
            session.event("a")
            session.wait_for("SPIKE_NATIVE|GATE_SUSPEND_WAIT")
            pause_start = len(session.text)
            session.send("\x03")
            session.wait_for("SPIKE_NATIVE|GATE_SINGLE|" if mode == "gated_restore" else "SPIKE_NATIVE|GATE|", start=pause_start)
            session.read_for(1.2)
            observations["outer_continued_after_gate_interrupt"] = "SPIKE|OUTER_DONE" in session.text
            path = folder / "deferred-state.json"
            session.command(f"spike_report({r_string(path)})")
            deferred = json.loads(path.read_text())
            observations["deferred_state"] = deferred["native"]
            assertions["outer_gate_fault_observed_with_positive_frame"] = (deferred["native"]["wrapped_nframe"] if mode == "gated_restore" else deferred["native"]["bare_nframe"]) > 0
            assertions["fault_does_not_execute_or_consume_request"] = deferred["native"]["executed"] == 0 and deferred["native"]["pending"] == 1
            if mode == "gated_restore":
                assertions["outer_interrupt_propagates"] = not observations["outer_continued_after_gate_interrupt"]
            session.auto_nudge = True
            session.wait_for("SPIKE|METHOD_DONE|a")
        elif scenario == "gate_interrupt":
            session.auto_nudge = False
            session.command('spike_native("spike_gate_fault", 200L, 0L)')
            session.event("a")
            session.wait_for("SPIKE_NATIVE|GATE_SUSPEND_WAIT")
            suspend_start = len(session.text)
            session.send("\x03")
            session.wait_for("SPIKE_NATIVE|GATE_SINGLE|" if mode == "gated_restore" else "SPIKE_NATIVE|GATE|", start=suspend_start)
            session.read_for(0.05)
            unrelated_start = len(session.text)
            session.send('local({Sys.sleep(0.1); spike_marker("UNRELATED_DONE")})\n')
            session.read_for(0.4)
            observations["first_unrelated_expression_completed"] = "SPIKE|UNRELATED_DONE" in session.text[unrelated_start:]
            assertions["no_false_interrupt_in_first_unrelated_expression"] = observations["first_unrelated_expression_completed"]
            path = folder / "post-interrupt-state.json"
            session.command(f"spike_report({r_string(path)})")
            before = json.loads(path.read_text())
            observations["post_interrupt_state"] = before["native"]
            observations["method_entries_before_unrelated_expression"] = session.text[:unrelated_start].count("SPIKE|METHOD_BEGIN|a")
            if before["native"]["executed"] == 0:
                observations["interrupt_disposition"] = "deferred_before_start"
                assertions["unstarted_request_retained"] = before["native"]["pending"] == 1
                session.auto_nudge = True
                session.wait_for("SPIKE|METHOD_DONE|a")
            else:
                observations["interrupt_disposition"] = "terminal_after_start"
                assertions["started_request_is_terminal_failure"] = before["native"]["executed"] == 1 and before["native"]["failed"] == 1 and before["native"]["pending"] == 0
                session.auto_nudge = True
                session.read_for(0.2)
                retry_path = folder / "terminal-retry-state.json"
                session.command(f"spike_report({r_string(retry_path)})")
                after_retry = json.loads(retry_path.read_text())
                observations["terminal_retry_state"] = after_retry["native"]
                observations["terminal_method_entries_after_retry_delay"] = session.text.count("SPIKE|METHOD_BEGIN|a")
                assertions["interrupted_started_request_not_retried"] = (
                    after_retry["native"]["executed"] == before["native"]["executed"] == 1
                    and after_retry["native"]["failed"] == before["native"]["failed"] == 1
                    and after_retry["native"]["cleanups"] == 1
                    and after_retry["native"]["pending"] == 0
                    and after_retry["format_calls"] == before["format_calls"]
                    and after_retry["xtfrm_calls"] == before["xtfrm_calls"]
                    and observations["terminal_method_entries_after_retry_delay"] == observations["method_entries_before_unrelated_expression"]
                )
                session.trigger("b", mode)
            session.send('local({spike_marker("POST_FAULT_WAIT"); Sys.sleep(5); spike_marker("POST_FAULT_DONE")})\n')
            session.wait_for("SPIKE|POST_FAULT_WAIT")
            session.send("\x03")
            session.read_for(0.1)
            session.command('invisible(1)')
            assertions["ordinary_interrupt_still_effective"] = "SPIKE|POST_FAULT_DONE" not in session.text
        elif scenario in ("gate_prior_true", "gate_prior_true_error", "gate_prior_true_noninteger", "gate_prior_true_nonscalar"):
            session.auto_nudge = False
            fault = {"gate_prior_true": 0, "gate_prior_true_error": 1, "gate_prior_true_noninteger": 2, "gate_prior_true_nonscalar": 3}[scenario]
            session.command('spike_native("spike_set_suspend", TRUE)')
            session.command(f'spike_native("spike_gate_fault", 0L, {fault}L)')
            session.event("a")
            session.wait_for("SPIKE_NATIVE|GATE_SINGLE|" if mode == "gated_restore" else "SPIKE_NATIVE|GATE|")
            if fault == 0: session.wait_for("SPIKE|METHOD_DONE|a")
            path = folder / "prior-true-state.json"
            session.command(f"spike_report({r_string(path)})")
            prior = json.loads(path.read_text())
            observations["prior_true_state"] = prior["native"]
            assertions["original_true_flag_restored"] = prior["native"]["interrupts_suspended"] == 1
            if fault:
                assertions["original_true_fault_leaves_request_pending"] = prior["native"]["executed"] == 0 and prior["native"]["pending"] == 1
            session.command('stopifnot(spike_native("spike_set_suspend", FALSE))')
            session.auto_nudge = True
            session.wait_for("SPIKE|METHOD_DONE|a")
            session.send('local({spike_marker("POST_FAULT_WAIT"); Sys.sleep(5); spike_marker("POST_FAULT_DONE")})\n')
            session.wait_for("SPIKE|POST_FAULT_WAIT")
            session.send("\x03")
            session.read_for(0.1)
            session.command('invisible(1)')
            assertions["ordinary_interrupt_after_true_flag_reset"] = "SPIKE|POST_FAULT_DONE" not in session.text
        elif scenario in ("gate_error", "gate_noninteger", "gate_nonscalar"):
            session.auto_nudge = False
            fault = {"gate_error": 1, "gate_noninteger": 2, "gate_nonscalar": 3, "gate_interrupt": 0}[scenario]
            pause = 200 if scenario == "gate_interrupt" else 0
            session.command(f'spike_native("spike_gate_fault", {pause}L, {fault}L)')
            session.event("a")
            if scenario == "gate_interrupt":
                session.wait_for("SPIKE_NATIVE|GATE_SUSPEND_WAIT")
                session.send("\x03")
            session.wait_for("SPIKE_NATIVE|GATE_SINGLE|-1|" if mode == "gated_restore" else "SPIKE_NATIVE|GATE|0|-1|")
            path = folder / "deferred-state.json"
            session.command(f"spike_report({r_string(path)})")
            deferred = json.loads(path.read_text())
            observations["deferred_state"] = deferred["native"]
            assertions["fault_does_not_execute_or_consume_request"] = (
                deferred["native"]["executed"] == 0 and deferred["native"]["pending"] == 1
            )
            assertions["fault_restores_suspend_flag"] = deferred["native"]["interrupts_suspended"] == 0
            session.auto_nudge = True
            session.wait_for("SPIKE|METHOD_DONE|a")
            session.send('local({spike_marker("POST_FAULT_WAIT"); Sys.sleep(5); spike_marker("POST_FAULT_DONE")})\n')
            session.wait_for("SPIKE|POST_FAULT_WAIT")
            session.send("\x03")
            session.read_for(0.1)
            session.command('invisible(1)')
            assertions["ordinary_interrupt_still_effective"] = "SPIKE|POST_FAULT_DONE" not in session.text
        elif scenario in ("prompt", "state_pure", "lifetime"):
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
            observations["interrupt_consumed_by_background_wrapper"] = mode in ("direct",) + GATED_MODES and "SPIKE_NATIVE|FINISHED|i|0" in session.text
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
                session.requests_sent += 300
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
                                written = os.write(session.write_fd, b"a" * 32)
                                sent[0] += written
                                session.requests_sent += written
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
        if mode in GATED_MODES:
            if mode == "gated":
                assertions["paired_nframe_matches"] = native["gate_pair_mismatch"] == 0
            else:
                assertions["single_probe_without_bare_evaluation"] = native["bare_evaluations"] == 0 and native["probe_evaluations"] <= native["gate_checks"]
            assertions["interrupt_suspend_restored"] = native["interrupts_suspended"] == 0
            if scenario in ("sleep", "readline", "browser", "browser_eval", "outer_handlers"):
                assertions["framed_wait_defers_until_outer_completion"] = (
                    not observations["dispatched_before_outer_completion"] and native["max_nframe"] > 0
                )
            if scenario in ("top_sleep", "top_readline"):
                assertions["unwrapped_wait_has_nonzero_frame_and_defers"] = (
                    not observations["dispatched_while_waiting"] and native["max_nframe"] > 0
                )
            if scenario in ("top_browser", "top_browser_eval"):
                assertions["frame_free_browser_counterexample_recorded"] = (
                    observations["dispatched_while_waiting"] and native["max_nframe"] == 0
                )
            if scenario == "gated_batch":
                assertions["nudge_resumes_after_drain_budget"] = native["nudges"] >= 2
                assertions["nudge_does_not_duplicate_requests"] = native["executed"] == 24 and result["xtfrm_calls"] == 24
            if scenario in ("gate_error", "gate_noninteger", "gate_nonscalar"):
                assertions["gate_fault_then_request_recovers_once"] = native["gate_failures"] >= 1 and native["executed"] == 1 and result["xtfrm_calls"] == 1
            if scenario == "gate_interrupt_outer":
                assertions["deferred_request_recovers_once"] = native["executed"] == 1 and result["xtfrm_calls"] == 1
            if scenario == "gate_interrupt" and observations["interrupt_disposition"] == "terminal_after_start":
                assertions["final_counts_prove_no_terminal_retry"] = (
                    native["executed"] == 2 and native["failed"] == 1 and native["cleanups"] == 2
                    and result["format_calls"] == before["format_calls"] + 1
                    and result["xtfrm_calls"] == before["xtfrm_calls"] + 1
                    and session.text.count("SPIKE_NATIVE|STARTED|a") == 1
                    and session.text.count("SPIKE_NATIVE|COMPLETED|a|") == 1
                    and session.text.count("SPIKE|METHOD_BEGIN|a") == observations["method_entries_before_unrelated_expression"]
                    and session.text.count("SPIKE|METHOD_BEGIN|b") == 1
                )

            if scenario == "global_mask": assertions["base_env_ignores_global_mask"] = result["xtfrm_calls"] == 1

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
        if scenario == "top_loop":
            assertions["posix_input_not_dispatched_during_top_level_loop"] = not observations["input_dispatched_inside_top_level_loop"]
        if scenario in ("warning_collected", "warning_collected_warn2"):
            assertions["warning_collected_in_response"] = result["responses"][-1]["warnings"] == ["spike method warning"]
            assertions["collected_warning_preserves_state"] = all(result[key] for key in ("rng_unchanged", "options_unchanged", "warnings_unchanged"))
            assertions["warn_two_does_not_abort_collected_response"] = native["failed"] == 0 and result["xtfrm_calls"] == 1
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
                completed_after_close == completed_before_close if mode not in ("direct",) + GATED_MODES else True
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
    parser.add_argument("--modes", default=",".join(MODES))
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
        if mode not in MODES:
            parser.error(f"Unknown mode: {mode}")
        for scenario in args.scenarios.split(","):
            if scenario not in SCENARIOS:
                parser.error(f"Unknown scenario: {scenario}")
            if scenario in GATED_ONLY and mode not in GATED_MODES: continue
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

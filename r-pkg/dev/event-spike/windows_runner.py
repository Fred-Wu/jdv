#!/usr/bin/env python3
"""Observe Windows timers in Rscript, ConPTY/ESS Rterm, and optional Rgui."""
import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
MODES = ("direct", "gated", "gated_restore")
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def r_string(value):
    return json.dumps(str(value).replace("\\", "/"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def kill_tree(pid, folder):
    result = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                            capture_output=True, text=True, timeout=10)
    (folder / "process-cleanup.txt").write_text(result.stdout + result.stderr, encoding="utf-8")


def run_process(command, folder, timeout, env=None, transcript="transcript.txt"):
    with (folder / transcript).open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, env=env)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stream.write(f"\nHard timeout: {timeout} seconds\n")
            kill_tree(process.pid, folder)
            process.wait(timeout=10)
            return 124


def console_interrupt(pid, folder):
    # A detached helper attaches to this child's isolated console. CTRL_C_EVENT
    # must use group zero; targeting a nonzero process group does not deliver it.
    helper = """
import ctypes, json, sys, time
k = ctypes.WinDLL('kernel32', use_last_error=True)
attached = bool(k.AttachConsole(int(sys.argv[1])))
result = {'attach_console': attached, 'attach_error': ctypes.get_last_error()}
if attached:
    k.SetConsoleCtrlHandler(None, True)
    result['generated'] = bool(k.GenerateConsoleCtrlEvent(0, 0))
    result['generate_error'] = ctypes.get_last_error()
    time.sleep(0.2)
    k.FreeConsole()
print(json.dumps(result))
"""
    try:
        result = subprocess.run([sys.executable, "-c", helper, str(pid)],
                                creationflags=subprocess.DETACHED_PROCESS,
                                capture_output=True, text=True, timeout=5)
        (folder / "console-control.txt").write_text(result.stdout + result.stderr, encoding="utf-8")
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {"generated": False, "reason": str(error)}


class Session:
    def __init__(self, rterm, dll, mode, folder):
        self.folder, self.text = folder, ""
        self.chunks = queue.Queue()
        self.proc = None
        self.driver = None
        self.fallback_reason = None
        try:
            from winpty import Backend, PtyProcess
            # ConPTY's enum is zero; force the environment too for pywinpty's
            # `backend or env` implementation, rather than its default backend.
            self.proc = PtyProcess.spawn([str(rterm), "--vanilla", "--interactive"],
                backend=Backend.ConPTY, env={**os.environ, "PYWINPTY_BACKEND": "0"},
                dimensions=(40, 160))
            self.driver = "ConPTY / pywinpty (forced backend=0)"
            self.reader = threading.Thread(target=self._read, args=(self.proc, self.driver), daemon=True)
            self.reader.start()
            self.wait_text("> ", timeout=10)
        except Exception as error:
            self.fallback_reason = f"ConPTY startup unavailable: {error}"
            if self.proc is not None:
                kill_tree(self.proc.pid, folder)
                try:
                    self.proc.close(force=True)
                except Exception:
                    pass
            self.text += "\n" + self.fallback_reason + "\n"
            self.proc = subprocess.Popen([str(rterm), "--vanilla", "--ess", "--interactive"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NEW_CONSOLE)
            self.driver = "Rterm --ess / open stdin pipe / isolated console"
            self.reader = threading.Thread(target=self._read, args=(self.proc, self.driver), daemon=True)
            self.reader.start()
            self.wait_text("> ", start=len(self.text), timeout=10)
        self.command(f"source({r_string(HERE / 'fixtures.R')}); "
                     f"spike_setup({r_string(dll)}, mode={r_string(mode)}); spike_capture()")

    def _read(self, process, driver):
        try:
            while True:
                if driver.startswith("ConPTY"):
                    chunk = process.read(65536)
                else:
                    chunk = os.read(process.stdout.fileno(), 65536).decode(errors="replace")
                if not chunk:
                    break
                self.chunks.put(chunk)
        except (EOFError, OSError):
            pass

    def read_for(self, seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            try:
                chunk = self.chunks.get(timeout=min(0.05, max(0.001, until - time.monotonic())))
                self.text += ANSI.sub("", chunk).replace("\r\n", "\n").replace("\r", "\n")
            except queue.Empty:
                pass

    def wait_text(self, text, start=0, timeout=8):
        until = time.monotonic() + timeout
        while text not in self.text[start:]:
            if time.monotonic() >= until:
                raise TimeoutError(f"Waiting for {text!r}; tail={self.text[-1500:]!r}")
            self.read_for(0.05)

    def marker_count(self, marker, start=0):
        # Match emitted records, never marker strings echoed in R commands.
        return len(re.findall(r"(?m)^(?:> |Browse\[\d+\]> )?" + re.escape(marker) + r"(?:\||\n|$)", self.text[start:]))

    def wait_marker(self, marker, start=0, timeout=8):
        until = time.monotonic() + timeout
        while not self.marker_count(marker, start):
            if time.monotonic() >= until:
                raise TimeoutError(f"Waiting for emitted {marker!r}; tail={self.text[-1500:]!r}")
            self.read_for(0.05)

    def send(self, expression):
        if self.driver.startswith("ConPTY"):
            self.proc.write(expression.replace("\n", "\r\n"))
        else:
            self.proc.stdin.write(expression.encode())
            self.proc.stdin.flush()

    def command(self, expression):
        start = len(self.text)
        self.send(expression + '; spike_marker("COMMAND_DONE")\n')
        self.wait_marker("SPIKE|COMMAND_DONE", start)
        self.read_for(0.02)

    def report(self, name):
        path = self.folder / f"{name}.json"
        self.command(f"spike_report({r_string(path)})")
        return json.loads(path.read_text(encoding="utf-8"))

    def interrupt(self):
        observation = console_interrupt(self.proc.pid, self.folder)
        observation["method"] = "GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) / detached attached helper"
        if not observation.get("generated") and self.driver.startswith("ConPTY"):
            self.proc.sendintr()
            observation["fallback"] = "ConPTY control byte 0x03 (pywinpty sendintr)"
            observation["attempted"] = True
        else:
            observation["attempted"] = observation.get("generated", False)
        return observation

    def close(self):
        if self.proc is None:
            return
        try:
            self.send('q("no", status=0, runLast=FALSE)\n')
            self.read_for(0.3)
        except (OSError, EOFError):
            pass
        if self.driver.startswith("ConPTY"):
            if self.proc.isalive():
                kill_tree(self.proc.pid, self.folder)
            try:
                self.proc.close(force=True)
            except Exception:
                pass
        else:
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                kill_tree(self.proc.pid, self.folder)
                self.proc.wait(timeout=10)
            self.proc.stdin.close()
            self.proc.stdout.close()
        (self.folder / "transcript.txt").write_text(self.text, encoding="utf-8")


def recover(session, observations):
    state = session.report("before-recovery")
    if state["native"]["pending"]:
        session.command('spike_arm(100L, "~")')
        session.read_for(0.4)
        observations["recovery"] = "REPL armed one-shot timer nudge '~'; not another request"
        state = session.report("after-nudge")
        if state["native"]["pending"]:
            session.command("spike_poll()")
            observations["recovery"] += "; explicit poll fallback"
    else:
        observations.setdefault("recovery", "none")


def classify_outer_gate_interrupt(mode, native, outer_continued):
    # An interrupt caught by the gate/callback is delivery evidence even when
    # the outer expression incorrectly continues. Do not hide that regression.
    delivered = not outer_continued or native["gate_failures"] > 0 or native["failed"] > 0
    return {
        "status": "observed" if delivered else "unverified",
        "delivery_observed": delivered,
        "propagation_ok": not outer_continued if delivered and mode == "gated_restore" else None,
    }


def rterm_case(rterm, dll, mode, scenario, folder):
    folder.mkdir(parents=True)
    session = None
    observations, assertions = {}, {}
    result = {"frontend": "Rterm", "mode": mode, "scenario": scenario,
              "status": "observed", "passed": False}
    try:
        # Assign before starting so a failed constructor still has owned cleanup.
        session = Session.__new__(Session)
        session.__init__(rterm, dll, mode, folder)
        result["driver"] = session.driver
        observations["conpty_fallback_reason"] = session.fallback_reason
        if scenario in ("prompt", "self_close"):
            code = "h" if scenario == "self_close" else "a"
            session.command(f'spike_arm(150L, "{code}")')
            session.read_for(0.4)
            session.wait_marker(f"SPIKE_NATIVE|RECEIVED|{code}")
            observations["ran_automatically_at_prompt"] = bool(session.marker_count(f"SPIKE|METHOD_DONE|{code}"))
        elif scenario in ("sleep", "readline", "browser", "top_browser"):
            start = len(session.text)
            if scenario == "sleep":
                session.send('local({spike_arm(150L, "a"); spike_marker("WAITING"); Sys.sleep(0.8); spike_marker("OUTER_DONE")})\n')
                session.wait_marker("SPIKE|WAITING", start)
            elif scenario == "readline":
                session.send('local({spike_arm(150L, "a"); readline("SPIKE_READLINE> "); spike_marker("OUTER_DONE")})\n')
                session.wait_text("SPIKE_READLINE> ", start)
            elif scenario == "browser":
                session.send('local({spike_arm(150L, "a"); browser(); spike_marker("OUTER_DONE")})\n')
                session.wait_text("Browse[1]>", start)
            else:
                session.send('spike_arm(150L, "a"); browser()\n')
                session.wait_text("Browse[1]>", start)
            session.read_for(0.35)
            session.wait_marker("SPIKE_NATIVE|RECEIVED|a", start)
            observations["executed_while_waiting"] = bool(session.marker_count("SPIKE|METHOD_DONE|a", start))
            if mode != "direct" and scenario != "top_browser":
                assertions["framed_wait_defers"] = not observations["executed_while_waiting"]
            if scenario == "readline":
                session.send("answer\n")
            elif scenario in ("browser", "top_browser"):
                session.send("c\n")
            else:
                session.read_for(0.6)
            if scenario != "top_browser":
                session.wait_marker("SPIKE|OUTER_DONE", start)
        elif scenario in ("outer_interrupt", "gate_interrupt", "gate_interrupt_outer"):
            start = len(session.text)
            if scenario == "outer_interrupt":
                session.send('local({spike_marker("OUTER_WAIT"); Sys.sleep(3); spike_marker("OUTER_DONE")})\n')
                session.wait_marker("SPIKE|OUTER_WAIT", start)
            elif scenario == "gate_interrupt_outer":
                session.send('local({spike_native("spike_gate_fault", 400L, 0L); spike_arm(150L, "a"); spike_marker("OUTER_WAIT"); Sys.sleep(1); spike_marker("OUTER_DONE")})\n')
                session.wait_marker("SPIKE_NATIVE|GATE_SUSPEND_WAIT", start)
            else:
                session.command('spike_native("spike_gate_fault", 400L, 0L); spike_arm(150L, "a")')
                session.wait_marker("SPIKE_NATIVE|GATE_SUSPEND_WAIT", start)
            observations["interrupt_driver"] = session.interrupt()
            session.read_for(1.4 if scenario != "outer_interrupt" else 3.2)
            # Before any diagnostic R call, send one unrelated compound expression.
            unrelated_start = len(session.text)
            session.send('local({Sys.sleep(0.1); spike_marker("UNRELATED_DONE")})\n')
            session.wait_marker("SPIKE|UNRELATED_DONE", unrelated_start)
            assertions["first_unrelated_expression_completed"] = True
            observations["outer_continued"] = bool(session.marker_count("SPIKE|OUTER_DONE", start))
            if not observations["interrupt_driver"]["attempted"] or (scenario == "outer_interrupt" and observations["outer_continued"]):
                result.update(status="unverified", reason="Console interrupt delivery could not be established", passed=None)
            elif scenario == "gate_interrupt_outer":
                before = session.report("after-gate-interrupt")
                observations["deferred_native"] = before["native"]
                disposition = classify_outer_gate_interrupt(mode, before["native"], observations["outer_continued"])
                observations["interrupt_disposition"] = disposition
                if disposition["status"] == "unverified":
                    result.update(status="unverified", reason="No interrupt delivery observed in the paused gate", passed=None)
                assertions["request_not_started"] = before["native"]["executed"] == 0 and before["native"]["pending"] == 1
                if disposition["propagation_ok"] is not None:
                    assertions["outer_interrupt_propagated"] = disposition["propagation_ok"]
            elif scenario == "outer_interrupt":
                assertions["ordinary_interrupt_delivered"] = not observations["outer_continued"]
            else:
                before = session.report("after-prompt-interrupt")
                observations["prompt_interrupt_native"] = before["native"]
                if not (before["native"]["failed"] or before["native"]["gate_failures"]):
                    result.update(status="unverified", reason="Signal attempt produced no observable gate/callback interruption", passed=None)
                if before["native"]["executed"]:
                    count = session.marker_count("SPIKE_NATIVE|STARTED|a")
                    session.command('spike_arm(100L, "~")')
                    session.read_for(0.3)
                    retry = session.report("after-terminal-nudge")
                    assertions["started_request_is_terminal"] = retry["native"]["executed"] == before["native"]["executed"] and retry["native"]["pending"] == 0
                    assertions["terminal_nudge_no_extra_start"] = session.marker_count("SPIKE_NATIVE|STARTED|a") == count
                    observations["recovery"] = "REPL nudge after terminal outcome; no request retry"
        recover(session, observations)
        state = session.report("state")
        expected = 0 if scenario == "outer_interrupt" else 1
        assertions.update(
            guard_clear=state["native"]["busy"] == 0 and state["native"]["closing"] == 0,
            requests_not_duplicated=state["native"]["executed"] == expected,
            every_execution_cleaned=state["native"]["executed"] == state["native"]["cleanups"],
            queue_drained=state["native"]["pending"] == 0,
            suspension_restored=state["native"]["interrupts_suspended"] == 0,
            no_bare_probe_in_replacement=mode != "gated_restore" or state["native"]["bare_evaluations"] == 0,
        )
        stopped_path = folder / "stopped.json"
        session.command(f'spike_stop(); writeLines(jsonlite::toJSON(as.list(spike_status()), auto_unbox=TRUE), '
                        f'{r_string(stopped_path)}); spike_teardown(); Sys.sleep(0.3)')
        stopped = json.loads(stopped_path.read_text(encoding="utf-8"))
        assertions["native_source_stopped"] = stopped["source_active"] == 0 and stopped["configured"] == 0 and stopped["busy"] == 0
        assertions["unloaded_and_survived"] = bool(session.marker_count("SPIKE|UNLOADED"))
        result.update(state=state, observations=observations, assertions=assertions)
        if result["status"] == "observed":
            result["passed"] = all(assertions.values())
        elif not all(assertions.values()):
            # An unavailable signal is not permission to ignore resource failure.
            result.update(status="observed", passed=False)
    except Exception as error:
        result["error"] = str(error)
        result.update(observations=observations, assertions=assertions)
    finally:
        if session is not None:
            try:
                session.close()
            except Exception as error:
                result.update(status="observed", passed=False, cleanup_error=str(error))
                (folder / "transcript.txt").write_text(getattr(session, "text", ""), encoding="utf-8")
        result["transcript"] = str(folder / "transcript.txt")
        write_json(folder / "result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Windows-only driver; use run-os.py on POSIX")
    output = args.output.resolve()
    cases = []
    case_file = output / "windows-cases.json"
    write_json(case_file, cases)
    build = output / "build"
    build.mkdir()
    expression = (f"source({r_string(HERE / 'build.R')}); "
                  f"dll <- spike_build(output={r_string(build)}); writeLines(dll, {r_string(build / 'dll-path.txt')})")
    status = run_process(["Rscript", "--vanilla", "-e", expression], build, 120, transcript="build-driver.txt")
    if status:
        raise RuntimeError(f"DLL build failed: status {status}")
    dll = Path((build / "dll-path.txt").read_text(encoding="utf-8").strip())
    rhome = Path(subprocess.check_output(["Rscript", "--vanilla", "-e", 'cat(R.home("bin"))'], text=True).strip())
    rterm = rhome / "Rterm.exe"
    rgui = rhome / "Rgui.exe"
    for mode in MODES:
        for scenario in ("top_loop", "sleep", "lifecycle"):
            folder = output / f"Rscript-{mode}-{scenario}"
            folder.mkdir()
            status = run_process(["Rscript", "--vanilla", str(HERE / "windows-top-level.R"),
                                  str(dll), mode, scenario, str(folder)], folder, 90)
            path = folder / "result.json"
            result = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
                "frontend": "Rscript", "mode": mode, "scenario": scenario,
                "status": "observed", "passed": False, "error": f"Missing result; process status {status}"}
            if status:
                result.update(passed=False, process_status=status)
            cases.append(result)
            write_json(case_file, cases)
        for scenario in ("prompt", "sleep", "readline", "browser", "top_browser", "self_close", "outer_interrupt", "gate_interrupt", "gate_interrupt_outer"):
            if mode == "direct" and scenario.startswith("gate_"):
                continue
            result = rterm_case(rterm, dll, mode, scenario, output / f"Rterm-{mode}-{scenario}")
            cases.append(result)
            write_json(case_file, cases)
        folder = output / f"Rgui-{mode}-prompt"
        folder.mkdir()
        if not rgui.exists():
            result = {"frontend": "Rgui", "mode": mode, "scenario": "prompt", "status": "unverified",
                      "reason": f"Rgui executable absent: {rgui}"}
        else:
            env = {**os.environ, "R_PROFILE_USER": str(HERE / "windows-rgui-profile.R"),
                   "SPIKE_ROOT": str(HERE.parents[2]), "SPIKE_CASE": str(folder),
                   "SPIKE_DLL": str(dll), "SPIKE_MODE": mode}
            status = run_process([str(rgui), "--no-save", "--no-restore", "--no-site-file", "--no-environ"],
                                 folder, 15, env=env, transcript="process-output.txt")
            path = folder / "result.json"
            if not path.exists():
                result = {"frontend": "Rgui", "mode": mode, "scenario": "prompt", "status": "unverified",
                          "reason": f"No callback result before process exit/timeout; status {status}",
                          "startup_armed": (folder / "transcript.txt").exists()}
            else:
                result = json.loads(path.read_text(encoding="utf-8"))
                if status:
                    result.update(passed=False, process_status=status)
        cases.append(result)
        write_json(case_file, cases)
    cases.append({"frontend": "Rgui", "scenario": "Esc interrupt", "status": "unverified",
                  "reason": "Keyboard Esc / GUI modal interruption is not automated"})
    write_json(case_file, cases)
    return 0 if all(case.get("passed") for case in cases if case["status"] == "observed") else 1


if __name__ == "__main__":
    sys.exit(main())

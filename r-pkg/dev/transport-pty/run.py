#!/usr/bin/env python3
"""Run bounded real-console event-path checks against an installed jdv library."""

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
import time


HERE = Path(__file__).resolve().parent
SCENARIOS = ("automatic", "interrupt", "outer", "reentry", "close", "unload")


def r_string(value):
    return json.dumps(str(value))


class InteractiveR:
    def __init__(self, lib, scenario, ready, folder, timeout):
        self.text = ""
        self.closed = False
        self.timeout = timeout
        self.folder = folder
        self.started = time.monotonic()
        self.interrupt_state = {"isig_enabled": False, "character": None, "written": False}
        environment = os.environ.copy()
        environment["R_LIBS_USER"] = str(lib)
        pid, master = pty.fork()
        if pid == 0:
            os.execvpe("R", ["R", "--vanilla", "--interactive", "--no-readline"], environment)
        self.pid = pid
        self.master = master
        try:
            attrs = termios.tcgetattr(master)
            attrs[3] &= ~termios.ECHO
            termios.tcsetattr(master, termios.TCSANOW, attrs)
            self.wait_for("> ")
            setup = (
                f"suppressPackageStartupMessages(library(jdv)); "
                f"source({r_string(HERE / 'fixture.R')}); "
                f"transport_pty_open(readLines({r_string(ready)}), {r_string(scenario)}); "
                'transport_pty_marker("READY")\n'
            )
            self.send(setup)
            self.wait_for("JDV_PTY|READY")
        except BaseException:
            self.close()
            raise

    def send(self, value):
        os.write(self.master, value.encode("utf-8"))

    def interrupt(self):
        attrs = termios.tcgetattr(self.master)
        self.interrupt_state["isig_enabled"] = bool(attrs[3] & termios.ISIG)
        interrupt_char = attrs[6][termios.VINTR]
        if isinstance(interrupt_char, int):
            interrupt_char = bytes([interrupt_char])
        elif isinstance(interrupt_char, str):
            interrupt_char = interrupt_char.encode()
        if not self.interrupt_state["isig_enabled"] or not interrupt_char or interrupt_char == b"\x00":
            return False
        os.write(self.master, interrupt_char)
        self.interrupt_state["character"] = repr(interrupt_char)
        self.interrupt_state["written"] = True
        return True

    def read_for(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            ready, _, _ = select.select([self.master], [], [], min(0.05, max(0, remaining)))
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

    def wait_for(self, marker, start=0, timeout=None):
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while marker not in self.text[start:]:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"waiting for {marker!r}; transcript tail={self.text[-1800:]!r}")
            self.read_for(min(0.05, deadline - time.monotonic()))
            self.ensure_alive()
        return self.text.index(marker, start)

    def ensure_alive(self):
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.pid = None
            raise RuntimeError(f"interactive R exited early with status {status}")

    def command(self, expression, timeout=None):
        marker = f"JDV_PTY|COMMAND_{time.monotonic_ns()}"
        start = len(self.text)
        self.send(f'{expression}; transport_pty_marker({r_string(marker.removeprefix("JDV_PTY|") )})\n')
        self.wait_for(marker, start=start, timeout=timeout)
        return start

    def wait_file(self, path, timeout=None):
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while not path.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError(f"waiting for host file {path}")
            self.read_for(0.05)
            self.ensure_alive()

    def close(self):
        if self.closed:
            return
        try:
            if self.pid is not None:
                try:
                    self.send('q("no", status=0, runLast=FALSE)\n')
                except OSError:
                    pass
                deadline = time.monotonic() + 0.5
                while time.monotonic() < deadline:
                    self.read_for(0.02)
                    pid, _ = os.waitpid(self.pid, os.WNOHANG)
                    if pid:
                        self.pid = None
                        break
                if self.pid is not None:
                    os.kill(self.pid, signal.SIGKILL)
                    os.waitpid(self.pid, 0)
                    self.pid = None
        except (OSError, ChildProcessError):
            pass
        finally:
            os.close(self.master)
            self.closed = True
            (self.folder / "transcript.txt").write_text(self.text, encoding="utf-8")


def start_host(scenario, transport, folder, timeout):
    ready = folder / "ready.txt"
    result = folder / "host-result.json"
    sent = folder / "request-sent.txt"
    trigger = folder / "outer-start.txt"
    command = [
        sys.executable,
        str(HERE / "host.py"),
        "--transport",
        transport,
        "--scenario",
        scenario,
        "--ready",
        str(ready),
        "--result",
        str(result),
        "--timeout",
        str(timeout),
    ]
    if scenario == "outer":
        command.extend(("--sent", str(sent), "--trigger", str(trigger)))
    stdout_path = folder / "host.stdout"
    stderr_path = folder / "host.stderr"
    stdout = stdout_path.open("wb")
    stderr = stderr_path.open("wb")
    process = subprocess.Popen(command, stdout=stdout, stderr=stderr, close_fds=True)
    deadline = time.monotonic() + timeout
    while not ready.exists():
        if time.monotonic() >= deadline:
            process.kill()
            process.wait(timeout=2)
            raise TimeoutError("mock host did not publish its address")
        if process.poll() is not None:
            raise RuntimeError(f"mock host exited before listening: {stderr_path.read_text(errors='replace')}")
        time.sleep(0.02)
    return process, stdout, stderr, ready, result, sent, trigger


def wait_host(process, stdout, stderr, result, timeout):
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait(timeout=2)
        raise TimeoutError("mock host did not finish before the deadline") from error
    finally:
        stdout.close()
        stderr.close()
    if process.returncode != 0:
        raise RuntimeError(f"mock host failed: {stderr.name and Path(stderr.name).read_text(errors='replace')}")
    if not result.exists():
        raise RuntimeError("mock host exited without writing its result")
    return json.loads(result.read_text(encoding="utf-8"))


def response_error_code(host_result, index=0):
    try:
        return host_result["responses"][index].get("error", {}).get("code")
    except (IndexError, KeyError, TypeError):
        return None


def response_row_count(host_result, index=0):
    try:
        return len(host_result["responses"][index]["result"]["data"]["row_index"])
    except (IndexError, KeyError, TypeError):
        return None


def run_case(lib, scenario, transport, timeout, folder):
    host = None
    session = None
    outcome = {"scenario": scenario, "transport": transport, "status": "fail"}
    try:
        host = start_host(scenario, transport, folder, timeout)
        host_process, host_stdout, host_stderr, ready, host_result_path, sent_path, trigger_path = host
        session = InteractiveR(lib, scenario, ready, folder, timeout)
        if scenario == "automatic":
            session.wait_for("JDV_PTY|METHOD_BEGIN|64|1")
            session.wait_for("JDV_PTY|METHOD_EXIT|1")
        elif scenario == "interrupt":
            session.wait_for("JDV_PTY|METHOD_BEGIN|64|1")
            outcome["ctrl_c_written_to_controlling_terminal"] = session.interrupt()
            outcome["ctrl_c_terminal_state"] = session.interrupt_state
            session.wait_for("JDV_PTY|METHOD_BEGIN|64|2", timeout=timeout)
            session.wait_for("JDV_PTY|METHOD_EXIT|2")
        elif scenario == "outer":
            start = len(session.text)
            session.send('transport_pty_marker("OUTER_BEGIN"); Sys.sleep(5); transport_pty_marker("OUTER_DONE")\n')
            session.wait_for("JDV_PTY|OUTER_BEGIN", start=start)
            trigger_path.write_text("start\n", encoding="utf-8")
            session.wait_file(sent_path)
            outcome["ctrl_c_written_to_controlling_terminal"] = session.interrupt()
            outcome["ctrl_c_terminal_state"] = session.interrupt_state
            session.command("jdv_rpc(NULL)", timeout=timeout)
            outcome["outer_completed_after_ctrl_c"] = "JDV_PTY|OUTER_DONE" in session.text[start:]
        elif scenario == "reentry":
            session.wait_for("JDV_PTY|METHOD_BEGIN|64|1")
            session.wait_for("JDV_PTY|METHOD_EXIT|1")
            session.wait_for("JDV_PTY|METHOD_BEGIN|64|2")
            session.wait_for("JDV_PTY|METHOD_EXIT|2")
        elif scenario == "close":
            session.wait_for("JDV_PTY|METHOD_BEGIN|64|1")
            session.wait_for("JDV_PTY|METHOD_EXIT|1")
            session.command('stopifnot(isTRUE(transport_pty$closed_in_method)); stopifnot(1 + 1 == 2)')
            outcome["post_close_r_command_ran"] = "COMMAND_" in session.text
        elif scenario == "unload":
            session.command('jdv_close(); detach("package:jdv", unload = TRUE, character.only = TRUE)')
            session.command('suppressPackageStartupMessages(library(jdv)); transport_pty_open(readLines(' + r_string(ready) + '), "unload")')
            session.command("jdv_close()")

        session.wait_file(host_result_path, timeout=timeout)
        host_result = wait_host(host_process, host_stdout, host_stderr, host_result_path, timeout)
        outcome["host"] = host_result

        report_path = folder / "r-state.json"
        if scenario != "unload":
            session.command(f"transport_pty_report({r_string(report_path)})")
            session.wait_file(report_path, timeout=3)
            outcome["r"] = json.loads(report_path.read_text(encoding="utf-8"))

        if scenario == "interrupt":
            first_error = response_error_code(host_result)
            one_each = (
                outcome["r"]["calls"] == 2
                and outcome["r"]["max_active"] == 1
                and response_row_count(host_result, 1) == 64
            )
            if first_error == "interrupted" and one_each:
                outcome["status"] = "pass"
                outcome["interrupt"] = "delivered"
            elif first_error is None and one_each:
                outcome["status"] = "known_limitation"
                if outcome["ctrl_c_terminal_state"]["written"]:
                    outcome["interrupt"] = "not_observed_during_method; callback returned and next request ran once"
                else:
                    outcome["interrupt"] = "controlling-terminal SIGINT unavailable; callback returned and next request ran once"
            else:
                outcome["status"] = "fail"
                outcome["interrupt"] = f"response_error={first_error!r}; method_calls={outcome['r']['calls']}"
        elif scenario == "outer":
            if not outcome["ctrl_c_terminal_state"]["written"]:
                outcome["status"] = "known_limitation"
                outcome["interrupt"] = "controlling-terminal SIGINT unavailable; outer callback result is unverified"
            else:
                outcome["status"] = "pass" if (
                    not outcome["outer_completed_after_ctrl_c"]
                    and outcome["r"]["calls"] == 1
                    and response_row_count(host_result) == 64
                ) else "fail"
        elif scenario == "reentry":
            outcome["status"] = "pass" if (
                outcome["r"]["calls"] == 2
                and outcome["r"]["max_active"] == 1
                and all(response_row_count(host_result, i) == 64 for i in range(2))
            ) else "fail"
        elif scenario == "close":
            closed_events = [m.get("method") for m in host_result.get("close_messages", [])]
            outcome["close_notification_seen"] = "view/closed" in closed_events
            outcome["status"] = "pass" if outcome.get("post_close_r_command_ran") else "fail"
        elif scenario == "unload":
            connections = host_result.get("connections", [])
            outcome["status"] = "pass" if len(connections) == 2 else "fail"
        else:
            outcome["status"] = "pass" if (
                len(host_result.get("responses", [])) == 1
                and response_row_count(host_result) == 64
                and 0 < outcome["r"]["probe_max"] <= 32
            ) else "fail"
        return outcome
    except Exception as error:
        outcome["error"] = f"{type(error).__name__}: {error}"
        if session is not None:
            outcome["transcript_tail"] = session.text[-1800:]
        return outcome
    finally:
        if session is not None:
            session.close()
        if host is not None:
            process, stdout, stderr, _, _, _, _ = host
            if process.poll() is None:
                process.kill()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
            if not stdout.closed:
                stdout.close()
            if not stderr.closed:
                stderr.close()


def summarize(result):
    summary = {
        "scenario": result["scenario"],
        "transport": result["transport"],
        "status": result["status"],
    }
    for key in ("interrupt", "ctrl_c_terminal_state", "ctrl_c_written_to_controlling_terminal",
                "outer_completed_after_ctrl_c", "post_close_r_command_ran",
                "close_notification_seen", "error", "transcript_tail"):
        if key in result:
            summary[key] = result[key]
    if "host" in result:
        host = result["host"]
        summary["host_connections"] = len(host.get("connections", []))
        summary["host_response_count"] = len(host.get("responses", []))
        summary["response_row_counts"] = [
            response_row_count(host, index)
            for index in range(len(host.get("responses", [])))
        ]
        summary["eof_observed"] = host.get("eof_observed")
    if "r" in result:
        summary["r"] = {
            "calls": result["r"]["calls"],
            "probe_max": result["r"]["probe_max"],
            "max_active": result["r"]["max_active"],
            "closed_in_method": result["r"]["closed_in_method"],
            "transport": result["r"]["transport"],
        }
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lib", required=True, type=Path, help="scratch installed-library directory")
    parser.add_argument("--scenario", choices=("all",) + SCENARIOS, default="all")
    parser.add_argument("--transport", choices=("uds", "tcp"), default="uds")
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--output", type=Path, help="directory for transcripts and host records")
    args = parser.parse_args()
    if not args.lib.is_dir():
        parser.error(f"installed library directory does not exist: {args.lib}")
    timeout = min(max(args.timeout, 2.0), 30.0)
    output_root = args.output
    if output_root is None:
        output_root = Path(tempfile.mkdtemp(prefix="jdv-pty-"))
    else:
        output_root.mkdir(parents=True, exist_ok=True)
    scenarios = SCENARIOS if args.scenario == "all" else (args.scenario,)
    results = []
    for scenario in scenarios:
        folder = output_root / f"{args.transport}-{scenario}"
        folder.mkdir(parents=True, exist_ok=True)
        results.append(run_case(args.lib.resolve(), scenario, args.transport, timeout, folder))
    report = {"output": str(output_root), "results": [summarize(row) for row in results]}
    print(json.dumps(report, indent=2))
    if any(row["status"] == "fail" for row in results):
        return 1
    if any(row["status"] == "known_limitation" for row in results):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

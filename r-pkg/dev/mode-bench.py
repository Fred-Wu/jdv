#!/usr/bin/env python3
"""Run isolated R mode benchmarks and report process RSS high-water marks."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import select
import shutil
import sys
import tempfile
import time
from pathlib import Path


DEFAULT_CASES = [
    "numeric_10000",
    "numeric_50000",
    "numeric_100000",
    "mixed_10000",
    "mixed_50000",
    "mixed_100000",
    "strings_low_C",
    "strings_low_locale",
    "strings_high_C",
    "strings_high_locale",
    "zero_col_800m",
    "giant_cell_auto",
    "giant_late_auto",
]
DEFAULT_PHASES = ["prepare", "snapshot", "paged", "auto"]


def proc_memory_kb(pid: int) -> tuple[int | None, int | None]:
    """Return current RSS and kernel high-water RSS from /proc when available."""
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="ascii")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return None, None
    values = {}
    for key in ("VmRSS", "VmHWM"):
        match = re.search(rf"^{key}:\s+(\d+)\s+kB$", status, re.MULTILINE)
        if match:
            values[key] = int(match.group(1))
    return values.get("VmRSS"), values.get("VmHWM")


def run_child(command: list[str], env: dict[str, str], stderr_path: Path) -> dict:
    """Exec one R child and collect per-child wait4 usage plus /proc samples."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            os.dup2(write_fd, 1)
            os.close(write_fd)
            with stderr_path.open("wb") as error_stream:
                os.dup2(error_stream.fileno(), 2)
                os.execvpe(command[0], command, env)
        except BaseException as exc:  # pragma: no cover - child error path
            os.write(2, f"exec failed: {exc}\n".encode())
            os._exit(127)

    os.close(write_fd)
    os.set_blocking(read_fd, False)
    chunks = []
    start = time.monotonic()
    max_rss_kb = 0
    max_hwm_kb = 0
    wait_status = None
    usage = None
    eof = False
    while not eof or wait_status is None:
        rss, hwm = proc_memory_kb(pid)
        if rss is not None:
            max_rss_kb = max(max_rss_kb, rss)
        if hwm is not None:
            max_hwm_kb = max(max_hwm_kb, hwm)

        readable, _, _ = select.select([read_fd], [], [], 0.01)
        if readable:
            try:
                data = os.read(read_fd, 65536)
                if data:
                    chunks.append(data)
                else:
                    eof = True
            except BlockingIOError:
                pass
        if wait_status is None:
            try:
                found_pid, status, rusage = os.wait4(pid, os.WNOHANG)
            except ChildProcessError:
                found_pid = pid
                status = 0
                rusage = None
            if found_pid:
                wait_status = status
                usage = rusage
        if wait_status is not None and not eof:
            try:
                while True:
                    data = os.read(read_fd, 65536)
                    if not data:
                        eof = True
                        break
                    chunks.append(data)
            except BlockingIOError:
                pass
    os.close(read_fd)

    stdout = b"".join(chunks).decode("utf-8", errors="replace")
    exit_code = os.waitstatus_to_exitcode(wait_status)
    wait4_maxrss = None if usage is None else int(usage.ru_maxrss)
    wall_ms = (time.monotonic() - start) * 1000
    stderr = stderr_path.read_text(encoding="utf-8", errors="replace")
    return {
        "exit_code": exit_code,
        "wall_ms": round(wall_ms, 3),
        "wait4_maxrss_kb": wait4_maxrss,
        "proc_sampled_max_rss_kb": max_rss_kb or None,
        "proc_sampled_max_hwm_kb": max_hwm_kb or None,
        "stdout": stdout,
        "stderr": stderr[-4000:],
    }


def parse_result(stdout: str) -> dict:
    lines = [line for line in stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError(f"expected one JSON result line; got {len(lines)}")
    return json.loads(lines[0])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rscript", default=shutil.which("Rscript") or "Rscript")
    parser.add_argument("--lib", default=os.environ.get("JDV_BENCH_LIB", ""))
    parser.add_argument("--cases", default=",".join(DEFAULT_CASES))
    parser.add_argument("--phases", default=",".join(DEFAULT_PHASES))
    parser.add_argument("--snapshot-cells", default="10000")
    parser.add_argument("--include-large-matrix", action="store_true")
    parser.add_argument("--rprofmem", action="store_true")
    parser.add_argument("--max-message", type=int, default=256 * 1024 * 1024)
    parser.add_argument("--work-bytes", type=int, default=64 * 1024 * 1024)
    parser.add_argument("--cache-bytes", type=int, default=32 * 1024 * 1024)
    parser.add_argument("--query-rows", type=int, default=1000000)
    args = parser.parse_args()

    cases = [part for part in args.cases.split(",") if part]
    phases = [part for part in args.phases.split(",") if part]
    thresholds = [part for part in args.snapshot_cells.split(",") if part]
    valid_phases = {
        "prepare",
        "snapshot",
        "paged",
        "auto",
        "encoder",
        "format",
        "rank",
        "sort",
    }
    if set(phases) - valid_phases:
        parser.error(f"invalid phases: {sorted(set(phases) - valid_phases)}")
    if args.include_large_matrix and "matrix_2m_x8" not in cases:
        cases.append("matrix_2m_x8")

    script = Path(__file__).with_name("mode-bench.R").resolve()
    output = []
    with tempfile.TemporaryDirectory(prefix="jdv-mode-bench-") as temporary:
        temp_root = Path(temporary)
        baseline_rss = {}
        for case in cases:
            for phase in phases:
                phase_thresholds = thresholds if phase == "auto" else [thresholds[0]]
                for threshold in phase_thresholds:
                    workdir = temp_root / f"{case}-{phase}-{threshold}"
                    workdir.mkdir()
                    child_env = os.environ.copy()
                    child_env["JDV_BENCH_TMP"] = str(workdir)
                    child_env["JDV_BENCH_SNAPSHOT_CELLS"] = threshold
                    child_env["JDV_BENCH_MAX_MESSAGE"] = str(args.max_message)
                    child_env["JDV_BENCH_WORK_BYTES"] = str(args.work_bytes)
                    child_env["JDV_BENCH_CACHE_BYTES"] = str(args.cache_bytes)
                    child_env["JDV_BENCH_QUERY_ROWS"] = str(args.query_rows)
                    child_env["JDV_BENCH_RPROFMEM"] = "1" if args.rprofmem else "0"
                    if args.lib:
                        child_env["JDV_BENCH_LIB"] = args.lib
                    command = [
                        args.rscript,
                        "--vanilla",
                        str(script),
                        case,
                        phase,
                        str(workdir),
                    ]
                    child = run_child(
                        command,
                        child_env,
                        workdir / "stderr.log",
                    )
                    record = {
                        "case": case,
                        "phase": phase,
                        "snapshot_cells_option": int(threshold),
                        "measurement": {key: value for key, value in child.items()
                                        if key not in {"stdout", "stderr"}},
                    }
                    if child["exit_code"] == 0:
                        try:
                            result = parse_result(child["stdout"])
                            record["result"] = result
                            selected_rss = child["wait4_maxrss_kb"]
                            if selected_rss is None:
                                selected_rss = child["proc_sampled_max_hwm_kb"]
                            if phase == "prepare" and selected_rss is not None:
                                baseline_rss[case] = selected_rss
                            elif selected_rss is not None and case in baseline_rss:
                                record["measurement"]["rss_delta_from_prepare_kb"] = (
                                    selected_rss - baseline_rss[case]
                                )
                        except Exception as exc:
                            record["parse_error"] = str(exc)
                    else:
                        record["error"] = child["stderr"] or child["stdout"][-4000:]
                    if child["stderr"]:
                        record["stderr_tail"] = child["stderr"]
                    output.append(record)

    json.dump(
        {
            "benchmark": "jdv-mode-bench-v1",
            "host_platform": platform.platform(),
            "python_version": sys.version.split()[0],
            "rss_note": (
                "wait4 ru_maxrss and /proc VmHWM include resident C malloc memory; "
                "RSS delta from prepare is a paired high-water comparison, not "
                "additive engine-only allocation. Rprofmem, when enabled, is "
                "R-version-dependent, covers R allocations only, and omits "
                "native C allocations."
            ),
            "results": output,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

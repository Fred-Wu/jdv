#!/usr/bin/env python3
"""Prepare durable evidence for manually dispatched OS/frontend experiments."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
MODES = ("direct", "gated", "gated_restore")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def stop_tree(process):
    """Terminate only this runner's child tree, including abandoned frontends."""
    if os.name == "nt":
        return subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                              capture_output=True, text=True, timeout=10)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return None


def execute(command, log, timeout, env=None):
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=os.name != "nt")
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stream.write(f"\nRunner timeout after {timeout} seconds.\n")
            cleanup = stop_tree(process)
            if cleanup is not None:
                stream.write(cleanup.stdout + cleanup.stderr)
            process.wait(timeout=10)
            return 124


def metadata(output):
    environment = {
        "os": platform.platform(), "python": sys.version,
        "image_os": os.getenv("ImageOS"), "image_version": os.getenv("ImageVersion"),
        "runner_os": os.getenv("RUNNER_OS"), "runner_arch": os.getenv("RUNNER_ARCH"),
        "run_url": (f"{os.getenv('GITHUB_SERVER_URL')}/{os.getenv('GITHUB_REPOSITORY')}"
                    f"/actions/runs/{os.getenv('GITHUB_RUN_ID')}" if os.getenv("GITHUB_RUN_ID") else None),
        "rtools_environment": {k: v for k, v in os.environ.items() if k.upper().startswith("RTOOLS")},
        "frontends_not_covered": ["Rgui Esc", "R.app", "RStudio", "arf"],
    }
    if os.name == "nt":
        try:
            environment["pywinpty"] = importlib.metadata.version("pywinpty")
        except importlib.metadata.PackageNotFoundError:
            environment["pywinpty"] = {"unavailable": "Not installed; ESS pipe fallback will be attempted"}
    commands = {
        "R": ["Rscript", "--vanilla", "-e", 'cat(R.version.string, "\\n", R.version$platform, "\\n", R.home(), "\\n"); print(Sys.which(c("make", "gcc")))'],
        "compiler": ["gcc", "--version"],
        "make": ["make", "--version"],
    }
    for name, command in commands.items():
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=20)
            environment[name] = {"exit_code": result.returncode, "output": result.stdout + result.stderr}
        except (OSError, subprocess.TimeoutExpired) as error:
            environment[name] = {"unavailable": str(error)}
    write_json(output / "metadata.json", environment)


def validate(output):
    summary = json.loads((output / "results.json").read_text(encoding="utf-8"))
    cases = summary.get("cases", [])
    if any(case.get("status") not in ("observed", "unverified") for case in cases):
        raise RuntimeError("Unknown observation status")
    if any(not case.get("reason") for case in cases if case.get("status") == "unverified"):
        raise RuntimeError("An unverified scenario must explain what was not measured")
    observed = [case for case in cases if case.get("status") == "observed"]
    if not observed or summary.get("error"):
        raise RuntimeError("No completed observations, or runner failed; inspect results.json")
    if any(not case.get("passed") for case in observed):
        raise RuntimeError("Observation/resource assertions failed")
    if not (output / "metadata.json").stat().st_size:
        raise RuntimeError("Missing environment metadata")
    builds = list(output.rglob("build.log"))
    transcripts = list(output.rglob("transcript.txt"))
    if not any(path.stat().st_size for path in builds) or not any(path.stat().st_size for path in transcripts):
        raise RuntimeError("Missing nonempty build log or frontend transcript")
    if summary["os"] == "windows":
        required = {(mode, scenario) for mode in MODES for scenario in ("top_loop", "sleep", "lifecycle")}
        actual = {(c.get("mode"), c.get("scenario")) for c in observed if c.get("frontend") == "Rscript"}
        if not required.issubset(actual):
            raise RuntimeError("Incomplete mandatory Rscript comparison")
    print(f"Evidence valid: {len(observed)} observed, {len(cases) - len(observed)} unverified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate", type=Path)
    args = parser.parse_args()
    if args.validate:
        validate(args.validate)
        return 0
    if not args.output:
        parser.error("--output or --validate is required")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    summary = {"os": "windows" if os.name == "nt" else platform.system().lower(),
               "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cases": []}
    write_json(output / "results.json", summary)
    try:
        metadata(output)
        if os.name == "nt":
            status = execute([sys.executable, str(HERE / "windows_runner.py"), "--output", str(output)],
                             output / "runner.log", timeout=900)
            path = output / "windows-cases.json"
            if path.exists():
                summary["cases"] = json.loads(path.read_text(encoding="utf-8"))
        else:
            cases_dir = output / "posix"
            status = execute([sys.executable, str(HERE / "run.py"), "--output", str(cases_dir),
                              "--modes", ",".join(MODES)], output / "runner.log", timeout=1100)
            path = cases_dir / "results.json"
            if path.exists():
                summary["cases"] = [{**case, "frontend": "CLI R / POSIX PTY", "status": "observed"}
                                    for case in json.loads(path.read_text(encoding="utf-8"))]
            summary["cases"].append({"frontend": "R.app", "status": "unverified",
                                     "reason": "Only command-line R is driven; no R.app automation"})
        if status:
            summary["error"] = f"Frontend runner exited with status {status}; see runner.log"
    except Exception as error:
        summary["error"] = str(error)
    finally:
        write_json(output / "results.json", summary)
    try:
        validate(output)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

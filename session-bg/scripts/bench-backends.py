#!/usr/bin/env python3
"""Controlled, isolated Tattoy/own comparison using process CPU-time deltas.

The child is local synthetic terminal output; no AI session is started.
Examples: --seconds 30 --workload quiet; --workload updates --output result.json
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]


def cpu_seconds(value):
    days, _, clock = value.rpartition("-")
    parts = [float(part) for part in clock.split(":")]
    return (int(days) * 86400 if days else 0) + sum(part * 60 ** index for index, part in enumerate(reversed(parts)))


def sample(pids):
    result = subprocess.run(["ps", "-o", "pid=,time=,rss=", "-p", ",".join(map(str, pids))], capture_output=True, text=True, check=True)
    rows = [line.split() for line in result.stdout.splitlines()]
    if len(rows) != len(pids):
        raise RuntimeError("a measured backend process exited during the sample")
    return {"cpu": sum(cpu_seconds(row[1]) for row in rows), "rss": sum(int(row[2]) * 1024 for row in rows)}


def run(backend, seconds, workload, fps):
    with tempfile.TemporaryDirectory(prefix=f"sbg-bench-{backend}-") as scratch:
        path = Path(scratch)
        state = path / "state"
        state.mkdir()
        (state / "override.json").write_text(json.dumps({"params": {"scene": "studio"}}))
        (state / "journey.json").write_text(json.dumps({"repo": "benchmark", "tools": 500, "subagents": 11, "compactions": 2}))
        env = dict(os.environ, SBG_BACKEND=backend, SBG_STATE=str(state), XDG_CACHE_HOME=str(path / "cache"),
                   SBG_SCRIPT=str(ROOT / "plugins/fx/world.lua"), SBG_FPS=str(fps), SBG_SEED="1", SBG_EFFECT="stars",
                   SBG_OPACITY="0.6", SBG_DENSITY="1", TERM="xterm-kitty", COLORTERM="truecolor", TATTOY_NEST="allow")
        child = path / "child.py"
        hz = {"quiet": 0, "updates": 2, "busy": 100}[workload]
        child.write_text(f"""import os, time, tty, termios
tty.setraw(0, termios.TCSANOW)
os.write(1, b'\\x1b[2J\\x1b[H\\x1b[0mBENCH_READY')
deadline = time.monotonic() + {seconds + 8}
step = 0
while time.monotonic() < deadline:
    if {hz}:
        os.write(1, f'\\x1b[2;1Hnative update {{step:06d}}\\x1b[K\\x1b[0m'.encode())
    step += 1
    time.sleep(1 / {max(hz, 1)})
""")
        dry = subprocess.run([str(ROOT / "bin/sbg"), "--backend", backend, "--dry-run", "--fps", str(fps), "stars", "--", sys.executable, str(child)],
                             env=env, capture_output=True, text=True, check=True)
        argv = shlex.split(dry.stdout.splitlines()[-1])
        metrics = path / "metrics.json"
        if backend == "own":
            argv[1:1] = ["--metrics", str(metrics)]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 200, 0, 0))
        process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env,
                                   start_new_session=True, preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        os.set_blocking(master, False)
        total = 0
        prefix = bytearray()
        probed = backend != "own"

        def pump(duration):
            nonlocal total, probed
            until = time.monotonic() + duration
            while time.monotonic() < until:
                if select.select([master], [], [], min(0.05, max(0, until - time.monotonic())))[0]:
                    try:
                        data = os.read(master, 65536)
                    except (BlockingIOError, OSError):
                        break
                    total += len(data)
                    if len(prefix) < 65536:
                        prefix.extend(data)
                    if not probed and b"\x1b[6n" in prefix:
                        os.write(master, b"\x1b[1;1R")
                        probed = True

        try:
            pump(3)
            if process.poll() is not None:
                raise RuntimeError(f"{backend} exited early: {bytes(prefix[-500:])!r}")
            measured = [process.pid]
            if backend == "tattoy":
                descendants = subprocess.run(["pgrep", "-P", str(process.pid)], capture_output=True, text=True, check=False)
                for pid in descendants.stdout.split():
                    name = subprocess.run(["ps", "-p", pid, "-o", "comm="], capture_output=True, text=True, check=True).stdout
                    if "sbg-fx" in name:
                        measured.append(int(pid))
                if len(measured) != 2:
                    raise RuntimeError("expected one Tattoy effect process")
            first = sample(measured)
            start = time.monotonic()
            start_bytes = total
            memory = []
            while time.monotonic() - start < seconds:
                pump(min(1, seconds - (time.monotonic() - start)))
                last = sample(measured)
                memory.append(last["rss"])
            elapsed = time.monotonic() - start
            delta = last["cpu"] - first["cpu"]
            runtime = json.loads((state / "runtime.json").read_text())
            if runtime["status"] != "running" or runtime["active"]["kind"] != "script":
                raise RuntimeError(f"effect not running normally: {runtime}")
            if runtime["fps"] != fps:
                raise RuntimeError(f"discarded sample: effect throttled to {runtime['fps']} fps (requested {fps}); rerun without concurrent builds")
            result = {"backend": backend, "workload": workload, "viewport": "200x60", "requested_fps": fps,
                      "reported_fps": runtime["fps"], "sample_seconds": round(elapsed, 3), "cpu_seconds": round(delta, 3),
                      "last_render_cpu_ms": runtime.get("render_cpu_ms"), "last_render_wall_ms": runtime.get("render_wall_ms"),
                      "cpu_percent_one_core": round(delta / elapsed * 100, 3),
                      "rss_median_mib": round(statistics.median(memory) / 1048576, 2),
                      "rss_peak_mib": round(max(memory) / 1048576, 2), "terminal_bytes": total - start_bytes,
                      "terminal_bytes_per_second": round((total - start_bytes) / elapsed), "processes_measured": len(measured)}
            # End only this isolated fixture. Keep draining while the native
            # backend forwards SIGTERM and restores its terminal.
            process.terminate()
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                pump(0.1)
            if metrics.exists():
                result["own_lifetime_metrics"] = json.loads(metrics.read_text())
            return result
        finally:
            # Terminate only the measured fixture's effect, before waiting for
            # the controlling session leader to release its outer terminal.
            for pid in locals().get("measured", [])[1:]:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            os.close(master)
            os.close(slave)
            process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--fps", type=int, default=6)
    parser.add_argument("--workload", choices=("quiet", "updates", "busy"), default="quiet")
    parser.add_argument("--backends", nargs="+", choices=("own", "tattoy"), default=["tattoy", "own"])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.seconds < 5 or not 1 <= args.fps <= 60:
        parser.error("seconds must be >= 5; fps must be 1–60")
    results = []
    for backend in args.backends:
        result = run(backend, args.seconds, args.workload, args.fps)
        results.append(result)
        print(json.dumps(result), flush=True)
    if args.output:
        args.output.write_text(json.dumps({"method": "steady-state ps CPU-time delta, backend plus effect; native child excluded",
                                          "results": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()

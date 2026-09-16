#!/usr/bin/env python3
"""Run N headless tattoy+sbg-fx instances for a few seconds and report CPU per process.

Usage: bench.py [instances] [seconds]
"""
from __future__ import annotations

import fcntl
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EFFECTS = ("matrix", "plasma", "waves", "stars")


def spawn(effect: str, seconds: int) -> tuple[int, int]:
    dry = subprocess.run(
        [str(ROOT / "bin" / "sbg"), "--dry-run", effect, "--", "sleep", str(seconds)],
        capture_output=True, text=True, check=True,
    )
    config = dry.stdout.splitlines()[1].split()[2]
    argv = [shutil.which("tattoy"), "--main-config", config, "--disable-indicator", "--command", str(ROOT / "scripts" / "bench-child.sh")]
    env = dict(os.environ, TERM="xterm-kitty", COLORTERM="truecolor", SBG_EFFECT=effect, SBG_SEED="1", SBG_FPS="12", BENCH_SECONDS=str(seconds))
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, struct.pack("HHHH", 60, 200, 0, 0))
        os.execve(argv[0], argv, env)
    return pid, fd


def sample(pids: list[int]) -> list[str]:
    out = subprocess.run(["ps", "-o", "pid=,%cpu=,rss=,comm=", "-p", ",".join(map(str, pids))], capture_output=True, text=True, check=False)
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


def children_of(pid: int) -> list[int]:
    out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True, check=False)
    return [int(x) for x in out.stdout.split()]


def main() -> int:
    if shutil.which("tattoy") is None:
        print("skip bench: tattoy not on PATH")
        return 0
    instances = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    procs = [spawn(EFFECTS[i % len(EFFECTS)], seconds) for i in range(instances)]
    fds = [fd for _, fd in procs]
    deadline = time.time() + seconds - 1
    while time.time() < deadline:
        ready, _, _ = select.select(fds, [], [], 0.1)
        for fd in ready:
            try:
                os.read(fd, 1 << 16)
            except OSError:
                fds.remove(fd)
    pids = [pid for pid, _ in procs]
    plugin_pids = [c for pid in pids for c in children_of(pid)]
    print(f"{instances} instances, sampled after {seconds - 1}s (200x60 cells, 12 fps):")
    for line in sample(pids + plugin_pids):
        print("  " + line)
    for pid, fd in procs:
        for target in (pid, *children_of(pid)):
            try:
                os.kill(target, 9)
            except ProcessLookupError:
                pass
        os.close(fd)
        for _ in range(50):
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                break
            if done:
                break
            time.sleep(0.05)
    return 0


if __name__ == "__main__":
    sys.exit(main())

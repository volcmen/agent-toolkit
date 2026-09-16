#!/usr/bin/env python3
"""Headless smoke test: run tattoy + sbg-fx inside a pseudo-terminal and check the log.

Prints a compact verdict and exits nonzero when the plugin does not start, the
plugin exits early, or tattoy never renders. Requires `tattoy` on PATH.
"""
from __future__ import annotations

import fcntl
import os
import pty
import struct
import termios
import select
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = Path.home() / ".cache" / "sbg" / "tattoy.log"


def run(effect: str, seconds: float = 6.0) -> tuple[bool, str]:
    if shutil.which("tattoy") is None:
        return False, "tattoy not on PATH"
    if LOG.exists():
        LOG.unlink()
    dry = subprocess.run(
        [str(ROOT / "bin" / "sbg"), "--dry-run", "--log-level", "debug", effect, "--", str(ROOT / "scripts" / "smoke-child.sh")],
        capture_output=True, text=True, check=False,
    )
    if dry.returncode:
        return False, dry.stderr.strip()
    argv = [shutil.which("tattoy"), "--main-config", dry.stdout.splitlines()[1].split()[2], "--disable-indicator", "--command", str(ROOT / "scripts" / "smoke-child.sh")]
    env = dict(os.environ, TERM="xterm-kitty", COLORTERM="truecolor", SBG_EFFECT=effect, SBG_SEED="1", SBG_FPS="12", LINES="30", COLUMNS="100")
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        os.execve(argv[0], argv, env)
    output = b""
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
    try:
        _, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        status = 0
    if status == 0:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    log = LOG.read_text(encoding="utf-8", errors="replace") if LOG.exists() else ""
    started = f"Starting plugin: sbg-{effect}" in log
    exited = "plugin exited" in log or "plugin error" in log
    rendered = "Rendering from plugin message" in log
    problems = []
    if not started:
        problems.append("plugin never started")
    if exited:
        problems.append("plugin exited or errored")
    if not rendered:
        problems.append("no plugin frame rendered")
    if b"\x1b[" not in output:
        problems.append("tattoy produced no terminal output")
    return not problems, "; ".join(problems) or f"ok ({len(output)} bytes of terminal output)"


def main() -> int:
    effects = sys.argv[1:] or ["matrix", "plasma", "waves", "stars"]
    failed = 0
    for effect in effects:
        ok, detail = run(effect)
        print(f"{'ok  ' if ok else 'FAIL'} smoke {effect}: {detail}")
        failed += not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

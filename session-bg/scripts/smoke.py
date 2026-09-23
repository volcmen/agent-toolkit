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
import shlex
import subprocess
import sys
import time
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(effect: str, seconds: float = 6.0) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory(prefix="sbg-smoke-") as tmp:
        return run_isolated(effect, seconds, Path(tmp))


def run_isolated(effect: str, seconds: float, scratch: Path) -> tuple[bool, str]:
    # This test owns a fresh PTY; it must also run from an sbg-wrapped shell.
    env = dict(os.environ, XDG_CACHE_HOME=str(scratch), SBG_STATE=str(scratch / "pane"), TATTOY_NEST="allow")
    env.pop("SBG_SCRIPT", None)
    log_path = scratch / "sbg" / "tattoy.log"
    dry = subprocess.run(
        [str(ROOT / "bin" / "sbg"), "--dry-run", "--log-level", "debug", effect, "--", str(ROOT / "scripts" / "smoke-child.sh")],
        capture_output=True, text=True, check=False, env=env,
    )
    if dry.returncode:
        return False, dry.stderr.strip()
    argv = shlex.split(dry.stdout.splitlines()[1])
    env = dict(env, TERM="xterm-kitty", COLORTERM="truecolor", SBG_EFFECT=effect, SBG_SEED="1", SBG_FPS="12", LINES="30", COLUMNS="100")
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
        done, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        done, status = pid, 0
    if done == 0:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    os.close(fd)
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
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
        if output.strip():
            problems.append(output.decode("utf-8", errors="replace").strip()[-500:])
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

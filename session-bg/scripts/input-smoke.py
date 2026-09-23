#!/usr/bin/env python3
"""Check byte-preserving input and shortcuts across a real nested Tattoy PTY."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import pty
import select
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import tty
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ESC = b"\x1b"


def cases():
    """(name, outer-write fragments, expected child bytes). All data synthetic."""
    payload = ("paste 🌍\n".encode() + b"\x00\xff\x1bt") * 4000
    payload = payload[:50 * 1024]
    paste = ESC + b"[200~" + payload + ESC + b"[201~"
    return [
        ("coalesced typing", [b"hi\r"], b"hi\r"),
        ("split UTF-8", [b"\xf0", b"\x9f", b"\x8c", b"\x8d"], "🌍".encode()),
        ("split Shift+Enter", [ESC, b"[13;", b"2u"], ESC + b"[13;2u"),
        ("delayed paste opener", [(ESC + b"[20", 0.12), b"0~\x1bt\x1b[201~"], ESC + b"[200~\x1bt\x1b[201~"),
        ("bare Escape", [ESC], ESC),
        ("shortcuts inside a burst", [b"a\x1btb\x1b[116;3uc"], b"abc"),
        ("NUL and invalid UTF-8", [b"a\0b\xffc"], b"a\0b\xffc"),
        ("unknown CSI and focus", [b"\x1b[999;42u\x1b[I\x1b[O"], b"\x1b[999;42u\x1b[I\x1b[O"),
        ("opaque OSC", [b"\x1b]52;c;\x1bt", b"\x07z"], b"\x1b]52;c;\x1bt\x07z"),
        ("128-byte boundary", [b"x" * 128], b"x" * 128),
        ("unbracketed burst", [b"abcd" * 1250], b"abcd" * 1250),
        ("50 KiB bracketed paste", [paste[i:i + 997] for i in range(0, len(paste), 997)], paste),
        ("typing after paste", [b"done\r"], b"done\r"),
    ]


def child(scratch: Path) -> None:
    old = termios.tcgetattr(0)
    tty.setraw(0)
    try:
        os.write(1, ESC + b"[?2004h")
        results = []
        for index, (name, _, expected) in enumerate(cases()):
            (scratch / f"ready-{index}").touch()
            received = bytearray()
            started = time.monotonic()
            last = started
            first = None
            while time.monotonic() - started < 8:
                if select.select([0], [], [], 0.01)[0]:
                    received.extend(os.read(0, 65536))
                    last = time.monotonic()
                    if first is None:
                        first = last - started
                if len(received) >= len(expected) and time.monotonic() - last > 0.15:
                    break
            result = {"name": name, "bytes": len(received), "first_seconds": first,
                      "sha256": hashlib.sha256(received).hexdigest(), "ok": received == expected}
            if not result["ok"]:
                result["sample"] = repr(received[:80])
            results.append(result)
            # Parent observes only complete files.
            staged = scratch / "result.tmp"
            staged.write_text(json.dumps(results))
            staged.replace(scratch / "results.json")
            if not result["ok"]:
                return
        os.write(1, ESC + b"[?2004l")
        time.sleep(0.2)
    finally:
        termios.tcsetattr(0, termios.TCSANOW, old)


def run(binary: str) -> None:
    with tempfile.TemporaryDirectory(prefix="sbg-input-") as tmp:
        scratch = Path(tmp)
        config_dir = scratch / "config"
        config_dir.mkdir()
        palette = "\n".join(f"{i} = [{i}, {i}, {i}]" for i in range(256))
        (config_dir / "palette.toml").write_text(palette + "\nforeground = [220, 220, 220]\nbackground = [20, 20, 20]\n")
        launcher = scratch / "child"
        launcher.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, str(Path(__file__).resolve()), "child", tmp]) + "\n")
        launcher.chmod(0o755)
        env = dict(os.environ, XDG_CACHE_HOME=tmp, SBG_STATE=str(scratch / "pane"),
                   SBG_TATTOY=binary, SBG_TATTOY_CONFIG_DIR=str(config_dir),
                   TATTOY_NEST="allow", SBG_KITTY_KEYS="0", SBG_LOG_LEVEL="debug",
                   TERM="xterm-256color", COLORTERM="truecolor")
        for key in ("SBG_SCRIPT", "NO_COLOR", "FORCE_COLOR"):
            env.pop(key, None)
        dry = subprocess.run([str(ROOT / "bin/sbg"), "stars", "--dry-run", "--", str(launcher)],
                             env=env, capture_output=True, text=True, check=True)
        argv = shlex.split(dry.stdout.splitlines()[1])
        argv.extend(["--config-dir", str(config_dir)])
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
            os.execve(argv[0], argv, env)
        os.set_blocking(fd, False)
        output = bytearray()
        index, fragment, offset = 0, 0, 0
        next_write = 0.0
        status = None
        scenarios = cases()
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if index < len(scenarios) and (scratch / f"ready-{index}").exists() and time.monotonic() >= next_write:
                    parts = scenarios[index][1]
                    part = parts[fragment]
                    data, delay = part if isinstance(part, tuple) else (part, 0.01)
                    try:
                        offset += os.write(fd, data[offset:])
                    except BlockingIOError:
                        pass
                    if offset == len(data):
                        fragment, offset = fragment + 1, 0
                        next_write = time.monotonic() + delay
                        if fragment == len(parts):
                            index, fragment = index + 1, 0
                if select.select([fd], [], [], 0.002)[0]:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)
                    del output[:-65536]
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    break
                status = None
        finally:
            if status is None:
                done, status = os.waitpid(pid, os.WNOHANG)
                grace = time.monotonic() + 1
                while not done and time.monotonic() < grace:
                    time.sleep(0.01)
                    done, status = os.waitpid(pid, os.WNOHANG)
                if not done:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                    raise AssertionError(f"input fixture timed out at case {index}; output={output[-1000:]!r}")
            os.close(fd)
        assert os.waitstatus_to_exitcode(status) == 0, output[-1000:]
        results = json.loads((scratch / "results.json").read_text())
        assert all(r["ok"] for r in results), results[-1]
        assert len(results) == len(scenarios), results
        escape = next(r for r in results if r["name"] == "bare Escape")
        assert escape["first_seconds"] < 0.5, escape
        logs = "\n".join(p.read_text(errors="replace") for p in scratch.rglob("*.log"))
        assert logs.count("Toggling Tattoy renderer to:") == 2, "shortcuts must fire twice, including CSI-u, and never inside paste/OSC"
        print(f"ok input: {len(results)} real PTY cases, 50 KiB paste byte-exact, shortcuts preserved, Escape {escape['first_seconds'] * 1000:.1f} ms")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "child":
        child(Path(sys.argv[2]))
    else:
        run(str(Path(sys.argv[1]).resolve()))

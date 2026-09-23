#!/usr/bin/env python3
"""Exercise palette replies and colored-space occupancy through a real Tattoy PTY."""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
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
ST = ESC + b"\\"


def child(scratch: Path) -> None:
    old = termios.tcgetattr(0)
    tty.setraw(0)
    try:
        # Query split across reads, with cursor motion in the same stream.
        os.write(1, ESC + b"[5;7H" + ESC + b"]10;")
        time.sleep(0.02)
        started = time.monotonic()
        os.write(1, b"?" + ST + ESC + b"]11;?\a" + ESC + b"[6n")
        reply = b""
        while time.monotonic() - started < 0.5:
            if select.select([0], [], [], 0.01)[0]:
                reply += os.read(0, 4096)
            if b"]10;rgb:" in reply and b"]11;rgb:" in reply and b"[5;7R" in reply:
                break
        (scratch / "reply.json").write_text(json.dumps({
            "reply": reply.decode(), "seconds": time.monotonic() - started,
        }))
        os.write(1, ESC + b"[10;1H" + ESC + b"[48;2;53;54;64m" + b" " * 40 + ESC + b"[0m")
        os.write(1, ESC + b"[12;1H" + ESC + b"[44m" + b" " * 20 + ESC + b"[0m")
        os.write(1, ESC + b"[14;1H" + b" " * 40)
        received = b""
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not received:
            if select.select([0], [], [], 0.05)[0]:
                received += os.read(0, 128)
        size = (30, 100)
        while time.monotonic() < deadline and size != (34, 110):
            size = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8)))[:2]
            time.sleep(0.02)
        (scratch / "input.json").write_text(json.dumps({"input": received.decode(), "size": size}))
        time.sleep(0.5)
    finally:
        termios.tcsetattr(0, termios.TCSANOW, old)


def spy(scratch: Path) -> None:
    for line in sys.stdin:
        message = json.loads(line)
        update = message.get("pty_update")
        if update is not None:
            # Append so resize's blank frame cannot hide a previously seen panel.
            with (scratch / "occupancy.jsonl").open("a") as file:
                file.write(json.dumps(update) + "\n")


def run(binary: str) -> None:
    with tempfile.TemporaryDirectory(prefix="sbg-colors-") as tmp:
        scratch = Path(tmp)
        config_dir = scratch / "config"
        config_dir.mkdir()
        palette = "\n".join(f"{i} = [{i}, {i}, {i}]" for i in range(256))
        (config_dir / "palette.toml").write_text(palette + "\nforeground = [201, 202, 203]\nbackground = [26, 27, 38]\n")
        for mode in ("child", "spy"):
            path = scratch / mode
            path.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, str(Path(__file__).resolve()), mode, tmp]) + "\n")
            path.chmod(0o755)
        env = dict(os.environ, XDG_CACHE_HOME=tmp, SBG_STATE=str(scratch / "pane"),
                   SBG_TATTOY=binary, SBG_TATTOY_CONFIG_DIR=str(config_dir),
                   TATTOY_NEST="allow", SBG_KITTY_KEYS="0",
                   TERM="xterm-256color", COLORTERM="truecolor")
        for key in ("SBG_SCRIPT", "NO_COLOR", "FORCE_COLOR"):
            env.pop(key, None)
        dry = subprocess.run([str(ROOT / "bin/sbg"), "stars", "--dry-run", "--", str(scratch / "child")],
                             env=env, capture_output=True, text=True, check=True)
        argv = shlex.split(dry.stdout.splitlines()[1])
        config = Path(argv[argv.index("--main-config") + 1])
        with config.open("a") as file:
            file.write(f'\n[[plugins]]\nname = "sbg-color-spy"\npath = "{scratch / "spy"}"\nenabled = true\nlayer = -6\nopacity = 0.5\n')
        argv.extend(["--config-dir", str(config_dir)])
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
            os.execve(argv[0], argv, env)
        output = bytearray()
        sent = False
        resize_at = None
        status = None
        try:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if resize_at is None and (scratch / "reply.json").exists():
                    resize_at = time.monotonic() + 0.3
                if not sent and resize_at is not None and time.monotonic() >= resize_at:
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 110, 0, 0))
                    os.kill(pid, signal.SIGWINCH)
                    # Let the application's PTY resize before it reports its size.
                    time.sleep(0.1)
                    os.write(fd, b"x")
                    sent = True
                if select.select([fd], [], [], 0.02)[0]:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)
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
                    details = {p.name: p.read_text() for p in scratch.glob("*.json")}
                    raise AssertionError(f"Tattoy failed to exit with its child: {details}; output={output[-2000:]!r}")
            os.close(fd)
        assert os.waitstatus_to_exitcode(status) == 0, output[-1500:]
        response = json.loads((scratch / "reply.json").read_text())
        reply = response["reply"]
        assert "]10;rgb:c9c9/caca/cbcb" in reply, response
        assert "]11;rgb:1a1a/1b1b/2626" in reply, response
        assert reply.count("[5;7R") == 1, response
        interaction = json.loads((scratch / "input.json").read_text())
        assert interaction == {"input": "x", "size": [34, 110]}, interaction
        updates = [json.loads(line) for line in (scratch / "occupancy.jsonl").read_text().splitlines()]
        protected = {(x, 9) for x in range(40)} | {(x, 11) for x in range(20)}
        assert any(protected <= {tuple(c["coordinates"]) for c in u["cells"]} for u in updates), "colored spaces omitted from occupancy"
        assert all(not any(c["coordinates"] == [10, 13] for c in u["cells"]) for u in updates), "default blank became occupied"
        assert b"48:2::53:54:64m" in output, ("panel RGB missing from final terminal output", sorted(set(re.findall(rb"\x1b\[[^m\x1b]*48[^m\x1b]*m", output)))[:30])
        print(f"ok terminal colors: paired palette replies ({response['seconds'] * 1000:.1f} ms), split query, cursor, colored spaces, single-key input, resize, exit")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("child", "spy"):
        (child if sys.argv[1] == "child" else spy)(Path(sys.argv[2]))
    else:
        run(str(Path(sys.argv[1]).resolve()))

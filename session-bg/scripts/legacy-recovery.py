#!/usr/bin/env python3
"""Opt-in migration bridge for an already-running pre-recovery sbg-fx host.

Retire this helper when that host exits or begins reporting runtime.json. It
only touches the mtime of an already selected script override after an exact
legacy fallback log; it never writes settings, events or world checkpoints.
Newly launched hosts own recovery internally and do not need this process.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time

FALLBACK = re.compile(r"^(\d+\.\d+) running the builtin effect$", re.M)


def birth(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=,comm="],
                            capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


class Bridge:
    def __init__(self, pane, script):
        self.pane = Path(pane)
        self.script = str(Path(script).resolve())
        self.event = None
        self.deadline = None
        self.attempts = 0
        self.healthy_since = None
        self.log_stamp = None
        self.last_fallback = None

    def fallback(self):
        path = self.pane / "fx.log"
        stat = path.stat()
        stamp = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        if stamp != self.log_stamp:
            with path.open("rb") as log:
                log.seek(max(0, stat.st_size - 16384))
                matches = FALLBACK.findall(log.read(16384).decode(errors="replace"))
            self.log_stamp = stamp
            self.last_fallback = float(matches[-1]) if matches else None
        return self.last_fallback

    def tick(self, now, wall):
        # Presence means a new host has taken responsibility. Never run two
        # recovery controllers, even if that host's heartbeat becomes stale.
        if (self.pane / "runtime.json").exists():
            return "retired"
        try:
            with (self.pane / "override.json").open("r") as override:
                value = json.load(override)
                if not isinstance(value, dict):
                    return "inactive"
                selected = value.get("script")
                params = value.get("params") or {}
                if not isinstance(selected, str) or str(Path(selected).resolve()) != self.script:
                    return "inactive"
                if value.get("enabled") is False or (isinstance(params, dict) and params.get("paused") is True):
                    return "suspended"
                event = self.fallback()
                saved = (self.pane / "fortress.json").stat().st_mtime
                if wall - saved < 3 or (event is not None and saved > event):
                    if self.healthy_since is None:
                        self.healthy_since = now
                    if now - self.healthy_since >= 30:
                        self.attempts = 0
                    return "healthy"
                self.healthy_since = None
                if event is None:
                    return "unknown"
                if event != self.event:
                    self.event = event
                    self.deadline = now + min(60, 5 * 2 ** min(self.attempts, 4))
                if self.deadline is None or now < self.deadline:
                    return "waiting"
                # Touch this open inode only: a concurrent user replacement
                # cannot have its content overwritten or selection changed.
                os.utime(override.fileno(), None)
                self.attempts += 1
                self.deadline = now + min(60, 5 * 2 ** min(self.attempts, 4))
                return "retry"
        except (OSError, ValueError, TypeError):
            return "unknown"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", type=int, required=True, help="existing sbg-fx PID")
    parser.add_argument("--pane", type=Path, required=True)
    parser.add_argument("--script", type=Path, required=True)
    args = parser.parse_args()
    owner = birth(args.parent)
    if args.parent <= 1 or not owner.endswith("sbg-fx") or not args.pane.is_dir():
        parser.error("parent must be an existing sbg-fx process and pane must exist")
    # One opt-in bridge per pane, automatically released on helper exit.
    with (args.pane / ".legacy-recovery.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        bridge = Bridge(args.pane, args.script)
        checked = 0
        while True:
            now = time.monotonic()
            try:
                os.kill(args.parent, 0)
            except OSError:
                return 0
            if now - checked >= 30:
                if birth(args.parent) != owner:
                    return 0
                checked = now
            result = bridge.tick(now, time.time())
            if result == "retired":
                return 0
            if result == "retry":
                print(f"{time.time():.3f} legacy recovery: requested selected script after fallback", flush=True)
            time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())

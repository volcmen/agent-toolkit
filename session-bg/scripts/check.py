#!/usr/bin/env python3
"""Project gate: plugin build, clippy, cargo tests, launcher tests, and (when tattoy exists) the headless smoke."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    commands = [
        (["cargo", "build", "--release", "--quiet"], ROOT / "plugins"),
        (["cargo", "clippy", "--release", "--quiet", "--", "-D", "warnings"], ROOT / "plugins"),
        (["cargo", "test", "--quiet"], ROOT / "plugins"),
        ([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], ROOT),
        ([sys.executable, "scripts/state-smoke.py"], ROOT),
    ]
    commands.append(([sys.executable, "scripts/world/bundle.py", "--check"], ROOT))
    if shutil.which("lua"):
        commands.append((["lua", "scripts/world/drive.lua"], ROOT))
    else:
        print("skip world drive: lua not on PATH")
    if shutil.which("tattoy"):
        commands.append(([sys.executable, "scripts/smoke.py"], ROOT))
    else:
        print("skip smoke: tattoy not on PATH")
    for command, cwd in commands:
        result = subprocess.run(command, cwd=cwd, check=False)
        if result.returncode:
            return result.returncode
    print("ok session-bg checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

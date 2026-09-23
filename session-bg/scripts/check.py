#!/usr/bin/env python3
"""Project gate: plugin build, clippy, cargo tests, launcher tests, and (when tattoy exists) the headless smoke."""
from __future__ import annotations

import shutil
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    commands = [
        (["cargo", "build", "--release", "--workspace", "--locked", "--quiet"], ROOT / "plugins"),
        (["cargo", "clippy", "--release", "--workspace", "--all-targets", "--locked", "--quiet", "--", "-D", "warnings"], ROOT / "plugins"),
        (["cargo", "test", "--workspace", "--locked", "--quiet"], ROOT / "plugins"),
        ([sys.executable, "scripts/term-smoke.py"], ROOT),
        ([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], ROOT),
        ([sys.executable, "scripts/state-smoke.py"], ROOT),
        ([sys.executable, "scripts/recovery-smoke.py"], ROOT),
        ([sys.executable, "scripts/world/fortress-smoke.py"], ROOT),
    ]
    commands.append(([sys.executable, "scripts/world/bundle.py", "--check"], ROOT))
    if shutil.which("lua"):
        commands.extend([
            (["lua", "scripts/world/tests/glyphs.lua"], ROOT),
            (["lua", "scripts/world/tests/studioview.lua"], ROOT),
            (["lua", "scripts/world/tests/studio.lua"], ROOT),
            (["lua", "scripts/world/tests/cast.lua"], ROOT),
            (["lua", "scripts/world/tests/fortress.lua"], ROOT),
            (["lua", "scripts/world/tests/life.lua"], ROOT),
            (["lua", "scripts/world/tests/plaque.lua"], ROOT),
            (["lua", "scripts/world/tests/presentation.lua"], ROOT),
            (["lua", "scripts/world/tests/landscape.lua"], ROOT),
            ([sys.executable, "scripts/world/fixtures.py"], ROOT),
            (["lua", "scripts/world/golden.lua"], ROOT),
            *[(["lua", "scripts/world/replay.lua", f"tests/fixtures/fortress/{name}.lua"], ROOT) for name in ("short", "half-hour", "three-hour")],
            (["lua", "scripts/world/drive.lua"], ROOT),
        ])
    else:
        print("skip world drive: lua not on PATH")
    managed = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "sbg/tattoy/bin/tattoy"
    backend = os.environ.get("SBG_TATTOY") or (str(managed) if managed.is_file() else shutil.which("tattoy"))
    if backend:
        commands.append(([sys.executable, "scripts/smoke.py"], ROOT))
        if managed.is_file() and not os.environ.get("SBG_TATTOY"):
            commands.append(([sys.executable, "scripts/build-tattoy.py", "--check"], ROOT))
        if managed.is_file() or os.environ.get("SBG_TATTOY"):
            commands.append(([sys.executable, "scripts/color-smoke.py", backend], ROOT))
            commands.append(([sys.executable, "scripts/input-smoke.py", backend], ROOT))
        else:
            print("skip color compatibility smoke: run python3 scripts/build-tattoy.py to install the fixed backend")
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

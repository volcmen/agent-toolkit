#!/usr/bin/env python3
"""Run the self-contained Qwen GSD project checks."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
WRAPPER = (
    PROJECT
    / "plugins"
    / "qwen-gsd"
    / "skills"
    / "qwen-gsd-slice"
    / "scripts"
    / "qwen_slice.sh"
)


def run(command: list[str]) -> bool:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(command, cwd=PROJECT, env=env, check=False)
    return result.returncode == 0


def main() -> int:
    checks = (
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        ["bash", "-n", str(WRAPPER)],
    )
    for command in checks:
        if not run(command):
            return 1
    print("ok  qwen-gsd project checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


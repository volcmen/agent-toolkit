#!/usr/bin/env python3
"""Offline launcher, bundle, and recovery checks; never launch the user's Chrome."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    if sys.platform != "darwin":
        print("skip Chrome CDP: macOS required; covered by the macOS CI job")
        return 0
    commands = (
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        ["bash", "-n", "scripts/install.sh"],
        ["/usr/bin/swift", "run", "chrome-cdp-tests"],
        ["/usr/bin/swift", "build", "-c", "release", "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"],
    )
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode:
            return result.returncode
    print("ok Chrome CDP offline checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Own the Qwen process group so cancelling the wrapper also stops its tools."""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from qwen_result import load, validate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--stderr", required=True)
    for name in ("session", "phase", "log", "model", "wall-time", "max-tool-calls", "max-turns"):
        parser.add_argument("--" + name, default="")
    parser.add_argument("--resumed", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    process = None
    interrupted = 0
    deadline = 0.0
    owned = {}

    def send(signum: int) -> None:
        if process is None:
            return
        snapshot = {}
        try:
            listing = subprocess.run(["ps", "-axo", "pid=,ppid=,lstart="], capture_output=True, text=True, timeout=1, check=True)
            for line in listing.stdout.splitlines():
                fields = line.split(None, 2)
                if len(fields) == 3:
                    snapshot[int(fields[0])] = (int(fields[1]), fields[2])
        except (OSError, ValueError, subprocess.SubprocessError):
            print("qwen_slice: descendant inspection failed; stopping the Qwen process group", file=sys.stderr)
        descendants = {process.pid}
        while True:
            children = {pid for pid, (parent, _started) in snapshot.items() if parent in descendants}
            expanded = descendants | children
            if expanded == descendants:
                break
            descendants = expanded
        for pid in descendants:
            if pid in snapshot:
                owned[pid] = snapshot[pid][1]
        for pid, started in list(owned.items()):
            if pid in snapshot and snapshot[pid][1] == started:
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    pass
        if process.poll() is None:
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass

    def stop(signum: int, _frame) -> None:
        nonlocal interrupted, deadline
        if not interrupted:
            interrupted = signum
            deadline = time.monotonic() + 2

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    code = 1
    try:
        handles = []
        try:
            for path in (args.log, args.stderr):
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                os.fchmod(descriptor, 0o600)
                handles.append(os.fdopen(descriptor, "w"))
            with open(args.prompt_file) as prompt:
                if not interrupted:
                    process = subprocess.Popen(command, stdin=prompt, stdout=handles[0], stderr=handles[1],
                                               start_new_session=True,
                                               env={**os.environ, "QWEN_CODE_SUPPRESS_YOLO_WARNING": "1"})
                    signalled = False
                    while process.poll() is None:
                        if interrupted:
                            if not signalled:
                                send(interrupted)
                                signalled = True
                            elif time.monotonic() >= deadline:
                                send(signal.SIGKILL)
                        time.sleep(0.05)
                    code = process.wait()
        finally:
            if interrupted:
                send(signal.SIGKILL)
            for handle in handles:
                handle.close()
    except OSError as error:
        print(f"qwen_slice: launch failed: {error}", file=sys.stderr)
    if interrupted:
        code = 128 + interrupted
    elif code < 0:
        code = 128 - code
    if code == 0:
        code, message = validate(load(Path(args.log)), args.model)
        if message:
            print(message, file=sys.stderr)
    here = Path(__file__).resolve().parent
    subprocess.run([sys.executable, str(here / "qwen_result.py"), args.log, "--exit-code", str(code)], check=False)
    print(f"stderr_log={args.stderr}")
    record = [sys.executable, str(here / "qwen_log.py"), "record", "--exit-code", str(code), "--stderr", args.stderr]
    for name in ("session", "phase", "log", "model", "wall-time", "max-tool-calls", "max-turns"):
        record.extend(["--" + name, getattr(args, name.replace("-", "_"))])
    if args.resumed:
        record.append("--resumed")
    subprocess.run(record, check=False)
    return code


if __name__ == "__main__":
    raise SystemExit(main())

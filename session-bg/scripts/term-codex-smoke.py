#!/usr/bin/env python3
"""Optional real Codex/Claude TUI probe. Types an unsent marker, then quits.

Build the outer terminal fixture first:
cargo build --release --manifest-path plugins/Cargo.toml -p sbg-term --example observe
This checks startup/input/colors in a headless terminal, not physical kitty parity.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("term_smoke", ROOT / "scripts/term-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class Observed(smoke.Terminal):
    def __init__(self, command):
        self.observer = subprocess.Popen([str(ROOT / "plugins/target/release/examples/observe")],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        super().__init__("", background=True, args=command, width=120, height=35,
                         env={"SBG_SCRIPT": str(ROOT / "plugins/fx/world.lua"), "SBG_ACTIVE": "1", "SBG_AUTO": "0"})

    def exchange(self, value):
        self.observer.stdin.write(json.dumps(value) + "\n")
        self.observer.stdin.flush()
        return json.loads(self.observer.stdout.readline())

    def pump(self, seconds=0.05):
        if select.select([self.master], [], [], seconds)[0]:
            try:
                data = os.read(self.master, 65536)
            except (BlockingIOError, OSError):
                return
            self.output.extend(data)
            reply = self.exchange({"bytes": list(data)})["reply"]
            if reply:
                self.send(bytes(reply))

    def close(self):
        super().close()
        self.observer.stdin.close()
        self.observer.wait(timeout=5)
        self.observer.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    app = parser.add_mutually_exclusive_group(required=True)
    app.add_argument("--codex", type=Path, help="real Codex binary, not the sbg shim")
    app.add_argument("--claude", type=Path, help="real Claude binary, not the sbg shim")
    args = parser.parse_args()
    name = "codex" if args.codex else "claude"
    command = ([str(args.codex), "--no-alt-screen", "-c", "check_for_update_on_startup=false"]
               if args.codex else [str(args.claude)])
    marker = "SBG_NATIVE_73-paste-check"
    with Observed(command) as terminal:
        start = time.monotonic()
        ready_at = None
        typed = pasted = False
        snapshot = None
        while time.monotonic() - start < 75:
            terminal.pump()
            elapsed = time.monotonic() - start
            # Wait for the application's interactive mode, not canonical PTY
            # echo during startup. Never submit a prompt to test readiness.
            if ready_at is None and elapsed > (18 if args.codex else 10) and b"\x1b[?2004h" in terminal.output:
                ready_at = elapsed
            if ready_at is None:
                continue
            if not typed:
                terminal.send(b"SBG_NATIVE_73-")
                typed = True
            if elapsed > ready_at + 1 and not pasted:
                terminal.send(b"\x1b[200~paste-check\x1b[201~")
                pasted = True
            if elapsed > ready_at + 4:
                snapshot = terminal.exchange({"snapshot": True})
                if marker in "\n".join(snapshot["rows"]):
                    break
        assert snapshot is not None
        text = "\n".join(snapshot["rows"])
        assert text.count(marker) == 1, "typed and pasted marker did not appear exactly once"
        if args.codex:
            assert snapshot["shaded_spaces"] > 0, "Codex shaded panels disappeared"
        # Frame counters can advance even when all moving glyphs are hidden.
        # Check the visible lower body while the real TUI is idle and unsent.
        until = time.monotonic() + 2.1
        while time.monotonic() < until:
            terminal.pump()
        later = terminal.exchange({"snapshot": True})
        animated_cells = sum(a != b for before, after in zip(snapshot["rows"][17:30], later["rows"][17:30])
                             for a, b in zip(before, after))
        assert animated_cells > 0, "visible lower-body animation is frozen behind the TUI"
        # Never press Enter: no prompt or paid model request is submitted.
        terminal.send(b"\x03")
        until = time.monotonic() + 0.3
        while time.monotonic() < until:
            terminal.pump()
        terminal.send(b"\x03")
        terminal.finish(10)
        metrics = json.loads(terminal.metrics.read_text())
        assert metrics["frames"] > 0, "native background never rendered"
        print(json.dumps({"app": name, "input_copies": 1, "shaded_spaces": snapshot["shaded_spaces"],
                          "visible_animation_cells": animated_cells,
                          "prompt_submitted": False, "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()

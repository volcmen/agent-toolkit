#!/usr/bin/env python3
"""Drive sbg-fx directly over its stdio protocol and prove that state files change the frames.

Starts the plugin with SBG_STATE pointing at a scratch pane dir, feeds one
pty_update, samples frames, then writes override.json (effect=stars) and
session.json (mode=error) and checks that the glyph set and colours change.
"""
from __future__ import annotations

import json
import os
import selectors
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = Path(os.environ.get("SBG_FX", ROOT / "plugins" / "target" / "release" / "sbg-fx"))


def frames(proc: subprocess.Popen, seconds: float) -> list[list[dict]]:
    out: list[list[dict]] = []
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for _ in sel.select(timeout=0.1):
            line = proc.stdout.readline()
            if not line:
                return out
            message = json.loads(line)
            if "output_cells" in message:
                out.append(message["output_cells"])
    return out


def main() -> int:
    if not PLUGIN.is_file():
        print(f"plugin missing: {PLUGIN}")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, SBG_STATE=tmp, SBG_EFFECT="matrix", SBG_SEED="3", SBG_FPS="20")
        proc = subprocess.Popen([str(PLUGIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True, bufsize=1)
        proc.stdin.write(json.dumps({"pty_update": {"size": [120, 40], "cells": [], "cursor": [0, 0]}}) + "\n")
        proc.stdin.flush()
        before = frames(proc, 1.0)
        Path(tmp, "override.json").write_text(json.dumps({"v": 1, "effect": "stars"}))
        after = frames(proc, 1.0)
        Path(tmp, "session.json").write_text(json.dumps({"v": 1, "mode": "error", "ts": time.time()}))
        tinted = frames(proc, 0.5)
        Path(tmp, "override.json").write_text(json.dumps({"v": 1, "enabled": False}))
        disabled = frames(proc, 0.6)
        proc.stdin.close()
        proc.wait(timeout=3)

    def glyphs(sample: list[list[dict]]) -> set[str]:
        return {cell["character"] for frame in sample for cell in frame}

    def redness(sample: list[list[dict]]) -> float:
        cells = [cell for frame in sample for cell in frame if cell.get("fg")]
        if not cells:
            return 0.0
        return sum(c["fg"][0] - (c["fg"][1] + c["fg"][2]) / 2 for c in cells) / len(cells)

    checks = {
        "matrix frames rendered": len(before) >= 5 and any(before),
        "katakana before override": any("ｱ" <= ch <= "ﾝ" for ch in glyphs(before)),
        "stars after override": bool(glyphs(after)) and not any("ｱ" <= ch <= "ﾝ" for ch in glyphs(after[-3:])),
        "error mode tints red": redness(tinted[-3:]) > redness(after[-3:]) + 0.1,
        "disabled emits a blank frame": bool(disabled) and disabled[-1] == [],
    }
    for name, ok in checks.items():
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

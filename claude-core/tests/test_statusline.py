#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import random
import string
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
STATUSLINE = ROOT / "statusline.py"


def published_status(payload: dict) -> dict:
    with TemporaryDirectory() as tmp:
        state = Path(tmp) / "state"
        state.mkdir()
        payload = {"workspace": {"current_dir": tmp}, "session_id": "statusline-test", **payload}
        env = {**os.environ, "SBG_STATE": str(state), "HOME": tmp}
        result = subprocess.run(
            [sys.executable, str(STATUSLINE)],
            input=json.dumps(payload),
            env=env,
            cwd=tmp,
            text=True,
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        return json.loads((state / "status.json").read_text(encoding="utf-8"))


class SessionBackgroundStatus(unittest.TestCase):
    def test_effort_level_reaches_the_published_status(self) -> None:
        level = "".join(random.choices(string.ascii_lowercase, k=random.randint(1, 8)))
        status = published_status({"model": {"display_name": "Opus"}, "effort": {"level": level}})
        self.assertEqual(status["effort"], level, f"level={level!r}")

    def test_missing_effort_is_published_as_null(self) -> None:
        status = published_status({"model": {"display_name": "Opus"}})
        self.assertIsNone(status["effort"])


if __name__ == "__main__":
    unittest.main()

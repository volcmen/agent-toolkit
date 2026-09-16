"""Offline tests for `sbg set` and `sbg state`."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SBG = ROOT / "bin" / "sbg"


class SbgSetStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.tmp.name)
        self.override_path = self.state_dir / "override.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_sbg(self, *args):
        env = dict(os.environ, SBG_STATE=str(self.state_dir))
        return subprocess.run([sys.executable, str(SBG), *args], capture_output=True, text=True, env=env, check=False)

    def read_override(self):
        return json.loads(self.override_path.read_text(encoding="utf-8"))

    def test_set_round_trip(self):
        result = self.run_sbg("set", "effect=matrix", "density=1.5")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = self.read_override()
        self.assertEqual(data["effect"], "matrix")
        self.assertEqual(data["params"]["density"], 1.5)
        self.assertEqual(data["v"], 1)
        self.assertIn("ts", data)

    def test_set_merges_and_keeps_earlier_keys(self):
        self.run_sbg("set", "effect=matrix")
        result = self.run_sbg("set", "speed=2.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = self.read_override()
        self.assertEqual(data["effect"], "matrix")
        self.assertEqual(data["params"]["speed"], 2.0)

    def test_set_empty_value_nulls_the_key(self):
        self.run_sbg("set", "effect=matrix")
        result = self.run_sbg("set", "effect=")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.read_override()["effect"])

    def test_unknown_key_rejected_and_file_untouched(self):
        self.run_sbg("set", "effect=matrix")
        before = self.override_path.read_text(encoding="utf-8")
        result = self.run_sbg("set", "bogus=1")
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stderr.strip())
        self.assertEqual(self.override_path.read_text(encoding="utf-8"), before)

    def test_density_out_of_range_rejected_and_file_untouched(self):
        self.run_sbg("set", "effect=matrix")
        before = self.override_path.read_text(encoding="utf-8")
        result = self.run_sbg("set", "density=9")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.override_path.read_text(encoding="utf-8"), before)

    def test_bogus_mode_rejected_and_file_untouched(self):
        self.run_sbg("set", "effect=matrix")
        before = self.override_path.read_text(encoding="utf-8")
        result = self.run_sbg("set", "mode=bogus")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.override_path.read_text(encoding="utf-8"), before)

    def test_frozen_maybe_rejected_and_file_untouched(self):
        self.run_sbg("set", "effect=matrix")
        before = self.override_path.read_text(encoding="utf-8")
        result = self.run_sbg("set", "frozen=maybe")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.override_path.read_text(encoding="utf-8"), before)

    def test_set_no_args_prints_empty_object_when_missing(self):
        result = self.run_sbg("set")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {})

    def test_set_no_args_prints_current_override(self):
        self.run_sbg("set", "effect=matrix")
        result = self.run_sbg("set")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["effect"], "matrix")

    def test_state_json_merges_files_and_marks_malformed(self):
        (self.state_dir / "session.json").write_text(json.dumps({"mode": "thinking"}), encoding="utf-8")
        (self.state_dir / "status.json").write_text("{not json", encoding="utf-8")
        self.run_sbg("set", "effect=matrix")
        result = self.run_sbg("state", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["session"]["mode"], "thinking")
        self.assertEqual(payload["status"], "<invalid>")
        self.assertEqual(payload["override"]["effect"], "matrix")
        self.assertIsNone(payload["error"])
        self.assertTrue(payload["pane"])
        self.assertEqual(payload["dir"], str(self.state_dir))

    def test_dry_run_prints_pane_and_state_env(self):
        env = dict(os.environ, SBG_STATE=str(self.state_dir), SBG_FX=str(SBG))
        result = subprocess.run(
            [sys.executable, str(SBG), "--dry-run", "matrix", "--", "claude"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SBG_PANE=", result.stdout)
        self.assertIn(f"SBG_STATE={self.state_dir}", result.stdout)


if __name__ == "__main__":
    unittest.main()

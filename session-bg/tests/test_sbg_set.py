"""Offline tests for `sbg set` and `sbg state`."""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SBG = ROOT / "bin" / "sbg"


def setUpModule():
    stub_bin = Path(unittest.enterModuleContext(tempfile.TemporaryDirectory()))
    tattoy = stub_bin / "tattoy"
    tattoy.write_text("#!/bin/sh\nexit 0\n")
    tattoy.chmod(0o755)
    unittest.enterModuleContext(mock.patch.dict(os.environ, {"PATH": f"{stub_bin}{os.pathsep}{os.environ['PATH']}"}))


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

    def test_scene_round_trip(self):
        result = self.run_sbg("set", "scene=settlement")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_override()["params"]["scene"], "settlement")

    def test_bogus_scene_rejected_and_file_untouched(self):
        self.run_sbg("set", "effect=matrix")
        before = self.override_path.read_text(encoding="utf-8")
        result = self.run_sbg("set", "scene=garden")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.override_path.read_text(encoding="utf-8"), before)

    def test_removed_office_scene_rejected_and_file_untouched(self):
        self.run_sbg("set", "scene=studio")
        before = self.override_path.read_text(encoding="utf-8")
        result = self.run_sbg("set", "scene=office")
        self.assertEqual(result.returncode, 2)
        self.assertIn("scene=studio", result.stderr)
        self.assertEqual(self.override_path.read_text(encoding="utf-8"), before)

    def test_studio_scene_round_trip(self):
        result = self.run_sbg("set", "scene=studio")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_override()["params"]["scene"], "studio")

    def test_glyphs_round_trip(self):
        for value in random.sample(["unicode", "ascii"], 2):
            result = self.run_sbg("set", f"glyphs={value}")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.read_override()["params"]["glyphs"], value)

    def test_bogus_glyphs_rejected_and_file_untouched(self):
        self.run_sbg("set", "effect=matrix")
        before = self.override_path.read_text(encoding="utf-8")
        bogus = random.choice(["emoji", "UNICODE", "", "ascii2", "nerd"])
        result = self.run_sbg("set", f"glyphs={bogus}")
        self.assertEqual(result.returncode, 2, f"glyphs={bogus!r}")
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

    def test_runtime_reports_actual_effect_separately_from_selection(self):
        self.run_sbg("set", "script=/tmp/requested-fortress.lua")
        runtime = {"status": "recovering", "active": {"kind": "builtin", "name": "stars"},
                   "requested": {"kind": "script", "path": "/tmp/requested-fortress.lua"},
                   "reason": "repeated script failures", "ts": time.time(), "retry_at": time.time() + 5}
        (self.state_dir / "runtime.json").write_text(json.dumps(runtime))
        result = self.run_sbg("state", "--json")
        self.assertEqual(json.loads(result.stdout)["runtime"], runtime)
        result = self.run_sbg("doctor")
        self.assertIn("runtime: recovering active={'kind': 'builtin', 'name': 'stars'}", result.stdout)
        self.assertIn("repeated script failures", result.stdout)
        runtime["ts"] = 1
        (self.state_dir / "runtime.json").write_text(json.dumps(runtime))
        self.assertIn("runtime: stale;", self.run_sbg("doctor").stdout)


if __name__ == "__main__":
    unittest.main()

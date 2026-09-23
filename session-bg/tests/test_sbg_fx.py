"""Offline tests for `sbg fx` and `--script`."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SBG = ROOT / "bin" / "sbg"
FX_SOURCE = ROOT / "plugins" / "fx"


def setUpModule():
    stub_bin = Path(unittest.enterModuleContext(tempfile.TemporaryDirectory()))
    tattoy = stub_bin / "tattoy"
    tattoy.write_text("#!/bin/sh\nexit 0\n")
    tattoy.chmod(0o755)
    unittest.enterModuleContext(mock.patch.dict(os.environ, {"PATH": f"{stub_bin}{os.pathsep}{os.environ['PATH']}"}))


class SbgFxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.fx_dir = Path(self.tmp.name) / "fx"
        self.state_dir = Path(self.tmp.name) / "state"
        self.home.mkdir()
        self.fx_dir.mkdir()
        self.state_dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_sbg(self, *args, env_extra=None):
        env = dict(
            os.environ,
            HOME=str(self.home),
            SBG_FX_DIR=str(self.fx_dir),
            SBG_STATE=str(self.state_dir),
        )
        if env_extra:
            env.update(env_extra)
        return subprocess.run([sys.executable, str(SBG), *args], capture_output=True, text=True, env=env, check=False)

    def override_data(self):
        path = self.state_dir / "override.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_list_shows_builtins_and_copied_scripts(self):
        result = self.run_sbg("fx", "list")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("matrix", "plasma", "waves", "stars"):
            self.assertIn(name, result.stdout)
        new_result = self.run_sbg("fx", "new", "mycustom")
        self.assertEqual(new_result.returncode, 0, new_result.stderr)
        result = self.run_sbg("fx", "list")
        self.assertIn("mycustom", result.stdout)

    def test_list_json_shape(self):
        self.run_sbg("fx", "new", "mycustom")
        result = self.run_sbg("fx", "list", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("matrix", payload["builtins"])
        names = [entry["name"] for entry in payload["scripts"]]
        self.assertIn("mycustom", names)

    def test_new_creates_file_from_template(self):
        result = self.run_sbg("fx", "new", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        target = self.fx_dir / "demo.lua"
        self.assertEqual(result.stdout.strip(), str(target))
        self.assertTrue(target.is_file())
        self.assertIn("function render", target.read_text(encoding="utf-8"))

    def test_new_refuses_to_overwrite(self):
        self.run_sbg("fx", "new", "demo")
        (self.fx_dir / "demo.lua").write_text("-- edited\n", encoding="utf-8")
        result = self.run_sbg("fx", "new", "demo")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.fx_dir / "demo.lua").read_text(encoding="utf-8"), "-- edited\n")

    def test_path_resolves_script_and_rejects_unknown(self):
        self.run_sbg("fx", "new", "demo")
        result = self.run_sbg("fx", "path", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(self.fx_dir / "demo.lua"))
        missing = self.run_sbg("fx", "path", "nope")
        self.assertNotEqual(missing.returncode, 0)

    def test_path_for_builtin_without_script_errors(self):
        result = self.run_sbg("fx", "path", "matrix")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("builtin", result.stderr)

    def test_use_script_writes_override_path(self):
        self.run_sbg("fx", "new", "demo")
        result = self.run_sbg("fx", "use", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = self.override_data()
        self.assertEqual(data["script"], str(self.fx_dir / "demo.lua"))

    def test_use_off_clears_script(self):
        self.run_sbg("fx", "new", "demo")
        self.run_sbg("fx", "use", "demo")
        result = self.run_sbg("fx", "use", "off")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.override_data()["script"])

    def test_use_builtin_name_sets_effect_and_clears_script(self):
        self.run_sbg("fx", "new", "demo")
        self.run_sbg("fx", "use", "demo")
        result = self.run_sbg("fx", "use", "matrix")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = self.override_data()
        self.assertEqual(data["effect"], "matrix")
        self.assertIsNone(data["script"])

    def test_use_unknown_name_errors(self):
        result = self.run_sbg("fx", "use", "nope")
        self.assertNotEqual(result.returncode, 0)

    def test_install_copies_shipped_scripts_without_overwriting(self):
        shipped = sorted(p.name for p in FX_SOURCE.glob("*.lua"))
        self.assertTrue(shipped)
        edited = self.fx_dir / shipped[0]
        edited.write_text("-- keep me\n", encoding="utf-8")
        result = self.run_sbg("install")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in shipped:
            self.assertTrue((self.fx_dir / name).is_file())
        self.assertEqual(edited.read_text(encoding="utf-8"), "-- keep me\n")

    def test_dry_run_with_script_prints_sbg_script(self):
        script = self.fx_dir / "pulse.lua"
        script.write_text("-- test\n", encoding="utf-8")
        result = self.run_sbg(
            "--dry-run",
            "--script",
            str(script),
            "matrix",
            "--",
            "claude",
            env_extra={"SBG_FX": str(SBG)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"SBG_SCRIPT={script}", result.stdout)

    def test_dry_run_without_script_omits_sbg_script(self):
        result = self.run_sbg(
            "--dry-run",
            "matrix",
            "--",
            "claude",
            env_extra={"SBG_FX": str(SBG)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("SBG_SCRIPT=", result.stdout)


if __name__ == "__main__":
    unittest.main()

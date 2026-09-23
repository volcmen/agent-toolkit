"""The migration helper cannot fabricate events, replace user choices or spin."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("legacy_recovery", Path(__file__).resolve().parents[1] / "scripts/legacy-recovery.py")
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class LegacyRecoveryTests(unittest.TestCase):
    def test_only_exact_legacy_fallback_retries_with_settings_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            pane = Path(tmp)
            script = pane / "fortress.lua"
            selection = pane / "override.json"
            settings = {"script": str(script), "session_name": "My world", "params": {"density": 1.2}}
            selection.write_text(json.dumps(settings))
            checkpoint = pane / "fortress.json"
            checkpoint.write_text('{"seq":42}')
            os.utime(checkpoint, (100, 100))
            log = pane / "fx.log"
            log.write_text("101.000 running the builtin effect\n")
            bridge = legacy.Bridge(pane, script)
            before = selection.read_bytes()
            assert bridge.tick(0, 110) == "waiting"
            assert bridge.tick(4, 114) == "waiting"
            assert bridge.tick(5, 115) == "retry"
            assert bridge.tick(6, 116) == "waiting"
            assert bridge.tick(15, 125) == "retry"
            self.assertEqual(selection.read_bytes(), before)
            self.assertEqual(checkpoint.read_text(), '{"seq":42}')
            for fields in [{"effect": "stars"}, {**settings, "enabled": False},
                           {**settings, "params": {"paused": True}}]:
                selection.write_text(json.dumps(fields))
                self.assertIn(bridge.tick(100, 210), {"inactive", "suspended"})
                self.assertEqual(json.loads(selection.read_text()), fields)
            selection.write_text(before.decode())
            os.utime(checkpoint, (211, 211))
            self.assertEqual(bridge.tick(102, 212), "healthy")
            (pane / "runtime.json").write_text("{}")
            self.assertEqual(bridge.tick(200, 310), "retired")

    def test_stale_checkpoint_alone_is_not_a_fallback_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            pane = Path(tmp)
            script = pane / "fortress.lua"
            (pane / "override.json").write_text(json.dumps({"script": str(script)}))
            checkpoint = pane / "fortress.json"
            checkpoint.write_text("{}")
            os.utime(checkpoint, (100, 100))
            (pane / "fx.log").write_text("101.000 reloaded script\n")
            bridge = legacy.Bridge(pane, script)
            self.assertEqual(bridge.tick(0, 110), "unknown")
            self.assertEqual(bridge.tick(100, 210), "unknown")


if __name__ == "__main__":
    unittest.main()

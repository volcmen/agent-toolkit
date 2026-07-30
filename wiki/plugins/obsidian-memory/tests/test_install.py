from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[3] / "scripts" / "install.py"
SPEC = importlib.util.spec_from_file_location("install", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InstallTests(unittest.TestCase):
    def test_codex_policy_preserves_existing_guidance_and_refreshes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            destination = root / "AGENTS.md"
            policy = root / "policy.md"
            destination.write_text("# My guidance\n\nKeep this.\n", encoding="utf-8")
            policy.write_text("# Shared memory\n\nFirst version.\n", encoding="utf-8")

            with mock.patch.object(MODULE, "POLICY", policy):
                MODULE.install_codex_policy(destination)
                first = destination.read_text(encoding="utf-8")
                policy.write_text(
                    "# Shared memory\n\nSecond version at `C:\\vault`.\n",
                    encoding="utf-8",
                )
                MODULE.install_codex_policy(destination)
                second = destination.read_text(encoding="utf-8")

            self.assertIn("# My guidance", second)
            self.assertIn("Keep this.", second)
            self.assertNotIn("First version.", second)
            self.assertIn(r"Second version at `C:\vault`.", second)
            self.assertEqual(second.count(MODULE.CODEX_POLICY_START), 1)
            self.assertEqual(second.count(MODULE.CODEX_POLICY_END), 1)
            self.assertNotEqual(first, second)

    def test_codex_policy_migrates_legacy_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            destination = root / "AGENTS.md"
            policy = root / "policy.md"
            policy.write_text("# Shared memory\n", encoding="utf-8")
            destination.symlink_to(policy)

            with mock.patch.object(MODULE, "POLICY", policy):
                MODULE.install_codex_policy(destination)

            self.assertFalse(destination.is_symlink())
            self.assertIn(MODULE.CODEX_POLICY_START, destination.read_text(encoding="utf-8"))

    def test_codex_policy_rejects_malformed_markers(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            destination = root / "AGENTS.md"
            policy = root / "policy.md"
            policy.write_text("# Shared memory\n", encoding="utf-8")
            destination.write_text(MODULE.CODEX_POLICY_START, encoding="utf-8")

            with mock.patch.object(MODULE, "POLICY", policy):
                with self.assertRaises(RuntimeError):
                    MODULE.install_codex_policy(destination)

    def test_plugin_cache_repoints_broken_versions_for_active_threads(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp)
            current = cache / "2.0"
            current.mkdir()
            previous = cache / "1.0"
            previous.symlink_to(cache / "missing", target_is_directory=True)

            MODULE.preserve_plugin_cache_path(cache, "1.0", "2.0")

            self.assertTrue(previous.is_symlink())
            self.assertEqual(previous.resolve(), current.resolve())

    def test_plugin_cache_preserves_existing_version_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp)
            previous = cache / "1.0"
            current = cache / "2.0"
            previous.mkdir()
            current.mkdir()

            MODULE.preserve_plugin_cache_path(cache, "1.0", "2.0")

            self.assertTrue(previous.is_dir())
            self.assertFalse(previous.is_symlink())


if __name__ == "__main__":
    unittest.main()

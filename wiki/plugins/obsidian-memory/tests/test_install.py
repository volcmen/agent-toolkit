from __future__ import annotations

import io
import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[3] / "scripts" / "install.py"
SPEC = importlib.util.spec_from_file_location("install", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InstallTests(unittest.TestCase):
    def test_guidance_status_distinguishes_claude_and_codex_health(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            policy = root / "policy.md"
            claude_policy = root / "claude-rule.md"
            codex_policy = root / "AGENTS.md"
            config = root / "config.json"
            vault = root / "vault"
            (vault / "wiki").mkdir(parents=True)
            policy.write_text("# Shared memory\n", encoding="utf-8")
            config.write_text(json.dumps({"vault": str(vault)}), encoding="utf-8")
            with (
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", claude_policy),
                mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
                mock.patch.object(MODULE, "CONFIG", config),
            ):
                missing = MODULE.guidance_status()
                MODULE.link_policy(claude_policy, replace=False)
                MODULE.install_codex_policy(codex_policy)
                current = MODULE.guidance_status()
            self.assertFalse(missing["ok"])
            self.assertEqual(missing["claude"], "missing")
            self.assertEqual(missing["codex"], "missing")
            self.assertTrue(current["ok"])
            self.assertEqual(current["claude"], "current")
            self.assertEqual(current["codex"], "current")

    def test_guidance_status_reports_stale_claude_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            policy = root / "policy.md"
            old_policy = root / "old-policy.md"
            claude_policy = root / "claude-rule.md"
            config = root / "config.json"
            policy.write_text("current\n", encoding="utf-8")
            old_policy.write_text("old\n", encoding="utf-8")
            claude_policy.symlink_to(old_policy)
            config.write_text(json.dumps({"vault": str(root / "vault")}), encoding="utf-8")
            with (
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", claude_policy),
                mock.patch.object(MODULE, "CODEX_POLICY", root / "missing-agents.md"),
                mock.patch.object(MODULE, "CONFIG", config),
            ):
                status = MODULE.guidance_status()
            self.assertEqual(status["claude"], "stale")

    def test_guidance_status_distinguishes_stale_and_malformed_codex_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            policy = root / "policy.md"
            codex_policy = root / "AGENTS.md"
            config = root / "config.json"
            policy.write_text("current\n", encoding="utf-8")
            config.write_text(json.dumps({"vault": str(root / "vault")}), encoding="utf-8")
            codex_policy.write_text(
                f"{MODULE.CODEX_POLICY_START}\nold\n{MODULE.CODEX_POLICY_END}\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", root / "missing-rule.md"),
                mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
                mock.patch.object(MODULE, "CONFIG", config),
            ):
                self.assertEqual(MODULE.guidance_status()["codex"], "stale")
                codex_policy.write_text(MODULE.CODEX_POLICY_START, encoding="utf-8")
                self.assertEqual(MODULE.guidance_status()["codex"], "malformed")

    def test_guidance_status_reports_reversed_codex_markers_as_malformed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            policy = root / "policy.md"
            codex_policy = root / "AGENTS.md"
            config = root / "config.json"
            policy.write_text("current\n", encoding="utf-8")
            config.write_text(json.dumps({"vault": str(root / "vault")}), encoding="utf-8")
            codex_policy.write_text(
                f"{MODULE.CODEX_POLICY_END}\nunmanaged\n{MODULE.CODEX_POLICY_START}\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", root / "missing-rule.md"),
                mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
                mock.patch.object(MODULE, "CONFIG", config),
            ):
                self.assertEqual(MODULE.guidance_status()["codex"], "malformed")

    def test_guidance_status_fails_closed_on_invalid_config_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "config.json"
            config.write_text("{broken", encoding="utf-8")
            with mock.patch.object(MODULE, "CONFIG", config):
                with self.assertRaises(RuntimeError):
                    MODULE.guidance_status()

    def test_reuse_config_requires_existing_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with (
                mock.patch.object(MODULE, "CONFIG", Path(temp) / "missing.json"),
                mock.patch.object(sys, "argv", ["install.py", "--reuse-config"]),
            ):
                with self.assertRaisesRegex(RuntimeError, "configuration not found"):
                    MODULE.main()

    def test_reuse_config_refreshes_guidance_without_rewriting_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "config.json"
            original = json.dumps({"vault": "/private/example", "custom": True}) + "\n"
            config.write_text(original, encoding="utf-8")
            with (
                mock.patch.object(MODULE, "CONFIG", config),
                mock.patch.object(sys, "argv", [
                    "install.py",
                    "--reuse-config",
                    "--skip-product-install",
                    "--skip-upstream-skill-link",
                    "--keep-legacy-hooks",
                ]),
                mock.patch.object(MODULE, "link_policy"),
                mock.patch.object(MODULE, "install_codex_policy"),
            ):
                self.assertEqual(MODULE.main(), 0)
            self.assertEqual(config.read_text(encoding="utf-8"), original)

    def test_reuse_config_rejects_reversed_codex_markers_without_rewriting(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "config.json"
            policy = root / "policy.md"
            claude_policy = root / "claude-rule.md"
            codex_policy = root / "AGENTS.md"
            config.write_text(json.dumps({"vault": "/private/example"}) + "\n", encoding="utf-8")
            policy.write_text("# Shared memory\n", encoding="utf-8")
            claude_policy.symlink_to(policy)
            original = f"personal\n{MODULE.CODEX_POLICY_END}\nbody\n{MODULE.CODEX_POLICY_START}\n"
            codex_policy.write_text(original, encoding="utf-8")
            with (
                mock.patch.object(MODULE, "CONFIG", config),
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", claude_policy),
                mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
                mock.patch.object(sys, "argv", [
                    "install.py",
                    "--reuse-config",
                    "--skip-product-install",
                    "--skip-upstream-skill-link",
                    "--keep-legacy-hooks",
                ]),
            ):
                with self.assertRaisesRegex(RuntimeError, "malformed obsidian-memory markers"):
                    MODULE.main()
            self.assertEqual(codex_policy.read_text(encoding="utf-8"), original)

    def test_reuse_config_rejects_unmanaged_codex_symlink_without_replacing_it(
        self,
    ) -> None:
        """Catches automatic config reuse acquiring Codex replacement authority."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "config.json"
            policy = root / "policy.md"
            claude_policy = root / "claude-rule.md"
            codex_policy = root / "AGENTS.md"
            unrelated = root / "unrelated-guidance.md"
            config_bytes = b'{"vault": "/private/example", "custom": true}\n'
            unrelated_bytes = b"KEEP THIS ACTIVE\n"
            config.write_bytes(config_bytes)
            policy.write_text("# Shared memory\n", encoding="utf-8")
            claude_policy.symlink_to(policy)
            unrelated.write_bytes(unrelated_bytes)
            codex_policy.symlink_to(unrelated)
            link_target = codex_policy.readlink()

            with (
                mock.patch.object(MODULE, "CONFIG", config),
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", claude_policy),
                mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "install.py",
                        "--reuse-config",
                        "--skip-product-install",
                        "--skip-upstream-skill-link",
                        "--keep-legacy-hooks",
                    ],
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "symlink not managed by obsidian-memory"
                ):
                    MODULE.main()

            self.assertEqual(config.read_bytes(), config_bytes)
            self.assertTrue(codex_policy.is_symlink())
            self.assertEqual(codex_policy.readlink(), link_target)
            self.assertEqual(unrelated.read_bytes(), unrelated_bytes)

    def test_explicit_replace_guidance_retains_symlink_replacement_authority(
        self,
    ) -> None:
        """Catches removal of the reviewed explicit replacement escape hatch."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "config.json"
            policy = root / "policy.md"
            claude_policy = root / "claude-rule.md"
            codex_policy = root / "AGENTS.md"
            unrelated = root / "unrelated-guidance.md"
            config.write_text('{"vault": "/private/example"}\n', encoding="utf-8")
            policy.write_text("# Shared memory\n", encoding="utf-8")
            claude_policy.symlink_to(policy)
            unrelated.write_text("KEEP TARGET\n", encoding="utf-8")
            codex_policy.symlink_to(unrelated)

            with (
                mock.patch.object(MODULE, "CONFIG", config),
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", claude_policy),
                mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "install.py",
                        "--reuse-config",
                        "--replace-guidance",
                        "--skip-product-install",
                        "--skip-upstream-skill-link",
                        "--keep-legacy-hooks",
                    ],
                ),
            ):
                self.assertEqual(MODULE.main(), 0)

            self.assertFalse(codex_policy.is_symlink())
            self.assertIn(
                MODULE.CODEX_POLICY_START,
                codex_policy.read_text(encoding="utf-8"),
            )
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "KEEP TARGET\n")

    def test_status_is_read_only_and_does_not_expose_vault_or_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "config.json"
            secret_vault = "/private/secret-vault"
            secret_policy = "never print this policy body"
            config.write_text(json.dumps({"vault": secret_vault}), encoding="utf-8")
            policy = root / "policy.md"
            policy.write_text(secret_policy, encoding="utf-8")
            output = io.StringIO()
            with (
                mock.patch.object(MODULE, "CONFIG", config),
                mock.patch.object(MODULE, "POLICY", policy),
                mock.patch.object(MODULE, "CLAUDE_POLICY", root / "missing-rule.md"),
                mock.patch.object(MODULE, "CODEX_POLICY", root / "missing-agents.md"),
                mock.patch.object(sys, "argv", ["install.py", "--status", "--json"]),
                mock.patch.object(MODULE, "configure") as configure,
                mock.patch.object(MODULE, "link_policy") as link_policy,
                mock.patch.object(MODULE, "install_codex_policy") as install_codex_policy,
                mock.patch.object(MODULE, "link_upstream_skills") as link_upstream_skills,
                mock.patch.object(MODULE, "remove_legacy_hooks") as remove_legacy_hooks,
                mock.patch.object(MODULE, "install_products") as install_products,
                redirect_stdout(output),
            ):
                self.assertEqual(MODULE.main(), 1)
            for operation in (
                configure,
                link_policy,
                install_codex_policy,
                link_upstream_skills,
                remove_legacy_hooks,
                install_products,
            ):
                operation.assert_not_called()
            payload = json.loads(output.getvalue())
            self.assertFalse(payload["ok"])
            self.assertNotIn(secret_vault, output.getvalue())
            self.assertNotIn(secret_policy, output.getvalue())

    def test_unconfigured_status_is_healthy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = io.StringIO()
            with (
                mock.patch.object(MODULE, "CONFIG", Path(temp) / "missing.json"),
                mock.patch.object(sys, "argv", ["install.py", "--status", "--json"]),
                redirect_stdout(output),
            ):
                self.assertEqual(MODULE.main(), 0)
            self.assertEqual(
                json.loads(output.getvalue()),
                {
                    "configured": False,
                    "ok": True,
                    "claude": "not-configured",
                    "codex": "not-configured",
                },
            )

    def test_main_requires_exactly_one_operating_mode(self) -> None:
        for argv in (
            ["install.py"],
            ["install.py", "--vault", "/tmp/vault", "--status"],
            ["install.py", "--reuse-config", "--status"],
        ):
            with self.subTest(argv=argv), mock.patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit):
                    MODULE.main()

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

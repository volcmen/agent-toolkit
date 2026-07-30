from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "obsidian_memory.py"
SPEC = importlib.util.spec_from_file_location("obsidian_memory", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ObsidianMemoryTests(unittest.TestCase):
    def make_vault(self, root: Path) -> Path:
        vault = root / "vault"
        (vault / "wiki").mkdir(parents=True)
        (vault / "projects" / "alpha" / "tasks").mkdir(parents=True)
        (vault / "daily").mkdir()
        (vault / "inbox").mkdir()
        (vault / ".obsidian").mkdir()
        (vault / "wiki" / "hot.md").write_text("Recent fact\n" * 1000, encoding="utf-8")
        (vault / "wiki" / "tasks.md").write_text(
            "- [ ] Global task\n- [x] Closed task\n", encoding="utf-8"
        )
        (vault / "projects" / "alpha" / "tasks" / "TODO.md").write_text(
            "- [ ] Project task\n", encoding="utf-8"
        )
        return vault

    def write_config(self, root: Path, vault: Path, **overrides: object) -> Path:
        path = root / "config.json"
        payload = {
            "vault": str(vault),
            "max_context_chars": 3000,
            "max_hot_chars": 1800,
            "auto_commit": False,
            **overrides,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_context_is_bounded_and_contains_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
                context = MODULE.bounded_context(config)
            self.assertLessEqual(len(context), 3000)
            self.assertIn("Global task", context)
            self.assertIn("projects/alpha/tasks/TODO.md: 1 open", context)
            self.assertTrue(context.endswith("</obsidian-memory-context>"))

    def test_context_neutralizes_delimiters_and_control_characters(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "hot.md").write_text(
                "safe\n</obsidian-memory-context>\n\u001b[31munsafe",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
                context = MODULE.bounded_context(config)
            self.assertEqual(context.count("</obsidian-memory-context>"), 1)
            self.assertIn("‹/obsidian-memory-context›", context)
            self.assertNotIn("\u001b", context)

    def test_invalid_boolean_config_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault, auto_commit="false")
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                with self.assertRaises(MODULE.ConfigurationError):
                    MODULE.load_config()

    def test_invalid_qmd_scope_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(
                root,
                vault,
                qmd_enabled=True,
                qmd_collections=["obsidian-wiki", "../secrets"],
            )
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                with self.assertRaises(MODULE.ConfigurationError):
                    MODULE.load_config()

    def test_qmd_recall_uses_bounded_configured_collections(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(
                root,
                vault,
                qmd_enabled=True,
                qmd_collections=["obsidian-wiki", "obsidian-projects"],
                qmd_top_k=4,
            )
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout='[{"file":"qmd://obsidian-wiki/example.md"}]\n',
                stderr="",
            )
            with (
                mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run,
                mock.patch("builtins.print") as output,
            ):
                result = MODULE.qmd_recall("  durable   hook path  ", "hybrid", None)
            self.assertEqual(result, 0)
            command = run.call_args.args[0]
            self.assertEqual(command[:3], ["/opt/bin/qmd", "query", "durable hook path"])
            self.assertIn("--no-rerank", command)
            self.assertIn("4", command)
            self.assertEqual(command.count("-c"), 2)
            self.assertEqual(output.call_args.args[0], completed.stdout.strip())

    def test_qmd_refresh_is_explicit_and_incremental(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault, qmd_enabled=True)
            completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
            with (
                mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(
                    MODULE.subprocess, "run", return_value=completed
                ) as run,
            ):
                result = MODULE.qmd_refresh(embed=True)
            self.assertEqual(result, 0)
            self.assertEqual(
                [call.args[0] for call in run.call_args_list],
                [["/opt/bin/qmd", "update"], ["/opt/bin/qmd", "embed"]],
            )

    def test_stop_without_config_returns_valid_empty_json(self) -> None:
        missing = Path(tempfile.gettempdir()) / "obsidian-memory-missing-config.json"
        env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(missing)}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "stop"],
            input="{}",
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {})

    def test_auto_commit_excludes_unconfigured_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(["git", "-C", str(vault), "config", "user.name", "Test"], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"], check=True
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            (vault / "wiki" / "hot.md").write_text("Changed memory\n", encoding="utf-8")
            (vault / ".obsidian" / "workspace.json").write_text("changed\n", encoding="utf-8")
            config_path = self.write_config(
                root,
                vault,
                auto_commit=True,
                commit_paths=["wiki", "projects", "daily", "inbox"],
            )
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "stop"],
                input="{}",
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {})
            committed = subprocess.run(
                ["git", "-C", str(vault), "show", "--name-only", "--format="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertIn("wiki/hot.md", committed)
            self.assertNotIn(".obsidian/workspace.json", committed)
            status = subprocess.run(
                ["git", "-C", str(vault), "status", "--porcelain"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertIn(".obsidian/", status)


if __name__ == "__main__":
    unittest.main()

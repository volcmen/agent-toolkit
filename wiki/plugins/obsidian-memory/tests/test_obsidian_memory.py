from __future__ import annotations

import contextlib
import importlib.util
import io
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
sys.modules[SPEC.name] = MODULE
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

    def init_git_vault(self, vault: Path) -> None:
        subprocess.run(["git", "init", "-q", str(vault)], check=True)
        subprocess.run(
            ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(vault),
                "config",
                "user.email",
                "test@example.com",
            ],
            check=True,
        )
        subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
        subprocess.run(
            ["git", "-C", str(vault), "commit", "-qm", "initial"], check=True
        )

    def git_stdout(self, vault: Path, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(vault), *args],
            text=True,
            capture_output=True,
            check=True,
        ).stdout

    def index_blobs(self, vault: Path, *paths: str) -> dict[str, str]:
        return {
            path: self.git_stdout(vault, "rev-parse", f":{path}").strip()
            for path in paths
        }

    def test_focused_context_is_bounded_and_routes_without_task_bodies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                context = MODULE.bounded_context(config)
            self.assertLessEqual(len(context), 3000)
            self.assertLessEqual(MODULE.estimated_tokens(context), 420)
            self.assertIn("wiki/tasks.md: 1 open", context)
            self.assertIn("projects/*/tasks/TODO.md: 1 project(s) with open tasks", context)
            self.assertNotIn("Global task", context)
            self.assertTrue(context.endswith("</obsidian-memory-context>"))

    def test_full_context_is_an_explicit_compatibility_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(
                root,
                vault,
                context_profile="full",
                max_context_tokens=1000,
                max_hot_chars=500,
            )
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
                context = MODULE.bounded_context(config)
            self.assertIn("Global task", context)
            self.assertIn("projects/alpha/tasks/TODO.md: 1 open", context)

    def test_focused_hot_uses_only_the_current_item(self) -> None:
        hot = """---
type: meta
---
# Recent Context

## Last Updated
2026-08-01. Latest: current durable outcome.

Prior: old unrelated outcome.

## Open global tasks
- [ ] unrelated
"""
        capsule = MODULE.focused_hot_text(hot)
        self.assertIn("current durable outcome", capsule)
        self.assertNotIn("old unrelated outcome", capsule)
        self.assertNotIn("Open global tasks", capsule)

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

    def test_invalid_recall_provider_and_root_fail_closed(self) -> None:
        cases = (
            {"recall_provider": "cloud-magic"},
            {"recall_roots": ["wiki", "../secrets"]},
            {"recall_roots": ["inbox"]},
            {"recall_roots": ["projects/alpha/.raw"]},
        )
        for overrides in cases:
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                vault = self.make_vault(root)
                config_path = self.write_config(root, vault, **overrides)
                with mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ):
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

    def test_invalid_qmd_collection_root_fails_closed(self) -> None:
        for invalid_root in ("../outside", "."):
            with self.subTest(root=invalid_root), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                vault = self.make_vault(root)
                config_path = self.write_config(
                    root,
                    vault,
                    qmd_collection_roots={"obsidian-wiki": invalid_root},
                )
                with mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ):
                    with self.assertRaises(MODULE.ConfigurationError):
                        MODULE.load_config()

    def test_recall_payload_is_the_cli_contract_without_printing(self) -> None:
        """Catches a payload helper that emits CLI output instead of returning it."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            note = vault / "projects" / "alpha" / "decision.md"
            note.write_text(
                "---\nstatus: accepted\nmemory_class: decision\n---\n"
                "# Canonical provider\nMarkdown remains canonical.\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault, recall_provider="native")
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    payload = MODULE.recall_payload(
                        config,
                        "Markdown remains canonical",
                        "fast",
                        3,
                        provider="native",
                        scope="projects/alpha",
                    )
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(payload["provider"], "native")
            self.assertEqual(payload["requested_provider"], "native")
            self.assertEqual(payload["requested_mode"], "fast")
            self.assertEqual(payload["results"][0]["path"], "projects/alpha/decision.md")
            self.assertLessEqual(
                payload["results_estimated_tokens"],
                payload["result_token_limit"],
            )

    def test_configured_qmd_collection_requires_a_root_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(
                root,
                vault,
                qmd_collections=["obsidian-wiki", "extra-collection"],
            )
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                with self.assertRaises(MODULE.ConfigurationError):
                    MODULE.load_config()

    def test_native_provider_recalls_without_qmd_and_honors_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "projects" / "alpha" / "decision.md").write_text(
                "---\nstatus: accepted\nmemory_class: decision\n---\n"
                "# Provider boundary\nThe portable provider boundary keeps Markdown canonical.\n",
                encoding="utf-8",
            )
            (vault / "projects" / "beta").mkdir()
            (vault / "projects" / "beta" / "decision.md").write_text(
                "# Provider boundary\nA conflicting portable provider boundary.\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault, recall_provider="auto")
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch("builtins.print") as output,
            ):
                result = MODULE.recall(
                    "portable provider boundary",
                    "hybrid",
                    5,
                    scope="projects/alpha",
                )
            self.assertEqual(result, 0)
            payload = json.loads(output.call_args.args[0])
            self.assertEqual(payload["provider"], "native")
            self.assertEqual(payload["requested_provider"], "auto")
            self.assertEqual(payload["requested_mode"], "hybrid")
            self.assertEqual(payload["mode"], "fast")
            self.assertTrue(payload["degraded"])
            self.assertEqual(payload["scope"], "projects/alpha")
            self.assertEqual(
                [item["path"] for item in payload["results"]],
                ["projects/alpha/decision.md"],
            )
            self.assertEqual(payload["results"][0]["memory"]["state"], "current")
            self.assertGreaterEqual(payload["diagnostics"]["files_scanned"], 1)

    def test_auto_provider_isolates_qmd_failure_and_falls_back(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "fallback.md").write_text(
                "# Durable fallback\nNative recall remains available.\n",
                encoding="utf-8",
            )
            config_path = self.write_config(
                root,
                vault,
                recall_provider="auto",
                qmd_enabled=True,
            )
            failed = subprocess.CompletedProcess(
                args=[], returncode=7, stdout="", stderr="index unavailable"
            )
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(MODULE.subprocess, "run", return_value=failed),
                mock.patch("builtins.print") as output,
            ):
                result = MODULE.recall("durable fallback", "fast", 3)
            self.assertEqual(result, 0)
            payload = json.loads(output.call_args.args[0])
            self.assertEqual(payload["provider"], "native")
            self.assertTrue(payload["degraded"])
            self.assertIn("QMD failed", payload["warnings"][0])
            self.assertEqual(payload["results"][0]["path"], "wiki/fallback.md")

    def test_auto_fast_provider_falls_back_from_weak_qmd_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "provider.md").write_text(
                "# Memory provider architecture\n"
                "The memory provider architecture keeps Markdown canonical.\n",
                encoding="utf-8",
            )
            config_path = self.write_config(
                root,
                vault,
                recall_provider="auto",
                qmd_enabled=True,
            )
            qmd_result = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(
                    [
                        {
                            "file": "qmd://obsidian-projects/alpha/tasks/TODO.md",
                            "title": "Architecture cleanup",
                            "snippet": "Unrelated task",
                            "score": 0.9,
                        }
                    ]
                ),
                stderr="",
            )
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(MODULE.subprocess, "run", return_value=qmd_result),
                mock.patch("builtins.print") as output,
            ):
                result = MODULE.recall("memory provider architecture", "fast", 3)
            self.assertEqual(result, 0)
            payload = json.loads(output.call_args.args[0])
            self.assertEqual(payload["provider"], "native")
            self.assertEqual(payload["results"][0]["path"], "wiki/provider.md")
            self.assertEqual(payload["diagnostics"]["filtered_low_coverage"], 1)
            self.assertIn("no sufficiently complete", payload["warnings"][0])

    def test_provider_status_keeps_markdown_canonical(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault, recall_provider="auto")
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                status = MODULE.recall_provider_status(config)
            self.assertEqual(status["canonical"]["name"], "obsidian-markdown")
            self.assertEqual(status["active"], "native")
            self.assertTrue(status["providers"]["native"]["healthy"])

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
            (vault / "wiki" / "example.md").write_text(
                "---\nstatus: verified\nconfidence: high\n---\n# Example\n",
                encoding="utf-8",
            )
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(
                    [
                        {
                            "file": "qmd://obsidian-wiki/example.md",
                            "title": "Example",
                            "line": 4,
                            "score": 0.9,
                            "context": "Repeated collection context",
                            "snippet": "@@ -3,2 @@\nUseful compact evidence",
                        }
                    ]
                ),
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
            self.assertEqual(command[:2], ["/opt/bin/qmd", "query"])
            # Options first, then the query behind `--`, so a query such as
            # "--max-tokens" cannot be parsed as a QMD option.
            self.assertEqual(command[-2:], ["--", "durable hook path"])
            self.assertIn("--no-rerank", command)
            # The full bounded pool is fetched regardless of --top so that
            # governance filtering cannot starve small requests.
            self.assertEqual(command[command.index("-n") + 1], "60")
            self.assertEqual(command[command.index("-C") + 1], "60")
            self.assertEqual(command.count("-c"), 2)
            payload = json.loads(output.call_args.args[0])
            self.assertEqual(payload["query"], "durable hook path")
            self.assertEqual(payload["results"][0]["path"], "wiki/example.md")
            self.assertEqual(payload["results"][0]["memory"]["state"], "current")
            self.assertNotIn("context", payload["results"][0])

    def test_scoped_qmd_recall_narrows_collection_and_candidate_starvation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "projects" / "alpha" / "decision.md"
            source.write_text(
                "---\nstatus: accepted\n---\n# Provider isolation\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault, qmd_enabled=True)
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(
                    [
                        {
                            "file": "qmd://obsidian-projects/alpha/decision.md",
                            "title": "Provider isolation",
                            "snippet": "Optional accelerator failure isolation",
                            "score": 0.91,
                        }
                    ]
                ),
                stderr="",
            )
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run,
                mock.patch("builtins.print") as output,
            ):
                result = MODULE.recall(
                    "optional accelerator failure isolation",
                    "semantic",
                    3,
                    provider="qmd",
                    scope="projects/alpha",
                )
            self.assertEqual(result, 0)
            command = run.call_args.args[0]
            self.assertEqual(command[command.index("-n") + 1], "60")
            self.assertEqual(command.count("-c"), 1)
            self.assertEqual(command[command.index("-c") + 1], "obsidian-projects")
            payload = json.loads(output.call_args.args[0])
            self.assertEqual(payload["results"][0]["path"], "projects/alpha/decision.md")

    def test_auto_semantic_empty_scope_falls_back_to_native_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "projects" / "alpha" / "provider.md"
            source.write_text(
                "# Provider resilience\nOptional accelerator failure isolation is required.\n",
                encoding="utf-8",
            )
            (vault / "projects" / "beta").mkdir()
            (vault / "projects" / "beta" / "other.md").write_text(
                "# Other project\n", encoding="utf-8"
            )
            config_path = self.write_config(
                root, vault, qmd_enabled=True, recall_provider="auto"
            )
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(
                    [
                        {
                            "file": "qmd://obsidian-projects/beta/other.md",
                            "title": "Other project",
                            "snippet": "A global semantic candidate outside scope",
                            "score": 0.9,
                        }
                    ]
                ),
                stderr="",
            )
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed),
                mock.patch("builtins.print") as output,
            ):
                result = MODULE.recall(
                    "optional accelerator failure isolation",
                    "semantic",
                    3,
                    scope="projects/alpha",
                )
            self.assertEqual(result, 0)
            payload = json.loads(output.call_args.args[0])
            self.assertEqual(payload["provider"], "native")
            self.assertEqual(payload["requested_mode"], "semantic")
            self.assertEqual(payload["mode"], "fast")
            self.assertEqual(payload["results"][0]["path"], "projects/alpha/provider.md")
            self.assertIn("no governed in-scope", payload["warnings"][0])

    def test_qmd_uri_recovers_one_canonical_filename_normalized_by_qmd(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "wiki" / "Memory systems (2026).md"
            source.write_text("---\nstatus: verified\n---\n", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            resolved = MODULE.resolve_qmd_uri(
                config, "qmd://obsidian-wiki/Memory-systems-2026.md"
            )
            self.assertEqual(
                resolved, (source.resolve(), "wiki/Memory systems (2026).md")
            )

    def test_provider_resolution_rejects_nested_private_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            private = vault / "projects" / "alpha" / ".raw"
            private.mkdir()
            (private / "secret.md").write_text("not recallable\n", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            self.assertIsNone(
                MODULE.resolve_qmd_uri(
                    config,
                    "qmd://obsidian-projects/alpha/.raw/secret.md",
                )
            )
            with self.assertRaises(MODULE.ConfigurationError):
                MODULE.normalize_recall_scope("projects/alpha/.raw")

    def test_qmd_recall_filters_stale_results_unless_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "old.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: wiki/current\n---\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "current.md").write_text(
                "---\nstatus: verified\n---\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault, qmd_enabled=True)
            raw = [
                {
                    "file": "qmd://obsidian-wiki/old.md",
                    "score": 1.0,
                    "snippet": "historical current choice",
                },
                {
                    "file": "qmd://obsidian-wiki/current.md",
                    "score": 0.8,
                    "snippet": "historical current choice",
                },
            ]
            completed = subprocess.CompletedProcess(
                args=[], returncode=0, stdout=json.dumps(raw), stderr=""
            )
            with (
                mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}),
                mock.patch.object(MODULE.shutil, "which", return_value="/opt/bin/qmd"),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed),
                mock.patch("builtins.print") as output,
            ):
                self.assertEqual(MODULE.qmd_recall("current choice", "fast", 2), 0)
                filtered = json.loads(output.call_args.args[0])
                self.assertEqual(
                    [item["path"] for item in filtered["results"]],
                    ["wiki/current.md"],
                )
                self.assertEqual(
                    MODULE.qmd_recall(
                        "historical choice", "fast", 2, include_stale=True
                    ),
                    0,
                )
                historical = json.loads(output.call_args.args[0])
                self.assertEqual(len(historical["results"]), 2)
                self.assertEqual(
                    historical["results"][0]["memory"]["superseded_by"],
                    "wiki/current",
                )

    def test_fast_provider_filters_weak_partial_matches(self) -> None:
        candidates = [
            {
                "path": "projects/wine/README.md",
                "title": "Anti-hallucination architecture",
                "snippet": "Render facts from a CSV.",
            },
            {
                "path": "wiki/memory.md",
                "title": "Memory provider architecture",
                "snippet": "Provider lifecycle and memory failure isolation.",
            },
        ]
        filtered, removed = MODULE.filter_fast_candidates(
            candidates, "memory provider architecture"
        )
        self.assertEqual([item["path"] for item in filtered], ["wiki/memory.md"])
        self.assertEqual(removed, 1)

    def test_compact_recall_results_obey_the_independent_token_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            raw = [
                {
                    "file": f"qmd://obsidian-wiki/result-{index}.md",
                    "title": f"Result {index}",
                    "score": 1 - index / 100,
                    "snippet": "high-signal detail " * 50,
                }
                for index in range(10)
            ]
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            results, _filtered = MODULE.compact_qmd_results(
                config,
                raw,
                limit=10,
                max_tokens=180,
                include_stale=False,
            )
            encoded = json.dumps(results, ensure_ascii=False, separators=(",", ":"))
            self.assertLessEqual(MODULE.estimated_tokens(encoded), 180)
            self.assertLess(len(results), len(raw))

    def test_vault_reference_resolves_sibling_alias_and_heading(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            decisions = vault / "projects" / "alpha" / "decisions"
            decisions.mkdir()
            source = decisions / "0001-old.md"
            target = decisions / "0002-current.md"
            source.write_text("---\nstatus: superseded\n---\n", encoding="utf-8")
            target.write_text("---\nstatus: accepted\n---\n", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "[[0002-current#Decision|current choice]]",
                source_path=source,
                allowed_roots=["projects"],
            )
            self.assertEqual(result.path, target.resolve())
            self.assertEqual(
                result.vault_relative,
                "projects/alpha/decisions/0002-current.md",
            )
            self.assertIsNone(result.issue)

    def test_vault_reference_rejects_ambiguous_bare_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "projects" / "alpha" / "old.md"
            source.write_text("old", encoding="utf-8")
            for project in ("beta", "gamma"):
                directory = vault / "projects" / project
                directory.mkdir()
                (directory / "current.md").write_text("current", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "[[current]]",
                source_path=source,
                allowed_roots=["projects"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "ambiguous")

    def test_vault_reference_never_guesses_a_numeric_filename_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            decisions = vault / "projects" / "alpha" / "decisions"
            decisions.mkdir()
            source = decisions / "0017-old.md"
            source.write_text("old", encoding="utf-8")
            (decisions / "0018-decision.md").write_text(
                "current", encoding="utf-8"
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            result = MODULE.resolve_vault_reference_detailed(
                config,
                "[[0018]]",
                source_path=source,
                allowed_roots=["projects"],
            )

            self.assertIsNone(result.path)
            self.assertIsNone(result.vault_relative)
            self.assertEqual(result.issue, "missing")

    def test_missing_explicit_root_path_never_falls_back_by_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "projects" / "alpha" / "old.md"
            source.write_text("old", encoding="utf-8")
            (vault / "wiki" / "current.md").write_text("current", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "projects/missing/current",
                source_path=source,
                allowed_roots=["wiki", "projects"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "missing")

    def test_vault_reference_detailed_reports_unsafe_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                ".git/config",
                allowed_roots=["wiki"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "unsafe")

    def test_vault_reference_detailed_reports_out_of_root_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "projects" / "alpha" / "current.md"
            target.write_text("current", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "projects/alpha/current",
                allowed_roots=["wiki"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "out-of-root")

    def test_vault_reference_detailed_reports_non_markdown_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "notes.txt").write_text("plain", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "wiki/notes.txt",
                allowed_roots=["wiki"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "non-markdown")

    def test_vault_reference_reports_excluded_configured_root_as_out_of_root(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "wiki" / "old.md"
            target = vault / "projects" / "alpha" / "new.md"
            source.write_text("old", encoding="utf-8")
            target.write_text("new", encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "projects/alpha/new",
                source_path=source,
                allowed_roots=["wiki"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "out-of-root")

    def test_vault_reference_rejects_safe_root_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "projects" / "alpha" / "new.md"
            target.write_text("new", encoding="utf-8")
            os.symlink(target, vault / "wiki" / "link.md")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "wiki/link",
                allowed_roots=["wiki"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "unsafe")

    def test_vault_reference_rejects_allowed_root_symlink_during_fallback(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "wiki" / "old.md"
            source.write_text("old", encoding="utf-8")
            target_root = vault / "projects" / "alpha"
            (target_root / "current.md").write_text("current", encoding="utf-8")
            os.symlink(target_root, vault / "alias")
            config_path = self.write_config(
                root,
                vault,
                recall_roots=["wiki", "alias"],
            )
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "current",
                source_path=source,
                allowed_roots=["alias"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "unsafe")

    def test_vault_reference_fails_closed_on_nul_and_resolve_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            nul_result = MODULE.resolve_vault_reference_detailed(
                config,
                "wiki/\0.md",
                allowed_roots=["wiki"],
            )
            self.assertIsNone(nul_result.path)
            self.assertEqual(nul_result.issue, "unsafe")
            with mock.patch.object(MODULE.Path, "resolve", side_effect=RuntimeError("loop")):
                error_result = MODULE.resolve_vault_reference_detailed(
                    config,
                    "wiki/hot",
                    allowed_roots=["wiki"],
                )
            self.assertIsNone(error_result.path)
            self.assertEqual(error_result.issue, "unsafe")

    def test_private_paths_survive_case_and_symlink_variants(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / ".raw").mkdir()
            (vault / ".raw" / "secret.md").write_text("transcript\n", encoding="utf-8")
            os.symlink(vault / ".raw" / "secret.md", vault / "wiki" / "leak.md")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            self.assertFalse(MODULE.safe_recall_parts((".Raw", "secret.md")))
            self.assertFalse(MODULE.safe_recall_parts(("INBOX", "note.md")))
            # A case-insensitive filesystem resolves this to the real .raw file.
            self.assertIsNone(MODULE.resolve_vault_reference(config, ".Raw/secret.md"))
            # A symlink only reveals the private target after resolution.
            self.assertIsNone(MODULE.resolve_vault_reference(config, "wiki/leak.md"))

    def test_recall_never_resolves_repository_or_non_markdown_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / ".git").mkdir()
            (vault / ".git" / "config").write_text(
                "[remote]\n\turl = https://user:TOKEN@example.com/x.git\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "notes.txt").write_text("plain\n", encoding="utf-8")
            (vault / "wiki" / "old.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: .git/config\n---\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            self.assertIsNone(MODULE.resolve_vault_reference(config, ".git/config"))
            self.assertIsNone(MODULE.resolve_vault_reference(config, "wiki/notes.txt"))
            results, filtered = MODULE.compact_recall_results(
                config,
                [{"path": "wiki/old.md", "snippet": "credentials"}],
                limit=5,
                max_tokens=900,
                include_stale=False,
            )
            self.assertEqual(results, [])
            self.assertEqual(filtered, 1)

    def test_frontmatter_document_parses_bounded_scalar_and_list_values(self) -> None:
        """Governance metadata accepts only first-block scalar/list values."""
        with tempfile.TemporaryDirectory() as temp:
            note = Path(temp) / "note.md"
            note.write_text(
                "---\n"
                "memory_class: fact\n"
                "status: verified\n"
                "source:\n"
                "  - https://example.test/primary\n"
                "  - explicit user confirmation\n"
                "verified_by: deterministic test\n"
                "---\n"
                "BODY MUST NOT ENTER METADATA\n"
                "---\n"
                "status: superseded\n"
                "---\n",
                encoding="utf-8",
            )

            metadata = MODULE.parse_frontmatter_document(note)

        self.assertEqual(metadata["memory_class"], "fact")
        self.assertEqual(metadata["status"], "verified")
        self.assertEqual(
            metadata["source"],
            ["https://example.test/primary", "explicit user confirmation"],
        )
        self.assertEqual(metadata["verified_by"], "deterministic test")
        self.assertNotIn("BODY MUST NOT ENTER METADATA", repr(metadata))

    def test_frontmatter_document_removes_only_matching_outer_quotes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            note = Path(temp) / "quotes.md"
            note.write_text(
                "---\n"
                "single: 'single value'\n"
                'double: "double value"\n'
                "unmatched: 'keep this double quote\"\n"
                "source:\n"
                "  - 'single source'\n"
                '  - "double source"\n'
                "---\n",
                encoding="utf-8",
            )

            metadata = MODULE.parse_frontmatter_document(note)

        self.assertEqual(metadata["single"], "single value")
        self.assertEqual(metadata["double"], "double value")
        self.assertEqual(metadata["unmatched"], "'keep this double quote\"")
        self.assertEqual(metadata["source"], ["single source", "double source"])

    def test_frontmatter_document_ignores_non_scalar_yaml_constructs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            note = Path(temp) / "untrusted.md"
            note.write_text(
                "---\n"
                "# An untrusted YAML comment\n"
                "safe: value # ignored inline comment\n"
                "nested:\n"
                "  child: ignored\n"
                "folded: >\n"
                "  this must not be read\n"
                "anchored: &unsafe value\n"
                "tagged: !unsafe value\n"
                "alias: *unsafe\n"
                "mapping: {key: value}\n"
                "sequence: [value]\n"
                "source:\n"
                "  - allowed\n"
                "  - !tagged ignored\n"
                "  - {object: ignored}\n"
                "---\n",
                encoding="utf-8",
            )

            metadata = MODULE.parse_frontmatter_document(note)

        self.assertEqual(metadata, {"safe": "value", "source": ["allowed"]})

    def test_frontmatter_document_requires_a_complete_block_within_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            exact = Path(temp) / "exact.md"
            exact_text = "---\nstatus: accepted\n---\n"
            exact.write_text(exact_text, encoding="utf-8")
            truncated = Path(temp) / "truncated.md"
            truncated.write_text(exact_text + "x", encoding="utf-8")

            exact_metadata = MODULE.parse_frontmatter_document(
                exact, limit=len(exact_text)
            )
            truncated_metadata = MODULE.parse_frontmatter_document(
                truncated, limit=len(exact_text)
            )

        self.assertEqual(exact_metadata, {"status": "accepted"})
        self.assertEqual(truncated_metadata, {})

    def test_scalar_frontmatter_wrapper_preserves_recall_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            note = Path(temp) / "legacy.md"
            note.write_text(
                "---\n"
                "status: superseded\n"
                "superseded_by: '[[current-decision]]'\n"
                "valid_from: 2026-01-01\n"
                "valid_until: 2026-12-31\n"
                "source:\n"
                "  - https://example.test/primary\n"
                "---\n",
                encoding="utf-8",
            )

            metadata = MODULE.parse_frontmatter(note)

        self.assertEqual(
            metadata,
            {
                "status": "superseded",
                "superseded_by": "[[current-decision]]",
                "valid_from": "2026-01-01",
                "valid_until": "2026-12-31",
            },
        )
        self.assertEqual(MODULE.memory_state(metadata), "stale")
        self.assertEqual(MODULE.validity_warning(metadata), "")

    def test_supersession_follows_source_relative_chain_to_current_decision(self) -> None:
        """A sibling wikilink chain resolves relative to each predecessor."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            decisions = vault / "projects" / "alpha" / "decisions"
            decisions.mkdir()
            rows = (
                ("0017-old.md", "superseded", "[[0018-middle]]"),
                ("0018-middle.md", "superseded", "[[0019-current]]"),
                ("0019-current.md", "accepted", ""),
            )
            for name, status, successor in rows:
                (decisions / name).write_text(
                    f'---\nstatus: {status}\nsuperseded_by: "{successor}"\n---\n# {name}\n',
                    encoding="utf-8",
                )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            result = MODULE.follow_supersession_chain(
                config,
                source_path=decisions / "0017-old.md",
                source_relative="projects/alpha/decisions/0017-old.md",
                metadata=MODULE.parse_frontmatter(decisions / "0017-old.md"),
                allowed_roots=["projects"],
                scope="projects/alpha",
            )
            self.assertEqual(
                result.vault_relative,
                "projects/alpha/decisions/0019-current.md",
            )
            self.assertEqual(result.state, "current")
            self.assertIsNone(result.issue)

    def test_supersession_chain_skips_successors_that_are_themselves_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "v1.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: wiki/v2.md\n---\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "v2.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: wiki/v3.md\n---\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "v3.md").write_text(
                "---\nstatus: accepted\n---\n\n# V3\ncurrent decision\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "loop-a.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: wiki/loop-b.md\n---\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "loop-b.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: wiki/loop-a.md\n---\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            cycle = MODULE.follow_supersession_chain(
                config,
                source_path=vault / "wiki" / "loop-a.md",
                source_relative="wiki/loop-a.md",
                metadata=MODULE.parse_frontmatter(vault / "wiki" / "loop-a.md"),
                allowed_roots=["wiki"],
            )
            self.assertEqual(cycle.issue, "cycle")

            chained, _ = MODULE.compact_recall_results(
                config,
                [{"path": "wiki/v1.md", "snippet": "decision"}],
                limit=5,
                max_tokens=900,
                include_stale=False,
            )
            self.assertEqual([hit["path"] for hit in chained], ["wiki/v3.md"])
            self.assertEqual(chained[0]["memory"]["state"], "current")

            looped, _ = MODULE.compact_recall_results(
                config,
                [{"path": "wiki/loop-a.md", "snippet": "decision"}],
                limit=5,
                max_tokens=900,
                include_stale=False,
            )
            self.assertEqual(looped, [])

    def test_supersession_chain_rejects_future_and_expired_successors(self) -> None:
        successor_metadata = {
            "future": "valid_from: 2999-01-01",
            "expired": "valid_until: 2000-01-01",
        }
        for expected_issue, validity in successor_metadata.items():
            with (
                self.subTest(state=expected_issue),
                tempfile.TemporaryDirectory() as temp,
            ):
                root = Path(temp)
                vault = self.make_vault(root)
                source = vault / "wiki" / "old.md"
                successor = vault / "wiki" / "successor.md"
                current = vault / "wiki" / "current.md"
                source.write_text(
                    "---\nstatus: superseded\nsuperseded_by: wiki/successor.md\n---\n",
                    encoding="utf-8",
                )
                successor.write_text(
                    "---\n"
                    "status: accepted\n"
                    f"{validity}\n"
                    "superseded_by: wiki/current.md\n"
                    "---\n",
                    encoding="utf-8",
                )
                current.write_text(
                    "---\nstatus: accepted\n---\n# Current\n",
                    encoding="utf-8",
                )
                config_path = self.write_config(root, vault)
                with mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ):
                    config, _ = MODULE.load_config()

                result = MODULE.follow_supersession_chain(
                    config,
                    source_path=source,
                    source_relative="wiki/old.md",
                    metadata=MODULE.parse_frontmatter(source),
                    allowed_roots=["wiki"],
                )

                self.assertIsNone(result.path)
                self.assertIsNone(result.vault_relative)
                self.assertEqual(result.state, expected_issue)
                self.assertEqual(result.issue, expected_issue)

    def test_supersession_redirect_stays_within_recall_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "old.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: projects/alpha/new.md\n---\n",
                encoding="utf-8",
            )
            (vault / "projects" / "alpha" / "new.md").write_text(
                "---\nstatus: accepted\n---\n\n# New\nprivate decision\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "stale.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: wiki/fresh.md\n---\n",
                encoding="utf-8",
            )
            (vault / "wiki" / "fresh.md").write_text(
                "---\nstatus: accepted\n---\n\n# Fresh\npublic decision\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault, recall_roots=["wiki"])
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            out_of_root = MODULE.follow_supersession_chain(
                config,
                source_path=vault / "wiki" / "old.md",
                source_relative="wiki/old.md",
                metadata=MODULE.parse_frontmatter(vault / "wiki" / "old.md"),
                allowed_roots=["wiki"],
            )
            self.assertEqual(out_of_root.issue, "out-of-root")

            escaped, filtered = MODULE.compact_recall_results(
                config,
                [{"path": "wiki/old.md", "snippet": "decision"}],
                limit=5,
                max_tokens=900,
                include_stale=False,
            )
            self.assertEqual(escaped, [])
            self.assertEqual(filtered, 1)

            contained, _ = MODULE.compact_recall_results(
                config,
                [{"path": "wiki/stale.md", "snippet": "decision"}],
                limit=5,
                max_tokens=900,
                include_stale=False,
            )
            self.assertEqual([hit["path"] for hit in contained], ["wiki/fresh.md"])

    def test_vault_reference_recognizes_configured_qmd_roots_outside_allowed_roots(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            source = vault / "wiki" / "old.md"
            target = vault / "projects" / "alpha" / "new.md"
            source.write_text("old", encoding="utf-8")
            target.write_text("new", encoding="utf-8")
            config_path = self.write_config(root, vault, recall_roots=["wiki"])
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            result = MODULE.resolve_vault_reference_detailed(
                config,
                "projects/alpha/new.md",
                source_path=source,
                allowed_roots=["wiki"],
            )
            self.assertIsNone(result.path)
            self.assertEqual(result.issue, "out-of-root")

    def test_qmd_uri_resolution_survives_normalized_path_segments(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "Team Notes").mkdir()
            (vault / "wiki" / "Team Notes" / "my_file.md").write_text(
                "---\nstatus: accepted\n---\n\n# Note\ndurable fact\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault, qmd_enabled=True)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            resolved = MODULE.resolve_qmd_uri(
                config, "qmd://obsidian-wiki/Team-Notes/my-file.md"
            )
            self.assertIsNotNone(resolved)
            _path, vault_relative = resolved
            self.assertEqual(vault_relative, "wiki/Team Notes/my_file.md")

    def test_qmd_supersession_redirect_honors_active_collections_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "old.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: projects/alpha/new.md\n---\n",
                encoding="utf-8",
            )
            (vault / "projects" / "alpha" / "new.md").write_text(
                "---\nstatus: accepted\n---\n\n# New\nunqueried decision\n",
                encoding="utf-8",
            )
            config_path = self.write_config(
                root,
                vault,
                qmd_enabled=True,
                qmd_collections=["obsidian-wiki"],
                qmd_collection_roots={
                    "obsidian-wiki": "wiki",
                    "obsidian-projects": "projects",
                },
            )
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            active_roots = MODULE.provider_recall_roots(config, "qmd")
            out_of_root = MODULE.follow_supersession_chain(
                config,
                source_path=vault / "wiki" / "old.md",
                source_relative="wiki/old.md",
                metadata=MODULE.parse_frontmatter(vault / "wiki" / "old.md"),
                allowed_roots=active_roots,
            )
            self.assertEqual(out_of_root.issue, "out-of-root")
            results, filtered = MODULE.compact_recall_results(
                config,
                [{"path": "wiki/old.md", "snippet": "decision"}],
                limit=5,
                max_tokens=900,
                include_stale=False,
                provider="qmd",
            )
            self.assertEqual(results, [])
            self.assertEqual(filtered, 1)

    def test_identifier_matching_survives_unicode_case_folding(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "Straße.md").write_text(
                "---\nstatus: accepted\n---\n\n# Route notes\n"
                "The tram detour is documented here.\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            candidates, _diagnostics = MODULE.native_recall_candidates(
                config, "STRASSE", 5, None
            )
            self.assertIn("wiki/Straße.md", [item["path"] for item in candidates])

    def test_filename_only_match_omits_the_synthetic_line_number(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "DDR-0099.md").write_text(
                "---\nstatus: accepted\ntitle: archived\n---\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            candidates, _diagnostics = MODULE.native_recall_candidates(
                config, "DDR-0099", 5, None
            )
            hit = next(
                item for item in candidates if item["path"] == "wiki/DDR-0099.md"
            )
            self.assertNotIn("line", hit)

    def test_native_recall_accepts_exact_path_and_title_identifiers(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "DDR-0042.md").write_text(
                "---\nstatus: accepted\n---\n\n# Release record\n"
                "The rollout completed without incident.\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            candidates, _diagnostics = MODULE.native_recall_candidates(
                config, "DDR-0042", 5, None
            )
            self.assertIn("wiki/DDR-0042.md", [item["path"] for item in candidates])

    def test_small_top_recall_survives_governance_heavy_result_sets(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            for index in range(3):
                (vault / "wiki" / f"stale-{index}.md").write_text(
                    "---\nstatus: superseded\n---\n\n# Old\n"
                    "release decision release decision release decision\n",
                    encoding="utf-8",
                )
            (vault / "wiki" / "current.md").write_text(
                "---\nstatus: accepted\n---\n\n# Current\n"
                "the release was a considered and recorded decision\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            buffer = io.StringIO()
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                contextlib.redirect_stdout(buffer),
            ):
                result = MODULE.recall("release decision", "fast", 1)
            self.assertEqual(result, 0)
            payload = json.loads(buffer.getvalue())
            self.assertEqual(
                [hit["path"] for hit in payload["results"]], ["wiki/current.md"]
            )

    def test_validity_window_hides_future_notes_and_flags_bad_dates(self) -> None:
        self.assertEqual(
            MODULE.memory_state({"status": "accepted", "valid_from": "2999-01-01"}),
            "future",
        )
        self.assertEqual(
            MODULE.memory_state({"status": "accepted", "valid_until": "1999-01-01"}),
            "expired",
        )
        self.assertEqual(MODULE.memory_state({"status": "accepted"}), "current")
        self.assertEqual(
            MODULE.validity_warning({"valid_until": "soon"}),
            "unparsable valid_until",
        )
        self.assertEqual(MODULE.validity_warning({"valid_until": "2026-01-01"}), "")

    def test_read_text_never_loads_more_than_its_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "big.md"
            path.write_text("x" * 50_000, encoding="utf-8")
            with mock.patch.object(
                MODULE.Path, "read_text", side_effect=AssertionError("whole-file read")
            ):
                text = MODULE.read_text(path, 500)
            self.assertLessEqual(len(text), 500)
            self.assertTrue(text.endswith("[…truncated…]"))

    def test_supersession_redirect_respects_the_requested_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "projects" / "beta").mkdir()
            (vault / "projects" / "alpha" / "old.md").write_text(
                "---\nstatus: superseded\nsuperseded_by: projects/beta/new.md\n---\n",
                encoding="utf-8",
            )
            (vault / "projects" / "beta" / "new.md").write_text(
                "---\nstatus: accepted\n---\n\n# New\ndeployment decision\n",
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            rows = [{"path": "projects/alpha/old.md", "snippet": "deployment decision"}]

            out_of_scope = MODULE.follow_supersession_chain(
                config,
                source_path=vault / "projects" / "alpha" / "old.md",
                source_relative="projects/alpha/old.md",
                metadata=MODULE.parse_frontmatter(
                    vault / "projects" / "alpha" / "old.md"
                ),
                allowed_roots=["projects"],
                scope="projects/alpha",
            )
            self.assertEqual(out_of_scope.issue, "out-of-scope")

            scoped, filtered = MODULE.compact_recall_results(
                config,
                rows,
                limit=5,
                max_tokens=900,
                include_stale=False,
                scope="projects/alpha",
            )
            self.assertEqual(scoped, [])
            self.assertEqual(filtered, 1)

            unscoped, _ = MODULE.compact_recall_results(
                config, rows, limit=5, max_tokens=900, include_stale=False
            )
            self.assertEqual([hit["path"] for hit in unscoped], ["projects/beta/new.md"])

    def test_supersession_chain_reports_hop_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            for number in range(1, MODULE.MAX_SUPERSESSION_HOPS + 2):
                successor = f"wiki/v{number + 1}.md"
                (vault / "wiki" / f"v{number}.md").write_text(
                    "---\nstatus: superseded\n"
                    f"superseded_by: {successor}\n---\n",
                    encoding="utf-8",
                )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            limited = MODULE.follow_supersession_chain(
                config,
                source_path=vault / "wiki" / "v1.md",
                source_relative="wiki/v1.md",
                metadata=MODULE.parse_frontmatter(vault / "wiki" / "v1.md"),
                allowed_roots=["wiki"],
            )
            self.assertEqual(limited.issue, "hop-limit")

    def test_oversized_first_hit_degrades_instead_of_starving_recall(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "long.md").write_text(
                "---\nstatus: accepted\n---\n\n# Long\n" + "budget " * 100,
                encoding="utf-8",
            )
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            rows = [
                {
                    "path": "wiki/long.md",
                    "title": "A long title that alone consumes the token budget",
                    "snippet": "budget " * 40,
                }
            ]
            results, _filtered = MODULE.compact_recall_results(
                config, rows, limit=5, max_tokens=64, include_stale=False
            )
            self.assertEqual([hit["path"] for hit in results], ["wiki/long.md"])
            self.assertTrue(results[0]["truncated"])
            self.assertNotIn("snippet", results[0])

    def test_native_recall_line_numbers_survive_non_ascii_bodies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            # casefold() expands "ß" to "ss"; offsets taken from a naively folded
            # copy would drift past several line breaks before the real match.
            filler = "\n".join(["Straße"] * 100)
            note = (
                "---\nstatus: verified\n---\n\n# Straße\n\n"
                f"{filler}\ndeployment rollback decision\n{filler}\n"
            )
            (vault / "wiki" / "strasse.md").write_text(note, encoding="utf-8")
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
            candidates, _diagnostics = MODULE.native_recall_candidates(
                config, "deployment rollback decision", 5, None
            )

            self.assertEqual(MODULE.index_safe_fold("Straße"), "straße")
            hit = next(item for item in candidates if item["path"] == "wiki/strasse.md")
            expected_line = note.splitlines().index("deployment rollback decision") + 1
            self.assertEqual(hit["line"], expected_line)
            self.assertIn("deployment rollback decision", hit["snippet"])

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

    def test_explicit_commit_accepts_uppercase_markdown_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "wiki" / "explicit.MD"
            target.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            target.write_text("after\n", encoding="utf-8")
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            ok, detail = MODULE.safe_commit_paths(
                config, config_path, ["wiki/explicit.MD"]
            )

            self.assertTrue(ok, detail)
            self.assertEqual(
                self.git_stdout(vault, "show", "--name-only", "--format=").splitlines(),
                ["wiki/explicit.MD"],
            )

    def test_configured_commit_discovers_uppercase_markdown_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "wiki" / "configured.MD"
            target.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            before = self.git_stdout(vault, "rev-parse", "HEAD").strip()
            target.write_text("after\n", encoding="utf-8")
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            ok, detail = MODULE.safe_commit_paths(config, config_path)

            self.assertTrue(ok, detail)
            self.assertNotEqual(before, self.git_stdout(vault, "rev-parse", "HEAD").strip())
            self.assertEqual(
                self.git_stdout(vault, "show", "--name-only", "--format=").splitlines(),
                ["wiki/configured.MD"],
            )

    def test_explicit_commit_paths_commit_only_exact_markdown_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            first = vault / "wiki" / "exact-one.md"
            second = vault / "projects" / "alpha" / "exact-two.md"
            third = vault / "daily" / "uncommitted.md"
            private = vault / ".obsidian" / "workspace.json"
            for path in (first, second, third, private):
                path.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            for path in (first, second, third, private):
                path.write_text("changed\n", encoding="utf-8")
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "commit",
                    "--path",
                    "wiki/exact-one.md",
                    "--path",
                    "projects/alpha/exact-two.md",
                ],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            committed = subprocess.run(
                ["git", "-C", str(vault), "show", "--name-only", "--format="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.splitlines()
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            status = subprocess.run(
                ["git", "-C", str(vault), "status", "--porcelain"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                committed, ["projects/alpha/exact-two.md", "wiki/exact-one.md"]
            )
            self.assertEqual(staged, "")
            self.assertIn(" daily/uncommitted.md", status)
            self.assertIn(" .obsidian/workspace.json", status)

    def test_explicit_commit_preserves_unrelated_prestaged_index_blobs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "wiki" / "target.md"
            staged_markdown = vault / "daily" / "staged.md"
            staged_non_markdown = vault / "projects" / "alpha" / "state.json"
            for path in (target, staged_markdown, staged_non_markdown):
                path.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            target.write_text("target change\n", encoding="utf-8")
            staged_markdown.write_text("staged Markdown change\n", encoding="utf-8")
            staged_non_markdown.write_text("staged JSON change\n", encoding="utf-8")
            unrelated = ("daily/staged.md", "projects/alpha/state.json")
            subprocess.run(
                ["git", "-C", str(vault), "add", "--", *unrelated], check=True
            )
            blobs_before = self.index_blobs(vault, *unrelated)
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            ok, detail = MODULE.safe_commit_paths(
                config, config_path, ["wiki/target.md"]
            )

            self.assertTrue(ok, detail)
            self.assertEqual(
                self.git_stdout(vault, "show", "--name-only", "--format=").splitlines(),
                ["wiki/target.md"],
            )
            self.assertEqual(blobs_before, self.index_blobs(vault, *unrelated))
            self.assertEqual(
                self.git_stdout(vault, "diff", "--cached", "--name-only").splitlines(),
                list(unrelated),
            )

    def test_configured_commit_preserves_unrelated_prestaged_index_blobs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "wiki" / "configured.md"
            staged_markdown = vault / "daily" / "staged.md"
            staged_non_markdown = vault / "projects" / "alpha" / "state.json"
            for path in (target, staged_markdown, staged_non_markdown):
                path.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            target.write_text("configured change\n", encoding="utf-8")
            staged_markdown.write_text("staged Markdown change\n", encoding="utf-8")
            staged_non_markdown.write_text("staged JSON change\n", encoding="utf-8")
            unrelated = ("daily/staged.md", "projects/alpha/state.json")
            subprocess.run(
                ["git", "-C", str(vault), "add", "--", *unrelated], check=True
            )
            blobs_before = self.index_blobs(vault, *unrelated)
            config_path = self.write_config(
                root, vault, commit_paths=["wiki/configured.md"]
            )
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            ok, detail = MODULE.safe_commit_paths(config, config_path)

            self.assertTrue(ok, detail)
            self.assertEqual(
                self.git_stdout(vault, "show", "--name-only", "--format=").splitlines(),
                ["wiki/configured.md"],
            )
            self.assertEqual(blobs_before, self.index_blobs(vault, *unrelated))
            self.assertEqual(
                self.git_stdout(vault, "diff", "--cached", "--name-only").splitlines(),
                list(unrelated),
            )

    def test_commit_validation_rejection_preserves_prestaged_index_blobs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            target = vault / "wiki" / "target.md"
            invalid = vault / "wiki" / "state.json"
            staged_markdown = vault / "daily" / "staged.md"
            staged_non_markdown = vault / "projects" / "alpha" / "state.json"
            for path in (target, invalid, staged_markdown, staged_non_markdown):
                path.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            target.write_text("target change\n", encoding="utf-8")
            invalid.write_text("invalid change\n", encoding="utf-8")
            staged_markdown.write_text("staged Markdown change\n", encoding="utf-8")
            staged_non_markdown.write_text("staged JSON change\n", encoding="utf-8")
            unrelated = ("daily/staged.md", "projects/alpha/state.json")
            subprocess.run(
                ["git", "-C", str(vault), "add", "--", *unrelated], check=True
            )
            blobs_before = self.index_blobs(vault, *unrelated)
            head_before = self.git_stdout(vault, "rev-parse", "HEAD").strip()
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            ok, detail = MODULE.safe_commit_paths(
                config, config_path, ["wiki/target.md", "wiki/state.json"]
            )

            self.assertFalse(ok)
            self.assertIn("Markdown", detail)
            self.assertEqual(
                head_before, self.git_stdout(vault, "rev-parse", "HEAD").strip()
            )
            self.assertEqual(blobs_before, self.index_blobs(vault, *unrelated))
            self.assertEqual(
                self.git_stdout(vault, "diff", "--cached", "--name-only").splitlines(),
                list(unrelated),
            )

    def test_explicit_commit_paths_reject_invalid_overrides_before_staging(self) -> None:
        cases = (
            ("duplicate normalized path", ["wiki/valid.md", "wiki/./valid.md"]),
            ("non-markdown path", ["wiki/state.json"]),
            ("private raw path", [".raw/source.md"]),
            ("symlink to private raw path", ["wiki/public-link.md"]),
        )
        for label, paths in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                vault = self.make_vault(root)
                valid = vault / "wiki" / "valid.md"
                raw = vault / ".raw" / "source.md"
                valid.write_text("before\n", encoding="utf-8")
                raw.parent.mkdir()
                raw.write_text("before\n", encoding="utf-8")
                os.symlink("../.raw/source.md", vault / "wiki" / "public-link.md")
                subprocess.run(["git", "init", "-q", str(vault)], check=True)
                subprocess.run(
                    ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
                )
                subprocess.run(
                    ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                    check=True,
                )
                subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
                subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

                valid.write_text("changed\n", encoding="utf-8")
                raw.write_text("changed\n", encoding="utf-8")
                config_path = self.write_config(root, vault, commit_paths=["wiki"])
                before = subprocess.run(
                    ["git", "-C", str(vault), "rev-parse", "HEAD"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
                env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                command = [sys.executable, str(SCRIPT), "commit"]
                for path in paths:
                    command.extend(["--path", path])

                result = subprocess.run(
                    command,
                    text=True,
                    capture_output=True,
                    env=env,
                    check=False,
                )

                after = subprocess.run(
                    ["git", "-C", str(vault), "rev-parse", "HEAD"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
                staged = subprocess.run(
                    ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("unrecognized arguments", result.stderr)
                self.assertEqual(before, after)
                self.assertEqual(staged, "")

    def test_explicit_commit_resolution_errors_preserve_head_and_index(self) -> None:
        cases = (
            ("NUL", ["wiki/target\0.md"], None),
            ("OSError", ["wiki/target.md"], OSError("mocked resolution failure")),
            (
                "RuntimeError",
                ["wiki/target.md"],
                RuntimeError("mocked symlink loop"),
            ),
            ("ValueError", ["wiki/target.md"], ValueError("mocked invalid path")),
        )
        for label, explicit_paths, failure in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                vault = self.make_vault(root)
                target = vault / "wiki" / "target.md"
                staged = vault / "daily" / "already-staged.md"
                target.write_text("before\n", encoding="utf-8")
                staged.write_text("before\n", encoding="utf-8")
                self.init_git_vault(vault)
                target.write_text("target change\n", encoding="utf-8")
                staged.write_text("staged change\n", encoding="utf-8")
                subprocess.run(
                    ["git", "-C", str(vault), "add", "--", "daily/already-staged.md"],
                    check=True,
                )
                config_path = self.write_config(root, vault, commit_paths=["wiki"])
                with mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ):
                    config, _ = MODULE.load_config()
                head_before = self.git_stdout(vault, "rev-parse", "HEAD").strip()
                blobs_before = self.index_blobs(vault, "daily/already-staged.md")

                try:
                    if failure is None:
                        ok, detail = MODULE.safe_commit_paths(
                            config, config_path, explicit_paths
                        )
                    else:
                        with mock.patch.object(
                            MODULE.Path, "resolve", side_effect=failure
                        ):
                            ok, detail = MODULE.safe_commit_paths(
                                config, config_path, explicit_paths
                            )
                except (OSError, RuntimeError, ValueError) as exc:
                    self.fail(f"untrusted path resolution escaped: {exc}")

                self.assertFalse(ok)
                self.assertLessEqual(len(detail), 600)
                self.assertEqual(
                    head_before, self.git_stdout(vault, "rev-parse", "HEAD").strip()
                )
                self.assertEqual(
                    blobs_before, self.index_blobs(vault, "daily/already-staged.md")
                )

    def test_configured_status_resolution_errors_preserve_head_and_index(self) -> None:
        for failure_type in (OSError, RuntimeError, ValueError):
            with (
                self.subTest(failure=failure_type.__name__),
                tempfile.TemporaryDirectory() as temp,
            ):
                root = Path(temp)
                vault = self.make_vault(root)
                target = vault / "wiki" / "target.md"
                staged = vault / "daily" / "already-staged.md"
                target.write_text("before\n", encoding="utf-8")
                staged.write_text("before\n", encoding="utf-8")
                self.init_git_vault(vault)
                target.write_text("target change\n", encoding="utf-8")
                staged.write_text("staged change\n", encoding="utf-8")
                subprocess.run(
                    ["git", "-C", str(vault), "add", "--", "daily/already-staged.md"],
                    check=True,
                )
                config_path = self.write_config(root, vault, commit_paths=["wiki"])
                with mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ):
                    config, _ = MODULE.load_config()
                head_before = self.git_stdout(vault, "rev-parse", "HEAD").strip()
                blobs_before = self.index_blobs(vault, "daily/already-staged.md")
                real_resolve = MODULE.Path.resolve

                def resolve_or_fail(path: Path, *args: object, **kwargs: object) -> Path:
                    if path.name == "target.md":
                        raise failure_type("mocked status-path resolution failure")
                    return real_resolve(path, *args, **kwargs)

                try:
                    with mock.patch.object(
                        MODULE.Path,
                        "resolve",
                        autospec=True,
                        side_effect=resolve_or_fail,
                    ):
                        ok, detail = MODULE.safe_commit_paths(config, config_path)
                except (OSError, RuntimeError, ValueError) as exc:
                    self.fail(f"status-derived path resolution escaped: {exc}")

                self.assertFalse(ok)
                self.assertLessEqual(len(detail), 600)
                self.assertEqual(
                    head_before, self.git_stdout(vault, "rev-parse", "HEAD").strip()
                )
                self.assertEqual(
                    blobs_before, self.index_blobs(vault, "daily/already-staged.md")
                )

    def test_explicit_commit_symlink_loop_fails_closed_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            staged = vault / "daily" / "already-staged.md"
            staged.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            staged.write_text("staged change\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(vault), "add", "--", "daily/already-staged.md"],
                check=True,
            )
            os.symlink("loop", vault / "wiki" / "loop")
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            head_before = self.git_stdout(vault, "rev-parse", "HEAD").strip()
            blobs_before = self.index_blobs(vault, "daily/already-staged.md")
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "commit",
                    "--path",
                    "wiki/loop/note.md",
                ],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertLessEqual(len(result.stderr), 700)
            self.assertEqual(
                head_before, self.git_stdout(vault, "rev-parse", "HEAD").strip()
            )
            self.assertEqual(blobs_before, self.index_blobs(vault, "daily/already-staged.md"))

    def test_stop_resolution_error_emits_valid_bounded_json_and_preserves_index(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            staged = vault / "daily" / "already-staged.md"
            staged.write_text("before\n", encoding="utf-8")
            self.init_git_vault(vault)
            staged.write_text("staged change\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(vault), "add", "--", "daily/already-staged.md"],
                check=True,
            )
            config_path = self.write_config(
                root,
                vault,
                auto_commit=True,
                commit_paths=["wiki/unsafe\0.MD"],
            )
            head_before = self.git_stdout(vault, "rev-parse", "HEAD").strip()
            blobs_before = self.index_blobs(vault, "daily/already-staged.md")
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "stop"],
                input="{}",
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            payload = json.loads(result.stdout)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("systemMessage", payload)
            self.assertLessEqual(len(payload["systemMessage"]), 700)
            self.assertEqual(
                head_before, self.git_stdout(vault, "rev-parse", "HEAD").strip()
            )
            self.assertEqual(blobs_before, self.index_blobs(vault, "daily/already-staged.md"))

    def test_explicit_commit_paths_reject_git_pathspec_magic_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            private = vault / ".raw" / "source.md"
            private.parent.mkdir()
            private.write_text("private change\n", encoding="utf-8")
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            before = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "commit",
                    "--path",
                    ":(glob).raw/*.md",
                ],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            after = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("exact tracked Markdown file", result.stderr)
            self.assertEqual(before, after)
            self.assertEqual(staged, "")

    def test_auto_commit_rejects_private_configured_paths_before_staging(self) -> None:
        hostile_paths = [
            ".raw",
            ".obsidian",
            ".git",
            "projects/factorio-bot/.raw",
            "projects/factorio-bot/.ObSiDiAn",
        ]
        for hostile in hostile_paths:
            with self.subTest(hostile=hostile), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                vault = self.make_vault(root)
                (vault / "wiki" / "log.md").write_text("before\n", encoding="utf-8")
                private_target = vault / hostile / "secret.md"
                if hostile == ".git":
                    private_target = vault / ".git" / "private-memory"
                else:
                    private_target.parent.mkdir(parents=True, exist_ok=True)
                    private_target.write_text("before\n", encoding="utf-8")
                subprocess.run(["git", "init", "-q", str(vault)], check=True)
                subprocess.run(
                    ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
                )
                subprocess.run(
                    ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                    check=True,
                )
                subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
                subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

                (vault / "wiki" / "log.md").write_text("allowed change\n", encoding="utf-8")
                private_target.write_text("private change\n", encoding="utf-8")
                config_path = self.write_config(
                    root,
                    vault,
                    auto_commit=True,
                    commit_paths=["wiki/log.md", hostile],
                )
                with mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ):
                    config, _ = MODULE.load_config()
                before = subprocess.run(
                    ["git", "-C", str(vault), "rev-parse", "HEAD"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout

                ok, detail = MODULE.safe_commit_paths(config, config_path)

                after = subprocess.run(
                    ["git", "-C", str(vault), "rev-parse", "HEAD"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
                staged = subprocess.run(
                    ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
                self.assertFalse(ok)
                self.assertIn(hostile, detail)
                self.assertEqual(before, after)
                self.assertEqual(staged, "")

    def test_auto_commit_rejects_symlink_to_private_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "wiki" / "log.md").write_text("before\n", encoding="utf-8")
            (vault / ".raw").mkdir()
            (vault / ".raw" / "secret.md").write_text("before\n", encoding="utf-8")
            os.symlink("../.raw", vault / "wiki" / "private-link")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            (vault / "wiki" / "log.md").write_text("allowed change\n", encoding="utf-8")
            (vault / ".raw" / "secret.md").write_text("private change\n", encoding="utf-8")
            config_path = self.write_config(
                root,
                vault,
                auto_commit=True,
                commit_paths=["wiki/log.md", "wiki/private-link"],
            )
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
            before = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout

            ok, detail = MODULE.safe_commit_paths(config, config_path)

            after = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertFalse(ok)
            self.assertIn("wiki/private-link", detail)
            self.assertEqual(before, after)
            self.assertEqual(staged, "")

    def test_auto_commit_accepts_exact_public_markdown_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            readme = vault / "projects" / "factorio-bot" / "README.md"
            readme.parent.mkdir(parents=True)
            readme.write_text("before\n", encoding="utf-8")
            log = vault / "wiki" / "log.md"
            log.write_text("before\n", encoding="utf-8")
            workspace = vault / ".obsidian" / "workspace.json"
            workspace.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            readme.write_text("readme change\n", encoding="utf-8")
            log.write_text("log change\n", encoding="utf-8")
            workspace.write_text("private change\n", encoding="utf-8")
            config_path = self.write_config(
                root,
                vault,
                auto_commit=True,
                commit_paths=["projects/factorio-bot/README.md", "wiki/log.md"],
            )
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()

            ok, detail = MODULE.safe_commit_paths(config, config_path)

            committed = subprocess.run(
                ["git", "-C", str(vault), "show", "--name-only", "--format="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.splitlines()
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            status = subprocess.run(
                ["git", "-C", str(vault), "status", "--porcelain", "--", ".obsidian"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertTrue(ok, detail)
            self.assertEqual(
                committed, ["projects/factorio-bot/README.md", "wiki/log.md"]
            )
            self.assertEqual(staged, "")
            self.assertIn(" .obsidian/workspace.json", status)

    def test_configured_directory_cannot_commit_nested_private_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            public = vault / "projects" / "alpha" / "public.md"
            private = vault / "projects" / "alpha" / ".private" / "secret.md"
            public.write_text("before\n", encoding="utf-8")
            private.parent.mkdir()
            private.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            public.write_text("public change\n", encoding="utf-8")
            before = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            private.write_text("private change\n", encoding="utf-8")
            config_path = self.write_config(root, vault, commit_paths=["projects"])
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "commit"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            committed = subprocess.run(
                ["git", "-C", str(vault), "show", "--name-only", "--format="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.splitlines()
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            status = subprocess.run(
                ["git", "-C", str(vault), "status", "--porcelain"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertEqual(result.returncode, 0, result.stderr)
            after = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertNotEqual(before, after, result.stdout + result.stderr)
            self.assertEqual(committed, ["projects/alpha/public.md"])
            self.assertEqual(staged, "")
            self.assertIn("projects/alpha/.private/secret.md", status)

    def test_configured_directories_commit_markdown_changes_deletions_and_inbox(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            changed = vault / "projects" / "alpha" / "changed.md"
            deleted = vault / "projects" / "alpha" / "deleted.md"
            non_markdown = vault / "projects" / "alpha" / "state.json"
            inbox = vault / "inbox" / "capture.md"
            for path in (changed, deleted, non_markdown, inbox):
                path.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            changed.write_text("changed\n", encoding="utf-8")
            deleted.unlink()
            before = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            non_markdown.write_text("changed\n", encoding="utf-8")
            inbox.write_text("captured\n", encoding="utf-8")
            (vault / "projects" / "alpha" / "new.md").write_text(
                "new\n", encoding="utf-8"
            )
            config_path = self.write_config(
                root, vault, commit_paths=["projects", "inbox"]
            )
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "commit"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            committed = subprocess.run(
                ["git", "-C", str(vault), "show", "--name-only", "--format="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.splitlines()
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            status = subprocess.run(
                ["git", "-C", str(vault), "status", "--porcelain"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertEqual(result.returncode, 0, result.stderr)
            after = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertNotEqual(before, after, result.stdout + result.stderr)
            self.assertEqual(
                committed,
                [
                    "inbox/capture.md",
                    "projects/alpha/changed.md",
                    "projects/alpha/deleted.md",
                    "projects/alpha/new.md",
                ],
            )
            self.assertEqual(staged, "")
            self.assertIn("projects/alpha/state.json", status)

    def test_explicit_commit_rejects_markdown_directory_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            nested = vault / "wiki" / "bundle.md" / "nested.md"
            nested.parent.mkdir()
            nested.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            nested.write_text("changed\n", encoding="utf-8")
            config_path = self.write_config(root, vault, commit_paths=["wiki"])
            before = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "commit",
                    "--path",
                    "wiki/bundle.md",
                ],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            after = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            staged = subprocess.run(
                ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("file", result.stderr.casefold())
            self.assertEqual(before, after)
            self.assertEqual(staged, "")

    def test_explicit_commit_absent_paths_require_exact_tracked_markdown_file(
        self,
    ) -> None:
        cases = (
            (
                "deleted directory-like prefix",
                "wiki/bundle.md",
                (
                    "wiki/bundle.md/.private/secret.md",
                    "wiki/bundle.md/nested.md",
                    "wiki/bundle.md/state.json",
                ),
                "delete",
                None,
            ),
            (
                "deleted exact Markdown file",
                "wiki/deleted.md",
                ("wiki/deleted.md",),
                "delete",
                ("wiki/deleted.md",),
            ),
            (
                "never-tracked missing Markdown file",
                "wiki/missing.md",
                (),
                "none",
                None,
            ),
            (
                "new exact Markdown file",
                "wiki/new.md",
                (),
                "create",
                ("wiki/new.md",),
            ),
        )
        for label, explicit_path, initial_paths, mutation, expected_commit in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                vault = self.make_vault(root)
                for relative in initial_paths:
                    path = vault / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("before\n", encoding="utf-8")
                subprocess.run(["git", "init", "-q", str(vault)], check=True)
                subprocess.run(
                    ["git", "-C", str(vault), "config", "user.name", "Test"],
                    check=True,
                )
                subprocess.run(
                    [
                        "git",
                        "-C",
                        str(vault),
                        "config",
                        "user.email",
                        "test@example.com",
                    ],
                    check=True,
                )
                subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
                subprocess.run(
                    ["git", "-C", str(vault), "commit", "-qm", "initial"],
                    check=True,
                )

                if mutation == "delete":
                    for relative in initial_paths:
                        (vault / relative).unlink()
                    for directory in sorted(
                        {
                            (vault / relative).parent
                            for relative in initial_paths
                            if (vault / relative).parent != vault / "wiki"
                        },
                        key=lambda path: len(path.parts),
                        reverse=True,
                    ):
                        directory.rmdir()
                elif mutation == "create":
                    (vault / explicit_path).write_text("new\n", encoding="utf-8")

                config_path = self.write_config(root, vault, commit_paths=["wiki"])
                before = subprocess.run(
                    ["git", "-C", str(vault), "rev-parse", "HEAD"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout.strip()
                env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

                result = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPT),
                        "commit",
                        "--path",
                        explicit_path,
                    ],
                    text=True,
                    capture_output=True,
                    env=env,
                    check=False,
                )

                after = subprocess.run(
                    ["git", "-C", str(vault), "rev-parse", "HEAD"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout.strip()
                staged = subprocess.run(
                    ["git", "-C", str(vault), "diff", "--cached", "--name-only"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
                committed = subprocess.run(
                    ["git", "-C", str(vault), "diff", "--name-only", before, after],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout.splitlines()
                if expected_commit is None:
                    self.assertEqual(before, after, committed)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("exact tracked Markdown file", result.stderr)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotEqual(before, after)
                    self.assertEqual(committed, list(expected_commit))
                self.assertEqual(staged, "")

    def test_commit_help_describes_configured_and_exact_path_modes(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("configured", result.stdout)
        self.assertIn("repeat --path", result.stdout)

    def test_commit_without_path_uses_configured_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            configured = vault / "wiki" / "configured.md"
            unconfigured = vault / "daily" / "unconfigured.md"
            configured.write_text("before\n", encoding="utf-8")
            unconfigured.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                ["git", "-C", str(vault), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
            subprocess.run(["git", "-C", str(vault), "commit", "-qm", "initial"], check=True)

            configured.write_text("configured change\n", encoding="utf-8")
            before = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            unconfigured.write_text("unconfigured change\n", encoding="utf-8")
            config_path = self.write_config(
                root, vault, commit_paths=["wiki/configured.md"]
            )
            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "commit"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            committed = subprocess.run(
                ["git", "-C", str(vault), "show", "--name-only", "--format="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.splitlines()
            status = subprocess.run(
                ["git", "-C", str(vault), "status", "--porcelain"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertEqual(result.returncode, 0, result.stderr)
            after = subprocess.run(
                ["git", "-C", str(vault), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            self.assertNotEqual(before, after)
            self.assertEqual(committed, ["wiki/configured.md"])
            self.assertIn("daily/unconfigured.md", status)

    def test_recall_eval_suite_accepts_strict_schema_and_returns_frozen_cases(
        self,
    ) -> None:
        """Catches schema drift, query/scope normalization, and mutable cases."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            fixture = root / "recall-evals.json"
            fixture.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cases": [
                            {
                                "id": "current-decision",
                                "query": "  portable   provider\n boundary  ",
                                "mode": "hybrid",
                                "provider": "auto",
                                "scope": "/projects/alpha/",
                                "expected_paths": ["projects/alpha/current.md"],
                                "any_of_paths": ["projects/alpha/alternative.md"],
                                "forbidden_paths": ["projects/alpha/old.md"],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                cases = MODULE.load_recall_eval_suite(fixture, config)

            self.assertEqual(len(cases), 1)
            case = cases[0]
            self.assertEqual(case.query, "portable provider boundary")
            self.assertEqual(case.scope, "projects/alpha")
            self.assertIsNone(case.top)
            self.assertIsNone(case.max_tokens)
            self.assertFalse(case.allow_degraded)
            self.assertEqual(case.expected_paths, ("projects/alpha/current.md",))
            with self.assertRaises(AttributeError):
                case.id = "changed"  # type: ignore[misc]

    def test_recall_eval_fixture_rejects_every_malformed_schema_boundary(
        self,
    ) -> None:
        """Catches fail-open fixture parsing at every documented boundary."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            (vault / "projects" / "alpha" / "escape").symlink_to(root)
            config_path = self.write_config(root, vault)
            fixture = root / "invalid.json"
            valid_case = {
                "id": "valid",
                "query": "needle",
                "mode": "fast",
                "provider": "native",
                "scope": "projects/alpha",
                "expected_paths": ["projects/alpha/current.md"],
                "any_of_paths": [],
                "forbidden_paths": [],
                "allow_degraded": False,
            }

            def case_with(**updates: object) -> dict[str, object]:
                item = dict(valid_case)
                item.update(updates)
                return item

            malformed: list[tuple[str, object]] = [
                ("top-level-object", []),
                ("top-level-keys", {"schema_version": 1, "cases": [valid_case], "extra": 1}),
                ("schema-version", {"schema_version": 2, "cases": [valid_case]}),
                ("schema-version-type", {"schema_version": True, "cases": [valid_case]}),
                ("cases-type", {"schema_version": 1, "cases": {}}),
                ("cases-empty", {"schema_version": 1, "cases": []}),
                ("cases-bounded", {"schema_version": 1, "cases": [valid_case] * 201}),
                ("case-object", {"schema_version": 1, "cases": ["not-an-object"]}),
                ("required-field", {"schema_version": 1, "cases": [{key: value for key, value in valid_case.items() if key != "query"}]}),
                ("case-keys", {"schema_version": 1, "cases": [case_with(unexpected=True)]}),
                ("id-type", {"schema_version": 1, "cases": [case_with(id=7)]}),
                ("id-empty", {"schema_version": 1, "cases": [case_with(id="   ")]}),
                ("id-length", {"schema_version": 1, "cases": [case_with(id="i" * 121)]}),
                ("duplicate-id", {"schema_version": 1, "cases": [valid_case, valid_case]}),
                ("query-type", {"schema_version": 1, "cases": [case_with(query=7)]}),
                ("query-empty", {"schema_version": 1, "cases": [case_with(query=" \n ")]}),
                ("query-length", {"schema_version": 1, "cases": [case_with(query="q" * 1001)]}),
                ("mode", {"schema_version": 1, "cases": [case_with(mode="slow")]}),
                ("provider", {"schema_version": 1, "cases": [case_with(provider="cloud")]}),
                ("scope-parent", {"schema_version": 1, "cases": [case_with(scope="../outside")]}),
                ("scope-private", {"schema_version": 1, "cases": [case_with(scope="projects/.raw")]}),
                ("scope-root", {"schema_version": 1, "cases": [case_with(scope="outside")]}),
                ("scope-symlink", {"schema_version": 1, "cases": [case_with(scope="projects/alpha/escape")]}),
                ("top-low", {"schema_version": 1, "cases": [case_with(top=0)]}),
                ("top-high", {"schema_version": 1, "cases": [case_with(top=21)]}),
                ("top-bool", {"schema_version": 1, "cases": [case_with(top=True)]}),
                ("tokens-low", {"schema_version": 1, "cases": [case_with(max_tokens=63)]}),
                ("tokens-high", {"schema_version": 1, "cases": [case_with(max_tokens=4001)]}),
                ("tokens-bool", {"schema_version": 1, "cases": [case_with(max_tokens=False)]}),
                ("allow-degraded", {"schema_version": 1, "cases": [case_with(allow_degraded="false")]}),
                ("paths-type", {"schema_version": 1, "cases": [case_with(expected_paths="projects/alpha/current.md")]}),
                ("path-item-type", {"schema_version": 1, "cases": [case_with(expected_paths=[7])]}),
                ("path-empty", {"schema_version": 1, "cases": [case_with(expected_paths=[""])]}),
                ("path-duplicate", {"schema_version": 1, "cases": [case_with(expected_paths=["projects/alpha/current.md", "projects/alpha/current.md"])]}),
                ("path-extension", {"schema_version": 1, "cases": [case_with(expected_paths=["projects/alpha/current.txt"])]}),
                ("path-absolute", {"schema_version": 1, "cases": [case_with(expected_paths=[str(root / "secret.md")])]}),
                ("path-parent", {"schema_version": 1, "cases": [case_with(expected_paths=["projects/../secret.md"])]}),
                ("path-private", {"schema_version": 1, "cases": [case_with(expected_paths=["projects/.raw/secret.md"])]}),
                ("path-root", {"schema_version": 1, "cases": [case_with(expected_paths=["outside/secret.md"])]}),
                ("path-scope", {"schema_version": 1, "cases": [case_with(expected_paths=["wiki/secret.md"])]}),
                ("path-symlink", {"schema_version": 1, "cases": [case_with(expected_paths=["projects/alpha/escape/secret.md"])]}),
            ]

            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                for label, payload in malformed:
                    with self.subTest(label=label):
                        fixture.write_text(json.dumps(payload), encoding="utf-8")
                        with self.assertRaises(MODULE.EvaluationError) as raised:
                            MODULE.load_recall_eval_suite(fixture, config)
                        message = str(raised.exception)
                        self.assertNotIn(str(root), message)
                        self.assertNotIn("q" * 1001, message)

    def test_recall_eval_fixture_rejects_unknown_fields_and_unsafe_paths(self) -> None:
        """Catches fixtures that combine extension fields with private paths."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            fixture = root / "invalid.json"
            fixture.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cases": [
                            {
                                "id": "unsafe",
                                "query": "x",
                                "mode": "fast",
                                "provider": "native",
                                "expected_paths": [".raw/secret.md"],
                                "any_of_paths": [],
                                "forbidden_paths": [],
                                "unexpected": True,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                with self.assertRaises(MODULE.EvaluationError) as raised:
                    MODULE.load_recall_eval_suite(fixture, config)
            self.assertIn("unsafe", str(raised.exception))
            self.assertIn("keys", str(raised.exception))

    def test_recall_evaluator_checks_paths_degradation_and_hides_bodies(self) -> None:
        """Catches expectation/degradation/token drift and private output leaks."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            fixture = root / "recall-evals.json"
            fixture.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cases": [
                            {
                                "id": "passing",
                                "query": "SECRET PASSING QUERY",
                                "mode": "hybrid",
                                "provider": "auto",
                                "scope": "projects/alpha",
                                "top": 3,
                                "max_tokens": 900,
                                "expected_paths": ["projects/alpha/current.md"],
                                "any_of_paths": ["projects/alpha/current.md"],
                                "forbidden_paths": ["projects/alpha/old.md"],
                                "allow_degraded": False,
                            },
                            {
                                "id": "failing",
                                "query": "SECRET FAILING QUERY",
                                "mode": "semantic",
                                "provider": "auto",
                                "scope": "projects/alpha",
                                "top": 2,
                                "max_tokens": 900,
                                "expected_paths": ["projects/alpha/missing.md"],
                                "any_of_paths": ["projects/alpha/alternative.md"],
                                "forbidden_paths": ["projects/alpha/old.md"],
                                "allow_degraded": False,
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            payloads = iter(
                [
                    {
                        "provider": "qmd",
                        "requested_provider": "auto",
                        "mode": "hybrid",
                        "requested_mode": "hybrid",
                        "degraded": False,
                        "results": [
                            {
                                "path": "projects/alpha/current.md",
                                "title": "SECRET TITLE",
                                "snippet": "SECRET SNIPPET AND NOTE BODY",
                                "body": "SECRET BODY FIELD",
                            }
                        ],
                        "results_estimated_tokens": 42,
                        "result_token_limit": 900,
                        "filtered_stale": 2,
                    },
                    {
                        "provider": "native",
                        "requested_provider": "auto",
                        "mode": "fast",
                        "requested_mode": "semantic",
                        "degraded": True,
                        "results": [{"path": "projects/alpha/old.md"}],
                        "results_estimated_tokens": 901,
                        "result_token_limit": 900,
                        "filtered_stale": 0,
                    },
                ]
            )
            calls: list[tuple[object, ...]] = []

            def runner(*args: object, **kwargs: object) -> dict[str, object]:
                calls.append((*args, kwargs))
                return next(payloads)

            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch.object(
                    MODULE.time,
                    "perf_counter",
                    side_effect=[1.0, 1.012, 2.0, 2.020],
                ),
            ):
                config, _ = MODULE.load_config()
                cases = MODULE.load_recall_eval_suite(fixture, config)
                report = MODULE.evaluate_recall_cases(
                    config,
                    cases,
                    recall_runner=runner,
                )

            self.assertEqual(len(calls), 2)
            self.assertIs(calls[0][0], config)
            self.assertEqual(
                calls[0][1:6],
                ("SECRET PASSING QUERY", "hybrid", 3, 900, False),
            )
            self.assertEqual(
                calls[0][6],
                {"provider": "auto", "scope": "projects/alpha"},
            )
            self.assertEqual(report["summary"]["passed"], 1)
            self.assertEqual(report["summary"]["failed"], 1)
            self.assertEqual(report["summary"]["median_elapsed_ms"], 16.0)
            self.assertEqual(report["summary"]["median_result_tokens"], 471.5)
            self.assertEqual(report["cases"][0]["paths"], ["projects/alpha/current.md"])
            self.assertEqual(
                report["cases"][1]["reasons"],
                [
                    "missing-expected",
                    "missing-any-of",
                    "forbidden-returned",
                    "unexpected-degradation",
                    "token-limit-exceeded",
                ],
            )
            encoded = json.dumps(report)
            for secret in (
                "SECRET PASSING QUERY",
                "SECRET FAILING QUERY",
                "SECRET TITLE",
                "SECRET SNIPPET AND NOTE BODY",
                "SECRET BODY FIELD",
            ):
                self.assertNotIn(secret, encoded)

    def test_recall_evaluator_allows_explicitly_declared_degradation(self) -> None:
        """Catches treating allowed provider fallback as a failed case."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            fixture = root / "allowed-degradation.json"
            fixture.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cases": [
                            {
                                "id": "fallback-is-allowed",
                                "query": "PRIVATE ALLOWED QUERY",
                                "mode": "semantic",
                                "provider": "auto",
                                "expected_paths": [],
                                "any_of_paths": [],
                                "forbidden_paths": [],
                                "allow_degraded": True,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            payload = {
                "provider": "native",
                "requested_provider": "auto",
                "mode": "fast",
                "requested_mode": "semantic",
                "degraded": True,
                "results": [],
                "results_estimated_tokens": 0,
                "result_token_limit": 900,
                "filtered_stale": 0,
            }
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                cases = MODULE.load_recall_eval_suite(fixture, config)
                report = MODULE.evaluate_recall_cases(
                    config,
                    cases,
                    recall_runner=lambda *_args, **_kwargs: payload,
                )
        self.assertTrue(report["ok"])
        self.assertEqual(report["cases"][0]["reasons"], [])
        self.assertTrue(report["cases"][0]["degraded"])
        self.assertNotIn("PRIVATE ALLOWED QUERY", json.dumps(report))

    def test_recall_evaluator_rejects_incoherent_provider_mode_transitions(
        self,
    ) -> None:
        """Catches impossible effective providers, modes, and fallback flags."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            transitions = (
                ("auto-effective", "auto", "fast", "auto", "fast", False),
                ("explicit-native-changed", "native", "fast", "qmd", "fast", False),
                ("explicit-qmd-changed", "qmd", "fast", "native", "fast", True),
                ("unmarked-mode-change", "qmd", "hybrid", "qmd", "fast", False),
                ("unmarked-auto-fallback", "auto", "fast", "native", "fast", False),
                ("native-semantic", "native", "semantic", "native", "semantic", True),
                ("qmd-mode-change", "qmd", "hybrid", "qmd", "fast", True),
                ("native-false-degradation", "native", "fast", "native", "fast", True),
                ("qmd-false-degradation", "qmd", "fast", "qmd", "fast", True),
                ("auto-qmd-false-degradation", "auto", "fast", "qmd", "fast", True),
            )
            for (
                case_id,
                requested_provider,
                requested_mode,
                effective_provider,
                effective_mode,
                degraded,
            ) in transitions:
                with self.subTest(case_id=case_id):
                    case = MODULE.RecallEvalCase(
                        id=case_id,
                        query="PRIVATE TRANSITION QUERY",
                        mode=requested_mode,
                        provider=requested_provider,
                        scope=None,
                        top=3,
                        max_tokens=900,
                        expected_paths=(),
                        any_of_paths=(),
                        forbidden_paths=(),
                        allow_degraded=True,
                    )
                    payload = {
                        "provider": effective_provider,
                        "requested_provider": requested_provider,
                        "mode": effective_mode,
                        "requested_mode": requested_mode,
                        "degraded": degraded,
                        "results": [],
                        "results_estimated_tokens": 0,
                        "result_token_limit": 900,
                        "filtered_stale": 0,
                    }
                    report = MODULE.evaluate_recall_cases(
                        config,
                        [case],
                        recall_runner=lambda *_args, **_kwargs: payload,
                    )
                    self.assertEqual(
                        report["cases"][0]["reasons"],
                        ["recall-error"],
                    )
                    self.assertNotIn("PRIVATE TRANSITION QUERY", json.dumps(report))

    def test_recall_evaluator_preserves_valid_provider_mode_transitions(self) -> None:
        """Catches rejection of real explicit-native and auto fallback payloads."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()

            transitions = (
                ("explicit-native", "native", "semantic", "native", "fast", True),
                ("explicit-qmd", "qmd", "hybrid", "qmd", "hybrid", False),
                ("auto-qmd", "auto", "hybrid", "qmd", "hybrid", False),
                ("auto-native-mode", "auto", "hybrid", "native", "fast", True),
                ("auto-native-provider", "auto", "fast", "native", "fast", True),
            )
            for (
                case_id,
                requested_provider,
                requested_mode,
                effective_provider,
                effective_mode,
                degraded,
            ) in transitions:
                with self.subTest(case_id=case_id):
                    case = MODULE.RecallEvalCase(
                        id=case_id,
                        query="PRIVATE VALID TRANSITION QUERY",
                        mode=requested_mode,
                        provider=requested_provider,
                        scope=None,
                        top=3,
                        max_tokens=900,
                        expected_paths=(),
                        any_of_paths=(),
                        forbidden_paths=(),
                        allow_degraded=True,
                    )
                    payload = {
                        "provider": effective_provider,
                        "requested_provider": requested_provider,
                        "mode": effective_mode,
                        "requested_mode": requested_mode,
                        "degraded": degraded,
                        "results": [],
                        "results_estimated_tokens": 0,
                        "result_token_limit": 900,
                        "filtered_stale": 0,
                    }
                    report = MODULE.evaluate_recall_cases(
                        config,
                        [case],
                        recall_runner=lambda *_args, **_kwargs: payload,
                    )
                    self.assertTrue(report["ok"], report)
                    self.assertEqual(report["cases"][0]["reasons"], [])

    def test_recall_evaluator_sanitizes_runtime_and_malformed_provider_failures(
        self,
    ) -> None:
        """Catches exception, traceback, and absolute provider-path disclosure."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            fixture = root / "ABSOLUTE-FIXTURE-SENTINEL.json"
            base_case = {
                "query": "RUNTIME QUERY SENTINEL",
                "mode": "fast",
                "provider": "native",
                "scope": "projects/alpha",
                "top": 3,
                "max_tokens": 900,
                "expected_paths": [],
                "any_of_paths": [],
                "forbidden_paths": [],
                "allow_degraded": False,
            }
            fixture.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cases": [
                            {"id": "runtime", **base_case},
                            {"id": "malformed", **base_case},
                            {"id": "unhashable", **base_case},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            calls = 0

            def runner(*_args: object, **_kwargs: object) -> dict[str, object]:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise MODULE.RecallProviderError(
                        f"TRACEBACK SENTINEL {fixture} RUNTIME QUERY SENTINEL"
                    )
                if calls == 3:
                    return {
                        "provider": ["UNHASHABLE PROVIDER SENTINEL"],
                        "requested_provider": "native",
                        "mode": "fast",
                        "requested_mode": "fast",
                        "degraded": False,
                        "results": [],
                        "results_estimated_tokens": 0,
                        "result_token_limit": 900,
                        "filtered_stale": 0,
                    }
                return {
                    "provider": "native",
                    "requested_provider": "native",
                    "mode": "fast",
                    "requested_mode": "fast",
                    "degraded": False,
                    "results": [
                        {
                            "path": str(root / "ABSOLUTE-RESULT-SENTINEL.md"),
                            "title": "MALFORMED TITLE SENTINEL",
                            "snippet": "MALFORMED SNIPPET SENTINEL",
                        }
                    ],
                    "results_estimated_tokens": 1,
                    "result_token_limit": 900,
                    "filtered_stale": 0,
                }

            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                cases = MODULE.load_recall_eval_suite(fixture, config)
                report = MODULE.evaluate_recall_cases(
                    config,
                    cases,
                    recall_runner=runner,
                )

            self.assertEqual(calls, 3)
            self.assertEqual(report["cases"][0]["reasons"], ["recall-error"])
            self.assertEqual(report["cases"][1]["reasons"], ["recall-error"])
            self.assertEqual(report["cases"][2]["reasons"], ["recall-error"])
            self.assertEqual(report["cases"][0]["paths"], [])
            self.assertEqual(report["cases"][1]["paths"], [])
            self.assertEqual(report["cases"][2]["paths"], [])
            encoded = json.dumps(report)
            for secret in (
                str(fixture),
                str(root / "ABSOLUTE-RESULT-SENTINEL.md"),
                "TRACEBACK SENTINEL",
                "RUNTIME QUERY SENTINEL",
                "MALFORMED TITLE SENTINEL",
                "MALFORMED SNIPPET SENTINEL",
                "UNHASHABLE PROVIDER SENTINEL",
            ):
                self.assertNotIn(secret, encoded)

    def test_recall_evaluate_cli_resolves_paths_and_uses_documented_exits(self) -> None:
        """Catches wrong cwd resolution, output mode, privacy, and exit mappings."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            note = vault / "projects" / "alpha" / "current.md"
            note.write_text(
                "# CLI PRIVATE TITLE\nCLI_UNIQUE_NEEDLE PRIVATE NOTE BODY\n",
                encoding="utf-8",
            )
            config_path = self.write_config(
                root,
                vault,
                recall_provider="native",
                recall_roots=["projects"],
            )
            fixture = root / "suite.json"

            def write_fixture(*, forbidden: list[str]) -> None:
                fixture.write_text(
                    json.dumps(
                        {
                            "schema_version": 1,
                            "cases": [
                                {
                                    "id": "cli-case",
                                    "query": "CLI_UNIQUE_NEEDLE",
                                    "mode": "fast",
                                    "provider": "native",
                                    "scope": "projects/alpha",
                                    "top": 3,
                                    "max_tokens": 900,
                                    "expected_paths": ["projects/alpha/current.md"],
                                    "any_of_paths": [],
                                    "forbidden_paths": forbidden,
                                    "allow_degraded": False,
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )

            env = {**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            write_fixture(forbidden=[])
            passing = subprocess.run(
                [sys.executable, str(SCRIPT), "evaluate", "suite.json"],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(passing.returncode, 0, passing.stderr)
            self.assertEqual(len(passing.stdout.splitlines()), 1)
            self.assertTrue(json.loads(passing.stdout)["ok"])

            write_fixture(forbidden=["projects/alpha/current.md"])
            failing = subprocess.run(
                [sys.executable, str(SCRIPT), "evaluate", str(fixture), "--json"],
                cwd=vault,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(failing.returncode, 1, failing.stderr)
            self.assertGreater(len(failing.stdout.splitlines()), 1)
            self.assertFalse(json.loads(failing.stdout)["ok"])

            fixture.write_text('{"schema_version":', encoding="utf-8")
            invalid = subprocess.run(
                [sys.executable, str(SCRIPT), "evaluate", str(fixture), "--json"],
                cwd=vault,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(invalid.returncode, 2, invalid.stderr)
            self.assertEqual(json.loads(invalid.stdout)["error"], "fixture-error")

            missing_config = root / "ABSOLUTE-CONFIG-SENTINEL.json"
            config_error = subprocess.run(
                [sys.executable, str(SCRIPT), "evaluate", str(fixture), "--json"],
                cwd=vault,
                env={**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(missing_config)},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(config_error.returncode, 2, config_error.stderr)
            self.assertEqual(
                json.loads(config_error.stdout)["error"],
                "configuration-error",
            )

            for output in (
                passing.stdout + passing.stderr,
                failing.stdout + failing.stderr,
                invalid.stdout + invalid.stderr,
                config_error.stdout + config_error.stderr,
            ):
                self.assertNotIn("CLI_UNIQUE_NEEDLE", output)
                self.assertNotIn("CLI PRIVATE TITLE", output)
                self.assertNotIn("PRIVATE NOTE BODY", output)
                self.assertNotIn(str(fixture), output)
                self.assertNotIn(str(missing_config), output)

    def test_recall_evaluate_cli_sanitizes_malformed_utf8_configuration(self) -> None:
        """Catches decode failures escaping the evaluate configuration boundary."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config_path = root / "PRIVATE-CONFIG-PATH.json"
            config_path.write_bytes(b"\xffPRIVATE CONFIG BYTES")
            fixture = root / "PRIVATE-FIXTURE-PATH.json"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "evaluate", str(fixture), "--json"],
                env={**os.environ, "OBSIDIAN_MEMORY_CONFIG": str(config_path)},
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(
            json.loads(result.stdout),
            {"ok": False, "error": "configuration-error"},
        )
        self.assertEqual(result.stderr, "")
        output = result.stdout + result.stderr
        for secret in (
            str(config_path),
            str(fixture),
            "PRIVATE CONFIG BYTES",
            "UnicodeDecodeError",
            "Traceback",
        ):
            self.assertNotIn(secret, output)

    def test_recall_evaluate_sanitizes_vault_resolution_failure(self) -> None:
        """Catches vault path resolution failures leaking from load_config."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            fixture = root / "PRIVATE-FIXTURE-PATH.json"
            error_text = f"PRIVATE RESOLUTION ERROR {vault}"
            with (
                mock.patch.dict(
                    os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
                ),
                mock.patch.object(
                    MODULE.Path,
                    "resolve",
                    side_effect=RuntimeError(error_text),
                ),
                contextlib.redirect_stdout(io.StringIO()) as stdout,
                contextlib.redirect_stderr(io.StringIO()) as stderr,
            ):
                result = MODULE.evaluate_recall(fixture, True)
        self.assertEqual(result, 2)
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {"ok": False, "error": "configuration-error"},
        )
        self.assertEqual(stderr.getvalue(), "")
        output = stdout.getvalue() + stderr.getvalue()
        for secret in (str(config_path), str(vault), str(fixture), error_text, "Traceback"):
            self.assertNotIn(secret, output)

    def test_recall_eval_example_is_safe_and_loadable(self) -> None:
        """Catches a malformed or machine-specific checked-in example."""
        example = SCRIPT.parents[1] / "evals" / "recall-evals.example.json"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault)
            with mock.patch.dict(
                os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}
            ):
                config, _ = MODULE.load_config()
                cases = MODULE.load_recall_eval_suite(example, config)
        self.assertEqual([case.id for case in cases], ["scoped-current-decision"])
        self.assertNotIn(str(Path.home()), example.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

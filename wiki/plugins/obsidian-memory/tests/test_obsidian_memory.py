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


if __name__ == "__main__":
    unittest.main()

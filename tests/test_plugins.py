#!/usr/bin/env python3
"""Tests for the workspace plugin catalog and installer.

Pure/offline: no agent CLI is invoked. The one thing here that touches a real
user file — Codex hook-trust migration — is exercised against a temp config.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

if sys.version_info < (3, 11):
    current = str(Path(sys.executable).resolve())
    for name in ("python3.14", "python3.13", "python3.12", "python3.11"):
        candidate = shutil.which(name)
        if candidate and str(Path(candidate).resolve()) != current:
            # Run the test file directly; this avoids losing `-m unittest` in sys.argv[0].
            os.execv(candidate, [candidate, str(Path(__file__).resolve())])
    raise SystemExit("tests require Python 3.11+ (tomllib)")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import plugins as pl  # noqa: E402

tomllib = pl.tomllib


def catalog(**overrides) -> dict:
    base = {
        "marketplace": {"name": "ai-workspace", "owner": {"name": "Owner"}, "description": "d"},
        "plugins": [
            {
                "name": "demo",
                "source": "./project/plugins/demo",
                "version": "1.0.0",
                "description": "A demo plugin used by the tests.",
                "keywords": ["demo"],
                "category": "Productivity",
                "codex": {"shortDescription": "short", "capabilities": ["Read"]},
            }
        ],
    }
    base.update(overrides)
    return base


class CatalogValidation(unittest.TestCase):
    def load(self, payload: dict, tmp: Path) -> dict:
        (tmp / "plugins.json").write_text(json.dumps(payload), encoding="utf-8")
        with mock.patch.object(pl, "CATALOG", tmp / "plugins.json"):
            return pl.load_catalog()

    def test_accepts_a_well_formed_catalog(self) -> None:
        with TemporaryDirectory() as tmp:
            loaded = self.load(catalog(), Path(tmp))
            self.assertEqual(loaded["marketplace"]["name"], "ai-workspace")

    def test_rejects_a_missing_marketplace_name(self) -> None:
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pl.Problem, "marketplace.name"):
                self.load(catalog(marketplace={"owner": {"name": "x"}}), Path(tmp))

    def test_rejects_duplicate_plugin_names(self) -> None:
        payload = catalog()
        payload["plugins"] = payload["plugins"] + [dict(payload["plugins"][0])]
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pl.Problem, "duplicate"):
                self.load(payload, Path(tmp))

    def test_rejects_a_non_relative_source(self) -> None:
        payload = catalog()
        payload["plugins"][0]["source"] = "/absolute/path"
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pl.Problem, "repo-relative"):
                self.load(payload, Path(tmp))

    def test_rejects_a_plugin_with_no_description(self) -> None:
        payload = catalog()
        del payload["plugins"][0]["description"]
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pl.Problem, "description is required"):
                self.load(payload, Path(tmp))

    def test_rejects_a_plugin_with_no_catalog_version(self) -> None:
        payload = catalog()
        del payload["plugins"][0]["version"]
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pl.Problem, "version is required"):
                self.load(payload, Path(tmp))

    def test_rejects_an_empty_plugin_list(self) -> None:
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(pl.Problem, "non-empty"):
                self.load(catalog(plugins=[]), Path(tmp))


class Rendering(unittest.TestCase):
    def test_both_agents_get_the_same_marketplace(self) -> None:
        rendered = pl.render_marketplace(catalog())
        self.assertEqual(rendered["name"], "ai-workspace")
        self.assertEqual(rendered["plugins"][0]["source"], "./project/plugins/demo")
        self.assertIn("GENERATED", rendered["$comment"])

    def test_rendering_is_deterministic(self) -> None:
        self.assertEqual(pl.render_marketplace(catalog()), pl.render_marketplace(catalog()))

    def test_codex_manifest_adds_skills_and_interface(self) -> None:
        entry = catalog()["plugins"][0]
        manifests = pl.render_plugin_manifests(catalog(), entry)
        codex = next(payload for path, payload in manifests.items() if ".codex-plugin" in str(path))
        claude = next(payload for path, payload in manifests.items() if ".claude-plugin" in str(path))
        self.assertEqual(codex["skills"], "./skills/")
        self.assertEqual(codex["interface"]["shortDescription"], "short")
        self.assertNotIn("interface", claude)
        self.assertEqual(codex["name"], claude["name"])
        self.assertEqual(codex["version"], claude["version"])

    def test_the_marketplace_version_follows_the_catalog(self) -> None:
        entry = catalog()["plugins"][0]
        entry["version"] = "9.9.9"
        self.assertEqual(pl.plugin_version(entry), "9.9.9")

    def test_plugin_ids_are_marketplace_scoped(self) -> None:
        self.assertEqual(pl.plugin_id(catalog(), catalog()["plugins"][0]), "demo@ai-workspace")


class DriftDetection(unittest.TestCase):
    def test_write_json_reports_change_and_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "out.json"
            self.assertTrue(pl.write_json(path, {"a": 1}, check_only=False))
            self.assertFalse(pl.write_json(path, {"a": 1}, check_only=False))
            self.assertTrue(pl.write_json(path, {"a": 2}, check_only=True))
            self.assertEqual(json.loads(path.read_text())["a"], 1, "check mode must not write")

    def test_the_live_repo_has_no_drift(self) -> None:
        """The committed manifests must equal what the catalog renders."""
        live = pl.load_catalog()
        rendered = pl.render_marketplace(live)
        for path in (pl.CLAUDE_MARKETPLACE, pl.CODEX_MARKETPLACE):
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8")),
                rendered,
                f"{path} is stale — run scripts/plugins.py sync",
            )
        for entry in live["plugins"]:
            for path, payload in pl.render_plugin_manifests(live, entry).items():
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), payload, str(path))


class PluginValidation(unittest.TestCase):
    def build(self, tmp: Path, *, description: str = "x" * 90, skill_name: str = "demo") -> dict:
        entry = catalog()["plugins"][0]
        directory = tmp / "project" / "plugins" / "demo"
        (directory / ".claude-plugin").mkdir(parents=True)
        (directory / ".codex-plugin").mkdir(parents=True)
        for manifest in (".claude-plugin", ".codex-plugin"):
            (directory / manifest / "plugin.json").write_text(json.dumps({"name": "demo"}))
        skill = directory / "skills" / skill_name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: {skill_name}\ndescription: {description}\n---\n\nbody\n", encoding="utf-8"
        )
        return entry

    def test_a_well_formed_plugin_passes(self) -> None:
        with TemporaryDirectory() as tmp:
            entry = self.build(Path(tmp))
            with mock.patch.object(pl, "ROOT", Path(tmp)):
                self.assertEqual(pl.check_plugin(entry), [])

    def test_a_thin_description_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            entry = self.build(Path(tmp), description="too short")
            with mock.patch.object(pl, "ROOT", Path(tmp)):
                self.assertTrue(any("too thin" in problem for problem in pl.check_plugin(entry)))

    def test_a_frontmatter_name_mismatch_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            entry = catalog()["plugins"][0]
            directory = Path(tmp) / "project" / "plugins" / "demo"
            (directory / ".claude-plugin").mkdir(parents=True)
            (directory / ".codex-plugin").mkdir(parents=True)
            for manifest in (".claude-plugin", ".codex-plugin"):
                (directory / manifest / "plugin.json").write_text(json.dumps({"name": "demo"}))
            skill = directory / "skills" / "actual"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(f"---\nname: other\ndescription: {'x' * 90}\n---\nbody\n")
            with mock.patch.object(pl, "ROOT", Path(tmp)):
                self.assertTrue(any("must match" in problem for problem in pl.check_plugin(entry)))

    def test_a_missing_skills_directory_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            entry = catalog()["plugins"][0]
            directory = Path(tmp) / "project" / "plugins" / "demo"
            (directory / ".claude-plugin").mkdir(parents=True)
            (directory / ".codex-plugin").mkdir(parents=True)
            for manifest in (".claude-plugin", ".codex-plugin"):
                (directory / manifest / "plugin.json").write_text(json.dumps({"name": "demo"}))
            with mock.patch.object(pl, "ROOT", Path(tmp)):
                self.assertTrue(any("no skills/" in problem for problem in pl.check_plugin(entry)))

    def test_a_missing_directory_is_reported_once(self) -> None:
        with TemporaryDirectory() as tmp:
            with mock.patch.object(pl, "ROOT", Path(tmp)):
                problems = pl.check_plugin(catalog()["plugins"][0])
            self.assertEqual(len(problems), 1)
            self.assertIn("missing directory", problems[0])


class HookTrustMigration(unittest.TestCase):
    CONFIG = """model = "gpt-5.6-sol"

[hooks.state]

[hooks.state."obsidian-memory@old:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:aaa"

[hooks.state."obsidian-memory@old:hooks/hooks.json:stop:0:0"]
trusted_hash = "sha256:bbb"
"""

    def test_hashes_carry_across_a_rename(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.toml"
            config.write_text(self.CONFIG, encoding="utf-8")
            with mock.patch.object(pl, "CODEX_CONFIG", config):
                self.assertTrue(pl.migrate_codex_hook_trust("obsidian-memory@old", "obsidian-memory@new"))
            state = tomllib.loads(config.read_text())["hooks"]["state"]
            self.assertEqual(
                state["obsidian-memory@new:hooks/hooks.json:session_start:0:0"]["trusted_hash"],
                "sha256:aaa",
            )
            self.assertIn("obsidian-memory@old:hooks/hooks.json:stop:0:0", state, "old keys stay")

    def test_migration_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.toml"
            config.write_text(self.CONFIG, encoding="utf-8")
            with mock.patch.object(pl, "CODEX_CONFIG", config):
                pl.migrate_codex_hook_trust("obsidian-memory@old", "obsidian-memory@new")
                first = config.read_text()
                self.assertFalse(pl.migrate_codex_hook_trust("obsidian-memory@old", "obsidian-memory@new"))
            self.assertEqual(config.read_text(), first)

    def test_nothing_to_carry_leaves_the_file_untouched(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.toml"
            config.write_text('model = "x"\n', encoding="utf-8")
            with mock.patch.object(pl, "CODEX_CONFIG", config):
                self.assertFalse(pl.migrate_codex_hook_trust("a@old", "a@new"))
            self.assertEqual(config.read_text(), 'model = "x"\n')

    def test_a_missing_config_is_not_an_error(self) -> None:
        with TemporaryDirectory() as tmp:
            with mock.patch.object(pl, "CODEX_CONFIG", Path(tmp) / "absent.toml"):
                self.assertFalse(pl.migrate_codex_hook_trust("a@old", "a@new"))

    def test_invalid_toml_is_refused_rather_than_rewritten(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.toml"
            config.write_text("this is [not valid", encoding="utf-8")
            with mock.patch.object(pl, "CODEX_CONFIG", config):
                with self.assertRaisesRegex(pl.Problem, "not valid TOML"):
                    pl.migrate_codex_hook_trust("a@old", "a@new")
            self.assertEqual(config.read_text(), "this is [not valid")


class StatusParsing(unittest.TestCase):
    """`status` must judge each plugin from its own line, never the whole output."""

    LISTING = (
        "Marketplace `ai-workspace`\n"
        "/bounded/marketplace.json\n\n"
        f"{'PLUGIN':<36}{'STATUS':<20}{'VERSION':<10}PATH\n"
        f"{'obsidian-memory@ai-workspace':<36}{'installed, enabled':<20}"
        f"{'0.1.0':<10}/bounded/plugin\n"
    )

    SOURCE_LISTING = (
        "Marketplace `ai-workspace`\n"
        "/bounded/marketplace.json\n\n"
        f"{'PLUGIN':<36}{'STATUS':<20}{'VERSION':<10}SOURCE\n"
        f"{'obsidian-memory@ai-workspace':<36}{'installed, enabled':<20}"
        f"{'0.1.0':<10}/bounded/plugin\n"
    )

    def test_reads_a_source_column_as_well_as_path(self) -> None:
        states = pl.codex_plugin_states(self.SOURCE_LISTING, "ai-workspace")
        self.assertEqual(
            states.get("obsidian-memory@ai-workspace"),
            {
                "installed": True,
                "enabled": True,
                "version": "0.1.0",
                "path": "/bounded/plugin",
            },
        )

    def state_for(self, pid: str, listing: str) -> str:
        state = "-"
        for line in listing.splitlines():
            if line.startswith(pid):
                state = "installed" if "installed" in line else "not installed"
                if "enabled" in line:
                    state += ", enabled"
        return state

    def test_a_listed_plugin_reads_installed(self) -> None:
        self.assertEqual(
            self.state_for("obsidian-memory@ai-workspace", self.LISTING), "installed, enabled"
        )

    def test_an_absent_plugin_reads_dash_even_when_another_is_installed(self) -> None:
        self.assertEqual(self.state_for("absent-plugin@ai-workspace", self.LISTING), "-")

    def test_the_real_status_command_agrees(self) -> None:
        """Guards the production parser against whole-output substring matches."""
        states = pl.codex_plugin_states(self.LISTING, "ai-workspace")
        self.assertTrue(states["obsidian-memory@ai-workspace"]["installed"])
        self.assertTrue(states["obsidian-memory@ai-workspace"]["enabled"])
        self.assertNotIn("absent-plugin@ai-workspace", states)


class MarketplaceReconnection(unittest.TestCase):
    """Force install must source local plugins from the executing checkout."""

    OLD_ROOT = "/tmp/old-checkout"
    CODEX_OTHER_ROOT = "/tmp/codex-curated"
    CLAUDE_OTHER_ROOT = "/tmp/claude-official"

    def exercise_install(self, *, force: bool):
        state = {
            "codex_root": self.OLD_ROOT,
            "claude_root": self.OLD_ROOT,
        }
        codex_commands = []
        claude_commands = []

        def completed(stdout=""):
            return mock.Mock(returncode=0, stdout=stdout, stderr="")

        def run(command, allow_failure=False, quiet=False):
            if command[0] == "codex":
                codex_commands.append(list(command))
            elif command[0] == "claude":
                claude_commands.append(list(command))

            if command == ["codex", "plugin", "marketplace", "list"]:
                rows = [
                    "MARKETPLACE     ROOT",
                    f"openai-curated  {self.CODEX_OTHER_ROOT}",
                ]
                if state["codex_root"]:
                    rows.append(f"ai-workspace    {state['codex_root']}")
                return completed("\n".join(rows) + "\n")
            if command[:4] == ["codex", "plugin", "marketplace", "remove"]:
                state["codex_root"] = ""
            elif command[:4] == ["codex", "plugin", "marketplace", "add"]:
                if state["codex_root"]:
                    raise AssertionError("Codex marketplace add requires prior removal")
                state["codex_root"] = command[4]
            elif command == ["claude", "plugin", "marketplace", "list", "--json"]:
                entries = [
                    {
                        "name": "claude-plugins-official",
                        "source": "github",
                        "installLocation": self.CLAUDE_OTHER_ROOT,
                    }
                ]
                if state["claude_root"]:
                    entries.append(
                        {
                            "name": "ai-workspace",
                            "source": "directory",
                            "installLocation": state["claude_root"],
                        }
                    )
                return completed(json.dumps(entries))
            elif command[:4] == ["claude", "plugin", "marketplace", "remove"]:
                state["claude_root"] = ""
            elif command[:4] == ["claude", "plugin", "marketplace", "add"]:
                if state["claude_root"]:
                    raise AssertionError("Claude marketplace add requires prior removal")
                state["claude_root"] = command[4]
            return completed()

        args = argparse.Namespace(scope="user", force=force)
        with TemporaryDirectory() as tmp:
            with (
                mock.patch.object(pl, "MEMORY_CONFIG", Path(tmp) / "missing.json"),
                mock.patch.object(pl, "load_catalog", return_value=catalog()),
                mock.patch.object(pl.shutil, "which", return_value="/usr/bin/tool"),
                mock.patch.object(pl, "run", side_effect=run),
                mock.patch.object(pl, "cmd_status", return_value=0),
            ):
                self.assertEqual(pl.cmd_install(args), 0)

        return state, codex_commands, claude_commands

    def test_force_install_orders_codex_reconnection_before_plugin_refresh(self) -> None:
        state, commands, _ = self.exercise_install(force=True)

        self.assertEqual(state["codex_root"], str(pl.ROOT))
        self.assertEqual(
            commands,
            [
                ["codex", "plugin", "marketplace", "list"],
                ["codex", "plugin", "marketplace", "list"],
                ["codex", "plugin", "marketplace", "remove", "ai-workspace"],
                ["codex", "plugin", "marketplace", "list"],
                ["codex", "plugin", "marketplace", "add", str(pl.ROOT), "--json"],
                ["codex", "plugin", "remove", "demo@ai-workspace"],
                ["codex", "plugin", "add", "demo@ai-workspace", "--json"],
            ],
        )

    def test_force_install_orders_claude_reconnection_before_plugin_refresh(self) -> None:
        state, _, commands = self.exercise_install(force=True)

        self.assertEqual(state["claude_root"], str(pl.ROOT))
        self.assertEqual(
            commands,
            [
                ["claude", "plugin", "marketplace", "list", "--json"],
                [
                    "claude",
                    "plugin",
                    "marketplace",
                    "remove",
                    "ai-workspace",
                    "--scope",
                    "user",
                ],
                ["claude", "plugin", "marketplace", "list", "--json"],
                [
                    "claude",
                    "plugin",
                    "marketplace",
                    "add",
                    str(pl.ROOT),
                    "--scope",
                    "user",
                ],
                [
                    "claude",
                    "plugin",
                    "uninstall",
                    "demo@ai-workspace",
                    "--scope",
                    "user",
                    "--yes",
                    "--keep-data",
                ],
                [
                    "claude",
                    "plugin",
                    "install",
                    "demo@ai-workspace",
                    "--scope",
                    "user",
                ],
                [
                    "claude",
                    "plugin",
                    "update",
                    "demo@ai-workspace",
                    "--scope",
                    "user",
                ],
                [
                    "claude",
                    "plugin",
                    "enable",
                    "demo@ai-workspace",
                    "--scope",
                    "user",
                ],
            ],
        )

    def test_non_force_install_preserves_stale_roots_and_update_flow(self) -> None:
        state, codex_commands, claude_commands = self.exercise_install(force=False)

        self.assertEqual(
            state,
            {"codex_root": self.OLD_ROOT, "claude_root": self.OLD_ROOT},
        )
        self.assertEqual(
            codex_commands,
            [
                ["codex", "plugin", "marketplace", "list"],
                ["codex", "plugin", "marketplace", "list"],
                ["codex", "plugin", "add", "demo@ai-workspace", "--json"],
            ],
        )
        self.assertEqual(
            claude_commands,
            [
                ["claude", "plugin", "marketplace", "list", "--json"],
                ["claude", "plugin", "marketplace", "update", "ai-workspace"],
                [
                    "claude",
                    "plugin",
                    "install",
                    "demo@ai-workspace",
                    "--scope",
                    "user",
                ],
                [
                    "claude",
                    "plugin",
                    "update",
                    "demo@ai-workspace",
                    "--scope",
                    "user",
                ],
            ],
        )


class WorkspaceProductPostcondition(unittest.TestCase):
    """Status is the fresh two-product authority after every install attempt."""

    def exercise(self, *, install: bool = False, failure: str | None = None, **overrides):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            workspace = root / "workspace"
            source = workspace / "project" / "plugins" / "demo"
            codex_live = root / "codex-live" / "demo"
            claude_live = root / "claude-live" / "demo"
            home = root / "home"
            for directory in (source, codex_live, claude_live):
                directory.mkdir(parents=True)
            source.joinpath("plugin.txt").write_text("SOURCE-BYTES\n", encoding="utf-8")
            codex_live.joinpath("plugin.txt").write_text("SOURCE-BYTES\n", encoding="utf-8")
            claude_live.joinpath("plugin.txt").write_text("SOURCE-BYTES\n", encoding="utf-8")
            state = {
                "codex_cli": True,
                "claude_cli": True,
                "codex_root": str(workspace),
                "claude_root": str(workspace),
                "codex_installed": True,
                "claude_installed": True,
                "codex_enabled": True,
                "claude_enabled": True,
                "codex_live": str(codex_live),
                "claude_live": str(claude_live),
                **overrides,
            }
            if not state.pop("codex_bytes", True):
                codex_live.joinpath("plugin.txt").write_text(
                    "PRIVATE-CODEX-LIVE-BODY\n", encoding="utf-8"
                )
            if not state.pop("claude_bytes", True):
                claude_live.joinpath("plugin.txt").write_text(
                    "PRIVATE-CLAUDE-LIVE-BODY\n", encoding="utf-8"
                )

            def completed(stdout="", returncode=0):
                return mock.Mock(returncode=returncode, stdout=stdout, stderr="")

            def codex_marketplaces() -> str:
                rows = ["MARKETPLACE     ROOT", "openai-curated  /bounded/curated"]
                if state["codex_root"]:
                    rows.append(f"ai-workspace    {state['codex_root']}")
                return "\n".join(rows) + "\n"

            def codex_plugins() -> str:
                lines = [
                    "Marketplace `ai-workspace`",
                    f"{workspace}/.agents/plugins/marketplace.json",
                    "",
                    f"{'PLUGIN':<28}{'STATUS':<20}{'VERSION':<10}PATH",
                ]
                if state["codex_installed"]:
                    status = (
                        "installed, enabled"
                        if state["codex_enabled"]
                        else "installed"
                    )
                    lines.append(
                        f"{'demo@ai-workspace':<28}{status:<20}{'1.0.0':<10}"
                        f"{state['codex_live']}"
                    )
                return "\n".join(lines) + "\n"

            def claude_marketplaces() -> str:
                entries = []
                if state["claude_root"]:
                    entries.append(
                        {
                            "name": "ai-workspace",
                            "source": "directory",
                            "path": state["claude_root"],
                            "installLocation": state["claude_root"],
                        }
                    )
                return json.dumps(entries)

            def claude_plugins() -> str:
                entries = []
                if state["claude_installed"]:
                    entries.append(
                        {
                            "id": "demo@ai-workspace",
                            "version": "1.0.0",
                            "scope": "user",
                            "enabled": state["claude_enabled"],
                            "installPath": state["claude_live"],
                            "installedAt": "2026-08-27T00:00:00.000Z",
                            "lastUpdated": "2026-08-27T00:00:00.000Z",
                        }
                    )
                return json.dumps(entries)

            def write_legacy_claude_state() -> None:
                plugin_root = home / ".claude" / "plugins"
                plugin_root.mkdir(parents=True, exist_ok=True)
                records = {}
                if state["claude_installed"]:
                    records["demo@ai-workspace"] = [
                        {
                            "scope": "user",
                            "version": "1.0.0",
                            "installPath": state["claude_live"],
                        }
                    ]
                (plugin_root / "installed_plugins.json").write_text(
                    json.dumps({"plugins": records}), encoding="utf-8"
                )
                (home / ".claude" / "settings.json").write_text(
                    json.dumps(
                        {
                            "enabledPlugins": {
                                "demo@ai-workspace": state["claude_enabled"]
                            }
                        }
                    ),
                    encoding="utf-8",
                )

            def run(command, allow_failure=False, quiet=False):
                _ = allow_failure, quiet
                if command == ["codex", "plugin", "marketplace", "list"]:
                    return completed(codex_marketplaces())
                if command == ["codex", "plugin", "list"]:
                    return completed(codex_plugins())
                if command == ["claude", "plugin", "marketplace", "list", "--json"]:
                    return completed(claude_marketplaces())
                if command == ["claude", "plugin", "list", "--json"]:
                    return completed(claude_plugins())

                operation = None
                if command[:4] == ["codex", "plugin", "marketplace", "remove"]:
                    operation = "remove"
                    if failure != operation:
                        state["codex_root"] = ""
                elif command[:4] == ["codex", "plugin", "marketplace", "add"]:
                    if state["codex_root"]:
                        return completed(returncode=1)
                    state["codex_root"] = command[4]
                elif command[:3] == ["codex", "plugin", "remove"]:
                    state["codex_installed"] = False
                    state["codex_enabled"] = False
                elif command[:3] == ["codex", "plugin", "add"]:
                    operation = "add"
                    if failure != operation:
                        state["codex_installed"] = True
                        state["codex_enabled"] = True
                elif command[:4] == ["claude", "plugin", "marketplace", "remove"]:
                    state["claude_root"] = ""
                elif command[:4] == ["claude", "plugin", "marketplace", "add"]:
                    state["claude_root"] = command[4]
                elif command[:3] == ["claude", "plugin", "uninstall"]:
                    state["claude_installed"] = False
                    state["claude_enabled"] = False
                elif command[:3] == ["claude", "plugin", "install"]:
                    operation = "install"
                    if failure != operation:
                        state["claude_installed"] = True
                        state["claude_enabled"] = True
                elif command[:3] == ["claude", "plugin", "enable"]:
                    if state["claude_installed"]:
                        state["claude_enabled"] = True
                write_legacy_claude_state()
                return completed(returncode=1 if operation == failure else 0)

            write_legacy_claude_state()

            def which(name):
                return f"/usr/bin/{name}" if state.get(f"{name}_cli") else None

            output = io.StringIO()
            args = argparse.Namespace(scope="user", force=True if install else False)
            with (
                mock.patch.object(pl, "ROOT", workspace),
                mock.patch.object(pl, "MEMORY_CONFIG", root / "missing-config.json"),
                mock.patch.object(pl, "load_catalog", return_value=catalog()),
                mock.patch.object(pl.shutil, "which", side_effect=which),
                mock.patch.object(pl, "run", side_effect=run),
                mock.patch.object(Path, "home", return_value=home),
                mock.patch.object(
                    pl,
                    "memory_guidance_status",
                    return_value={"configured": False, "ok": True},
                ),
                redirect_stdout(output),
            ):
                rc = pl.cmd_install(args) if install else pl.cmd_status(args)
            return rc, output.getvalue(), workspace, codex_live, claude_live

    def test_status_requires_complete_current_byte_equal_state_for_both_products(
        self,
    ) -> None:
        healthy_rc, healthy_output, workspace, codex_live, claude_live = self.exercise()
        self.assertEqual(healthy_rc, 0)
        cases = (
            ("codex CLI", {"codex_cli": False}),
            ("claude CLI", {"claude_cli": False}),
            ("codex marketplace", {"codex_root": ""}),
            ("claude marketplace", {"claude_root": ""}),
            ("codex stale root", {"codex_root": "/bounded/old"}),
            ("claude stale root", {"claude_root": "/bounded/old"}),
            ("codex plugin", {"codex_installed": False}),
            ("claude plugin", {"claude_installed": False}),
            ("codex disabled", {"codex_enabled": False}),
            ("claude disabled", {"claude_enabled": False}),
            ("codex bytes", {"codex_bytes": False}),
            ("claude bytes", {"claude_bytes": False}),
        )
        outputs = [healthy_output]
        for label, overrides in cases:
            with self.subTest(label=label):
                rc, output, *_ = self.exercise(**overrides)
                self.assertEqual(rc, 1)
                outputs.append(output)
        encoded = "".join(outputs)
        for secret in (
            str(workspace),
            str(codex_live),
            str(claude_live),
            "PRIVATE-CODEX-LIVE-BODY",
            "PRIVATE-CLAUDE-LIVE-BODY",
        ):
            self.assertNotIn(secret, encoded)

    def test_force_install_uses_real_final_status_after_tolerated_failures(self) -> None:
        cases = (
            ("remove", {"codex_root": "/bounded/old"}),
            ("add", {}),
            ("install", {}),
        )
        for failure, overrides in cases:
            with self.subTest(failure=failure):
                rc, output, workspace, codex_live, claude_live = self.exercise(
                    install=True,
                    failure=failure,
                    **overrides,
                )
                self.assertEqual(rc, 1)
                for secret in (str(workspace), str(codex_live), str(claude_live)):
                    self.assertNotIn(secret, output)


class WorkspaceGuidanceParity(unittest.TestCase):
    def args(self) -> argparse.Namespace:
        return argparse.Namespace(scope="user", force=False)

    def test_install_repairs_memory_guidance_when_configured(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"vault": "/private/vault"}\n', encoding="utf-8")
            completed = mock.Mock(returncode=0, stdout="", stderr="")
            with (
                mock.patch.object(pl, "MEMORY_CONFIG", config),
                mock.patch.object(pl, "load_catalog", return_value=catalog()),
                mock.patch.object(pl.shutil, "which", return_value=None),
                mock.patch.object(pl, "cmd_status", return_value=0),
                mock.patch.object(pl, "run", return_value=completed) as run,
            ):
                self.assertEqual(pl.cmd_install(self.args()), 0)
            run.assert_called_once_with(
                [
                    sys.executable,
                    str(pl.MEMORY_INSTALLER),
                    "--reuse-config",
                    "--skip-product-install",
                    "--skip-upstream-skill-link",
                    "--keep-legacy-hooks",
                ]
            )

    def test_install_skips_memory_guidance_repair_without_config(self) -> None:
        with TemporaryDirectory() as tmp:
            with (
                mock.patch.object(pl, "MEMORY_CONFIG", Path(tmp) / "missing.json"),
                mock.patch.object(pl, "load_catalog", return_value=catalog()),
                mock.patch.object(pl.shutil, "which", return_value=None),
                mock.patch.object(pl, "cmd_status", return_value=0),
                mock.patch.object(pl, "run") as run,
            ):
                self.assertEqual(pl.cmd_install(self.args()), 0)
            run.assert_not_called()

    def test_status_fails_when_configured_guidance_is_unhealthy(self) -> None:
        output = io.StringIO()
        with (
            mock.patch.object(pl, "load_catalog", return_value=catalog()),
            mock.patch.object(pl.shutil, "which", return_value=None),
            mock.patch.object(
                pl,
                "memory_guidance_status",
                return_value={
                    "configured": True,
                    "ok": False,
                    "claude": "stale",
                    "codex": "malformed",
                },
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(pl.cmd_status(self.args()), 1)
        self.assertIn("guidance:", output.getvalue())
        self.assertIn("Claude stale", output.getvalue())
        self.assertIn("Codex malformed", output.getvalue())

    def test_status_reports_not_configured_but_fails_when_required_clis_are_missing(
        self,
    ) -> None:
        output = io.StringIO()
        with TemporaryDirectory() as tmp:
            with (
                mock.patch.object(pl, "MEMORY_CONFIG", Path(tmp) / "missing.json"),
                mock.patch.object(pl, "load_catalog", return_value=catalog()),
                mock.patch.object(pl.shutil, "which", return_value=None),
                redirect_stdout(output),
            ):
                self.assertEqual(pl.cmd_status(self.args()), 1)
        self.assertIn("guidance: not configured", output.getvalue())
        self.assertEqual(output.getvalue().count("CLI MISSING"), 4)

    def test_status_fails_closed_on_malformed_project_status_json(self) -> None:
        output = io.StringIO()
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"vault": "/private/vault"}\n', encoding="utf-8")
            completed = mock.Mock(returncode=0, stdout="not-json", stderr="")
            with (
                mock.patch.object(pl, "MEMORY_CONFIG", config),
                mock.patch.object(pl, "load_catalog", return_value=catalog()),
                mock.patch.object(pl.shutil, "which", return_value=None),
                mock.patch.object(pl, "run", return_value=completed),
                redirect_stdout(output),
            ):
                self.assertEqual(pl.cmd_status(self.args()), 1)
        self.assertIn("guidance: invalid status", output.getvalue())

    def test_status_rejects_semantically_inconsistent_project_payloads(self) -> None:
        cases = (
            (
                {
                    "configured": True,
                    "ok": True,
                    "claude": "stale",
                    "codex": "current",
                },
                0,
            ),
            (
                {
                    "configured": True,
                    "ok": False,
                    "claude": "current",
                    "codex": "current",
                },
                1,
            ),
            (
                {
                    "configured": False,
                    "ok": True,
                    "claude": "not-configured",
                    "codex": "not-configured",
                },
                0,
            ),
        )
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"vault": "/private/vault"}\n', encoding="utf-8")
            for payload, returncode in cases:
                with self.subTest(payload=payload):
                    with (
                        mock.patch.object(pl, "MEMORY_CONFIG", config),
                        mock.patch.object(
                            pl,
                            "run",
                            return_value=mock.Mock(
                                returncode=returncode,
                                stdout=json.dumps(payload),
                                stderr="",
                            ),
                        ),
                    ):
                        self.assertEqual(
                            pl.memory_guidance_status(),
                            {"configured": True, "ok": False, "error": "invalid-status"},
                        )

    def test_status_normalizes_valid_project_payload(self) -> None:
        payload = {
            "configured": True,
            "ok": False,
            "claude": "stale",
            "codex": "current",
            "vault": "/private/secret-vault",
            "policy": "private policy body",
        }
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"vault": "/private/vault"}\n', encoding="utf-8")
            with (
                mock.patch.object(pl, "MEMORY_CONFIG", config),
                mock.patch.object(
                    pl,
                    "run",
                    return_value=mock.Mock(
                        returncode=1,
                        stdout=json.dumps(payload),
                        stderr="",
                    ),
                ),
            ):
                self.assertEqual(
                    pl.memory_guidance_status(),
                    {
                        "configured": True,
                        "ok": False,
                        "claude": "stale",
                        "codex": "current",
                    },
                )


class WikiRelease(unittest.TestCase):
    """The wiki release flow must target the workspace marketplace, not wiki/."""

    def source(self) -> str:
        return (ROOT / "wiki" / "scripts" / "update.py").read_text(encoding="utf-8")

    def test_claude_validate_points_at_the_workspace(self) -> None:
        self.assertIn('run(["claude", "plugin", "validate", str(WORKSPACE)])', self.source())

    def test_a_version_bump_re_renders_the_manifests(self) -> None:
        self.assertIn('str(WORKSPACE_INSTALLER), "sync"', self.source())

    def test_reinstall_goes_through_the_workspace_installer(self) -> None:
        self.assertIn('str(WORKSPACE_INSTALLER), "install"', self.source())

    def test_the_marketplace_name_matches_the_catalog(self) -> None:
        live = pl.marketplace_name(pl.load_catalog())
        for script in ("install.py", "update.py"):
            text = (ROOT / "wiki" / "scripts" / script).read_text(encoding="utf-8")
            self.assertIn(f'MARKETPLACE = "{live}"', text, script)


class LiveCatalog(unittest.TestCase):
    def test_chatgpt_consult_is_catalogued_and_runs_its_package_gate(self) -> None:
        live = pl.load_catalog()
        entry = next(item for item in live["plugins"] if item["name"] == "chatgpt-consult")
        self.assertEqual(entry["source"], "./chatgpt-consult/plugins/chatgpt-consult")
        self.assertIn(("chatgpt-consult", ["bun", "run", "check"]), pl.PROJECT_CHECKS)

    def test_every_catalogued_plugin_exists_and_validates(self) -> None:
        live = pl.load_catalog()
        self.assertGreaterEqual(len(live["plugins"]), 2)
        for entry in live["plugins"]:
            self.assertEqual(pl.check_plugin(entry), [], entry["name"])

    def test_renames_point_at_this_marketplace(self) -> None:
        live = pl.load_catalog()
        for old, new in (live.get("renames") or {}).items():
            self.assertEqual(new, pl.marketplace_name(live), f"{old} renames to something else")


if __name__ == "__main__":
    unittest.main(verbosity=2)

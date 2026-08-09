#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock

if sys.version_info < (3, 11):
    current = str(Path(sys.executable).resolve())
    for name in ("python3.14", "python3.13", "python3.12", "python3.11"):
        candidate = shutil.which(name)
        if candidate and str(Path(candidate).resolve()) != current:
            os.execv(candidate, [candidate, str(Path(__file__).resolve())])
    raise SystemExit("tests require Python 3.11+")

import tomllib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import manage  # noqa: E402
import render  # noqa: E402


class Rendering(unittest.TestCase):
    def test_live_provider_files_match_the_shared_sources(self) -> None:
        self.assertEqual(render.render(check=True), [])

    def test_provider_models_are_native(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        controller = next(agent for agent in catalog if agent["id"] == "controller")
        self.assertEqual(controller["claude"]["model"], "fable")
        for agent in catalog:
            if agent.get("codex"):
                self.assertTrue(agent["codex"]["model"].startswith("gpt-"))

    def test_codex_agents_use_the_required_schema(self) -> None:
        for path in (ROOT / "codex" / "agents").glob("*.toml"):
            agent = tomllib.loads(path.read_text(encoding="utf-8"))
            for field in ("name", "description", "developer_instructions"):
                self.assertTrue(agent[field], f"{path}: {field}")

    def test_codex_agents_use_concrete_model_ids(self) -> None:
        supported = {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}
        for path in (ROOT / "codex" / "agents").glob("*.toml"):
            agent = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertIn(agent["model"], supported, str(path))

    def test_codex_controller_profile_is_explicit_and_native(self) -> None:
        profile = tomllib.loads(
            (ROOT / "codex" / "controller.config.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(profile["model"], "gpt-5.6-sol")
        self.assertEqual(profile["model_reasoning_effort"], "max")
        self.assertIn("active shared-agents controller", profile["developer_instructions"])

    def test_claude_plugin_agents_do_not_use_unsupported_permission_mode(self) -> None:
        for path in (ROOT / "plugins" / "shared-agents" / "agents").glob("*.md"):
            self.assertNotIn("permissionMode:", path.read_text(encoding="utf-8"), str(path))

    def test_read_only_claude_agents_do_not_receive_shell_access(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        for agent in catalog:
            claude = agent.get("claude", {})
            if not set(claude.get("disallowedTools", [])) & {"Write", "Edit", "NotebookEdit"}:
                continue
            self.assertNotIn("Bash", claude.get("tools", []), agent["id"])


class ClaudeRoutingSurfaces(unittest.TestCase):
    SURFACES = (
        "prompts/controller.md",
        "policy/claude-orchestration.md",
        "policy/claude-global.md",
        "plugins/shared-agents/skills/shared-agents/SKILL.md",
    )
    DETAILED_SURFACES = (
        "prompts/controller.md",
        "policy/claude-orchestration.md",
        "plugins/shared-agents/skills/shared-agents/SKILL.md",
    )

    def surface(self, relative_path: str) -> str:
        text = (ROOT / relative_path).read_text(encoding="utf-8")
        return " ".join(text.split()).lower()

    def test_every_surface_requires_an_explicit_model_per_agent_call(self) -> None:
        for relative_path in self.SURFACES:
            text = self.surface(relative_path)
            self.assertIn("a model on every agent call", text, relative_path)

    def test_every_surface_reserves_fable_for_the_controller(self) -> None:
        for relative_path in self.SURFACES:
            text = self.surface(relative_path)
            self.assertIn("fable", text, relative_path)
            self.assertIn("never dispatch it as a worker", text, relative_path)

    def test_every_surface_encodes_the_model_matrix(self) -> None:
        for relative_path in self.SURFACES:
            text = self.surface(relative_path)
            for model in ("sonnet", "haiku", "opus"):
                self.assertIn(model, text, f"{relative_path}: {model}")

    def test_detailed_surfaces_pair_each_model_with_its_role(self) -> None:
        pairings = (
            r"`sonnet` — default worker for analysis, exploration",
            r"`haiku` — only mechanical, low-risk, non-code",
            r"`opus` — (independent worker for )?architecture or "
            r"public-interface trade-offs, security, concurrency",
            r"`fable` — (the controller itself|main controller only)[;.] "
            r"never dispatch it as a worker",
        )
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            for pattern in pairings:
                self.assertRegex(text, pattern, relative_path)
            self.assertIn(
                "escalate because the decision is difficult or high-risk",
                text,
                relative_path,
            )

    def test_detailed_surfaces_forbid_model_inheritance(self) -> None:
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertRegex(
                text,
                r"(never rely on model inheritance|do not use `inherit`)",
                relative_path,
            )

    def test_detailed_surfaces_route_built_in_agents_to_sonnet(self) -> None:
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn(
                "pass `sonnet` explicitly when dispatching built-in agents",
                text,
                relative_path,
            )

    def test_detailed_surfaces_keep_the_subagent_model_override_unset(self) -> None:
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn("claude_code_subagent_model", text, relative_path)
            self.assertIn("unset", text, relative_path)

    def test_specialist_contracts_override_the_generic_packet(self) -> None:
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn("execution brief", text, relative_path)
            self.assertIn("compact report", text, relative_path)
            self.assertIn("ready-to-use artifact", text, relative_path)
            self.assertIn(
                "request the generic packet from any worker without a stronger "
                "terminal contract",
                text,
                relative_path,
            )

    def test_economics_never_overrides_the_mandatory_prose_route(self) -> None:
        for relative_path in ("prompts/controller.md", "policy/codex-global.md"):
            text = self.surface(relative_path)
            self.assertIn("never overrides a mandatory route", text, relative_path)

    def test_codex_contract_mirrors_the_claude_delegation_rules(self) -> None:
        text = self.surface("policy/codex-global.md")
        self.assertIn("execution brief", text)
        self.assertIn("compact report", text)
        self.assertIn("ready-to-use artifact", text)
        self.assertIn(
            "request the generic packet from any worker without a stronger "
            "terminal contract",
            text,
        )
        self.assertIn("automatically spawn `alan_wake`", text)
        self.assertIn('fork_turns = "none"', text)

    def test_claude_surfaces_govern_peer_session_messaging(self) -> None:
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn("listagents", text.replace("`", ""), relative_path)
            self.assertIn("sendmessage", text.replace("`", ""), relative_path)
            self.assertIn("evidence, not authority", text, relative_path)
        for relative_path in (
            "prompts/controller.md",
            "policy/claude-orchestration.md",
            "plugins/shared-agents/skills/shared-agents/SKILL.md",
        ):
            text = self.surface(relative_path)
            self.assertRegex(
                text, r"(not user consent|never user consent)", relative_path
            )
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn("delivery is not guaranteed", text, relative_path)
        policy = self.surface("policy/claude-orchestration.md")
        self.assertIn("crosssessioninbound", policy.replace("`", ""))
        codex = self.surface("policy/codex-global.md")
        self.assertNotIn("sendmessage", codex.replace("`", ""))

    def test_worker_catalog_pins_cheaper_claude_models(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        for agent in catalog:
            if agent["id"] == "controller":
                continue
            self.assertEqual(agent["claude"]["model"], "sonnet", agent["id"])


class ManagedBlocks(unittest.TestCase):
    def test_sync_is_idempotent_and_preserves_human_text(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AGENTS.md"
            path.write_text("# Human rules\n", encoding="utf-8")
            self.assertTrue(manage.sync_managed_block(path, "# Controller\n\nPolicy"))
            first = path.read_text(encoding="utf-8")
            self.assertFalse(manage.sync_managed_block(path, "# Controller\n\nPolicy"))
            self.assertEqual(path.read_text(encoding="utf-8"), first)
            self.assertIn("# Human rules", first)

    def test_sync_updates_only_the_managed_block(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "CLAUDE.md"
            manage.sync_managed_block(path, "old")
            manage.sync_managed_block(path, "new")
            text = path.read_text(encoding="utf-8")
            self.assertIn("new", text)
            self.assertNotIn("old", text)
            self.assertEqual(text.count(manage.START), 1)

    def test_incomplete_markers_are_refused(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AGENTS.md"
            path.write_text(f"{manage.START}\nbroken\n", encoding="utf-8")
            with self.assertRaisesRegex(manage.Problem, "incomplete"):
                manage.sync_managed_block(path, "new")

    def test_duplicate_managed_blocks_are_refused(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AGENTS.md"
            block = manage.render_managed("policy")
            path.write_text(f"{block}\n\n{block}\n", encoding="utf-8")
            with self.assertRaisesRegex(manage.Problem, "multiple"):
                manage.sync_managed_block(path, "new")
            with self.assertRaisesRegex(manage.Problem, "multiple"):
                manage.remove_managed_block(path)


class Symlinks(unittest.TestCase):
    def test_conflicting_file_is_backed_up_before_linking(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.toml"
            target = root / "agents" / "source.toml"
            source.write_text("name = 'source'\n", encoding="utf-8")
            target.parent.mkdir()
            target.write_text("name = 'old'\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups")
            self.assertTrue(manage.ensure_symlink(source, target, backups))
            self.assertEqual(target.resolve(), source.resolve())
            self.assertEqual(len(backups.created), 1)
            self.assertIn("name = 'old'", backups.created[0].read_text(encoding="utf-8"))

    def test_install_uninstall_round_trip_restores_claude_state(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            claude_settings = root / ".claude" / "settings.json"
            claude_settings.parent.mkdir(parents=True)
            claude_settings.write_text(
                json.dumps({"agent": "legacy", "theme": "dark"}) + "\n",
                encoding="utf-8",
            )
            claude_standalone = root / ".claude" / "agents"
            claude_standalone.mkdir(parents=True)
            legacy_controller = claude_standalone / "controller.md"
            legacy_controller.write_text("legacy controller\n", encoding="utf-8")
            replacements = {
                "CODEX_TARGET": root / ".codex" / "agents",
                "CODEX_CONTROLLER_TARGET": root / ".codex" / "controller.config.toml",
                "CLAUDE_STANDALONE": claude_standalone,
                "CLAUDE_RULE": root / ".claude" / "rules" / "orchestration.md",
                "CLAUDE_GLOBAL": root / ".claude" / "CLAUDE.md",
                "CODEX_GLOBAL": root / ".codex" / "AGENTS.md",
                "CLAUDE_SETTINGS": claude_settings,
                "STATE_FILE": root / ".config" / "shared-agents" / "install-state.json",
                "BACKUP_ROOT": root / ".config" / "shared-agents" / "backups",
            }
            backups = manage.BackupStore(replacements["BACKUP_ROOT"] / "install")
            with mock.patch.multiple(manage, **replacements, create=True), mock.patch.object(
                manage.shutil, "which", return_value=None
            ):
                manage.install_native_files(backups)
                installed = json.loads(claude_settings.read_text(encoding="utf-8"))
                self.assertEqual(installed["agent"], "controller")
                self.assertFalse(legacy_controller.exists())

                with redirect_stdout(StringIO()):
                    manage.cmd_uninstall(SimpleNamespace())

            restored = json.loads(claude_settings.read_text(encoding="utf-8"))
            self.assertEqual(restored, {"agent": "legacy", "theme": "dark"})
            self.assertEqual(legacy_controller.read_text(encoding="utf-8"), "legacy controller\n")

    def test_install_adopts_retired_agent_backup_from_older_installer(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            claude_settings = root / ".claude" / "settings.json"
            claude_settings.parent.mkdir(parents=True)
            claude_settings.write_text('{"agent": "controller"}\n', encoding="utf-8")
            claude_standalone = root / ".claude" / "agents"
            legacy_controller = claude_standalone / "controller.md"
            backup_root = root / ".config" / "shared-agents" / "backups"
            prior_backups = manage.BackupStore(backup_root / "older")
            preserved = prior_backups.destination(legacy_controller)
            preserved.parent.mkdir(parents=True)
            preserved.write_text("legacy controller\n", encoding="utf-8")
            replacements = {
                "CODEX_TARGET": root / ".codex" / "agents",
                "CODEX_CONTROLLER_TARGET": root / ".codex" / "controller.config.toml",
                "CLAUDE_STANDALONE": claude_standalone,
                "CLAUDE_RULE": root / ".claude" / "rules" / "orchestration.md",
                "CLAUDE_GLOBAL": root / ".claude" / "CLAUDE.md",
                "CODEX_GLOBAL": root / ".codex" / "AGENTS.md",
                "CLAUDE_SETTINGS": claude_settings,
                "STATE_FILE": root / ".config" / "shared-agents" / "install-state.json",
                "BACKUP_ROOT": backup_root,
            }
            with mock.patch.multiple(manage, **replacements), mock.patch.object(
                manage.shutil, "which", return_value=None
            ):
                manage.install_native_files(manage.BackupStore(backup_root / "new"))
                with redirect_stdout(StringIO()):
                    manage.cmd_uninstall(SimpleNamespace())

            self.assertTrue(legacy_controller.is_file(), "older installer backup was not adopted")
            self.assertEqual(legacy_controller.read_text(encoding="utf-8"), "legacy controller\n")

    def test_install_adopts_prior_agent_setting_from_older_installer(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            claude_settings = root / ".claude" / "settings.json"
            claude_settings.parent.mkdir(parents=True)
            claude_settings.write_text(
                '{"agent": "controller", "theme": "current"}\n', encoding="utf-8"
            )
            backup_root = root / ".config" / "shared-agents" / "backups"
            prior_backups = manage.BackupStore(backup_root / "older")
            preserved = prior_backups.destination(claude_settings)
            preserved.parent.mkdir(parents=True)
            preserved.write_text(
                '{"agent": "legacy", "theme": "old"}\n', encoding="utf-8"
            )
            replacements = {
                "CODEX_TARGET": root / ".codex" / "agents",
                "CODEX_CONTROLLER_TARGET": root / ".codex" / "controller.config.toml",
                "CLAUDE_STANDALONE": root / ".claude" / "agents",
                "CLAUDE_RULE": root / ".claude" / "rules" / "orchestration.md",
                "CLAUDE_GLOBAL": root / ".claude" / "CLAUDE.md",
                "CODEX_GLOBAL": root / ".codex" / "AGENTS.md",
                "CLAUDE_SETTINGS": claude_settings,
                "STATE_FILE": root / ".config" / "shared-agents" / "install-state.json",
                "BACKUP_ROOT": backup_root,
            }
            with mock.patch.multiple(manage, **replacements), mock.patch.object(
                manage.shutil, "which", return_value=None
            ):
                manage.install_native_files(manage.BackupStore(backup_root / "new"))
                with redirect_stdout(StringIO()):
                    manage.cmd_uninstall(SimpleNamespace())

            restored = json.loads(claude_settings.read_text(encoding="utf-8"))
            self.assertEqual(restored, {"agent": "legacy", "theme": "current"})

    def test_install_adopts_absent_agent_setting_from_older_installer(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            claude_settings = root / ".claude" / "settings.json"
            claude_settings.parent.mkdir(parents=True)
            claude_settings.write_text(
                '{"agent": "controller", "theme": "current"}\n', encoding="utf-8"
            )
            backup_root = root / ".config" / "shared-agents" / "backups"
            prior_backups = manage.BackupStore(backup_root / "older")
            preserved = prior_backups.destination(claude_settings)
            preserved.parent.mkdir(parents=True)
            preserved.write_text('{"theme": "old"}\n', encoding="utf-8")
            replacements = {
                "CODEX_TARGET": root / ".codex" / "agents",
                "CODEX_CONTROLLER_TARGET": root / ".codex" / "controller.config.toml",
                "CLAUDE_STANDALONE": root / ".claude" / "agents",
                "CLAUDE_RULE": root / ".claude" / "rules" / "orchestration.md",
                "CLAUDE_GLOBAL": root / ".claude" / "CLAUDE.md",
                "CODEX_GLOBAL": root / ".codex" / "AGENTS.md",
                "CLAUDE_SETTINGS": claude_settings,
                "STATE_FILE": root / ".config" / "shared-agents" / "install-state.json",
                "BACKUP_ROOT": backup_root,
            }
            with mock.patch.multiple(manage, **replacements), mock.patch.object(
                manage.shutil, "which", return_value=None
            ):
                manage.install_native_files(manage.BackupStore(backup_root / "new"))
                with redirect_stdout(StringIO()):
                    manage.cmd_uninstall(SimpleNamespace())

            restored = json.loads(claude_settings.read_text(encoding="utf-8"))
            self.assertEqual(restored, {"theme": "current"})


class Package(unittest.TestCase):
    def test_package_validation_passes(self) -> None:
        self.assertEqual(manage.package_problems(), [])

    def test_package_has_no_fish_integration(self) -> None:
        self.assertFalse((ROOT / "shell" / "fish" / "shared-agents.fish").exists())
        for relative_path in (
            "scripts/manage.py",
            "README.md",
            "ARCHITECTURE.md",
            "policy/codex-global.md",
            "codex/controller.config.toml",
        ):
            content = (ROOT / relative_path).read_text(encoding="utf-8")
            self.assertNotIn("codexd", content, relative_path)
            self.assertNotIn("FISH_", content, relative_path)

    def test_codex_named_agent_route_uses_a_non_inheriting_fork(self) -> None:
        policy = (ROOT / "policy" / "codex-global.md").read_text(encoding="utf-8")
        skill = (
            ROOT / "plugins" / "shared-agents" / "skills" / "shared-agents" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn('fork_turns = "none"', policy)
        self.assertIn('fork_turns = "none"', skill)

    def test_alan_wake_writes_destination_native_slack_mrkdwn(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn("`<url|label>`", normalized)
        self.assertIn("`[text](url)` does not render in Slack", normalized)
        self.assertIn("named link", normalized)
        self.assertIn("never invent a URL", normalized)
        self.assertIn("bold headline", normalized)
        self.assertIn("identifier as the label", normalized)

    def test_alan_wake_is_a_terminal_writer(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        policy = (ROOT / "policy" / "codex-global.md").read_text(encoding="utf-8")
        self.assertIn("not spawn, delegate to, or ask for another writing agent", prompt)
        self.assertIn("already `alan_wake`", policy)

    def test_check_command_runs_unit_suite(self) -> None:
        if os.environ.get("SHARED_AGENTS_CHECK_CHILD") == "1":
            return
        env = {**os.environ, "SHARED_AGENTS_CHECK_CHILD": "1"}
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "manage.py"), "check"],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = result.stdout + result.stderr
        self.assertRegex(output, r"Ran \d+ tests? in")
        self.assertIn("OK", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)

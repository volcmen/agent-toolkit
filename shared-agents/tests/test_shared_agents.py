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
        self.assertEqual(controller["claude"]["effort"], "medium")
        rendered = (ROOT / "claude" / "agents" / "controller.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("\neffort: medium\n", rendered)
        for agent in catalog:
            if agent.get("codex"):
                self.assertTrue(agent["codex"]["model"].startswith("gpt-"))

    def test_empty_claude_name_is_rejected(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt = root / "prompt.md"
            prompt.write_text("Prompt\n", encoding="utf-8")
            catalog = root / "agents.json"
            catalog.write_text(
                json.dumps(
                    {
                        "agents": [
                            {
                                "id": "explorer",
                                "description": "Explore repositories",
                                "prompt": str(prompt),
                                "claude": {"name": ""},
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(render, "CATALOG", catalog):
                with self.assertRaisesRegex(
                    render.Problem, "claude.name must be a non-empty string"
                ):
                    render.load_catalog()

    def test_duplicate_claude_names_are_rejected(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt = root / "prompt.md"
            prompt.write_text("Prompt\n", encoding="utf-8")
            catalog = root / "agents.json"
            catalog.write_text(
                json.dumps(
                    {
                        "agents": [
                            {
                                "id": agent_id,
                                "description": f"{agent_id} agent",
                                "prompt": str(prompt),
                                "claude": {"name": "Explore"},
                            }
                            for agent_id in ("first", "second")
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(render, "CATALOG", catalog):
                with self.assertRaisesRegex(
                    render.Problem, "duplicate Claude name Explore"
                ):
                    render.load_catalog()

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

    def test_claude_agents_do_not_use_unsupported_permission_mode(self) -> None:
        for path in (ROOT / "claude" / "agents").glob("*.md"):
            self.assertNotIn("permissionMode:", path.read_text(encoding="utf-8"), str(path))

    def test_claude_agents_render_to_standalone_source_directory(self) -> None:
        expected = {"controller.md", "task-analyst.md", "Explore.md", "alan-wake.md"}
        actual = {path.name for path in (ROOT / "claude" / "agents").glob("*.md")}
        self.assertEqual(actual, expected)

    def test_explore_overrides_the_builtin_with_a_pinned_model(self) -> None:
        text = (ROOT / "claude" / "agents" / "Explore.md").read_text(encoding="utf-8")
        self.assertIn("\nname: Explore\n", text)
        self.assertIn("\nmodel: sonnet\n", text)
        self.assertIn("\neffort: medium\n", text)
        self.assertIn("tools: Read, Grep, Glob, LSP", text)
        self.assertIn("disallowedTools: Write, Edit, NotebookEdit", text)
        for thoroughness in ("quick", "medium", "very thorough"):
            self.assertIn(thoroughness, text.lower())

    def test_read_only_claude_agents_do_not_receive_shell_access(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        for agent in catalog:
            claude = agent.get("claude", {})
            if not set(claude.get("disallowedTools", [])) & {"Write", "Edit", "NotebookEdit"}:
                continue
            self.assertNotIn("Bash", claude.get("tools", []), agent["id"])


class ClaudeRoutingSurfaces(unittest.TestCase):
    SURFACES = ("prompts/controller.md",)
    DETAILED_SURFACES = ("prompts/controller.md",)

    def surface(self, relative_path: str) -> str:
        text = (ROOT / relative_path).read_text(encoding="utf-8")
        return " ".join(text.split()).lower()

    def test_controller_uses_bare_standalone_agent_names(self) -> None:
        text = (ROOT / "prompts" / "controller.md").read_text(encoding="utf-8")
        self.assertIn("`Explore` on Sonnet", text)
        self.assertIn("`task-analyst` on Sonnet", text)
        self.assertIn("`alan-wake` on Opus", text)
        self.assertNotIn("shared-agents:", text)

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

    def test_specialists_have_distinct_terminal_contracts(self) -> None:
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn("execution brief", text, relative_path)
            self.assertIn("compact report", text, relative_path)
            self.assertIn("ready-to-use artifact", text, relative_path)
            self.assertNotIn("generic packet", text, relative_path)

    def test_controller_keeps_the_mandatory_prose_route(self) -> None:
        text = self.surface("prompts/controller.md")
        self.assertIn("automatically delegate its final draft", text)
        self.assertIn("`alan-wake` on opus", text)
        self.assertIn("drafting never authorizes sending or publishing", text)

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
        for relative_path in ("prompts/controller.md",):
            text = self.surface(relative_path)
            self.assertRegex(
                text, r"(not user consent|never user consent)", relative_path
            )
        for relative_path in self.DETAILED_SURFACES:
            text = self.surface(relative_path)
            self.assertIn("delivery is not guaranteed", text, relative_path)
        codex = self.surface("policy/codex-global.md")
        self.assertNotIn("sendmessage", codex.replace("`", ""))

    def test_worker_catalog_pins_expected_claude_models(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        expected = {
            "controller": "fable",
            "alan-wake": "opus",
            "repo-explorer": "sonnet",
            "task-analyst": "sonnet",
        }
        for agent in catalog:
            self.assertEqual(agent["claude"]["model"], expected[agent["id"]], agent["id"])


class StandaloneCopies(unittest.TestCase):
    def test_install_copies_regular_files_and_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            (source / "controller.md").write_text("controller\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups" / "first")
            with mock.patch.multiple(
                manage,
                CLAUDE_SOURCE=source,
                CLAUDE_TARGET=target,
                create=True,
            ):
                changed = manage.install_claude_agents(backups)
                self.assertEqual(changed, [target / "controller.md"])
                self.assertFalse((target / "controller.md").is_symlink())
                self.assertEqual((target / "controller.md").read_text(), "controller\n")
                self.assertEqual(manage.install_claude_agents(backups), [])

    def test_idempotent_install_reports_unchanged_agent_files(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "controller.md").write_text("controller\n", encoding="utf-8")
            (target / "controller.md").write_text("controller\n", encoding="utf-8")
            output = StringIO()
            with (
                mock.patch.multiple(
                    manage,
                    CLAUDE_SOURCE=source,
                    CLAUDE_TARGET=target,
                    BACKUP_ROOT=root / "backups",
                ),
                mock.patch.object(manage, "run"),
                mock.patch.object(manage, "package_problems", return_value=[]),
                mock.patch.object(manage, "cmd_status", return_value=0),
                redirect_stdout(output),
            ):
                self.assertEqual(manage.cmd_install(unittest.mock.Mock()), 0)
            self.assertIn("unchanged 1 agent file(s)", output.getvalue())

    def test_non_object_claude_settings_are_reported_as_invalid(self) -> None:
        with TemporaryDirectory() as tmp:
            settings_path = Path(tmp) / "settings.json"
            for value in (None, "controller", ["controller"], 42, True):
                with self.subTest(value=value):
                    settings_path.write_text(json.dumps(value), encoding="utf-8")
                    with (
                        mock.patch.object(manage, "CLAUDE_SETTINGS", settings_path),
                        mock.patch.object(manage, "claude_agent_sources", return_value=[]),
                        mock.patch.object(manage, "package_problems", return_value=[]),
                    ):
                        self.assertEqual(
                            manage.live_problems(),
                            [f"{settings_path}: must contain a JSON object"],
                        )

    def test_install_backs_up_a_conflicting_target(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "Explore.md").write_text("new\n", encoding="utf-8")
            (target / "Explore.md").write_text("personal\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups" / "install")
            with mock.patch.multiple(manage, CLAUDE_SOURCE=source, CLAUDE_TARGET=target):
                manage.install_claude_agents(backups)
            self.assertEqual((target / "Explore.md").read_text(), "new\n")
            self.assertEqual(len(backups.created), 1)
            self.assertEqual(backups.created[0].read_text(), "personal\n")

    def test_uninstall_preserves_a_user_modified_copy(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "controller.md").write_text("managed\n", encoding="utf-8")
            (target / "controller.md").write_text("user changed\n", encoding="utf-8")
            with mock.patch.multiple(manage, CLAUDE_SOURCE=source, CLAUDE_TARGET=target):
                self.assertEqual(manage.uninstall_claude_agents(), [])
            self.assertTrue((target / "controller.md").exists())


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
        self.assertIn('fork_turns = "none"', policy)

    def test_shared_agents_is_not_a_workspace_plugin(self) -> None:
        catalog = json.loads((ROOT.parent / "plugins.json").read_text(encoding="utf-8"))
        names = {entry["name"] for entry in catalog["plugins"]}
        self.assertNotIn("shared-agents", names)
        self.assertFalse((ROOT / "plugins" / "shared-agents").exists())

    def test_claude_routing_has_one_canonical_surface(self) -> None:
        self.assertFalse((ROOT / "policy" / "claude-global.md").exists())
        self.assertFalse((ROOT / "policy" / "claude-orchestration.md").exists())
        controller = (ROOT / "prompts" / "controller.md").read_text(encoding="utf-8")
        self.assertIn("`Explore` on Sonnet", controller)
        self.assertNotIn("shared-agents:", controller)

    def test_routing_evals_live_outside_the_plugin_tree(self) -> None:
        path = ROOT / "evals" / "controller-routing.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["agent_name"], "controller")
        by_id = {case["id"]: case for case in payload["evals"]}
        self.assertEqual(set(by_id), {1, 2, 3, 4, 5})
        alan_case = " ".join(
            [
                by_id[4]["expected_output"],
                *by_id[4]["expectations"],
            ]
        )
        self.assertIn("alan-wake", alan_case)
        self.assertIn("Opus", alan_case)

    def test_agent_catalog_has_focused_routing_descriptions(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))
        by_id = {agent["id"]: agent for agent in catalog["agents"]}
        expected = {
            "controller": (
                "Main-thread Fable technical lead for repository work. Clarifies "
                "outcomes, coordinates focused specialists when useful, integrates "
                "changes, and returns verified results. Run as the primary agent; "
                "never dispatch it as a worker."
            ),
            "alan-wake": (
                "Final-draft specialist for developer and workplace writing. Use for "
                "Slack, issues, PR/MR text, reviews, email, docs, release notes, status "
                "updates, decisions, requests, and handoffs. Preserves facts, matches "
                "destination formatting, and returns ready-to-use prose. Never "
                "implements or publishes."
            ),
            "repo-explorer": (
                "Read-only repository explorer for one bounded question: file and "
                "symbol discovery, behavior and dependency tracing, architecture, "
                "tests, or implementation context. Supports quick, medium, and very "
                "thorough depth. Never edits."
            ),
            "task-analyst": (
                "Read-only task shaper for vague, symptom-based, conflicting, risky, "
                "or solution-first requests. Establishes evidence, scope, acceptance "
                "criteria, and the one decision needed before work. Never edits."
            ),
        }
        for agent_id, description in expected.items():
            self.assertEqual(by_id[agent_id]["description"], description)

    def test_alan_wake_uses_judgment_not_rigid_prose_limits(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn("Use plain, familiar words", normalized)
        self.assertIn(
            "A missing URL must not block an otherwise correct draft", normalized
        )
        self.assertIn("Return one ready-to-use artifact", normalized)
        self.assertNotIn("a bare name is a defect", normalized)
        self.assertNotIn("unfinished text until it is clickable", normalized)
        self.assertNotRegex(normalized, r"default to one to \d+")

    def test_each_specialist_has_one_terminal_contract(self) -> None:
        alan = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        analyst = (ROOT / "prompts" / "task-analyst.md").read_text(encoding="utf-8")
        explorer = (ROOT / "prompts" / "repo-explorer.md").read_text(encoding="utf-8")
        self.assertIn("Return one ready-to-use artifact", alan)
        self.assertIn("Return a concise execution brief", analyst)
        self.assertIn("Return a compact report", explorer)
        self.assertNotIn("ready-to-use artifact", analyst)
        self.assertNotIn("execution brief", explorer)

    def test_alan_wake_consults_official_destination_references(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        sources = (ROOT / "docs" / "sources.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        urls = (
            "https://docs.slack.dev/messaging/formatting-message-text/",
            "https://developers.notion.com/reference/block",
            "https://developers.notion.com/guides/data-apis/working-with-markdown-content",
            "https://www.notion.com/help/what-is-a-block",
            "https://support.atlassian.com/confluence-cloud/docs/format-text/",
            "https://support.atlassian.com/confluence-cloud/docs/available-markdown-commands/",
            "https://support.atlassian.com/confluence-cloud/docs/insert-confluence-wiki-markup/",
            "https://docs.gitlab.com/user/markdown/",
        )
        self.assertIn("consult the applicable official reference", normalized)
        self.assertIn("before finalizing", normalized)
        self.assertIn("temporarily unavailable", normalized)
        for url in urls:
            with self.subTest(url=url):
                self.assertIn(url, prompt)
                self.assertIn(url, sources)

    def test_alan_wake_uses_destination_native_format_contracts(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn("Notion-flavored Markdown", normalized)
        self.assertIn("ordinary Markdown does not represent every Notion block", normalized)
        self.assertIn("legacy wiki markup", normalized)
        self.assertIn("current Confluence editor", normalized)
        self.assertIn("GitLab Flavored Markdown", normalized)
        self.assertIn("titles do not support full GitLab Flavored Markdown", normalized)

    def test_alan_wake_writes_destination_native_slack_mrkdwn(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn("`<url|label>`", normalized)
        self.assertIn("`[text](url)` does not render in raw Slack messages", normalized)
        self.assertIn("active tool contract explicitly documents", normalized)
        self.assertNotIn("Slack MCP draft/send tools", prompt)
        self.assertIn("named link", normalized)
        self.assertIn("never invent a URL", normalized)
        self.assertIn("lead with the current state, result, or request", normalized)
        self.assertIn("Use verified, descriptive link labels", normalized)

    def test_alan_wake_is_a_terminal_writer(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        policy = (ROOT / "policy" / "codex-global.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn(
            "not spawn, delegate to, or ask for another writing agent", normalized
        )
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

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

ROOT = Path(__file__).resolve().parents[1] / "agents"
ENGINEERING = ROOT.parent / "skills" / "engineering" / "SKILL.md"
CORE = ROOT.parent / "CLAUDE.md"
DELIVERY = ROOT.parent / "skills" / "engineering" / "references" / "delivery.md"
sys.path.insert(0, str(ROOT.parent / "scripts"))

import manage  # noqa: E402
import render  # noqa: E402


class Rendering(unittest.TestCase):
    def test_live_provider_files_match_the_shared_sources(self) -> None:
        self.assertEqual(render.render(check=True), [])

    def test_agent_without_claude_settings_is_rejected(self) -> None:
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
                                "id": "orphan",
                                "description": "Renders nowhere",
                                "prompt": str(prompt),
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(render, "CATALOG", catalog):
                with self.assertRaisesRegex(
                    render.Problem, "orphan: claude settings are required"
                ):
                    render.load_catalog()

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

    def test_no_rendered_agent_declares_a_permission_mode(self) -> None:
        for path in (ROOT / "rendered").glob("*.md"):
            self.assertNotIn("permissionMode:", path.read_text(encoding="utf-8"), str(path))

    def test_renderer_emits_optional_scalars(self) -> None:
        text = (ROOT / "rendered" / "worker.md").read_text(encoding="utf-8")
        frontmatter = text.split("---")[1]
        self.assertIn("\nmaxTurns: 100\n", frontmatter)
        self.assertIn("\ntools: Read, Grep, Glob, LSP, Edit, Write, Bash\n", frontmatter)
        for forbidden in ("memory:", "skills:", "color:", "superpowers"):
            self.assertNotIn(forbidden, text)

    def test_rendered_agents_stay_within_size_budgets(self) -> None:
        budgets = {"worker.md": 1800, "reviewer.md": 1400, "Explore.md": 1600}
        for name, limit in budgets.items():
            self.assertLessEqual((ROOT / "rendered" / name).stat().st_size, limit, name)

    def test_rendered_agents_do_not_restate_core_rules(self) -> None:
        sentinels = ("never claim", "smallest coherent", "ticket key", "sibling", "session link", "superpowers")
        for path in (ROOT / "rendered").glob("*.md"):
            text = path.read_text(encoding="utf-8").lower()
            for sentinel in sentinels:
                self.assertNotIn(sentinel, text, f"{path.name}: {sentinel!r}")

    def test_catalog_is_three_read_write_review_agents(self) -> None:
        self.assertEqual(
            {path.name for path in (ROOT / "rendered").glob("*.md")},
            {"Explore.md", "worker.md", "reviewer.md"},
        )
        self.assertEqual(
            {path.name for path in (ROOT / "prompts").glob("*.md")},
            {"repo-explorer.md", "worker.md", "reviewer.md"},
        )

    def test_explore_overrides_the_builtin_with_a_pinned_model(self) -> None:
        text = (ROOT / "rendered" / "Explore.md").read_text(encoding="utf-8")
        self.assertIn("\nname: Explore\n", text)
        self.assertIn("\nmodel: sonnet\n", text)
        self.assertIn("\neffort: medium\n", text)
        self.assertIn("tools: Read, Grep, Glob, LSP", text)
        self.assertIn("disallowedTools: Write, Edit, NotebookEdit", text)
        for thoroughness in ("quick", "medium", "very thorough"):
            self.assertIn(thoroughness, text.lower())
        self.assertNotIn("recent history", text)
        self.assertNotIn("recent changes", text)
        self.assertIn("git history and runtime behavior are out of reach", text)

    def test_worker_is_a_scoped_sonnet_replacement_for_general_purpose(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        worker = next(agent for agent in catalog if agent["id"] == "worker")
        self.assertIn("prefer it over general-purpose", worker["description"])
        self.assertEqual(worker["claude"]["model"], "sonnet")
        self.assertEqual(worker["claude"]["maxTurns"], 100)
        self.assertEqual(
            worker["claude"]["tools"],
            ["Read", "Grep", "Glob", "LSP", "Edit", "Write", "Bash"],
        )
        for absent in ("memory", "skills", "permissionMode", "disallowedTools"):
            self.assertNotIn(absent, worker["claude"])
        prompt = (ROOT / "prompts" / "worker.md").read_text(encoding="utf-8")
        self.assertIn("~/.claude/skills/engineering/references/minimalism.md", prompt)
        self.assertIn("DONE, PARTIAL, or BLOCKED", prompt)
        self.assertIn("exactly as\nobserved", prompt)
        self.assertIn("No commits, pushes", prompt)

    def test_specialists_declare_their_tool_posture_explicitly(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        by_id = {agent["id"]: agent["claude"] for agent in catalog}
        self.assertNotIn("Bash", by_id["repo-explorer"]["tools"])
        self.assertEqual(set(by_id["repo-explorer"]["disallowedTools"]), {"Write", "Edit", "NotebookEdit"})
        self.assertEqual(by_id["reviewer"]["tools"], ["Bash", "Read", "Grep", "Glob"])
        self.assertEqual(by_id["reviewer"]["maxTurns"], 20)
        for agent in by_id.values():
            for absent in ("memory", "skills", "permissionMode"):
                self.assertNotIn(absent, agent)
            for tool in ("Agent", "WebFetch", "WebSearch", "Skill"):
                self.assertNotIn(tool, agent["tools"])

    def test_reviewer_is_a_bounded_read_only_opus_5_5_reviewer(self) -> None:
        rendered = (ROOT / "rendered" / "reviewer.md").read_text(encoding="utf-8")
        self.assertIn("\nmodel: claude-opus-5-5\n", rendered)
        self.assertIn("\neffort: high\n", rendered)
        self.assertIn("\nmaxTurns: 20\n", rendered)
        self.assertIn("\ntools: Bash, Read, Grep, Glob\n", rendered)
        self.assertIn("Never install a dependency, create an environment, or build", rendered)
        self.assertIn("No source edits,\nGit mutations, external writes, or agents", rendered)
        self.assertIn("treat each as a\nclaim and confirm or refute it with evidence", rendered)
        skill = (ROOT.parent / "skills" / "mr-preflight" / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("agent:", skill.split("---")[1])
        self.assertNotIn("context:", skill.split("---")[1])
        self.assertIn("independent `reviewer` run", skill)
        for retired in ("`gate`", "mr-review-fixer"):
            self.assertNotIn(retired, skill)


class ClaudeRoutingSurfaces(unittest.TestCase):
    def surface(self, path: Path) -> str:
        return " ".join(path.read_text(encoding="utf-8").split()).lower()

    def test_delegation_names_bare_standalone_agents(self) -> None:
        text = " ".join(ENGINEERING.read_text(encoding="utf-8").split())
        self.assertIn("`Explore` on Sonnet", text)
        self.assertIn("`worker` on Sonnet", text)
        self.assertIn("`reviewer` on Opus 5.5", text)
        self.assertIn("`general-purpose` only when a slice needs web, MCP, or skills", text)
        for retired in ("alan", "mr-review-fixer", "`gate`", "controller", "shared-agents:"):
            self.assertNotIn(retired, text.lower() if retired == "alan" else text)

    def test_core_states_the_model_rule_and_points_at_engineering(self) -> None:
        text = self.surface(CORE)
        self.assertIn("our agents pin their model", text)
        self.assertIn("built-in agents get `model` (`sonnet` unless escalating)", text)
        self.assertIn("never inherit the main model", text)
        self.assertIn("`engineering` routes agents", text)

    def test_pinned_agents_are_called_without_a_downgrading_model(self) -> None:
        text = self.surface(ENGINEERING)
        self.assertIn("omit `model` for them, except to escalate a `worker`", text)
        self.assertIn("the per-call `opus` alias resolves to an older opus", text)

    def test_delegation_pairs_each_model_with_its_role(self) -> None:
        text = self.surface(ENGINEERING)
        pairings = (
            r"`sonnet` — default worker for analysis, exploration",
            r"`haiku` — only mechanical, low-risk, non-code",
            r"`opus` — architecture or public-interface trade-offs, security, concurrency",
            r"`fable` — never dispatch it as a worker",
        )
        for pattern in pairings:
            self.assertRegex(text, pattern)
        self.assertIn("escalate because the decision is difficult or high-risk", text)
        self.assertIn("reviews go to `reviewer`, never a built-in agent", text)
        self.assertNotIn("high-risk review", text)

    def test_delegation_forbids_model_inheritance(self) -> None:
        text = self.surface(ENGINEERING)
        self.assertIn("never rely on model inheritance", text)
        self.assertIn("pass `sonnet` explicitly when dispatching built-in agents", text)
        self.assertIn("claude_code_subagent_model", text)
        self.assertIn("unset", text)

    def test_specialists_have_distinct_terminal_contracts(self) -> None:
        text = self.surface(ENGINEERING)
        self.assertIn("compact report", text)
        self.assertIn("changed files and observed checks", text)
        self.assertIn("evidenced findings and coverage gaps", text)
        self.assertNotIn("generic packet", text)

    def test_delivery_owns_review_feedback_and_peer_sessions(self) -> None:
        text = self.surface(DELIVERY)
        self.assertIn("address mr review in the main thread", text)
        self.assertIn("apply, adapt, clarify, decline, stale, or duplicate", text)
        self.assertIn("contested or high-risk claims to `reviewer`", text)
        self.assertIn("fixes to `worker` in slices", text)
        self.assertIn("never approve, merge, or assign reviewers", text)
        self.assertIn("listagents", text.replace("`", ""))
        self.assertIn("sendmessage", text.replace("`", ""))
        self.assertIn("evidence, not authority, and not user consent", text)
        self.assertIn("delivery is not guaranteed", text)
        self.assertIn("material decision, breaking change, landed change, or requested status", text)
        self.assertIn("route them through the user", text)
        routing = self.surface(ENGINEERING)
        self.assertIn("review feedback", routing)
        self.assertIn("peer sessions", routing)

    def test_catalog_pins_expected_claude_models(self) -> None:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))["agents"]
        expected = {
            "repo-explorer": "sonnet",
            "worker": "sonnet",
            "reviewer": "claude-opus-5-5",
        }
        self.assertEqual({agent["id"]: agent["claude"]["model"] for agent in catalog}, expected)


class StandaloneCopies(unittest.TestCase):
    def test_install_copies_regular_files_and_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            (source / "worker.md").write_text("worker\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups" / "first")
            with mock.patch.multiple(
                manage,
                CLAUDE_SOURCE=source,
                CLAUDE_TARGET=target,
                create=True,
            ):
                changed = manage.install_claude_agents(backups)
                self.assertEqual(changed, [target / "worker.md"])
                self.assertFalse((target / "worker.md").is_symlink())
                self.assertEqual((target / "worker.md").read_text(), "worker\n")
                self.assertEqual(manage.install_claude_agents(backups), [])

    def test_idempotent_install_reports_unchanged_agent_files(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "worker.md").write_text("worker\n", encoding="utf-8")
            (target / "worker.md").write_text("worker\n", encoding="utf-8")
            output = StringIO()
            with (
                mock.patch.multiple(
                    manage,
                    CLAUDE_SOURCE=source,
                    CLAUDE_TARGET=target,
                    BACKUP_ROOT=root / "backups",
                    CLAUDE_SETTINGS=root / "settings.json",
                ),
                mock.patch.object(manage, "run"),
                mock.patch.object(manage, "managed_links", return_value=[]),
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
                        mock.patch.object(manage, "managed_links", return_value=[]),
                        mock.patch.object(manage, "reference_edges", return_value=[]),
                        mock.patch.object(manage, "external_caller_files", return_value=[]),
                        mock.patch.object(manage, "claude_agent_sources", return_value=[]),
                        mock.patch.object(manage, "package_problems", return_value=[]),
                    ):
                        self.assertEqual(
                            manage.live_problems(),
                            [f"{settings_path}: must contain a JSON object"],
                        )

    def test_install_backs_up_a_hand_maintained_agent_before_replacing_it(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "reviewer.md").write_text("rendered\n", encoding="utf-8")
            (target / "reviewer.md").write_text("hand-maintained\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups" / "install")
            with mock.patch.multiple(manage, CLAUDE_SOURCE=source, CLAUDE_TARGET=target):
                manage.install_claude_agents(backups)
            self.assertEqual((target / "reviewer.md").read_text(), "rendered\n")
            self.assertEqual(len(backups.created), 1)
            self.assertEqual(backups.created[0].read_text(), "hand-maintained\n")

    def test_uninstall_preserves_a_user_modified_copy(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "worker.md").write_text("managed\n", encoding="utf-8")
            (target / "worker.md").write_text("user changed\n", encoding="utf-8")
            with mock.patch.multiple(manage, CLAUDE_SOURCE=source, CLAUDE_TARGET=target):
                self.assertEqual(manage.uninstall_claude_agents(), [])
            self.assertTrue((target / "worker.md").exists())


class Package(unittest.TestCase):
    def test_shared_writer_reference_stays_small_and_owns_publishing(self) -> None:
        contract = ROOT.parent / "skills/engineering/references/writing.md"
        self.assertIn("~/.claude/skills/engineering/references/writing.md", CORE.read_text())
        self.assertIn("Drafting never authorizes sending or publishing.", contract.read_text())
        self.assertLessEqual(contract.stat().st_size, 4500)

    def test_risk_reviewer_reference_resolves_without_preloading_a_fork(self) -> None:
        skill = ROOT.parent / "skills/mr-preflight/SKILL.md"
        self.assertTrue(skill.is_file())
        self.assertIn("~/.claude/skills/mr-preflight/SKILL.md", (ROOT / "prompts/reviewer.md").read_text())
        self.assertLessEqual(skill.stat().st_size, 5000)

    def test_package_validation_passes(self) -> None:
        self.assertEqual(manage.package_problems(), [])

    def test_package_has_no_fish_integration(self) -> None:
        self.assertFalse((ROOT.parent / "shell" / "fish" / "shared-agents.fish").exists())
        for relative_path in (
            "../scripts/manage.py",
            "../README.md",
        ):
            content = (ROOT / relative_path).read_text(encoding="utf-8")
            self.assertNotIn("codexd", content, relative_path)
            self.assertNotIn("FISH_", content, relative_path)

    def test_shared_agents_is_not_a_workspace_plugin(self) -> None:
        catalog = json.loads((ROOT.parents[1] / "plugins.json").read_text(encoding="utf-8"))
        names = {entry["name"] for entry in catalog["plugins"]}
        self.assertNotIn("shared-agents", names)
        self.assertFalse((ROOT.parent / "plugins" / "shared-agents").exists())

    def test_claude_routing_has_one_canonical_surface(self) -> None:
        for retired in ("policy", "codex", "docs/superpowers", "prompts/controller.md"):
            self.assertFalse((ROOT / retired).exists(), retired)
        self.assertIn("`Explore` on Sonnet", ENGINEERING.read_text(encoding="utf-8"))

    def test_routing_evals_cover_each_route(self) -> None:
        payload = json.loads((ROOT / "evals" / "routing.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["agent_name"], "main-thread")
        by_id = {case["id"]: case for case in payload["evals"]}
        self.assertEqual(set(by_id), {1, 2, 3, 4, 5, 6, 7})
        prose_case = " ".join([by_id[4]["expected_output"], *by_id[4]["expectations"]])
        self.assertIn("inline", prose_case)
        self.assertIn("worker", " ".join(by_id[6]["expectations"]))
        self.assertIn("reviewer", " ".join(by_id[7]["expectations"]))
        self.assertIn("without a model argument", " ".join(by_id[6]["expectations"]))
        for case in by_id.values():
            self.assertNotIn("names the model", " ".join(case["expectations"]).lower())

    def test_each_specialist_has_one_terminal_contract(self) -> None:
        explorer = (ROOT / "prompts" / "repo-explorer.md").read_text(encoding="utf-8")
        worker = (ROOT / "prompts" / "worker.md").read_text(encoding="utf-8")
        reviewer = (ROOT / "prompts" / "reviewer.md").read_text(encoding="utf-8")
        self.assertIn("Return a compact report", explorer)
        self.assertIn("Return, usually under 150 words: DONE, PARTIAL, or BLOCKED", " ".join(worker.split()))
        self.assertIn("Return only actionable findings", reviewer)
        for other in (explorer, reviewer):
            self.assertNotIn("DONE, PARTIAL, or BLOCKED", other)
        for other in (worker, reviewer):
            self.assertNotIn("compact report", other)

    def test_brief_contract_survives_compression(self) -> None:
        delegation = " ".join(ENGINEERING.read_text(encoding="utf-8").split())
        self.assertIn("one objective, the relevant paths and constraints, ownership, the expected output, and its verification", delegation)
        self.assertIn("split long work into sequential slices", delegation)

    def test_check_command_runs_unit_suite(self) -> None:
        if os.environ.get("CLAUDE_CORE_CHECK_CHILD") == "1":
            return
        env = {**os.environ, "CLAUDE_CORE_CHECK_CHILD": "1"}
        result = subprocess.run(
            [sys.executable, str(ROOT.parent / "scripts" / "manage.py"), "check"],
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

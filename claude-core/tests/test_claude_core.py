#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import random
import shutil
import string
import subprocess
import sys
import unittest
from contextlib import ExitStack, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import manage  # noqa: E402


def build_fixture(tmp: Path) -> tuple[Path, Path]:
    workspace = tmp / "workspace"
    root = workspace / "repo"
    home = tmp / "home" / ".claude"
    home.mkdir(parents=True)
    for rel in (*manage.MANAGED_FILES, *(rel for rel, _ in manage.EXTERNAL_MANAGED_FILES)):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{rel}\nsee ~/.claude/rules/\n", encoding="utf-8")
    for rel, names in manage.REQUIRED_DIRECTORY_FILES.items():
        base = workspace if rel in manage.WORKSPACE_DIRECTORIES else root
        for name in names:
            path = base / rel / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{rel}/{name}\n", encoding="utf-8")
    for rel, _ in manage.WORKSPACE_MANAGED:
        if rel in manage.WORKSPACE_DIRECTORIES:
            continue
        path = workspace / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{rel}\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text(
        "read `~/.claude/rules/code-style.md` and $HOME/.claude/skills/mr-preflight/failure-modes.md\n",
        encoding="utf-8",
    )
    for rel in manage.EXECUTABLES:
        (root / rel).chmod(0o755)
    (root / "settings").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "settings" / "managed.json", root / "settings" / "managed.json")
    shutil.copytree(ROOT / "agents", root / "agents")
    (root / "scripts").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "scripts" / "render.py", root / "scripts" / "render.py")
    return root, home


def patched(root: Path, home: Path, backups: Path) -> ExitStack:
    stack = ExitStack()
    stack.enter_context(mock.patch.object(manage, "ROOT", root))
    stack.enter_context(mock.patch.object(manage, "REPO_ROOT", root.parent))
    stack.enter_context(mock.patch.object(manage, "HOME", home.parent))
    stack.enter_context(mock.patch.object(manage, "CLAUDE_HOME", home))
    stack.enter_context(mock.patch.object(manage, "MANAGED_SETTINGS_FRAGMENT", root / "settings" / "managed.json"))
    stack.enter_context(mock.patch.object(manage, "BACKUP_ROOT", backups))
    stack.enter_context(mock.patch.object(manage, "CLAUDE_SOURCE", root / "agents" / "rendered"))
    stack.enter_context(mock.patch.object(manage, "CLAUDE_TARGET", home / "agents"))
    stack.enter_context(mock.patch.object(manage, "CLAUDE_SETTINGS", home / "settings.json"))
    return stack


def quiet(handler, *args):
    with redirect_stdout(StringIO()) as output:
        code = handler(*args)
    return code, output.getvalue()


class Package(unittest.TestCase):
    def test_package_validation_passes(self) -> None:
        self.assertEqual(manage.package_problems(), [])

    def test_every_internal_reference_targets_an_existing_managed_path_or_known_container(self) -> None:
        for path, rel in manage.reference_edges():
            origin = f"{path.relative_to(ROOT)} -> ~/.claude/{rel}"
            if rel.endswith("/"):
                self.assertIn(rel.rstrip("/"), manage.MANAGED_CONTAINERS, origin)
            else:
                self.assertTrue(manage.is_managed(rel), origin)
                self.assertTrue(manage.managed_source(rel).exists(), origin)

    def test_reference_edges_cover_the_known_hardcoded_callers(self) -> None:
        edges = {(path.relative_to(ROOT).as_posix(), rel) for path, rel in manage.reference_edges()}
        for expected in (
            ("skills/mr-preflight/SKILL.md", "skills/mr-preflight/preflight-triage.sh"),
            ("skills/mr-preflight/preflight-triage.sh", "skills/mr-preflight/failure-modes.md"),
            ("skills/mr-preflight/preflight-triage.sh", "skills/mr-preflight/harness-delta.py"),
            ("skills/review-retro/SKILL.md", "skills/mr-preflight/failure-modes.md"),
            ("CLAUDE.md", "rules/code-style.md"),
        ):
            self.assertIn(expected, edges)

    def test_executable_assets_keep_their_mode_bits(self) -> None:
        for rel in manage.EXECUTABLES:
            self.assertTrue((ROOT / rel).stat().st_mode & 0o111, rel)

    def test_missing_executable_bit_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (root / "hooks" / "f17-ticket-keys.sh").chmod(0o644)
            with patched(root, home, Path(tmp) / "backups"):
                problems = manage.package_problems()
        self.assertEqual(problems, ["hooks/f17-ticket-keys.sh: must keep its executable bit"])

    def test_unmanaged_file_reference_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (root / "CLAUDE.md").write_text("see ~/.claude/unknown.py\n", encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                problems = manage.package_problems()
        self.assertEqual(problems, ["CLAUDE.md references unmanaged ~/.claude/unknown.py"])

    def test_unknown_directory_reference_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (root / "CLAUDE.md").write_text("see ~/.claude/anything/\n", encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                problems = manage.package_problems()
        self.assertEqual(problems, ["CLAUDE.md references unmanaged ~/.claude/anything/"])

    def test_missing_descendant_of_a_managed_directory_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (root / "CLAUDE.md").write_text("see ~/.claude/skills/mr-preflight/not-there.md\n", encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                problems = manage.package_problems()
        self.assertEqual(
            problems,
            ["CLAUDE.md references ~/.claude/skills/mr-preflight/not-there.md, which does not exist in the repository"],
        )

    def test_managed_inventory_covers_statusline_and_git_guards(self) -> None:
        for rel in ("statusline.py", "keybindings.json"):
            self.assertIn(rel, manage.MANAGED_FILES)
        self.assertEqual(
            manage.EXTERNAL_MANAGED_FILES,
            (
                ("git-guards/install", ".config/git-guards/install"),
                ("git-guards/pre-push-foreign-history", ".config/git-guards/pre-push-foreign-history"),
            ),
        )
        for rel in ("statusline.py", "git-guards/install", "git-guards/pre-push-foreign-history"):
            self.assertIn(rel, manage.EXECUTABLES)
            self.assertTrue((ROOT / rel).stat().st_mode & 0o111, rel)
        targets = {target for _, target in manage.managed_links()}
        self.assertIn(manage.CLAUDE_HOME / "statusline.py", targets)
        self.assertIn(manage.CLAUDE_HOME / "keybindings.json", targets)
        self.assertIn(manage.HOME / ".config" / "git-guards" / "install", targets)

    def test_check_command_runs_unit_suite(self) -> None:
        text = (ROOT / "scripts" / "manage.py").read_text(encoding="utf-8")
        self.assertIn('"unittest", "discover", "-s", str(ROOT / "tests")', text)


class Consolidation(unittest.TestCase):
    CORPUS = ("CLAUDE.md", "rules/code-style.md", "rules/waiting.md")
    SENTINELS = ("never claim", "smallest coherent", "ticket key", "sibling", "session link", "claude-session")
    PLUGIN_RULE = ROOT.parent / "wiki" / "plugins" / "obsidian-memory" / "rules" / "obsidian-vault.md"

    def corpus_files(self) -> list[Path]:
        files = [ROOT / rel for rel in self.CORPUS]
        files.extend(sorted((ROOT / "skills" / "engineering").rglob("*.md")))
        return files

    def test_inventory_names_the_engineering_skill_and_drops_the_merged_rules(self) -> None:
        self.assertIn("skills/engineering", manage.MANAGED_DIRECTORIES)
        self.assertEqual(len(manage.REQUIRED_DIRECTORY_FILES["skills/engineering"]), 9)
        for rel in ("rules/workflow.md", "rules/testing.md"):
            self.assertNotIn(rel, manage.MANAGED_FILES)
            self.assertFalse((ROOT / rel).exists(), rel)

    def test_always_on_bytes_stay_within_budget(self) -> None:
        core = (ROOT / "CLAUDE.md").stat().st_size
        always_on = core + (ROOT / "rules" / "waiting.md").stat().st_size + self.PLUGIN_RULE.stat().st_size
        with_code = always_on + (ROOT / "rules" / "code-style.md").stat().st_size
        self.assertLessEqual(core, 3300)
        self.assertLessEqual(always_on, 7000)
        self.assertLessEqual(with_code, 12000)

    def test_each_sentinel_rule_lives_in_at_most_one_file(self) -> None:
        for sentinel in self.SENTINELS:
            homes = [path.relative_to(ROOT).as_posix() for path in self.corpus_files() if sentinel in path.read_text(encoding="utf-8").lower()]
            self.assertLessEqual(len(homes), 1, f"{sentinel!r} in {homes}")

    def test_code_style_keeps_its_path_scope(self) -> None:
        text = (ROOT / "rules" / "code-style.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\npaths:\n"))
        self.assertIn('"**/*.{asm,bash,c,cc,clj', text)

    def test_engineering_skill_routes_every_reference(self) -> None:
        skill = (ROOT / "skills" / "engineering" / "SKILL.md").read_text(encoding="utf-8")
        for name in manage.REQUIRED_DIRECTORY_FILES["skills/engineering"][1:]:
            self.assertIn(f"`{name}`", skill)


class ReferenceLiterals(unittest.TestCase):
    def test_extracts_every_spelling_and_strips_trailing_punctuation(self) -> None:
        text = (
            "Read `~/.claude/rules/code-style.md`. Then $HOME/.claude/skills/mr-preflight/failure-modes.md, "
            "and /Users/david.david/.claude/hooks/f17-ticket-keys.sh (see ~/.claude/rules/ and ~/.claude/rules/*.md)."
        )
        self.assertEqual(
            manage.reference_literals(text),
            {
                "rules/code-style.md",
                "skills/mr-preflight/failure-modes.md",
                "hooks/f17-ticket-keys.sh",
                "rules/",
            },
        )

    def test_rendered_literals_round_trip_through_extraction(self) -> None:
        rng = random.Random()
        alphabet = string.ascii_lowercase + string.digits + "_-"
        for _ in range(200):
            expected: set[str] = set()
            pieces: list[str] = []
            for _ in range(rng.randint(1, 6)):
                depth = rng.randint(1, 3)
                segments = ["".join(rng.choices(alphabet, k=rng.randint(1, 8))) for _ in range(depth)]
                rel = "/".join(segments)
                if rng.random() < 0.3:
                    rel += "/"
                elif rng.random() < 0.6:
                    rel += "." + "".join(rng.choices(string.ascii_lowercase, k=rng.randint(1, 3)))
                account = "".join(rng.choices(string.ascii_lowercase + ".", k=rng.randint(1, 12))).strip(".") or "x"
                prefix = rng.choice(("~", "$HOME", f"/Users/{account}"))
                wrap = rng.choice((("`", "`"), ("(", ")"), ("", ""), ('"', '"')))
                pieces.append(f"{wrap[0]}{prefix}/.claude/{rel}{wrap[1]}{rng.choice(('', '.', ','))}")
                expected.add(rel)
            text = rng.choice((" ", "\n", " and ")).join(pieces)
            self.assertEqual(manage.reference_literals(text), expected, f"text={text!r}")


class Lifecycle(unittest.TestCase):
    def test_install_creates_exact_links_and_second_run_is_noop(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            with patched(root, home, backups):
                first_code, first_output = quiet(manage.cmd_install, None)
                second_code, second_output = quiet(manage.cmd_install, None)
                links = manage.managed_links()
            self.assertEqual((first_code, second_code), (0, 0))
            self.assertEqual(first_output.count("linked "), len(links))
            self.assertIn(f"unchanged {len(links)} link(s)", second_output)
            for source, target in links:
                self.assertTrue(target.is_symlink(), target)
                self.assertEqual(os.readlink(target), str(source))
            self.assertFalse(backups.exists())

    def test_status_reports_missing_regular_and_wrong_links_and_unresolved_references(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                (home / "rules" / "code-style.md").unlink()
                (home / "rules" / "waiting.md").unlink()
                (home / "rules" / "waiting.md").write_text("local edit\n", encoding="utf-8")
                (home / "hooks" / "f17-ticket-keys.sh").unlink()
                (home / "hooks" / "f17-ticket-keys.sh").symlink_to(Path(tmp) / "nowhere")
                (home / "skills" / "review-retro").unlink()
                (home / "skills" / "review-retro").symlink_to(root / "skills" / "mr-preflight")
                problems = manage.live_problems()
        states = {line.split(": ")[1].split(",")[0] for line in problems if "expected symlink" in line}
        self.assertEqual(states, {"missing", "regular", "wrong-link"})
        self.assertIn("CLAUDE.md references ~/.claude/rules/code-style.md, which does not resolve", problems)

    def test_dangling_managed_link_is_reported(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                (root / "chrome-cdp.md").unlink()
                problems = manage.live_problems()
        self.assertIn(f"{home / 'chrome-cdp.md'}: dangling, expected symlink -> {root / 'chrome-cdp.md'}", problems)

    def test_install_backs_up_a_conflicting_regular_file_and_foreign_link(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            (home / "CLAUDE.md").write_text("previous personal file\n", encoding="utf-8")
            (home / "rules").mkdir()
            (home / "rules" / "waiting.md").symlink_to(Path(tmp) / "elsewhere.md")
            with patched(root, home, backups):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0)
            self.assertIn("backed up 2 replaced path(s)", output)
            saved = list(backups.rglob("*"))
            regular = next(path for path in saved if path.name == "CLAUDE.md")
            foreign = next(path for path in saved if path.name == "waiting.md")
            self.assertEqual(regular.read_text(encoding="utf-8"), "previous personal file\n")
            self.assertEqual(os.readlink(foreign), str(Path(tmp) / "elsewhere.md"))
            self.assertEqual(os.readlink(home / "CLAUDE.md"), str(root / "CLAUDE.md"))

    def test_install_replaces_a_leftover_real_directory_after_backing_it_up(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            leftover = home / "skills" / "mr-preflight"
            leftover.mkdir(parents=True)
            (leftover / "failure-modes-archive.md").write_text("retired rows\n", encoding="utf-8")
            with patched(root, home, backups):
                code, _ = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0)
            self.assertTrue(leftover.is_symlink())
            saved = next(backups.rglob("failure-modes-archive.md"))
            self.assertEqual(saved.read_text(encoding="utf-8"), "retired rows\n")

    def test_uninstall_removes_only_exact_managed_links(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                (home / "rules" / "waiting.md").unlink()
                (home / "rules" / "waiting.md").write_text("local edit\n", encoding="utf-8")
                code, _ = quiet(manage.cmd_uninstall, None)
            self.assertEqual(code, 0)
            self.assertFalse((home / "CLAUDE.md").exists())
            self.assertFalse((home / "skills" / "mr-preflight").is_symlink())
            self.assertEqual((home / "rules" / "waiting.md").read_text(encoding="utf-8"), "local edit\n")

    def test_unmanaged_siblings_survive_install_and_uninstall(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (home / "rules").mkdir()
            (home / "rules" / "personal-notes.md").symlink_to(Path(tmp) / "vault-rule.md")
            (home / "skills").mkdir()
            (home / "skills" / "pr-review").symlink_to(Path(tmp) / "pr-review")
            (home / "settings.json").write_text('{"model": "opus"}\n', encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                quiet(manage.cmd_uninstall, None)
            self.assertEqual(os.readlink(home / "rules" / "personal-notes.md"), str(Path(tmp) / "vault-rule.md"))
            self.assertEqual(os.readlink(home / "skills" / "pr-review"), str(Path(tmp) / "pr-review"))
            self.assertEqual(json.loads((home / "settings.json").read_text(encoding="utf-8"))["model"], "opus")

    def test_install_prunes_only_dangling_links_into_the_repository(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (home / "rules").mkdir()
            (home / "rules" / "workflow.md").symlink_to(root / "rules" / "workflow.md")
            (home / "rules" / "relative.md").symlink_to(os.path.relpath(root / "rules" / "gone.md", home / "rules"))
            (home / "rules" / "foreign.md").symlink_to(Path(tmp) / "elsewhere" / "gone.md")
            (home / "rules" / "personal-notes.md").symlink_to(root / "README.md")
            (root / "README.md").write_text("live\n", encoding="utf-8")
            (home / "rules" / "local.md").write_text("regular\n", encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                _, first = quiet(manage.cmd_install, None)
                _, second = quiet(manage.cmd_install, None)
            self.assertEqual(first.count("pruned "), 2)
            self.assertNotIn("pruned ", second)
            self.assertFalse((home / "rules" / "workflow.md").is_symlink())
            self.assertFalse((home / "rules" / "relative.md").is_symlink())
            self.assertTrue((home / "rules" / "foreign.md").is_symlink())
            self.assertTrue((home / "rules" / "personal-notes.md").is_symlink())
            self.assertEqual((home / "rules" / "local.md").read_text(encoding="utf-8"), "regular\n")

    def test_external_caller_reference_to_a_managed_path_must_resolve(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (home / "agents").mkdir()
            (home / "agents" / "fixer.md").write_text("read ~/.claude/skills/mr-preflight/failure-modes.md\n", encoding="utf-8")
            (home / "settings.json").write_text('{"command": "bash /Users/me/.claude/hooks/f17-ticket-keys.sh"}\n', encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                before = manage.live_problems()
                quiet(manage.cmd_install, None)
                after = manage.live_problems()
        self.assertTrue(any("agents/fixer.md" in line and "does not resolve" in line for line in before))
        self.assertTrue(any("settings.json" in line and "does not resolve" in line for line in before))
        self.assertEqual(after, [])


class ExternalAndWorkspaceLinks(unittest.TestCase):
    def test_external_target_links_outside_claude_home(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0, output)
            for name in ("install", "pre-push-foreign-history"):
                guard = home.parent / ".config" / "git-guards" / name
                self.assertTrue(guard.is_symlink(), guard)
                self.assertEqual(os.readlink(guard), str(root / "git-guards" / name))
            self.assertFalse((home / ".config").exists())

    def test_external_link_backs_up_foreign_regular_file(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            guard = home.parent / ".config" / "git-guards" / "install"
            guard.parent.mkdir(parents=True)
            guard.write_text("hand-written guard\n", encoding="utf-8")
            with patched(root, home, backups):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0, output)
            self.assertIn("backed up 1 replaced path(s)", output)
            saved = next(backups.rglob("install"))
            self.assertEqual(saved.read_text(encoding="utf-8"), "hand-written guard\n")
            self.assertEqual(os.readlink(guard), str(root / "git-guards" / "install"))

    def test_workspace_source_links_and_prunes(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            plugin = root.parent / "wiki" / "plugins" / "obsidian-memory"
            (home / "skills").mkdir()
            stale = home / "skills" / "retired-plugin"
            stale.symlink_to(plugin / "skills" / "retired-plugin")
            with patched(root, home, Path(tmp) / "backups"):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0, output)
            self.assertIn(f"pruned {stale}", output)
            skill = home / "skills" / "obsidian-memory"
            self.assertEqual(os.readlink(skill), str(plugin / "skills" / "obsidian-memory"))
            self.assertTrue((skill / "SKILL.md").is_file())
            self.assertEqual(
                os.readlink(home / "rules" / "obsidian-vault.md"),
                str(plugin / "rules" / "obsidian-vault.md"),
            )
            self.assertEqual(
                os.readlink(home / "scripts" / "obsidian_memory.py"),
                str(plugin / "scripts" / "obsidian_memory.py"),
            )


class SettingsFragment(unittest.TestCase):
    def hook_commands(self, fragment: dict) -> list[str]:
        return [
            entry["command"]
            for event in fragment["hooks"].values()
            for group in event
            for entry in group["hooks"]
        ]

    def test_settings_fragment_applies_and_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            settings = home / "settings.json"
            with patched(root, home, backups):
                _, first = quiet(manage.cmd_install, None)
                stamp = settings.stat().st_mtime_ns
                _, second = quiet(manage.cmd_install, None)
                self.assertEqual(manage.settings_drift(), [])
            self.assertIn("settings fragment applied", first)
            self.assertIn("settings fragment unchanged", second)
            self.assertEqual(sorted(json.loads(settings.read_text())), sorted(manage.OWNED_SETTINGS_KEYS))
            self.assertEqual(settings.stat().st_mtime_ns, stamp)
            self.assertFalse(backups.exists())

    def test_settings_fragment_preserves_unowned_keys(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            settings = home / "settings.json"
            previous = json.dumps({"model": "opus", "attribution": {"commit": "trailer", "pr": ""}}, indent=2)
            settings.write_text(previous, encoding="utf-8")
            with patched(root, home, backups):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0, output)
            self.assertIn("settings fragment applied", output)
            written = json.loads(settings.read_text())
            self.assertEqual(written["model"], "opus")
            self.assertEqual(written["attribution"], {"commit": "", "pr": "", "sessionUrl": False})
            self.assertEqual(next(backups.rglob("settings.json")).read_text(encoding="utf-8"), previous)

    def test_status_flags_settings_fragment_drift(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            settings = home / "settings.json"
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                live = json.loads(settings.read_text())
                live["statusLine"]["command"] = "/bin/false"
                del live["attribution"]
                settings.write_text(json.dumps(live, indent=2), encoding="utf-8")
                code, output = quiet(manage.cmd_status, None)
            self.assertEqual(code, 1)
            self.assertIn(f"{settings}: statusLine differs from the managed settings fragment", output)
            self.assertIn(f"{settings}: attribution is missing", output)

    def test_settings_fragment_expands_home_in_hook_commands(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                fragment = manage.settings_fragment()
            commands = self.hook_commands(fragment)
            self.assertIn("rtk hook claude", commands)
            self.assertIn(f"bash {home}/hooks/f17-ticket-keys.sh", commands)
            self.assertIn(f"python3 {home}/scripts/obsidian_memory.py session-start", commands)
            self.assertIn(f"python3 {home}/scripts/obsidian_memory.py stop", commands)
            self.assertEqual(fragment["statusLine"]["command"], f"{home}/statusline.py")
            self.assertFalse([command for command in commands if "~/" in command])

    def test_settings_fragment_references_resolve(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                fragment_path = root / "settings" / "managed.json"
                edges = {rel for path, rel in manage.reference_edges() if path == fragment_path}
                self.assertEqual(
                    edges,
                    {
                        "hooks/f17-ticket-keys.sh",
                        "hooks/guard-red-write.py",
                        "scripts/obsidian_memory.py",
                        "statusline.py",
                    },
                )
                code, output = quiet(manage.cmd_install, None)
                self.assertEqual(code, 0, output)
                self.assertEqual(manage.live_problems(), [])


class MergedLifecycle(unittest.TestCase):
    def test_install_renders_before_validation_and_refuses_invalid_package(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            prompt = root / "agents" / "prompts" / "worker.md"
            prompt.write_text(prompt.read_text() + "\nRead ~/.claude/unknown.md\n")
            stale = home / "rules" / "retired.md"
            stale.parent.mkdir()
            stale.symlink_to(root / "rules" / "retired.md")
            (home / "CLAUDE.md").write_text("personal\n")
            with patched(root, home, backups):
                with self.assertRaisesRegex(manage.Problem, "package validation failed"):
                    quiet(manage.cmd_install, None)
            self.assertIn("Read ~/.claude/unknown.md", (root / "agents" / "rendered" / "worker.md").read_text())
            self.assertEqual((home / "CLAUDE.md").read_text(), "personal\n")
            self.assertTrue(stale.is_symlink())
            self.assertFalse((home / "agents").exists())
            self.assertFalse(backups.exists())

    def test_agent_prompt_references_are_validated(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            prompt = root / "agents" / "prompts" / "worker.md"
            for rel, diagnostic in (
                ("unknown.md", "unmanaged ~/.claude/unknown.md"),
                ("skills/engineering/references/missing.md", "which does not exist in the repository"),
            ):
                with self.subTest(rel=rel):
                    prompt.write_text(f"Read ~/.claude/{rel}\n")
                    with patched(root, home, Path(tmp) / "backups"):
                        quiet(manage.cmd_render, None)
                        problems = manage.package_problems()
                    self.assertEqual(len(problems), 1, problems)
                    self.assertIn("agents/prompts/worker.md references", problems[0])
                    self.assertIn(diagnostic, problems[0])

    def test_agent_copies_back_up_foreign_links_and_directories(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            target = home / "agents"
            target.mkdir()
            foreign = Path(tmp) / "foreign.md"
            foreign.write_text("foreign\n")
            (target / "worker.md").symlink_to(foreign)
            (target / "Explore.md").mkdir()
            (target / "Explore.md" / "personal.md").write_text("personal\n")
            with patched(root, home, backups):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0, output)
            self.assertIn("backed up 2 replaced path(s)", output)
            for name in ("worker.md", "Explore.md"):
                self.assertFalse((target / name).is_symlink())
                self.assertEqual((target / name).read_bytes(), (root / "agents" / "rendered" / name).read_bytes())
            self.assertEqual(os.readlink(next(backups.rglob("worker.md"))), str(foreign))
            self.assertEqual(next(backups.rglob("personal.md")).read_text(), "personal\n")
            self.assertEqual(foreign.read_text(), "foreign\n")

    def test_uninstall_preserves_modified_copies_links_and_directories(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            agents = home / "agents"
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                (agents / "worker.md").write_text("edited\n")
                (agents / "Explore.md").unlink()
                (agents / "Explore.md").symlink_to(root / "agents" / "rendered" / "Explore.md")
                (agents / "reviewer.md").unlink()
                (agents / "reviewer.md").mkdir()
                (agents / "reviewer.md" / "personal.md").write_text("personal\n")
                quiet(manage.cmd_uninstall, None)
                self.assertEqual((agents / "worker.md").read_text(), "edited\n")
                self.assertTrue((agents / "Explore.md").is_symlink())
                self.assertEqual((agents / "reviewer.md" / "personal.md").read_text(), "personal\n")
                quiet(manage.cmd_install, None)
                quiet(manage.cmd_uninstall, None)
            for name in ("Explore.md", "worker.md", "reviewer.md"):
                self.assertFalse((agents / name).exists(), name)
            self.assertFalse((home / "CLAUDE.md").is_symlink())

    def test_status_reports_missing_modified_and_linked_agent_copies(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                agents = home / "agents"
                (agents / "worker.md").write_text("edited\n")
                (agents / "Explore.md").unlink()
                (agents / "reviewer.md").unlink()
                (agents / "reviewer.md").symlink_to(root / "agents" / "rendered" / "reviewer.md")
                (home / "chrome-cdp.md").unlink()
                code, output = quiet(manage.cmd_status, None)
            self.assertEqual(code, 1)
            for name in ("worker.md", "Explore.md", "reviewer.md"):
                self.assertIn(f"{agents / name}: missing, stale, or not a regular-file copy", output)
            self.assertIn(f"{home / 'chrome-cdp.md'}: missing, expected symlink", output)

    def test_render_check_detects_changed_and_stale_files_without_writing(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            changed = [root / "agents" / "rendered" / "worker.md", root / "agents" / "rendered" / "reviewer.md"]
            stale = [root / "agents" / "rendered" / "retired.md"]
            for path in changed + stale:
                path.write_text("drift\n")
            command = [sys.executable, str(root / "scripts" / "render.py"), "--check"]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            for path in changed + stale:
                self.assertIn(str(path.relative_to(root / "agents")), result.stdout)
                self.assertEqual(path.read_text(), "drift\n")
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_render, None)
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for path in stale:
                self.assertFalse(path.exists())
            for path in changed:
                self.assertEqual(path.read_bytes(), (ROOT / path.relative_to(root)).read_bytes())

    def test_second_install_preserves_link_copy_and_backup_mtimes(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            backups = Path(tmp) / "backups"
            (home / "CLAUDE.md").write_text("personal core\n")
            (home / "agents").mkdir()
            (home / "agents" / "worker.md").write_text("personal worker\n")
            with patched(root, home, backups):
                code, output = quiet(manage.cmd_install, None)
                self.assertEqual(code, 0, output)
                runtime = home / "skills" / "mr-preflight" / "failure-modes-archive.md"
                runtime.write_text("retired rows\n")
                paths = [target for _, target in manage.managed_links()]
                paths.extend(home / "agents" / source.name for source in manage.claude_agent_sources())
                paths.extend(path for path in backups.rglob("*") if path.is_file())
                before = {path: path.lstat().st_mtime_ns for path in paths}
                code, output = quiet(manage.cmd_install, None)
                self.assertEqual(code, 0, output)
                self.assertEqual(before, {path: path.lstat().st_mtime_ns for path in paths})
                self.assertIn(f"unchanged {len(manage.managed_links())} link(s)", output)
                self.assertIn("unchanged 3 agent file(s)", output)
                self.assertNotIn("backed up", output)
                self.assertEqual(len([path for path in backups.rglob("*") if path.is_file()]), 2)
            self.assertEqual((root / "skills" / "mr-preflight" / runtime.name).read_text(), "retired rows\n")

    def test_reference_edges_resolve_managed_agent_copies(self) -> None:
        with TemporaryDirectory() as tmp:
            root, home = build_fixture(Path(tmp))
            (root / "CLAUDE.md").write_text("Read ~/.claude/agents/worker.md and ~/.claude/agents/\n")
            with patched(root, home, Path(tmp) / "backups"):
                self.assertEqual(manage.package_problems(), [])
                code, output = quiet(manage.cmd_install, None)
                self.assertEqual(code, 0, output)
                self.assertEqual(manage.live_problems(), [])


if __name__ == "__main__":
    unittest.main()

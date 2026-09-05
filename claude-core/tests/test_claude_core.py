#!/usr/bin/env python3

from __future__ import annotations

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
    root = tmp / "repo"
    home = tmp / "claude"
    home.mkdir()
    for rel in manage.MANAGED_FILES:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{rel}\nsee ~/.claude/rules/\n", encoding="utf-8")
    for rel, names in manage.REQUIRED_DIRECTORY_FILES.items():
        for name in names:
            path = root / rel / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{rel}/{name}\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text(
        "read `~/.claude/rules/code-style.md` and $HOME/.claude/skills/mr-preflight/failure-modes.md\n",
        encoding="utf-8",
    )
    for rel in manage.EXECUTABLES:
        (root / rel).chmod(0o755)
    return root, home


def patched(root: Path, home: Path, backups: Path) -> ExitStack:
    stack = ExitStack()
    stack.enter_context(mock.patch.object(manage, "ROOT", root))
    stack.enter_context(mock.patch.object(manage, "CLAUDE_HOME", home))
    stack.enter_context(mock.patch.object(manage, "BACKUP_ROOT", backups))
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
                self.assertTrue((ROOT / rel).exists(), origin)

    def test_reference_edges_cover_the_known_hardcoded_callers(self) -> None:
        edges = {(path.relative_to(ROOT).as_posix(), rel) for path, rel in manage.reference_edges()}
        for expected in (
            ("skills/mr-preflight/SKILL.md", "skills/mr-preflight/preflight-triage.sh"),
            ("skills/mr-preflight/preflight-triage.sh", "skills/mr-preflight/failure-modes.md"),
            ("skills/mr-preflight/preflight-triage.sh", "skills/mr-preflight/harness-delta.py"),
            ("skills/review-retro/SKILL.md", "skills/mr-preflight/"),
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
            (root / "CLAUDE.md").write_text("see ~/.claude/statusline.py\n", encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                problems = manage.package_problems()
        self.assertEqual(problems, ["CLAUDE.md references unmanaged ~/.claude/statusline.py"])

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

    def test_check_command_runs_unit_suite(self) -> None:
        text = (ROOT / "scripts" / "manage.py").read_text(encoding="utf-8")
        self.assertIn('"unittest", "discover", "-s", str(ROOT / "tests")', text)


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
            (home / "rules" / "testing.md").symlink_to(Path(tmp) / "elsewhere.md")
            with patched(root, home, backups):
                code, output = quiet(manage.cmd_install, None)
            self.assertEqual(code, 0)
            self.assertIn("backed up 2 replaced path(s)", output)
            saved = list(backups.rglob("*"))
            regular = next(path for path in saved if path.name == "CLAUDE.md")
            foreign = next(path for path in saved if path.name == "testing.md")
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
            (home / "rules" / "obsidian-vault.md").symlink_to(Path(tmp) / "vault-rule.md")
            (home / "skills").mkdir()
            (home / "skills" / "pr-review").symlink_to(Path(tmp) / "pr-review")
            (home / "settings.json").write_text("{}\n", encoding="utf-8")
            with patched(root, home, Path(tmp) / "backups"):
                quiet(manage.cmd_install, None)
                quiet(manage.cmd_uninstall, None)
            self.assertEqual(os.readlink(home / "rules" / "obsidian-vault.md"), str(Path(tmp) / "vault-rule.md"))
            self.assertEqual(os.readlink(home / "skills" / "pr-review"), str(Path(tmp) / "pr-review"))
            self.assertEqual((home / "settings.json").read_text(encoding="utf-8"), "{}\n")

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


if __name__ == "__main__":
    unittest.main()

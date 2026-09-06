from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPT = Path(__file__).resolve().parents[1] / "skills/mr-preflight/preflight-snapshot.py"


class PreflightSnapshot(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo with spaces"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.write("app.py", "enabled = False\n")
        self.write("CLAUDE.md", "Follow the project commands.\n")
        self.commit("base")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "-b", "feature")
        self.write("app.py", "enabled = True\n")
        self.commit("feature")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args], cwd=self.repo, capture_output=True, text=True, check=True).stdout

    def write(self, name: str, value: str) -> None:
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def commit(self, message: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-qm", message)

    def run_snapshot(self, *args: str, cwd: Path | None = None) -> tuple[int, dict]:
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.repo), *args], cwd=cwd or Path(self.tmp.name), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.stderr, "")
        return result.returncode, json.loads(result.stdout)

    def test_scopes_the_correct_repository_from_another_cwd_without_writing(self) -> None:
        before = sorted(str(p.relative_to(self.repo)) for p in self.repo.rglob("*"))
        index_before = (self.repo / ".git/index").read_bytes()
        code, data = self.run_snapshot("main", "--branch", "feature")
        self.assertEqual(code, 0)
        self.assertEqual(data["repo"], str(self.repo.resolve()))
        self.assertEqual(data["base"], self.base)
        self.assertEqual(data["head"], self.git("rev-parse", "HEAD").strip())
        self.assertEqual(data["changes"], [{"status": "M", "path": "app.py"}])
        self.assertEqual(data["instruction_paths"], ["CLAUDE.md"])
        self.assertFalse(data["local_edits_excluded"])
        self.assertEqual(data["whitespace"]["exit_code"], 0)
        self.assertNotIn("readiness", data)
        self.assertEqual(index_before, (self.repo / ".git/index").read_bytes())
        self.assertEqual(before, sorted(str(p.relative_to(self.repo)) for p in self.repo.rglob("*")))

    def test_missing_target_and_wrong_branch_cannot_succeed(self) -> None:
        for args in [("absent",), ("main", "--branch", "main")]:
            code, data = self.run_snapshot(*args)
            self.assertNotEqual(code, 0)
            self.assertEqual(data["readiness"], "INCOMPLETE")
            self.assertIn("error", data)

    def test_distinguishes_merge_base_from_target_tip_and_invalidates_review_identity(self) -> None:
        _, first = self.run_snapshot("main")
        self.git("checkout", "-q", "main")
        self.write("target.txt", "target moved\n")
        self.commit("target advance")
        self.git("checkout", "-q", "feature")
        _, second = self.run_snapshot("main")
        self.assertEqual(first["base"], second["base"])
        self.assertNotEqual(first["target"], second["target"])
        self.assertNotEqual(first["review_key"], second["review_key"])
        self.assertEqual(second["changes"], first["changes"])

    def test_dirty_and_untracked_inputs_are_excluded_not_silently_tested(self) -> None:
        _, first = self.run_snapshot("main")
        self.write("app.py", "enabled = 'uncommitted'\n")
        self.write("untracked.txt", "local\n")
        _, second = self.run_snapshot("main")
        self.assertTrue(second["local_edits_excluded"])
        self.assertIn("untracked.txt", second["local_status"])
        self.assertEqual(second["review_key"], first["review_key"])
        self.assertEqual(second["changes"], first["changes"])
        self.assertEqual(second["tests"], "not run")
        self.assertEqual((self.repo / "app.py").read_text(), "enabled = 'uncommitted'\n")

    def test_rename_deletion_and_unusual_names_survive_git_path_parsing(self) -> None:
        before_rename = self.git("rev-parse", "HEAD").strip()
        self.git("mv", "app.py", "renamed file.py")
        self.git("rm", "CLAUDE.md")
        odd = "nested/$(touch SHOULD_NOT_EXIST)\nname.py"
        self.write(odd, "value = 1\n")
        self.commit("rename and delete")
        _, data = self.run_snapshot(before_rename)
        self.assertIn({"status": "R100", "old_path": "app.py", "path": "renamed file.py"}, data["changes"])
        self.assertIn(odd, [c["path"] for c in data["changes"]])
        self.assertTrue(any(c["status"] == "D" and c["path"] == "CLAUDE.md" for c in data["changes"]))
        self.assertIn("CLAUDE.md", data["instruction_paths"])
        self.assertFalse((self.repo / "SHOULD_NOT_EXIST").exists())

    def test_truncation_is_explicit_and_can_be_expanded(self) -> None:
        for i in range(45):
            self.write(f"docs/{i}.md", "text\n")
        self.write(".claude/rules/new.md", "Check the changed rules too.\n")
        self.commit("many documents")
        _, small = self.run_snapshot("main")
        _, full = self.run_snapshot("main", "--all-paths")
        self.assertGreater(small["paths_omitted"], 0)
        self.assertEqual(full["paths_omitted"], 0)
        self.assertEqual(len(full["changes"]), small["change_count"])
        self.assertEqual(small["review_key"], full["review_key"])
        self.assertIn(".claude/rules/new.md", full["instruction_paths"])

    def test_whitespace_failure_remains_evidence_not_a_readiness_verdict(self) -> None:
        self.write("app.py", "enabled = True   \n")
        self.commit("whitespace")
        code, data = self.run_snapshot("main")
        self.assertEqual(code, 0)
        self.assertEqual(data["whitespace"]["exit_code"], 2)
        self.assertIn("app.py", data["whitespace"]["output"])
        self.assertNotIn("readiness", data)

    def test_does_not_execute_external_diff_driver(self) -> None:
        marker = self.repo / "external-diff-ran"
        self.git("config", "diff.external", f"touch '{marker}'")
        code, data = self.run_snapshot("main")
        self.assertEqual(code, 0)
        self.assertEqual(data["change_count"], 1)
        self.assertFalse(marker.exists())

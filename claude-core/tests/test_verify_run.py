#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_run", ROOT / "scripts" / "verify-run.py")
verify = importlib.util.module_from_spec(SPEC)
sys.modules["verify_run"] = verify
SPEC.loader.exec_module(verify)


def git_repo(path: Path) -> None:
    run = lambda *a: subprocess.run(a, cwd=path, capture_output=True, text=True, check=True)
    run("git", "init", "-q")
    run("git", "config", "user.email", "test@example.com")
    run("git", "config", "user.name", "Test")
    (path / "a.py").write_text("x = 1\n", encoding="utf-8")
    run("git", "add", "-A")
    run("git", "commit", "-qm", "init")


class ParseCounts(unittest.TestCase):
    def test_pytest_summary_is_parsed(self) -> None:
        self.assertEqual(verify.parse_counts("31 passed, 1 skipped in 0.42s"),
                         {"passed": 31, "skipped": 1})

    def test_failures_and_errors_are_parsed(self) -> None:
        counts = verify.parse_counts("1 failed, 2 passed, 3 errors in 1s")
        self.assertEqual(counts["failed"], 1)
        self.assertEqual(counts["errors"], 3)

    def test_unittest_and_vitest_shapes_are_parsed(self) -> None:
        self.assertEqual(verify.parse_counts("Ran 12 tests in 0.03s")["ran"], 12)
        self.assertEqual(verify.parse_counts("Tests  1428 passed (1430)")["vitest_passed"], 1428)

    def test_the_last_summary_wins_when_a_run_prints_several(self) -> None:
        counts = verify.parse_counts("2 passed in 1s\n... rerun ...\n7 passed in 2s")
        self.assertEqual(counts["passed"], 7)

    def test_output_with_no_summary_counts_nothing(self) -> None:
        self.assertEqual(verify.parse_counts("collected 0 items"), {})


class Vacuity(unittest.TestCase):
    def test_all_skipped_unittest_and_bun_runs_are_vacuous(self) -> None:
        for output in ("Ran 3 tests in 0.1s\nOK (skipped=3)", " 0 pass\n 3 skip\n"):
            self.assertTrue(verify.looks_empty(verify.parse_counts(output)), output)
        self.assertFalse(verify.looks_empty(verify.parse_counts("Ran 3 tests in 0.1s\nOK (skipped=2)")))

    def test_a_run_that_counted_nothing_is_vacuous(self) -> None:
        self.assertTrue(verify.looks_empty({}))
        self.assertTrue(verify.looks_empty({"skipped": 9}))

    def test_a_run_that_executed_tests_is_not_vacuous(self) -> None:
        self.assertFalse(verify.looks_empty({"passed": 1}))
        self.assertFalse(verify.looks_empty({"ran": 3}))
        self.assertFalse(verify.looks_empty({"vitest_passed": 10}))


class LedgerChain(unittest.TestCase):
    def test_concurrent_writers_preserve_every_entry_and_chain(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            with ThreadPoolExecutor(max_workers=12) as pool:
                list(pool.map(lambda i: verify.append(path, {"run": i}), range(48)))
            entries = verify.read_ledger(path)
            self.assertEqual({entry["run"] for entry in entries}, set(range(48)))
            self.assertEqual(verify.chain_breaks(entries), [])

    def test_appending_chains_each_entry_onto_the_previous(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            first = verify.append(path, {"tree": "a" * 40, "exit": 0})
            second = verify.append(path, {"tree": "b" * 40, "exit": 0})
            self.assertNotEqual(first["chain"], second["chain"])
            self.assertEqual(verify.chain_breaks(verify.read_ledger(path)), [])

    def test_editing_a_past_entry_breaks_the_chain(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            verify.append(path, {"tree": "a" * 40, "exit": 1})
            verify.append(path, {"tree": "b" * 40, "exit": 0})
            lines = path.read_text(encoding="utf-8").splitlines()
            tampered = json.loads(lines[0])
            tampered["exit"] = 0          # rewrite a red run as green
            lines[0] = json.dumps(tampered, sort_keys=True)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            # The tamper is localised: entry 1 chained onto entry 0's recorded
            # hash, which the edit left in place, so only index 0 mismatches.
            self.assertEqual(verify.chain_breaks(verify.read_ledger(path)), [0])
            self.assertEqual(verify.verified_trees(verify.read_ledger(path)),
                             {"a" * 40, "b" * 40})   # why the chain check must be run

    def test_deleting_an_entry_breaks_the_chain_of_the_one_after_it(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            verify.append(path, {"tree": "a" * 40, "exit": 0})
            verify.append(path, {"tree": "b" * 40, "exit": 0})
            verify.append(path, {"tree": "c" * 40, "exit": 0})
            lines = path.read_text(encoding="utf-8").splitlines()
            del lines[1]
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self.assertEqual(verify.chain_breaks(verify.read_ledger(path)), [1])

    def test_an_entry_appended_without_the_wrapper_breaks_the_chain(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            verify.append(path, {"tree": "a" * 40, "exit": 0})
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"tree": "c" * 40, "exit": 0, "chain": "forged"}) + "\n")
            self.assertIn(1, verify.chain_breaks(verify.read_ledger(path)))

    def test_only_green_non_vacuous_runs_count_as_verified(self) -> None:
        entries = [
            {"tree": "a" * 40, "exit": 0, "empty": False},
            {"tree": "b" * 40, "exit": 1, "empty": False},
            {"tree": "c" * 40, "exit": 0, "empty": True},
        ]
        self.assertEqual(verify.verified_trees(entries), {"a" * 40})

    def test_a_corrupt_line_does_not_crash_the_reader(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            path.write_text("{not json\n", encoding="utf-8")
            self.assertEqual(len(verify.read_ledger(path)), 1)
            self.assertEqual(verify.verified_trees(verify.read_ledger(path)), set())


class TreeStatus(unittest.TestCase):
    TREE = "a" * 40

    def entry(self, **fields):
        base = {"tree": self.TREE, "scope": "unit", "exit": 0, "empty": False, "deps": "d0"}
        base.update(fields)
        return base

    def test_a_tree_nothing_ran_against_is_missing(self) -> None:
        status, _ = verify.tree_status([], self.TREE)
        self.assertEqual(status, verify.MISSING)

    def test_a_green_non_vacuous_run_passes(self) -> None:
        status, _ = verify.tree_status([self.entry()], self.TREE)
        self.assertEqual(status, verify.PASS)

    def test_a_red_run_is_a_failure_not_an_absence(self) -> None:
        status, _ = verify.tree_status([self.entry(exit=1)], self.TREE)
        self.assertEqual(status, verify.FAIL)

    def test_a_failure_after_the_last_green_run_wins(self) -> None:
        entries = [self.entry(), self.entry(exit=1)]
        status, _ = verify.tree_status(entries, self.TREE)
        self.assertEqual(status, verify.FAIL)

    def test_green_after_red_in_the_same_scope_is_flaky_not_passing(self) -> None:
        entries = [self.entry(exit=1), self.entry()]
        status, _ = verify.tree_status(entries, self.TREE)
        self.assertEqual(status, verify.FLAKY)

    def test_a_failing_scope_is_not_covered_by_another_scope_passing(self) -> None:
        entries = [self.entry(scope="unit"), self.entry(scope="contract", exit=1)]
        status, _ = verify.tree_status(entries, self.TREE)
        self.assertEqual(status, verify.FAIL)

    def test_only_vacuous_green_runs_are_vacuous(self) -> None:
        status, _ = verify.tree_status([self.entry(empty=True)], self.TREE)
        self.assertEqual(status, verify.VACUOUS)

    def test_a_pass_taken_under_other_dependencies_is_stale(self) -> None:
        status, _ = verify.tree_status([self.entry(deps="d0")], self.TREE, deps="d1")
        self.assertEqual(status, verify.STALE)

    def test_a_pass_under_the_current_dependencies_is_not_stale(self) -> None:
        status, _ = verify.tree_status([self.entry(deps="d1")], self.TREE, deps="d1")
        self.assertEqual(status, verify.PASS)

    def test_a_legacy_entry_without_a_dependency_digest_is_not_called_stale(self) -> None:
        entry = self.entry()
        del entry["deps"]
        status, _ = verify.tree_status([entry], self.TREE, deps="d1")
        self.assertEqual(status, verify.PASS)

    def test_evidence_for_another_tree_does_not_cover_this_one(self) -> None:
        status, _ = verify.tree_status([self.entry(tree="b" * 40)], self.TREE)
        self.assertEqual(status, verify.MISSING)


class DependencyDigest(unittest.TestCase):
    def test_a_repository_with_no_lockfile_still_digests(self) -> None:
        with TemporaryDirectory() as tmp:
            self.assertTrue(verify.deps_digest(Path(tmp)))

    def test_changing_a_lockfile_changes_the_digest(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / "uv.lock"
            lock.write_text("a\n", encoding="utf-8")
            before = verify.deps_digest(root)
            lock.write_text("b\n", encoding="utf-8")
            self.assertNotEqual(verify.deps_digest(root), before)


class EndToEnd(unittest.TestCase):
    def run_verify(self, cwd: Path, *command: str):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify-run.py"), "--"] + list(command),
            cwd=cwd, capture_output=True, text=True)

    def test_a_green_run_records_the_worktree_tree_and_counts(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            result = self.run_verify(repo, sys.executable, "-c", "print('7 passed in 0.1s')")
            self.assertEqual(result.returncode, 0, result.stderr)
            entries = verify.read_ledger(repo / ".git" / verify.LEDGER_NAME)
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["exit"], 0)
            self.assertEqual(entries[0]["counts"]["passed"], 7)
            self.assertFalse(entries[0]["empty"])
            self.assertEqual(entries[0]["tree"], verify.worktree_tree(repo))

    def test_an_untracked_file_changes_the_recorded_tree(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            before = verify.worktree_tree(repo)
            (repo / "new_helper.py").write_text("y = 2\n", encoding="utf-8")
            self.assertNotEqual(verify.worktree_tree(repo), before)

    def test_a_failing_command_is_recorded_red_and_the_exit_code_propagates(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            result = self.run_verify(repo, sys.executable, "-c",
                                     "import sys; print('1 failed, 0 passed'); sys.exit(3)")
            self.assertEqual(result.returncode, 3)
            entries = verify.read_ledger(repo / ".git" / verify.LEDGER_NAME)
            self.assertEqual(entries[0]["exit"], 3)
            self.assertEqual(verify.verified_trees(entries), set())

    def test_a_green_run_that_counted_nothing_is_recorded_vacuous(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            result = self.run_verify(repo, sys.executable, "-c", "print('nothing ran')")
            self.assertEqual(result.returncode, 0)
            entries = verify.read_ledger(repo / ".git" / verify.LEDGER_NAME)
            self.assertTrue(entries[0]["empty"])
            self.assertEqual(verify.verified_trees(entries), set())
            self.assertIn("vacuous", result.stderr)

    def test_the_tracked_tree_ignores_untracked_scratch_files(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            tracked_before = verify.tracked_tree(repo)
            (repo / "scratch.log").write_text("noise\n", encoding="utf-8")
            self.assertEqual(verify.tracked_tree(repo), tracked_before)
            self.assertNotEqual(verify.worktree_tree(repo), tracked_before)

    def test_the_tracked_tree_equals_the_commit_tree_after_committing(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            (repo / "a.py").write_text("x = 2\n", encoding="utf-8")
            tested = verify.tracked_tree(repo)
            subprocess.run(("git", "commit", "-aqm", "change"), cwd=repo, check=True,
                           capture_output=True, text=True)
            committed = subprocess.run(("git", "rev-parse", "HEAD^{tree}"), cwd=repo,
                                       capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual(tested, committed)


class Gate(unittest.TestCase):
    def test_untracked_dependency_cannot_verify_a_commit_that_omits_it(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            (repo / "helper.py").write_text("value = 42\n")
            result = self.verify_run(repo, sys.executable, "-c", "import helper; assert helper.value == 42; print('1 passed')")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("MISSING", self.gate(repo, "HEAD").stdout)
            subprocess.run(["git", "add", "helper.py"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "include tested dependency"], cwd=repo, check=True)
            self.assertEqual(self.gate(repo, "HEAD").returncode, 0)

    def test_staged_additions_are_part_of_the_recorded_tree(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            (repo / "new.py").write_text("value = 42\n")
            subprocess.run(["git", "add", "new.py"], cwd=repo, check=True)
            self.verify_run(repo, sys.executable, "-B", "-c", "import new; assert new.value == 42; print('1 passed')")
            self.assertEqual(verify.tracked_tree(repo), verify.worktree_tree(repo))
            self.assertIn("MISSING", self.gate(repo, "HEAD").stdout)
            subprocess.run(["git", "commit", "-qm", "include staged addition"], cwd=repo, check=True)
            self.assertEqual(self.gate(repo, "HEAD").returncode, 0)

    def test_child_argument_separators_survive(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            result = self.verify_run(repo, sys.executable, "-c", "import sys; assert sys.argv[1:] == ['--', '-x']; print('1 passed')", "--", "-x")
            self.assertEqual(result.returncode, 0, result.stderr)

    def gate(self, cwd: Path, treeish: str):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify-run.py"), "--gate", treeish],
            cwd=cwd, capture_output=True, text=True)

    def verify_run(self, cwd: Path, *command: str):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify-run.py"), "--scope", "unit", "--"]
            + list(command),
            cwd=cwd, capture_output=True, text=True)

    def test_a_head_nothing_ran_against_does_not_pass_the_gate(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            result = self.gate(repo, "HEAD")
            self.assertEqual(result.returncode, 1)
            self.assertIn("MISSING", result.stdout)

    def test_a_head_with_a_green_run_passes_the_gate(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            self.verify_run(repo, sys.executable, "-c", "print('4 passed in 0.1s')")
            result = self.gate(repo, "HEAD")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("PASS", result.stdout)

    def test_a_typecheck_shaped_green_command_does_not_pass_the_gate(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            self.verify_run(repo, sys.executable, "-c", "print('no issues found')")
            result = self.gate(repo, "HEAD")
            self.assertEqual(result.returncode, 1)
            self.assertIn("VACUOUS", result.stdout)

    def test_evidence_does_not_survive_a_change_to_the_tree(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            self.verify_run(repo, sys.executable, "-c", "print('4 passed in 0.1s')")
            (repo / "a.py").write_text("x = 99\n", encoding="utf-8")
            subprocess.run(("git", "commit", "-aqm", "change"), cwd=repo, check=True,
                           capture_output=True, text=True)
            result = self.gate(repo, "HEAD")
            self.assertEqual(result.returncode, 1)
            self.assertIn("MISSING", result.stdout)

    def test_an_unresolvable_treeish_is_not_a_pass(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            result = self.gate(repo, "refs/heads/nope")
            self.assertEqual(result.returncode, 1)
            self.assertIn("UNRESOLVABLE", result.stdout)

    def test_a_broken_chain_denies_a_tree_that_would_otherwise_pass(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git_repo(repo)
            self.verify_run(repo, sys.executable, "-c", "print('4 passed in 0.1s')")
            path = repo / ".git" / verify.LEDGER_NAME
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"tree": "c" * 40, "exit": 0, "chain": "forged"}) + "\n")
            result = self.gate(repo, "HEAD")
            self.assertEqual(result.returncode, 1)
            self.assertIn("CHAIN BROKEN", result.stdout)


if __name__ == "__main__":
    unittest.main()

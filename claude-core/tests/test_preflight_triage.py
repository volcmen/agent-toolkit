#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "mr-preflight" / "preflight-triage.sh"
TICKET = "NTD" + "-" + "4321"
SESSION_LINK = "https://claude.ai/code/" + "session_" + "0123abcd"
GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.com"]
PYTHON_SHIM = """#!/bin/bash
case "$*" in
  *--collect-only*) echo 'tests/test_load.py::test_missing_file_returns_empty'; exit 0;;
  *"-m pytest"*) exec python3 -c 'import sys, tempfile, pathlib; sys.path.insert(0, "."); import tests.test_load as t; t.test_missing_file_returns_empty(pathlib.Path(tempfile.mkdtemp())); print("1 passed")';;
  *) exec python3 "$@";;
esac
"""
MISSING_SHIM = "#!/bin/bash\necho \"ModuleNotFoundError: No module named 'pandas'\" >&2; exit 2\n"
VITEST_SHIM = "#!/bin/bash\ncase \"$1\" in list) echo \"$2 > adds\";; run) echo '1 passed';; *) exit 1;; esac\n"
PADDING = "".join(f"def pad_{i}():\n    return {i}\n\n\n" for i in range(1, 8))


def git(repo: Path, *args: str, stdin: str | None = None) -> str:
    return subprocess.run(["git", *GIT_IDENTITY, *args], cwd=repo, input=stdin, capture_output=True, text=True, check=True).stdout


def write(path: Path, text: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if mode is not None:
        path.chmod(mode)


def install_venv_shim(repo: Path, body: str) -> None:
    write(repo / ".venv" / "bin" / "python", body, 0o755)


def build_repo(tmp: Path, *, ticket: bool = False, session_link: bool = False, runner: str = "ok") -> tuple[Path, Path]:
    repo = tmp / "repo"
    shims = tmp / "bin"
    write(shims / "glab", "#!/bin/bash\nexit 1\n", 0o755)
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo / ".gitignore", ".venv/\n")
    write(repo / "src" / "app.py", "def load(path):\n    with open(path) as handle:\n        return handle.read()\n\n\n" + PADDING + "def count(items):\n    return len(items)\n")
    write(repo / "src" / "legacy.py", "def legacy():\n    return 1\n")
    write(repo / "tests" / "test_app.py", "from src.app import count\n\n\ndef test_count():\n    assert count([1, 2]) == 2\n")
    write(repo / "docs" / "guide.md", "# Guide\n")
    if runner != "none":
        write(repo / "pytest.ini", "[pytest]\ntestpaths = tests\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    git(repo, "checkout", "-q", "-b", "feature")
    marker = f"  # {TICKET}" if ticket else ""
    write(repo / "src" / "app.py", "def load(path, strict=False):\n    try:\n        with open(path) as handle:\n            return handle.read()\n    except OSError:\n        return {}\n\n\n" + PADDING + "def count(items):\n    total = int(len(items))" + marker + "\n    return total\n")
    (repo / "src" / "legacy.py").unlink()
    write(repo / "tests" / "test_load.py", "from src.app import load\n\n\ndef test_missing_file_returns_empty(tmp_path):\n    assert load(tmp_path / 'absent') == {}\n")
    write(repo / "docs" / "guide.md", "# Guide\n\nRun `python3 -m pytest`.\n")
    if runner == "ok":
        install_venv_shim(repo, PYTHON_SHIM)
    elif runner == "missing":
        install_venv_shim(repo, MISSING_SHIM)
    body = "feature: tolerate missing files\n\n" + (f"Trailer: {SESSION_LINK}\n" if session_link else "")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-F", "-", stdin=body)
    return repo, shims


def build_js_repo(tmp: Path) -> tuple[Path, Path]:
    repo = tmp / "repo"
    shims = tmp / "bin"
    write(shims / "glab", "#!/bin/bash\nexit 1\n", 0o755)
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo / ".gitignore", "node_modules/\n")
    write(repo / "web" / "package.json", '{"name": "web", "devDependencies": {"vitest": "^2.0.0"}}\n')
    write(repo / "web" / "src" / "sum.js", "export const sum = (a, b) => a + b;\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    git(repo, "checkout", "-q", "-b", "feature")
    write(repo / "web" / "src" / "sum.js", "export const sum = (a, b) => Number(a) + Number(b);\n")
    for name in ("alpha", "gamma"):
        write(repo / "web" / "tests" / f"{name}.test.js", f"import {{ sum }} from '../src/sum.js';\ntest('{name}', () => expect(sum(1, 2)).toBe(3));\n")
    for name in ("beta", "delta"):
        write(repo / "web" / "tests" / f"{name}.test.js", "import { sum } from '../src/sum.js';\n" + "".join(f"test('{name} {i}', () => expect(sum({i}, 1)).toBe({i + 1}));\n" for i in range(80)))
    write(repo / "web" / "node_modules" / ".bin" / "vitest", VITEST_SHIM, 0o755)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "feature: coerce inputs")
    return repo, shims


def triage(repo: Path, shims: Path, **env: str) -> str:
    fixture_home = Path(env.get("HOME", str(shims.parent / "home")))
    helpers = ["skills/mr-preflight/harness-delta.py", "hooks/f17-comment-count.sh"]
    if "HOME" not in env:
        helpers.append("scripts/test-quality-scan.py")
    for relative in helpers:
        source = ROOT / relative
        destination = fixture_home / ".claude" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    inherited = {key: value for key, value in os.environ.items() if not key.startswith("PREFLIGHT_")}
    merged = {**inherited, "HOME": str(fixture_home), "PATH": f"{shims}:{os.environ['PATH']}", **env}
    result = subprocess.run(["bash", str(SCRIPT), str(repo), "main"], capture_output=True, text=True, env=merged, timeout=120)
    return result.stdout + result.stderr


def spill_dir(repo: Path) -> Path:
    path = Path(git(repo, "rev-parse", "--git-path", "mr-preflight").strip())
    return path if path.is_absolute() else repo / path


def runner_command(repo: Path, test_file: str) -> str:
    for line in (spill_dir(repo) / "runner.txt").read_text(encoding="utf-8").splitlines():
        fields = line.split("|")
        if fields[1] == test_file:
            return fields[2]
    raise AssertionError(f"no RUNNER line for {test_file}")


def run_in_detached_worktree(repo: Path, command: str, mutate: tuple[str, str, str] | None = None, link: str | None = None) -> list[subprocess.CompletedProcess[str]]:
    results = []
    with TemporaryDirectory() as tmp:
        worktree = Path(tmp) / "wt"
        git(repo, "worktree", "add", "--detach", "-q", str(worktree), "HEAD")
        try:
            assert not (worktree / ".venv").exists() and not (worktree / "web" / "node_modules").exists()
            if link:
                (worktree / link).symlink_to(repo / link)
            results.append(subprocess.run(["bash", "-c", command], cwd=worktree, capture_output=True, text=True))
            if mutate:
                rel, old, new = mutate
                target = worktree / rel
                target.write_text(target.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")
                results.append(subprocess.run(["bash", "-c", command], cwd=worktree, capture_output=True, text=True))
                subprocess.run(["git", "checkout", "--", rel], cwd=worktree, check=True)
                results.append(subprocess.run(["bash", "-c", command], cwd=worktree, capture_output=True, text=True))
        finally:
            git(repo, "worktree", "remove", "--force", str(worktree))
    return results


class PreflightTriage(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        cls.repo, cls.shims = build_repo(tmp / "clean")
        cls.spill = spill_dir(cls.repo)
        cls.first = triage(cls.repo, cls.shims)
        cls.runner_cmd = runner_command(cls.repo, "tests/test_load.py")
        cls.batch = triage(cls.repo, cls.shims, PREFLIGHT_BATCH="1")
        cls.override = triage(cls.repo, cls.shims, PREFLIGHT_TEST_CMD="make test FILE={file}")
        unknown_repo, unknown_shims = build_repo(tmp / "unknown", runner="none")
        cls.unknown = triage(unknown_repo, unknown_shims)
        write(unknown_repo / "pytest.ini", "[pytest]\n")
        install_venv_shim(unknown_repo, MISSING_SHIM)
        cls.unknown_then_missing = triage(unknown_repo, unknown_shims)
        install_venv_shim(unknown_repo, PYTHON_SHIM)
        cls.unknown_then_ok = triage(unknown_repo, unknown_shims)
        cls.dirty = triage(*build_repo(tmp / "dirty", ticket=True, session_link=True))
        cls.js_repo, js_shims = build_js_repo(tmp / "js")
        cls.js = triage(cls.js_repo, js_shims)
        cls.js_cmd = runner_command(cls.js_repo, "web/tests/alpha.test.js")
        cls.js_spill = spill_dir(cls.js_repo)
        cls.js_f7 = (cls.js_spill / "F7.ctx.txt").read_text(encoding="utf-8")
        cls.js_green = run_in_detached_worktree(cls.js_repo, cls.js_cmd, link="web/node_modules")[0]
        shutil.rmtree(cls.js_repo / "web" / "node_modules")
        cls.js_missing = triage(cls.js_repo, js_shims)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_batch_intersection_is_opt_in_and_bypasses_the_cache(self) -> None:
        self.assertIn("== F3 skipped", self.first)
        self.assertNotIn("F3 batch composition", self.first)
        self.assertIn("== F3 batch composition", self.batch)
        self.assertIn("UNKNOWN F3", self.batch)
        self.assertNotIn("== CACHED", self.batch)

    def test_runner_classifies_python_with_absolute_interpreters(self) -> None:
        venv = f"{self.repo.resolve()}/.venv/bin/python"
        self.assertIn(f"OK|tests/test_load.py|cd . && {venv} -m pytest tests/test_load.py -q -x|collected 1; config in .; interpreter ./.venv/bin/python", self.first)
        self.assertRegex(self.unknown, r"UNKNOWN\|tests/test_load\.py\|cd \. && /\S*python3 -m pytest tests/test_load\.py -q -x\|no pytest config or venv found above the file")
        self.assertIn("PASS F22 tests/test_load.py — runner/CI ref: 2:testpaths = tests", self.first)
        self.assertIn("src=2 tests=1 new_tests=1", self.first)
        for text in (self.first, self.unknown):
            self.assertRegex(text, r"(?m)^F7\|H\|", msg="F7 must stay triggered by changed tests")

    def test_runner_is_recomputed_on_every_invocation_while_the_core_stays_cached(self) -> None:
        self.assertNotIn("== CACHED", self.unknown)
        self.assertIn("== CACHED (identical base/head/script/rules/MR text/tools; RUNNER recomputed", self.unknown_then_missing)
        self.assertRegex(self.unknown_then_missing, r"MISSING-DEPS\|tests/test_load\.py\|cd \. && /\S+/\.venv/bin/python -m pytest tests/test_load\.py -q -x\|ModuleNotFoundError: No module named 'pandas'")
        self.assertIn("== CACHED", self.unknown_then_ok)
        self.assertIn("OK|tests/test_load.py|", self.unknown_then_ok)
        self.assertEqual(self.unknown_then_ok.count("== RUNNER"), 1)
        self.assertIn("== LEDGER", self.unknown_then_ok)

    def test_caller_supplied_command_is_expanded_per_file(self) -> None:
        self.assertIn("OVERRIDE|tests/test_load.py|make test FILE=tests/test_load.py|caller-supplied command; authoritative, not dry-run", self.override)

    def test_javascript_runner_uses_absolute_binaries_verified_by_listing(self) -> None:
        bin_dir = f"{self.js_repo.resolve()}/web/node_modules/.bin"
        self.assertIn(f"OK|web/tests/alpha.test.js|cd web && {bin_dir}/vitest run tests/alpha.test.js|listed 1 entr(y|ies) via vitest list tests/alpha.test.js; in a worktree first: ln -s {self.js_repo.resolve()}/web/node_modules <worktree>/web/node_modules", self.js)
        self.assertIn(f"UNVERIFIED|web/tests/gamma.test.js|cd web && {bin_dir}/vitest run tests/gamma.test.js|detected; dry listing capped at 3 files", self.js)
        self.assertEqual(len(re.findall(r"(?m)^(?:OK|UNVERIFIED|MISSING-DEPS|UNKNOWN)\|web/tests/", self.js)), 4)
        self.assertIn(f"MISSING-DEPS|web/tests/alpha.test.js|cd web && {bin_dir}/vitest run tests/alpha.test.js|no node_modules in web", self.js_missing)
        self.assertIn("== CACHED", self.js_missing)
        self.assertEqual(self.js_green.returncode, 0, self.js_green.stdout + self.js_green.stderr)
        self.assertIn("1 passed", self.js_green.stdout)

    def test_python_runner_command_mutates_red_and_green_inside_a_detached_worktree(self) -> None:
        green, red, green_again = run_in_detached_worktree(self.repo, self.runner_cmd, ("src/app.py", "return {}", "return None"))
        self.assertEqual(green.returncode, 0, green.stdout + green.stderr)
        self.assertNotEqual(red.returncode, 0)
        self.assertIn("AssertionError", red.stderr)
        self.assertEqual(green_again.returncode, 0, green_again.stdout + green_again.stderr)

    def test_context_windows_keep_hunk_identity_and_deleted_paths(self) -> None:
        f2 = (self.spill / "F2.ctx.txt").read_text(encoding="utf-8")
        f1 = (self.spill / "F1.ctx.txt").read_text(encoding="utf-8")
        f8 = (self.spill / "F8.ctx.txt").read_text(encoding="utf-8")
        self.assertRegex(f2, r"(?m)^>\+ 5 +except OSError:")
        self.assertRegex(f2, r"(?m)^ \+ 3 +with open\(path\) as handle:")
        self.assertRegex(f1, r"(?m)^>- 1 def load\(path\):")
        self.assertRegex(f1, r"(?m)^ \+ 1 def load\(path, strict=False\):")
        self.assertIn("-- src/legacy.py:-1", f1)
        self.assertRegex(f1, r"(?m)^>- 1 def legacy\(\):")
        self.assertRegex(f1, r"(?m)^ - 2 +return 1")
        numbers = [int(n) for n in re.findall(r"(?m)^[> ][+~-] (\d+) ", f8)]
        self.assertTrue(numbers and min(numbers) > 30, f"F8 window crossed into the first hunk: {f8}")

    def test_file_and_always_on_excerpts_cover_every_file_and_flag_truncation(self) -> None:
        f7 = (self.spill / "F7.ctx.txt").read_text(encoding="utf-8")
        f14 = (self.spill / "F14.ctx.txt").read_text(encoding="utf-8")
        always = (self.spill / "always-on.ctx.txt").read_text(encoding="utf-8")
        self.assertIn("-- tests/test_load.py (diff, 5 of 5 lines)", f7)
        self.assertIn("assert load(tmp_path / 'absent') == {}", f7)
        self.assertNotIn("TRUNCATED", f7)
        self.assertIn("Run `python3 -m pytest`.", f14)
        self.assertIn("-- src/app.py (diff,", always)
        self.assertIn("-- src/legacy.py (diff, 2 of 2 lines)", always)
        self.assertIn("return {}", always)
        self.assertNotIn("TRUNCATED", always)
        self.assertEqual(self.js_f7.count("-- web/tests/"), 4)
        self.assertIn("-- web/tests/beta.test.js (diff, 60 of 81 lines; TRUNCATED)", self.js_f7)
        self.assertIn("-- web/tests/delta.test.js (diff, 60 of 81 lines; TRUNCATED)", self.js_f7)
        self.assertIn("-- TRUNCATED: 0 file(s) not shown, 2 file(s) cut (≤60 lines each, ≤400 total)", self.js_f7)
        self.assertIn("F4/F5/F9/F16 — source diffs in", self.first)

    def test_mechanical_rows_toggle_on_ticket_keys_and_session_links(self) -> None:
        self.assertIn("PASS F17", self.first)
        self.assertIn("PASS F21", self.first)
        self.assertIn("FAIL F17 slop-comment-in-source", self.dirty)
        self.assertIn("FAIL F21 session-link-leak", self.dirty)
        self.assertIn("mech_fail=1", self.dirty)


class ScannerCache(unittest.TestCase):
    def test_scanner_installation_and_content_changes_invalidate_cached_rows(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, shims = build_repo(root / "fixture")
            home = root / "home"
            home.mkdir()
            scanner = home / ".claude/scripts/test-quality-scan.py"
            first = triage(repo, shims, HOME=str(home))
            cached = triage(repo, shims, HOME=str(home))
            self.assertIn("== CACHED", cached)
            write(scanner, "print('BLOCK pinned-seed tests/test_load.py:1 fixture')\n")
            installed = triage(repo, shims, HOME=str(home))
            self.assertNotIn("== CACHED", installed)
            self.assertIn("FAIL F19 pinned seed on the default exploration path", installed)
            write(scanner, "print('scanned: no findings')\n")
            changed = triage(repo, shims, HOME=str(home))
            self.assertNotIn("== CACHED", changed)
            self.assertIn("PASS F19-seed", changed)
            self.assertNotIn("FAIL F19", first)


if __name__ == "__main__":
    unittest.main()

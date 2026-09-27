#!/usr/bin/env python3

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "git-guards" / "pre-push-foreign-history"
ME = "me@example.com"
ME_TOO = "me@home.example"
THEM = "them@example.com"


def identity(email: str) -> dict:
    name = email.split("@")[0]
    return {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email,
            "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email}


class Clone:
    def __init__(self, path: Path, remote: Path, email: str, guarded: bool) -> None:
        self.path = path
        subprocess.run(("git", "clone", "-q", str(remote), str(path)), check=True, capture_output=True)
        self.git("config", "user.email", email)
        self.git("config", "user.name", email.split("@")[0])
        self.git("config", "guard.verifyRun", str(ROOT / "scripts" / "verify-run.py"))
        if guarded:
            hooks = path / ".git" / "hooks"
            hooks.mkdir(exist_ok=True)
            (hooks / "pre-push").symlink_to(GUARD)

    def git(self, *args: str, env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(("git", *args), cwd=self.path, capture_output=True, text=True,
                              check=check, env={**os.environ, **(env or {})})

    def commit(self, name: str, email: str | None = None) -> None:
        (self.path / name).write_text(name + "\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-qm", name, env=identity(email) if email else None)

    def amend(self, email: str | None = None) -> None:
        self.git("commit", "--amend", "-qm", "amended", env=identity(email) if email else None)

    def push(self, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        return self.git("push", "-q", *args, env=env, check=False)


class PrePushGuard(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.remote = root / "remote.git"
        subprocess.run(("git", "init", "-q", "--bare", "-b", "main", str(self.remote)), check=True)
        seed = Clone(root / "seed", self.remote, ME, guarded=False)
        seed.git("checkout", "-qb", "main")
        seed.commit("init")
        seed.git("push", "-q", "origin", "main")
        self.them = Clone(root / "them", self.remote, THEM, guarded=False)
        self.me = Clone(root / "me", self.remote, ME, guarded=True)

    def their_branch(self, name: str, *files: str) -> None:
        self.them.git("checkout", "-qb", name, "origin/main")
        for file in files:
            self.them.commit(file)
        self.them.git("push", "-q", "origin", name)
        self.me.git("fetch", "-q", "origin")

    def assertAllowed(self, result: subprocess.CompletedProcess) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)

    def assertRefused(self, result: subprocess.CompletedProcess, text: str) -> None:
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn(text, result.stderr)

    def test_my_branch_off_a_release_line_is_mine_to_rewrite(self) -> None:
        self.their_branch("release/7.1", "r1", "r2")
        self.me.git("checkout", "-qb", "chore/mine", "origin/release/7.1")
        self.me.commit("c1")
        self.assertAllowed(self.me.push("-u", "origin", "chore/mine"))
        self.me.commit("c2")
        self.assertAllowed(self.me.push("origin", "chore/mine"))
        self.me.amend()
        self.assertAllowed(self.me.push("--force-with-lease", "origin", "chore/mine"))

    def test_my_branch_stacked_on_theirs_is_mine_to_rewrite(self) -> None:
        self.their_branch("feature/theirs", "t1")
        self.me.git("checkout", "-qb", "feature/mine", "origin/feature/theirs")
        self.me.commit("m1")
        self.assertAllowed(self.me.push("-u", "origin", "feature/mine"))
        self.me.amend()
        self.assertAllowed(self.me.push("--force-with-lease", "origin", "feature/mine"))

    def test_their_branch_is_refused_even_fast_forward(self) -> None:
        self.their_branch("feature/theirs", "t1")
        self.me.git("checkout", "-qb", "feature/theirs", "origin/feature/theirs")
        self.me.commit("m1")
        self.assertRefused(self.me.push("origin", "feature/theirs"), "not mine")
        self.assertRefused(self.me.push("--dry-run", "origin", "feature/theirs"), "not mine")

    def test_replaying_their_commits_under_my_identity_is_refused(self) -> None:
        self.their_branch("feature/theirs", "t1")
        self.me.git("checkout", "-qb", "feature/theirs", "origin/feature/theirs")
        self.me.git("rebase", "-q", "--no-ff", "origin/main")
        self.assertRefused(self.me.push("--force", "origin", "feature/theirs"), "not mine")
        self.me.git("checkout", "-qb", "feature/backport", "origin/main")
        self.me.git("cherry-pick", "origin/feature/theirs")
        self.assertRefused(self.me.push("-u", "origin", "feature/backport"), "committed by me")
        self.me.git("config", "--add", "guard.ownBranch", "feature/backport")
        self.assertAllowed(self.me.push("-u", "origin", "feature/backport"))

    def test_second_identity_of_mine_needs_guard_email(self) -> None:
        self.me.git("checkout", "-qb", "feature/two", "origin/main")
        self.me.commit("a1")
        self.me.commit("a2", ME_TOO)
        self.assertAllowed(self.me.push("-u", "origin", "feature/two"))
        self.me.amend(ME_TOO)
        self.assertRefused(self.me.push("--force-with-lease", "origin", "feature/two"), ME_TOO)
        self.me.git("config", "--add", "guard.email", ME_TOO)
        self.assertAllowed(self.me.push("--force-with-lease", "origin", "feature/two"))

    def test_remote_deletion_is_refused(self) -> None:
        self.me.git("checkout", "-qb", "feature/gone", "origin/main")
        self.me.commit("g1")
        self.assertAllowed(self.me.push("-u", "origin", "feature/gone"))
        self.assertRefused(self.me.push("origin", ":feature/gone"), "deletion")

    def test_guard_allow_waives_one_matching_ref_only(self) -> None:
        self.their_branch("feature/theirs", "t1")
        self.me.git("checkout", "-qb", "feature/theirs", "origin/feature/theirs")
        self.me.commit("m1")
        refused = self.me.push("origin", "feature/theirs")
        self.assertRefused(refused, "GIT_GUARD_ALLOW='feature/theirs' git push")
        self.assertRefused(self.me.push("origin", "feature/theirs", env={"GIT_GUARD_ALLOW": "feature/other"}), "not mine")
        allowed = self.me.push("origin", "feature/theirs", env={"GIT_GUARD_ALLOW": "feature/theirs"})
        self.assertAllowed(allowed)
        self.assertIn("ALLOWED by GIT_GUARD_ALLOW", allowed.stderr)
        self.assertRefused(self.me.push("origin", ":feature/theirs"), "deletion")
        self.assertAllowed(self.me.push("origin", ":feature/theirs", env={"GIT_GUARD_ALLOW": "feature/*"}))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "ticket-key-guard.sh"
REPO = "/Users/someone/notraffic/devoperations"


def run(command: str, cwd: str = "/tmp") -> dict | None:
    payload = json.dumps({"tool_input": {"command": command}, "cwd": cwd})
    out = subprocess.run(("bash", str(HOOK)), input=payload, capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else None


def denied(result: dict | None) -> bool:
    return bool(result) and result["hookSpecificOutput"]["permissionDecision"] == "deny"


class TicketKeyGuard(unittest.TestCase):
    def test_a_new_branch_without_a_key_is_denied(self) -> None:
        self.assertTrue(denied(run(f"git -C {REPO} checkout -b fix/token-size")))
        self.assertTrue(denied(run(f"git -C {REPO} switch -c token-size origin/main")))
        self.assertTrue(denied(run(f"git -C {REPO} worktree add -b fix/token-size .worktrees/x origin/main")))

    def test_a_new_branch_with_a_key_or_a_release_name_passes(self) -> None:
        self.assertIsNone(run(f"git -C {REPO} checkout -b fix/PROJ-42-token-size"))
        self.assertIsNone(run(f"git -C {REPO} switch -c release/2610 origin/main"))
        self.assertIsNone(run(f"git -C {REPO} checkout main"))
        self.assertIsNone(run(f"git -C {REPO} worktree add -B ntst_8.0.0 .worktrees/x origin/ntst_8.0.0"))
        self.assertTrue(denied(run(f"git -C {REPO} checkout -b ntst_joel_test")))

    def test_mr_create_needs_a_keyed_title_and_branch(self) -> None:
        base = f"cd {REPO} && glab mr create --source-branch fix/PROJ-42-x"
        self.assertTrue(denied(run(base)))
        self.assertTrue(denied(run(base + " --title 'Keep the token small'")))
        self.assertIsNone(run(base + " --title '[FIX] PROJ-42: Keep the token small'"))
        unkeyed = f"cd {REPO} && glab mr create --source-branch fix/token --title '[FIX] PROJ-42: x'"
        self.assertTrue(denied(run(unkeyed)))

    def test_commands_outside_notraffic_are_ignored(self) -> None:
        self.assertIsNone(run("git checkout -b scratch", cwd="/tmp"))
        self.assertIsNone(run("glab mr create --title 'no key'", cwd="/tmp"))


if __name__ == "__main__":
    unittest.main()

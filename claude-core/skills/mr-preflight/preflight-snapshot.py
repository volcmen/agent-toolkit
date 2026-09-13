#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def git(repo: Path, *args: str, allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(repo), *args],
        capture_output=True, text=True, errors="surrogateescape", timeout=30,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat"},
    )
    if result.returncode not in allowed:
        raise ValueError(result.stderr.strip()[:500] or f"git {args[0]} exited {result.returncode}")
    return result


def revision(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").stdout.strip()


def changed_paths(raw: str) -> list[dict[str, str]]:
    fields = iter(raw.rstrip("\0").split("\0") if raw else [])
    records = []
    for status in fields:
        first = next(fields)
        if status.startswith(("R", "C")):
            records.append({"status": status, "old_path": first, "path": next(fields)})
        else:
            records.append({"status": status, "path": first})
    return records


def snapshot(repo: Path, target: str, branch: str | None, all_paths: bool) -> dict:
    root = Path(git(repo, "rev-parse", "--show-toplevel").stdout.strip())
    head = revision(root, "HEAD")
    target_sha = revision(root, target)
    if branch and revision(root, branch) != head:
        raise ValueError(f"requested branch {branch!r} does not match checkout HEAD")
    bases = git(root, "merge-base", "--all", target_sha, head).stdout.splitlines()
    if len(bases) != 1:
        raise ValueError("review needs one unambiguous merge base")
    base = bases[0]
    status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
    changes = changed_paths(git(root, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", base, head, "--").stdout)
    whitespace = git(root, "diff", "--no-ext-diff", "--no-textconv", "--check", base, head, "--", allowed=(0, 2))
    instruction_paths = set()
    for ref in (base, head):
        names = git(root, "ls-tree", "-r", "--name-only", "-z", ref).stdout.split("\0")
        for name in names:
            path = Path(name)
            if ".claude/rules/" in name:
                instruction_paths.add(name)
            elif path.name in {"CLAUDE.md", "AGENTS.md"}:
                if any(Path(c[key]).is_relative_to(path.parent) for c in changes for key in ("path", "old_path") if key in c):
                    instruction_paths.add(name)
    cap = len(changes) if all_paths else 40
    policy_cap = len(instruction_paths) if all_paths else 20
    identity = json.dumps([str(root), base, head, target_sha], separators=(",", ":"))
    if head != revision(root, "HEAD") or target_sha != revision(root, target) or status != git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout:
        raise ValueError("repository changed during snapshot; retry against stable inputs")
    return {
        "scope": "committed HEAD only; offline inventory, not a readiness verdict",
        "repo": str(root),
        "branch": git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip(),
        "head": head,
        "base": base,
        "target_ref": target,
        "target": target_sha,
        "review_key": hashlib.sha256(identity.encode()).hexdigest()[:20],
        "review_key_scope": "repository and commits only; not test/dependency/environment evidence",
        "local_edits_excluded": bool(status),
        "local_status": status.replace("\0", "\n")[:1000],
        "local_status_truncated": len(status) > 1000,
        "change_count": len(changes),
        "changes": changes[:cap],
        "paths_omitted": max(0, len(changes) - cap),
        "instruction_paths": sorted(instruction_paths)[:policy_cap],
        "instruction_paths_omitted": max(0, len(instruction_paths) - policy_cap),
        "expand_paths": "rerun with --all-paths" if len(changes) > cap or len(instruction_paths) > policy_cap else None,
        "whitespace": {"exit_code": whitespace.returncode, "output": whitespace.stdout[:1500], "truncated": len(whitespace.stdout) > 1500},
        "tests": "not run",
        "remote": "not queried; target ref may be stale",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only inventory for a committed branch review.")
    parser.add_argument("repo", nargs="?", default=".")
    parser.add_argument("target", nargs="?", default="origin/main")
    parser.add_argument("--branch")
    parser.add_argument("--all-paths", action="store_true")
    args = parser.parse_args()
    try:
        result = snapshot(Path(args.repo).expanduser().resolve(), args.target, args.branch, args.all_paths)
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"error": str(exc), "readiness": "INCOMPLETE"}))
        return 2
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Run a verification command and record what was verified, against which inputs.

    verify-run.py [--scope NAME] -- pytest tests -q
    verify-run.py --show
    verify-run.py --gate <tree-ish>

Writes one JSON line per run to `<git-common-dir>/guard-verify.jsonl`: the tree
hash the command ran against, whether the worktree was dirty, the resolved
dependency digest, the runner identity, the command, its exit status, duration,
any test counts parsed from its output, and a chain hash over the previous
entry so a rewritten or backdated ledger is detectable.

`--gate` answers one question for `pre-push`: does this tree have evidence?
It never answers "unknown" as success. Its states are MISSING, FAIL, FLAKY,
VACUOUS, STALE and PASS, and only PASS exits zero.

What this is and is not. Under an agent that owns this filesystem and these
credentials, the wrapper, the ledger and the chain are all writable by the
subject, so this is advisory: it converts a careless "it is tested" from an
omission into a deliberate fabrication, and it catches the honest mistakes —
the stale tree, the vacuous run, the green that followed a red, the suite that
was never re-run after the dependencies moved. It is not an authorization
boundary and it does not establish that the tests are any good.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

LEDGER_NAME = "guard-verify.jsonl"

COUNT_PATTERNS = (
    # pytest: "31 passed, 1 skipped in 0.42s"
    (r"(?P<passed>\d+) passed", "passed"),
    (r"(?P<failed>\d+) failed", "failed"),
    (r"(?P<errors>\d+) error", "errors"),
    (r"(?P<skipped>\d+) skipped", "skipped"),
    # unittest: "Ran 12 tests in 0.03s"
    (r"Ran (?P<ran>\d+) tests?", "ran"),
    # vitest / jest: "Tests  1428 passed (1430)"
    (r"Tests?\s+(?P<vitest>\d+) passed", "vitest_passed"),
)


def parse_counts(output: str) -> dict:
    """Extract test counts from a runner's output. Pure."""
    counts: dict = {}
    for pattern, key in COUNT_PATTERNS:
        match = None
        for match in re.finditer(pattern, output):
            pass
        if match is not None:
            counts[key] = int(next(v for v in match.groupdict().values() if v is not None))
    return counts


def looks_empty(counts: dict) -> bool:
    """True when nothing actually ran, so a zero exit means nothing. Pure."""
    ran = (counts.get("passed", 0) + counts.get("failed", 0)
           + counts.get("errors", 0) + counts.get("ran", 0)
           + counts.get("vitest_passed", 0))
    return ran == 0


def chain(previous_hash: str, entry: dict) -> str:
    """Hash of this entry chained onto the previous one. Pure."""
    payload = previous_hash + json.dumps(entry, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_ledger(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except ValueError:
            entries.append({"corrupt": line[:120]})
    return entries


def verified_trees(entries: list[dict], require_nonempty: bool = True) -> set:
    """Tree hashes with a green, non-vacuous run. Pure."""
    trees = set()
    for entry in entries:
        if entry.get("exit") != 0 or not entry.get("tree"):
            continue
        if require_nonempty and entry.get("empty"):
            continue
        trees.add(entry["tree"])
    return trees


LOCKFILES = (
    "uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
    "Cargo.lock", "go.sum", "Gemfile.lock",
)

MISSING, FAIL, FLAKY, VACUOUS, STALE, PASS = (
    "MISSING", "FAIL", "FLAKY", "VACUOUS", "STALE", "PASS")


def is_green(entry: dict) -> bool:
    """A run that both exited zero and counted tests. Pure."""
    return entry.get("exit") == 0 and not entry.get("empty")


def tree_status(entries: list[dict], tree: str, deps: str = "") -> tuple[str, str]:
    """Classify the evidence a ledger holds for one tree. Pure.

    Unknown is never success: a tree nothing ran against is MISSING, a scope
    whose last authorized attempt failed is FAIL, a scope that only passed
    after failing is FLAKY, a green run that counted no tests is VACUOUS, and
    a pass taken under different resolved dependencies is STALE.
    """
    relevant = [e for e in entries if e.get("tree") == tree]
    if not relevant:
        return MISSING, f"no run recorded against tree {tree[:12]}"

    scopes: dict = {}
    for entry in relevant:
        scopes.setdefault(entry.get("scope", ""), []).append(entry)

    passing, flaky, vacuous = [], [], []
    for scope, runs in scopes.items():
        greens = [r for r in runs if is_green(r)]
        if not greens:
            reds = [r for r in runs if r.get("exit") != 0]
            if reds:
                return FAIL, f"scope {scope or '(unnamed)'} last failed with exit {reds[-1]['exit']}"
            vacuous.append(scope)
            continue
        last_green = runs.index(greens[-1])
        after = [r for r in runs[last_green + 1:] if r.get("exit") != 0]
        if after:
            return FAIL, f"scope {scope or '(unnamed)'} failed after its last green run"
        if any(r.get("exit") != 0 for r in runs[:last_green]):
            flaky.append(scope)
        passing.append(greens[-1])

    if not passing:
        return VACUOUS, f"every run against {tree[:12]} exited zero without counting a test"
    if flaky:
        return FLAKY, f"scope {flaky[0] or '(unnamed)'} passed only after a failure"
    if deps and all(p.get("deps", "") not in ("", deps) for p in passing):
        return STALE, "every passing run predates the current dependency digest"
    return PASS, "{} green run(s) across scope(s): {}".format(
        len(passing), ", ".join(sorted(p.get("scope", "") or "(unnamed)" for p in passing)))


def deps_digest(root: Path) -> str:
    """Digest of the lockfiles present, as the resolved-dependency identity."""
    hasher = hashlib.sha256()
    for name in LOCKFILES:
        candidate = root / name
        if candidate.is_file():
            hasher.update(name.encode("utf-8"))
            hasher.update(hashlib.sha256(candidate.read_bytes()).digest())
    return hasher.hexdigest()[:16]


def runner_identity() -> str:
    """The interpreter and platform the run happened on."""
    import platform
    return f"{platform.python_version()}/{platform.machine()}/{platform.system()}"


def untracked_paths(cwd: Path | None = None) -> list[str]:
    out = git("ls-files", "--others", "--exclude-standard", cwd=cwd)
    return [line for line in out.splitlines() if line]


def chain_breaks(entries: list[dict]) -> list[int]:
    """Indexes whose recorded chain hash does not match a recomputation. Pure."""
    breaks, previous = [], ""
    for index, entry in enumerate(entries):
        recorded = entry.get("chain")
        body = {k: v for k, v in entry.items() if k != "chain"}
        expected = chain(previous, body)
        if recorded != expected:
            breaks.append(index)
        previous = recorded or expected
    return breaks


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(("git",) + args, cwd=cwd, capture_output=True,
                          text=True, check=True).stdout.strip()


def _tree_with(add_args: tuple, cwd: Path | None = None) -> str:
    import os
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))
        root = Path(git("rev-parse", "--show-toplevel", cwd=cwd))
        subprocess.run(("git", "read-tree", "HEAD"), cwd=root, env=env,
                       capture_output=True, text=True, check=False)
        subprocess.run(("git", "add") + add_args, cwd=root, env=env,
                       capture_output=True, text=True, check=True)
        return subprocess.run(("git", "write-tree"), cwd=root, env=env,
                              capture_output=True, text=True,
                              check=True).stdout.strip()


def tracked_tree(cwd: Path | None = None) -> str:
    """Tree of tracked files as they are on disk.

    This is the identity `pre-push` can compare against, because it equals the
    committed tree once the change is committed — untracked scratch files, which
    every working clone accumulates, do not move it.
    """
    return _tree_with(("-u",), cwd)


def worktree_tree(cwd: Path | None = None) -> str:
    """Tree of everything on disk, untracked files included.

    A test run is only meaningful against the bytes that were actually there: a
    new module the tests import is untracked until it is added.
    """
    return _tree_with(("-A",), cwd)


def ledger_path(cwd: Path | None = None) -> Path:
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=cwd)
    return Path(common) / LEDGER_NAME


def append(path: Path, entry: dict) -> dict:
    entries = read_ledger(path)
    previous = entries[-1].get("chain", "") if entries else ""
    entry = dict(entry)
    entry["chain"] = chain(previous, entry)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    return entry


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--scope", default="")
    parser.add_argument("--show", action="store_true")
    parser.add_argument("--gate", default="")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    if args.gate:
        try:
            tree = git("rev-parse", f"{args.gate}^{{tree}}")
            root = Path(git("rev-parse", "--show-toplevel"))
        except subprocess.CalledProcessError:
            print(f"UNRESOLVABLE {args.gate}: not a tree-ish in this repository")
            return 1
        entries = read_ledger(ledger_path())
        status, reason = tree_status(entries, tree, deps_digest(root))
        breaks = chain_breaks(entries)
        print(f"{status} {tree[:12]}: {reason}")
        if breaks:
            print(f"CHAIN BROKEN at entries: {breaks}")
        return 0 if status == PASS and not breaks else 1

    if args.show:
        path = ledger_path()
        entries = read_ledger(path)
        breaks = chain_breaks(entries)
        print(f"{path}: {len(entries)} entries, {len(verified_trees(entries))} verified trees")
        if breaks:
            print(f"CHAIN BROKEN at entries: {breaks}")
        for entry in entries[-8:]:
            print("  {tree:.12} exit={exit} {counts} {cmd}".format(
                tree=entry.get("tree", "?"), exit=entry.get("exit"),
                counts=entry.get("counts"), cmd=" ".join(entry.get("cmd", []))[:60]))
        return 1 if breaks else 0

    command = [a for a in args.command if a != "--"]
    if not command:
        parser.error("nothing to run: verify-run.py [--scope NAME] -- <command>")

    root = Path(git("rev-parse", "--show-toplevel"))
    tree = tracked_tree()
    tree_all = worktree_tree()
    untracked = untracked_paths()
    started = time.time()
    process = subprocess.run(command, text=True, capture_output=True)
    duration = round(time.time() - started, 3)
    sys.stdout.write(process.stdout)
    sys.stderr.write(process.stderr)

    output = process.stdout + process.stderr
    counts = parse_counts(output)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "tree": tree,
        "tree_all": tree_all,
        "dirty": tree != git("rev-parse", "HEAD^{tree}"),
        "untracked": untracked[:20],
        "deps": deps_digest(root),
        "runner": runner_identity(),
        "scope": args.scope,
        "cmd": command,
        "exit": process.returncode,
        "duration_s": duration,
        "counts": counts,
        "empty": looks_empty(counts),
        "output_sha256": hashlib.sha256(output.encode("utf-8", "replace")).hexdigest(),
    }
    append(ledger_path(), entry)

    if process.returncode == 0 and entry["empty"]:
        print("\nverify-run: exit 0 but no tests were counted — recorded as vacuous.",
              file=sys.stderr)
    if process.returncode == 0 and entry["untracked"]:
        print("verify-run: untracked files were present, so this run is not evidence "
              "for the committed tree until they are added or removed:",
              file=sys.stderr)
        for path in entry["untracked"][:5]:
            print(f"  {path}", file=sys.stderr)
    return process.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

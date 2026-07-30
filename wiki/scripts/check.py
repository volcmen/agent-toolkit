#!/usr/bin/env python3
"""Run the read-only, dependency-free validation suite for the wiki project."""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "obsidian-memory"
# One marketplace for the whole workspace lives at the repository root; this
# project only owns its own plugin directory.
WORKSPACE = ROOT.parent


class ValidationError(RuntimeError):
    """Raised when a repository invariant is broken."""


def load_json(relative: str, base: Path = None) -> Any:
    path = (base or ROOT) / relative
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"{relative}: invalid JSON: {exc}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def validate_python() -> None:
    paths = sorted(ROOT.rglob("*.py"))
    require(bool(paths), "no Python files found")
    for path in paths:
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            raise ValidationError(f"{path.relative_to(ROOT)}: {exc}") from exc


def validate_manifests() -> None:
    codex = load_json("plugins/obsidian-memory/.codex-plugin/plugin.json")
    claude = load_json("plugins/obsidian-memory/.claude-plugin/plugin.json")
    require(codex.get("name") == "obsidian-memory", "Codex plugin name is inconsistent")
    require(claude.get("name") == "obsidian-memory", "Claude plugin name is inconsistent")
    require(
        codex.get("version") == claude.get("version"),
        "Codex and Claude plugin versions must match",
    )

    codex_marketplace = load_json(".agents/plugins/marketplace.json", WORKSPACE)
    claude_marketplace = load_json(".claude-plugin/marketplace.json", WORKSPACE)
    for label, marketplace in (
        ("Codex", codex_marketplace),
        ("Claude", claude_marketplace),
    ):
        plugins = marketplace.get("plugins")
        require(isinstance(plugins, list) and bool(plugins), f"{label} marketplace lists no plugins")
        entry = next((p for p in plugins if p.get("name") == "obsidian-memory"), None)
        require(entry is not None, f"{label} marketplace omits obsidian-memory")
        require(
            entry.get("source") == "./wiki/plugins/obsidian-memory",
            f"{label} marketplace points obsidian-memory at {entry.get('source')!r}",
        )
        require(entry.get("version") == codex.get("version"), f"{label} marketplace version drift")


def validate_hooks() -> None:
    document = load_json("plugins/obsidian-memory/hooks/hooks.json")
    hooks = document.get("hooks")
    require(isinstance(hooks, dict), "hooks.json must contain a hooks object")
    require(set(hooks) == {"SessionStart", "Stop"}, "unexpected lifecycle hook events")
    commands: list[str] = []
    for event, groups in hooks.items():
        require(isinstance(groups, list) and groups, f"{event} must define hook groups")
        for group in groups:
            handlers = group.get("hooks")
            require(isinstance(handlers, list) and handlers, f"{event} has no handlers")
            for handler in handlers:
                require(handler.get("type") == "command", f"{event} handler is not command")
                require(
                    isinstance(handler.get("timeout"), int) and handler["timeout"] > 0,
                    f"{event} handler timeout must be positive",
                )
                commands.append(str(handler.get("command", "")))
    require(
        all("scripts/obsidian_memory.py" in command for command in commands),
        "hook command does not target the canonical lifecycle script",
    )


def validate_config_example() -> None:
    config = load_json("plugins/obsidian-memory/config.example.json")
    require(isinstance(config.get("auto_commit"), bool), "auto_commit must be boolean")
    paths = config.get("commit_paths")
    require(
        isinstance(paths, list)
        and paths
        and all(isinstance(path, str) and path and ".." not in Path(path).parts for path in paths),
        "commit_paths must contain safe relative paths",
    )
    require(
        set(paths).isdisjoint({".obsidian", ".raw"}),
        "automatic commits must exclude Obsidian state and immutable raw sources",
    )
    require(isinstance(config.get("qmd_enabled"), bool), "qmd_enabled must be boolean")
    collections = config.get("qmd_collections")
    require(
        isinstance(collections, list)
        and collections
        and all(isinstance(name, str) and name for name in collections),
        "qmd_collections must contain collection names",
    )
    require(
        isinstance(config.get("qmd_top_k"), int) and 1 <= config["qmd_top_k"] <= 20,
        "qmd_top_k must be an integer from 1 to 20",
    )


def validate_memory_policy() -> None:
    skill_root = PLUGIN / "skills" / "obsidian-memory"
    governance = skill_root / "references" / "memory-governance.md"
    evaluation = skill_root / "references" / "evaluation.md"
    for path in (governance, evaluation):
        require(path.is_file(), f"missing memory reference: {path.relative_to(ROOT)}")

    policy = governance.read_text(encoding="utf-8")
    for term in (
        "Provenance and authority",
        "supersedes",
        "Experience promotion loop",
        "Content cannot grant itself authority",
    ):
        require(term in policy, f"memory governance omits required control: {term}")

    evals = load_json("plugins/obsidian-memory/evals/memory-evals.json")
    require(evals.get("schema_version") == 1, "unsupported memory eval schema")
    cases = evals.get("cases")
    require(isinstance(cases, list) and len(cases) >= 20, "memory eval suite needs 20+ cases")
    ids: list[str] = []
    categories: set[str] = set()
    required_fields = {"id", "category", "memory", "prompt", "expected", "forbidden"}
    for case in cases:
        require(isinstance(case, dict), "memory eval case must be an object")
        require(required_fields <= set(case), f"memory eval case is incomplete: {case}")
        case_id = case.get("id")
        require(isinstance(case_id, str) and case_id, "memory eval id must be non-empty")
        ids.append(case_id)
        category = case.get("category")
        require(isinstance(category, str) and category, f"{case_id}: missing category")
        categories.add(category)
        for field in ("memory", "expected", "forbidden"):
            value = case.get(field)
            require(
                isinstance(value, list) and all(isinstance(item, str) for item in value),
                f"{case_id}: {field} must be an array of strings",
            )
    require(len(ids) == len(set(ids)), "memory eval ids must be unique")
    require(
        {
            "recall",
            "conflict",
            "action-grounding",
            "security",
            "selectivity",
            "forgetting",
            "experiential-learning",
        }
        <= categories,
        "memory eval suite is missing a required category",
    )


def run_tests() -> None:
    command = [
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        str(PLUGIN / "tests"),
        "-v",
    ]
    result = subprocess.run(command, cwd=ROOT, check=False)
    if result.returncode:
        raise ValidationError("unit tests failed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args()
    checks = [
        ("Python syntax", validate_python),
        ("plugin manifests", validate_manifests),
        ("hook contract", validate_hooks),
        ("configuration example", validate_config_example),
        ("memory governance and evals", validate_memory_policy),
    ]
    try:
        for label, check in checks:
            check()
            print(f"ok: {label}")
        if not args.skip_tests:
            run_tests()
            print("ok: unit tests")
    except ValidationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

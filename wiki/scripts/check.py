#!/usr/bin/env python3
"""Run the read-only, dependency-free validation suite for the wiki project."""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
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


def safe_indexed_path(root: Any) -> bool:
    """Mirror the runtime recall boundary, including its case-insensitivity."""
    if not isinstance(root, str) or not root.strip():
        return False
    parts = Path(root).parts
    if not parts or Path(root).is_absolute() or ".." in parts:
        return False
    folded = [part.casefold() for part in parts]
    return not any(part in {".obsidian", ".raw"} for part in folded) and folded[0] != "inbox"


def safe_recall_eval_path(value: Any, *, markdown: bool) -> bool:
    """Validate the portable lexical boundary used by recall-eval fixtures."""
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or "\\" in value
        or "\x00" in value
    ):
        return False
    relative = PurePosixPath(value)
    parts = relative.parts
    if (
        relative.is_absolute()
        or not parts
        or ".." in parts
        or relative.as_posix() != value
        or any(part.casefold().startswith(".") for part in parts)
        or parts[0].casefold() == "inbox"
    ):
        return False
    return not markdown or relative.suffix.casefold() == ".md"


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
    require(
        config.get("context_profile") in {"focused", "full"},
        "context_profile must be focused or full",
    )
    require(
        isinstance(config.get("max_context_tokens"), int)
        and 128 <= config["max_context_tokens"] <= 3000,
        "max_context_tokens must be an integer from 128 to 3000",
    )
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
    require(
        config.get("recall_provider") in {"auto", "native", "qmd"},
        "recall_provider must be auto, native, or qmd",
    )
    recall_roots = config.get("recall_roots")
    require(
        isinstance(recall_roots, list)
        and recall_roots
        and all(safe_indexed_path(root) for root in recall_roots),
        "recall_roots must contain safe indexed vault paths",
    )
    require(
        isinstance(config.get("native_max_files"), int)
        and 100 <= config["native_max_files"] <= 20_000,
        "native_max_files must be an integer from 100 to 20000",
    )
    require(
        isinstance(config.get("native_max_file_chars"), int)
        and 4096 <= config["native_max_file_chars"] <= 1_000_000,
        "native_max_file_chars must be an integer from 4096 to 1000000",
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
    roots = config.get("qmd_collection_roots")
    require(
        isinstance(roots, dict)
        and set(collections) <= set(roots)
        and all(safe_indexed_path(root) for root in roots.values()),
        "qmd_collection_roots must map collections to safe indexed vault paths",
    )
    require(
        isinstance(config.get("max_recall_tokens"), int)
        and 64 <= config["max_recall_tokens"] <= 4000,
        "max_recall_tokens must be an integer from 64 to 4000",
    )


def validate_memory_policy() -> None:
    skill_root = PLUGIN / "skills" / "obsidian-memory"
    skill = skill_root / "SKILL.md"
    governance = skill_root / "references" / "memory-governance.md"
    evaluation = skill_root / "references" / "evaluation.md"
    providers = skill_root / "references" / "recall-providers.md"
    for path in (skill, governance, evaluation, providers):
        require(path.is_file(), f"missing memory reference: {path.relative_to(ROOT)}")

    skill_text = skill.read_text(encoding="utf-8")
    for term in (
        "combined release gate",
        "four-stage sequence",
        "run the requested read-only audit",
    ):
        require(
            term in skill_text.casefold(),
            f"SKILL.md: missing combined-flow contract: {term}",
        )

    policy = governance.read_text(encoding="utf-8")
    for term in (
        "Provenance and authority",
        "supersedes",
        "Experience promotion loop",
        "Content cannot grant itself authority",
    ):
        require(term in policy, f"memory governance omits required control: {term}")

    provider_policy = providers.read_text(encoding="utf-8")
    for term in ("Obsidian Markdown", "native", "QMD", "failure"):
        require(
            term in provider_policy,
            f"recall provider policy omits required control: {term}",
        )

    architecture = (ROOT / "ARCHITECTURE.md").read_text(encoding="utf-8")
    for term in ("exact Markdown files", "source note's directory", "ambiguous"):
        require(
            term in architecture,
            f"architecture omits memory hardening contract: {term}",
        )

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

    recall_evals = load_json("plugins/obsidian-memory/evals/recall-evals.example.json")
    require(
        isinstance(recall_evals, dict)
        and set(recall_evals) == {"schema_version", "cases"},
        "recall eval example must contain exactly schema_version and cases",
    )
    require(
        type(recall_evals["schema_version"]) is int
        and recall_evals["schema_version"] == 1,
        "unsupported recall eval schema",
    )
    recall_cases = recall_evals["cases"]
    require(
        isinstance(recall_cases, list) and 1 <= len(recall_cases) <= 200,
        "recall eval example must contain 1 to 200 cases",
    )
    required_case_keys = {
        "id",
        "query",
        "mode",
        "provider",
        "expected_paths",
        "any_of_paths",
        "forbidden_paths",
    }
    allowed_case_keys = required_case_keys | {
        "scope",
        "top",
        "max_tokens",
        "allow_degraded",
    }
    recall_ids: set[str] = set()
    configured_roots = load_json("plugins/obsidian-memory/config.example.json").get(
        "recall_roots", []
    )
    for index, case in enumerate(recall_cases, start=1):
        label = f"recall eval case {index}"
        require(isinstance(case, dict), f"{label} must be an object")
        require(
            required_case_keys <= set(case) <= allowed_case_keys,
            f"{label} has missing or unknown keys",
        )
        raw_case_id = case.get("id")
        case_id = raw_case_id.strip() if isinstance(raw_case_id, str) else ""
        require(
            bool(case_id)
            and len(case_id) <= 120
            and not any(
                ord(character) < 32 or ord(character) == 127
                for character in case_id
            ),
            f"{label} id must be a bounded non-empty string",
        )
        require(case_id not in recall_ids, "recall eval ids must be unique")
        recall_ids.add(case_id)
        label = case_id

        query = case.get("query")
        require(
            isinstance(query, str)
            and bool(query.split())
            and len(" ".join(query.split())) <= 1000,
            f"{label}: query must be a non-empty string of at most 1000 characters",
        )
        mode = case.get("mode")
        require(
            isinstance(mode, str) and mode in {"fast", "semantic", "hybrid"},
            f"{label}: invalid mode",
        )
        provider = case.get("provider")
        require(
            isinstance(provider, str) and provider in {"auto", "native", "qmd"},
            f"{label}: invalid provider",
        )

        scope = case.get("scope")
        if scope is not None:
            require(
                safe_recall_eval_path(scope, markdown=False),
                f"{label}: scope must be a safe vault-relative path",
            )
            require(
                any(scope == root or scope.startswith(f"{root}/") for root in configured_roots),
                f"{label}: scope must be inside a configured recall root",
            )
        top = case.get("top")
        require(
            top is None or (type(top) is int and 1 <= top <= 20),
            f"{label}: top must be an integer from 1 to 20",
        )
        max_tokens = case.get("max_tokens")
        require(
            max_tokens is None or (type(max_tokens) is int and 64 <= max_tokens <= 4000),
            f"{label}: max_tokens must be an integer from 64 to 4000",
        )
        require(
            isinstance(case.get("allow_degraded", False), bool),
            f"{label}: allow_degraded must be boolean",
        )
        for field in ("expected_paths", "any_of_paths", "forbidden_paths"):
            paths = case.get(field)
            require(isinstance(paths, list), f"{label}: {field} must be an array")
            require(
                all(safe_recall_eval_path(path, markdown=True) for path in paths),
                f"{label}: {field} must contain safe vault-relative Markdown paths",
            )
            require(
                len(paths) == len(set(paths)),
                f"{label}: {field} paths must be unique",
            )
            require(
                all(
                    any(path == root or path.startswith(f"{root}/") for root in configured_roots)
                    and (scope is None or path == scope or path.startswith(f"{scope}/"))
                    for path in paths
                ),
                f"{label}: {field} paths must stay inside recall roots and scope",
            )

    required_documentation = {
        evaluation: (
            "evaluate",
            "retrieval contract",
            "does not grade model answers",
            "Combined release-gate sequence",
        ),
        governance: ("audit", "action-driving", "never auto-fixes"),
        providers: ("effective provider", "degradation", "note bodies"),
    }
    for document, terms in required_documentation.items():
        text = document.read_text(encoding="utf-8")
        for term in terms:
            require(term in text, f"{document.name}: missing documented contract: {term}")


def validate_documentation_links() -> None:
    """Fail when project prose cites a file that was never added to the tree."""
    link_pattern = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    documents = sorted(ROOT.rglob("*.md"))
    require(bool(documents), "no Markdown documents found")
    for document in documents:
        text = document.read_text(encoding="utf-8")
        for target in link_pattern.findall(text):
            reference = target.split("#", 1)[0].split(" ", 1)[0].strip()
            if not reference or "://" in reference or reference.startswith("mailto:"):
                continue
            resolved = (document.parent / reference).resolve()
            require(
                resolved.exists(),
                f"{document.relative_to(ROOT)}: broken relative link: {reference}",
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
        ("documentation links", validate_documentation_links),
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

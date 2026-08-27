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
# Keep these dependency-free bounds mirrored in the plugin runtime.
MAX_PROJECTED_CONFIG_ENTRIES = 64
MAX_PROJECTED_CONFIG_NAME_CHARS = 120
MAX_PROJECTED_CONFIG_PATH_CHARS = 1_000
MAX_RECALL_EVAL_CASES = 200
MAX_RECALL_EVAL_FIXTURE_CHARS = 1_000_000
MAX_RECALL_EVAL_PATHS = 20
MAX_RECALL_EVAL_PATH_CHARS = 1_000
RECALL_EVAL_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}")


class ValidationError(RuntimeError):
    """Raised when a repository invariant is broken."""


def load_json(
    relative: str, base: Path = None, *, max_chars: int | None = None
) -> Any:
    path = (base or ROOT) / relative
    try:
        if max_chars is None:
            text = path.read_text(encoding="utf-8")
        else:
            with path.open(encoding="utf-8") as handle:
                text = handle.read(max_chars + 1)
            if len(text) > max_chars:
                raise ValidationError(
                    f"{relative}: JSON exceeds {max_chars} characters"
                )
        return json.loads(text)
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValidationError(f"{relative}: invalid JSON: {exc}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def safe_indexed_path(root: Any) -> bool:
    """Mirror the runtime recall boundary, including its case-insensitivity."""
    if (
        not isinstance(root, str)
        or not root.strip()
        or len(root) > MAX_PROJECTED_CONFIG_PATH_CHARS
    ):
        return False
    relative = PurePosixPath(root)
    parts = relative.parts
    if not parts or relative.is_absolute() or ".." in parts:
        return False
    folded = [part.casefold() for part in parts]
    return not any(part.startswith(".") for part in folded) and folded[0] != "inbox"


def relative_path_is_within(path: str, root: str) -> bool:
    path_parts = PurePosixPath(path).parts
    root_parts = PurePosixPath(root).parts
    return path_parts[: len(root_parts)] == root_parts


def safe_collection_name(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= MAX_PROJECTED_CONFIG_NAME_CHARS
        and RECALL_EVAL_ID_RE.fullmatch(value) is not None
    )


def safe_recall_eval_path(value: Any, *, markdown: bool) -> bool:
    """Validate the portable lexical boundary used by recall-eval fixtures."""
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_RECALL_EVAL_PATH_CHARS
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


def validate_hook_document(document: Any) -> None:
    require(isinstance(document, dict), "hooks.json must contain an object")
    hooks = document.get("hooks")
    require(isinstance(hooks, dict), "hooks.json must contain a hooks object")
    require(set(hooks) == {"SessionStart", "Stop"}, "unexpected lifecycle hook events")
    expected_subcommands = {"SessionStart": "session-start", "Stop": "stop"}
    command_patterns = {
        "command": re.compile(
            r'python3 "\$\{CLAUDE_PLUGIN_ROOT\}/scripts/obsidian_memory\.py" '
            r'(session-start|stop)'
        ),
        "commandWindows": re.compile(
            r'py -3 "%CLAUDE_PLUGIN_ROOT%\\scripts\\obsidian_memory\.py" '
            r'(session-start|stop)'
        ),
    }
    for event, groups in hooks.items():
        require(isinstance(groups, list) and groups, f"{event} must define hook groups")
        for group in groups:
            require(isinstance(group, dict), f"{event} hook group must be an object")
            handlers = group.get("hooks")
            require(isinstance(handlers, list) and handlers, f"{event} has no handlers")
            for handler in handlers:
                require(isinstance(handler, dict), f"{event} handler must be an object")
                require(handler.get("type") == "command", f"{event} handler is not command")
                require(
                    isinstance(handler.get("timeout"), int) and handler["timeout"] > 0,
                    f"{event} handler timeout must be positive",
                )
                for field in ("command", "commandWindows"):
                    command = handler.get(field)
                    require(
                        isinstance(command, str) and bool(command.strip()),
                        f"{event} {field} must be a non-empty command",
                    )
                    matched = command_patterns[field].fullmatch(command)
                    require(
                        matched is not None,
                        f"{event} {field} is not an allowlisted canonical command",
                    )
                    require(
                        matched is not None
                        and matched.group(1) == expected_subcommands[event],
                        f"{event} {field} must invoke {expected_subcommands[event]}",
                    )


def validate_hooks() -> None:
    validate_hook_document(load_json("plugins/obsidian-memory/hooks/hooks.json"))


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
        and len(recall_roots) <= MAX_PROJECTED_CONFIG_ENTRIES
        and all(safe_indexed_path(root) for root in recall_roots),
        "recall_roots must contain safe indexed vault paths",
    )
    global_memory_root = config.get("global_memory_root")
    require(
        safe_indexed_path(global_memory_root)
        and any(
            relative_path_is_within(global_memory_root, root)
            for root in recall_roots
        ),
        "global_memory_root must be a safe indexed path contained by recall_roots",
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
        and len(collections) <= MAX_PROJECTED_CONFIG_ENTRIES
        and all(safe_collection_name(name) for name in collections),
        "qmd_collections must contain collection names",
    )
    require(
        isinstance(config.get("qmd_top_k"), int) and 1 <= config["qmd_top_k"] <= 20,
        "qmd_top_k must be an integer from 1 to 20",
    )
    roots = config.get("qmd_collection_roots")
    require(
        isinstance(roots, dict)
        and len(roots) <= MAX_PROJECTED_CONFIG_ENTRIES
        and set(collections) <= set(roots)
        and all(safe_collection_name(name) for name in roots)
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
    qmd_retrieval = skill_root / "references" / "qmd-retrieval.md"
    operations = skill_root / "references" / "memory-operations.md"
    for path in (skill, governance, evaluation, providers, qmd_retrieval, operations):
        require(path.is_file(), f"missing memory reference: {path.relative_to(ROOT)}")

    skill_text = skill.read_text(encoding="utf-8")
    for term in (
        "combined release gate",
        "four-stage sequence",
        "run the requested read-only audit",
        "QMD upgrade, installation, explicit maintenance, or rollback",
        "references/memory-operations.md",
    ):
        require(
            term.casefold() in skill_text.casefold(),
            f"SKILL.md: missing combined-flow contract: {term}",
        )

    require(len(skill_text.split()) <= 700, "SKILL.md exceeds 700 words")
    expected_frontmatter = """---
name: obsidian-memory
description: Use a configured Obsidian vault as durable, cross-session memory for Codex and Claude Code. Use when the user asks to remember, save, file, recall, or query knowledge; when work produces a durable decision, task, fact, design, daily update, or handoff context; or when prior project context from the shared vault would materially improve the current task.
---
"""
    require(
        skill_text.startswith(expected_frontmatter),
        "SKILL.md frontmatter changed",
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

    validate_memory_operations(operations)
    validate_skill_package_links(skill_root)
    qmd_text = qmd_retrieval.read_text(encoding="utf-8").casefold()
    for term in ("bun-owned", "install --force", "evaluate ... --json", "rollback"):
        require(
            term not in qmd_text,
            f"qmd-retrieval.md must not contain rollout operations: {term}",
        )
    validate_memory_research_and_evals(governance, evaluation, providers)


def validate_memory_operations(operations: Path) -> None:
    """Keep the installed skill's release procedure complete and ordered."""
    text = operations.read_text(encoding="utf-8")
    before_rollback, rollback_marker, rollback = text.partition(
        "## 7. Derived-only rollback"
    )
    require(rollback_marker, "memory operations omits rollback section")
    rollback_plan, recovery_marker, recovery = rollback.partition(
        "### Failed-rollback recovery"
    )
    require(recovery_marker, "memory operations omits failed-rollback recovery")
    required_in_order = (
        "## 1. Repository gates",
        "python3 wiki/scripts/check.py",
        "python3 scripts/plugins.py check",
        "## 2. Bun-owned QMD 2.8.3",
        "python3 bun-global-tools/sync.py apply",
        "qmd --version",
        "qmd status",
        "qmd doctor",
        "python3 bun-global-tools/sync.py check --deep",
        "## 3. Post-integration plugin install",
        "python3 scripts/plugins.py install --force",
        "python3 scripts/plugins.py status",
        "## 4. Pre-refresh read-only proof",
        "providers --json",
        "doctor --json",
        "audit --json",
        "evaluate path/to/private-recall-evals.json --json",
        "## 5. Explicit derived-index maintenance",
        "refresh-index --embed",
        "## 6. Repeat proof",
    )
    cursor = -1
    for term in required_in_order:
        position = before_rollback.find(term, cursor + 1)
        require(position >= 0, f"memory operations omits ordered contract: {term}")
        cursor = position

    rollback_required_in_order = (
        'qmd_status_before="$(qmd status)"',
        'qmd_expected_index="${XDG_CACHE_HOME:-${HOME:?HOME is required}/.cache}/qmd/index.sqlite"',
        'if [ "$qmd_index" != "$qmd_expected_index" ] || [ ! -f "$qmd_index" ] || [ -L "$qmd_index" ]; then',
        'if [ -L "${qmd_index}-wal" ] || { [ -e "${qmd_index}-wal" ] && [ ! -f "${qmd_index}-wal" ]; }; then',
        'if [ -L "${qmd_index}-shm" ] || { [ -e "${qmd_index}-shm" ] && [ ! -f "${qmd_index}-shm" ]; }; then',
        'qmd_backup_dir="$(mktemp -d "${qmd_index}.pre-rollback.XXXXXX")"',
        'mv "$qmd_index" "$qmd_backup_dir/index.sqlite"',
        'mv "${qmd_index}-wal" "$qmd_backup_dir/index.sqlite-wal"',
        'mv "${qmd_index}-shm" "$qmd_backup_dir/index.sqlite-shm"',
        "prior plugin commit",
        "QMD 2.5.3",
        "python3 bun-global-tools/sync.py apply",
        "python3 scripts/plugins.py install --force",
        "qmd update",
        "qmd embed",
        "qmd --version",
        "qmd status",
        "qmd doctor",
        "python3 bun-global-tools/sync.py check --deep",
        "python3 scripts/plugins.py status",
        "providers --json",
        "doctor --json",
        "audit --json",
        "evaluate path/to/private-recall-evals.json --json",
    )
    cursor = -1
    for term in rollback_required_in_order:
        position = rollback_plan.find(term, cursor + 1)
        require(
            position >= 0,
            f"memory rollback omits ordered recovery: {term}",
        )
        cursor = position
    require(
        "refresh-index --embed" not in rollback,
        "memory rollback must build a fresh index, not incrementally refresh it",
    )
    normalized_rollback = " ".join(rollback_plan.split())
    for term in (
        "unique non-overwriting",
        "Never delete or overwrite that backup",
        "global QMD collection YAML unchanged",
    ):
        require(
            term.casefold() in normalized_rollback.casefold(),
            f"memory rollback omits recovery boundary: {term}",
        )

    restore_command = 'cp -p "$qmd_backup_dir/index.sqlite" "$qmd_index"'
    before_saved_restore, restore_marker, after_saved_restore = recovery.partition(
        restore_command
    )
    require(restore_marker, "memory recovery omits saved database restoration")
    require(
        'if [ -f "$qmd_index" ]; then' in before_saved_restore,
        "memory recovery omits conditional quarantine",
    )
    target_absence = (
        'if [ -e "$qmd_index" ] || [ -L "$qmd_index" ] ||\n'
        '     [ -e "${qmd_index}-wal" ] || [ -L "${qmd_index}-wal" ] ||\n'
        '     [ -e "${qmd_index}-shm" ] || [ -L "${qmd_index}-shm" ]; then'
    )
    require(
        target_absence in before_saved_restore,
        "memory recovery omits symlink-safe target absence",
    )
    saved_input_guards = (
        'if [ -L "$qmd_backup_dir" ] || [ ! -d "$qmd_backup_dir" ] || '
        '[ -L "$qmd_backup_dir/index.sqlite" ] || '
        '[ ! -f "$qmd_backup_dir/index.sqlite" ]; then',
        'if [ -L "$qmd_backup_dir/index.sqlite-wal" ] ||',
        'if [ -L "$qmd_backup_dir/index.sqlite-shm" ] ||',
    )
    require(
        all(term in before_saved_restore for term in saved_input_guards),
        "memory recovery omits saved-input symlink guard",
    )
    saved_sidecar_guards = (
        'if [ -L "$qmd_backup_dir/index.sqlite-wal" ] || '
        '{ [ -e "$qmd_backup_dir/index.sqlite-wal" ] && '
        '[ ! -f "$qmd_backup_dir/index.sqlite-wal" ]; }; then',
        'if [ -L "$qmd_backup_dir/index.sqlite-shm" ] || '
        '{ [ -e "$qmd_backup_dir/index.sqlite-shm" ] && '
        '[ ! -f "$qmd_backup_dir/index.sqlite-shm" ]; }; then',
    )
    require(
        all(term in before_saved_restore for term in saved_sidecar_guards),
        "memory recovery omits complete saved-sidecar guard",
    )
    recovery_required_before_restore = (
        "exact upgraded plugin commit",
        "QMD 2.8.3",
        "python3 bun-global-tools/sync.py apply",
        "python3 scripts/plugins.py install --force",
        "qmd --version",
        "python3 bun-global-tools/sync.py check --deep",
        "python3 scripts/plugins.py status",
        'qmd_index="${XDG_CACHE_HOME:-${HOME:?HOME is required}/.cache}/qmd/index.sqlite"',
        'qmd_backup_dir="/recorded/pre-rollback/backup-directory"',
        saved_input_guards[0],
        saved_sidecar_guards[0],
        saved_sidecar_guards[1],
        'if [ -L "$qmd_index" ] || { [ -e "$qmd_index" ] && [ ! -f "$qmd_index" ]; }; then',
        'if [ -L "${qmd_index}-wal" ] || { [ -e "${qmd_index}-wal" ] && [ ! -f "${qmd_index}-wal" ]; }; then',
        'if [ -L "${qmd_index}-shm" ] || { [ -e "${qmd_index}-shm" ] && [ ! -f "${qmd_index}-shm" ]; }; then',
        'if [ -f "$qmd_index" ]; then',
        'qmd_failed_backup_dir="$(mktemp -d "${qmd_index}.failed-rollback.XXXXXX")"',
        'mv "$qmd_index" "$qmd_failed_backup_dir/index.sqlite"',
        'mv "${qmd_index}-wal" "$qmd_failed_backup_dir/index.sqlite-wal"',
        'mv "${qmd_index}-shm" "$qmd_failed_backup_dir/index.sqlite-shm"',
        'elif [ -e "${qmd_index}-wal" ] || [ -e "${qmd_index}-shm" ]; then',
        target_absence,
    )
    cursor = -1
    for term in recovery_required_before_restore:
        position = before_saved_restore.find(term, cursor + 1)
        require(
            position >= 0,
            f"memory recovery omits ordered restoration: {term}",
        )
        cursor = position

    recovery_required_after_restore = (
        'cp -p "$qmd_backup_dir/index.sqlite-wal" "${qmd_index}-wal"',
        'cp -p "$qmd_backup_dir/index.sqlite-shm" "${qmd_index}-shm"',
        "qmd status",
        "qmd doctor",
        "providers --json",
        "doctor --json",
        "audit --json",
        "evaluate path/to/private-recall-evals.json --json",
    )
    cursor = -1
    for term in recovery_required_after_restore:
        position = after_saved_restore.find(term, cursor + 1)
        require(
            position >= 0,
            f"memory recovery omits post-restoration proof: {term}",
        )
        cursor = position

    normalized_recovery = " ".join(recovery.split())
    for term in (
        "early failure before `qmd update` may leave no newly derived database",
        "pre-rollback QMD 2.8.3 and upgraded plugin state",
        "before restoring any saved SQLite file",
        "only when that database exists",
        "every restore target must satisfy both `! -e` and `! -L`",
        "Saved inputs must be regular non-symlink files",
        "Never delete the pre-rollback or failed-rebuild backup",
        "proceed without rewriting Markdown and leave the global collection "
        "YAML and vault configuration untouched",
    ):
        require(
            term.casefold() in normalized_recovery.casefold(),
            f"memory recovery omits safety boundary: {term}",
        )

    for command in ("providers --json", "doctor --json", "audit --json"):
        require(
            text.count(command) >= 2,
            f"memory operations must repeat post-maintenance proof: {command}",
        )
    require(
        text.count("evaluate path/to/private-recall-evals.json --json") >= 2,
        "memory operations must repeat post-maintenance private evaluation",
    )
    for term in (
        "local derived accelerator",
        "Markdown/Git is the recovery authority",
        "no vault content is mirrored",
        "QMD HTTP/MCP",
        "project-local configuration",
        "external source paths",
        "custom model URIs",
        "Lifecycle hooks never run QMD model/index work, evaluator, or audit",
        "without rewriting Markdown",
    ):
        require(
            term.casefold() in text.casefold(),
            f"memory operations omits required boundary: {term}",
        )


def validate_skill_package_links(skill_root: Path) -> None:
    """Installed skill Markdown may only link to assets installed with it."""
    link_pattern = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    package_root = skill_root.resolve()
    for document in sorted(skill_root.rglob("*.md")):
        for target in link_pattern.findall(document.read_text(encoding="utf-8")):
            reference = target.split("#", 1)[0].split(" ", 1)[0].strip()
            if not reference or "://" in reference or reference.startswith("mailto:"):
                continue
            resolved = (document.parent / reference).resolve()
            require(
                resolved.is_relative_to(package_root) and resolved.exists(),
                f"{document.relative_to(ROOT)}: link escapes installed skill package: {reference}",
            )


def validate_memory_research_and_evals(
    governance: Path, evaluation: Path, providers: Path
) -> None:
    """Validate the existing memory research and evaluation contracts."""
    research = (ROOT / "docs" / "research" / "2026-08-01-agent-memory-systems.md").read_text(
        encoding="utf-8"
    )
    scope_and_method, findings_marker, _ = research.partition("## Findings")
    require(findings_marker, "memory-provider research omits Findings")
    for term in (
        "b2bd1ac63ff137a6287ce989d65dccee6b9155e2",
        "nine available",
        "source- and contract-level",
        "not a claim of live end-to-end success",
    ):
        require(
            term in scope_and_method,
            f"memory-provider research scope and method omits: {term}",
        )

    provider_heading = "### Providers should preserve a dependable canonical layer"
    _, provider_heading_marker, provider_section = research.partition(provider_heading)
    require(provider_heading_marker, "memory-provider research omits provider heading")
    provider_section, _, _ = provider_section.partition("\n### ")
    table_lines = provider_section.splitlines()
    table_header = "| Provider | Verified design surface | Local decision |"
    try:
        table_start = table_lines.index(table_header)
    except ValueError as exc:
        raise ValidationError("memory-provider research omits provider decision table") from exc
    require(
        table_start + 1 < len(table_lines)
        and table_lines[table_start + 1].strip() == "| --- | --- | --- |",
        "memory-provider research provider table has invalid separator",
    )
    provider_rows: list[tuple[str, str, str]] = []
    for line in table_lines[table_start + 2 :]:
        if not line.startswith("|"):
            break
        cells = [cell.strip() for cell in line.strip().split("|")[1:-1]]
        require(
            len(cells) == 3,
            "memory-provider research provider table row must have three cells",
        )
        provider, surface, decision = cells
        require(provider and surface and decision, "memory-provider research provider table has an empty cell")
        provider_rows.append((provider, surface, decision))

    expected_providers = {
        "ByteRover",
        "Hindsight",
        "Holographic",
        "Honcho",
        "Mem0",
        "Memori",
        "OpenViking",
        "RetainDB",
        "Supermemory",
    }
    provider_names = [provider for provider, _, _ in provider_rows]
    require(
        len(provider_names) == len(set(provider_names)),
        "memory-provider research provider table has duplicate providers",
    )
    require(
        set(provider_names) == expected_providers,
        "memory-provider research provider table must contain exactly the nine Hermes providers",
    )
    hindsight_decision = next(
        decision for provider, _, decision in provider_rows if provider == "Hindsight"
    )
    require(
        hindsight_decision
        == "Defer as the best synthetic-data pilot only after a measured graph/temporal failure.",
        "memory-provider research Hindsight decision must defer the synthetic-data pilot until a measured graph/temporal failure",
    )

    _, primary_references_marker, primary_references = research.partition("## Primary references")
    require(primary_references_marker, "memory-provider research omits Primary references")
    primary_urls = set(re.findall(r"https?://[^\s)]+", primary_references))
    required_primary_urls = {
        "https://github.com/NousResearch/hermes-agent",
        "https://github.com/plastic-labs/honcho",
        "https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/01-architecture.md",
        "https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx",
        "https://github.com/vectorize-io/hindsight",
        "https://www.retaindb.com/docs/intro",
        "https://docs.byterover.dev/reference/cli-reference",
        "https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/quickstart.mdx",
        "https://github.com/MemoriLabs/Memori/blob/main/docs/memori-cloud/hermes/quickstart.mdx",
        "https://github.com/tobi/qmd",
    }
    missing_primary_urls = required_primary_urls - primary_urls
    require(
        not missing_primary_urls,
        "memory-provider research omits primary references: "
        + ", ".join(sorted(missing_primary_urls)),
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

    recall_evals = load_json(
        "plugins/obsidian-memory/evals/recall-evals.example.json",
        max_chars=MAX_RECALL_EVAL_FIXTURE_CHARS,
    )
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
        isinstance(recall_cases, list)
        and 1 <= len(recall_cases) <= MAX_RECALL_EVAL_CASES,
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
        case_id = raw_case_id if isinstance(raw_case_id, str) else ""
        require(
            RECALL_EVAL_ID_RE.fullmatch(case_id) is not None,
            f"{label} id must be an opaque portable label",
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
            require(
                isinstance(paths, list) and len(paths) <= MAX_RECALL_EVAL_PATHS,
                f"{label}: {field} must be a bounded array",
            )
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
            "[A-Za-z0-9][A-Za-z0-9._-]{0,119}",
            "defaults to `false`",
        ),
        governance: (
            "audit",
            "action-driving",
            "never auto-fixes",
            "fixed `configuration` locator",
        ),
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

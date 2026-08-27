#!/usr/bin/env python3
"""Install the shared Obsidian memory plugin for Codex and Claude Code."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "obsidian-memory"
MARKETPLACE = "ai-workspace"
PLUGIN_ID = f"obsidian-memory@{MARKETPLACE}"
POLICY = PLUGIN / "rules" / "obsidian-vault.md"
CONFIG = Path.home() / ".config" / "obsidian-memory" / "config.json"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"
CLAUDE_POLICY = Path.home() / ".claude" / "rules" / "obsidian-vault.md"
CODEX_POLICY = Path.home() / ".codex" / "AGENTS.md"
CODEX_UPSTREAM_SKILLS = Path.home() / ".codex" / "skills" / "claude-obsidian"
CLAUDE_MARKETPLACES = Path.home() / ".claude" / "plugins" / "marketplaces"
LEGACY_COMMAND_FRAGMENTS = ("obsidian-session-start.sh", "obsidian-stop.sh")
CODEX_POLICY_START = "<!-- obsidian-memory:managed:start -->"
CODEX_POLICY_END = "<!-- obsidian-memory:managed:end -->"


def timestamp() -> str:
    return dt.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")


def backup(path: Path) -> Path:
    destination = path.with_name(f"{path.name}.backup-{timestamp()}")
    shutil.copy2(path, destination, follow_symlinks=False)
    return destination


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def link_policy(destination: Path, replace: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() and destination.resolve() == POLICY.resolve():
        print(f"policy already linked: {destination}")
        return
    if destination.exists() or destination.is_symlink():
        if not replace:
            raise RuntimeError(
                f"{destination} already exists; rerun with --replace-guidance after reviewing it"
            )
        saved = backup(destination)
        destination.unlink()
        print(f"backed up guidance: {saved}")
    destination.symlink_to(POLICY)
    print(f"linked policy: {destination} -> {POLICY}")


def codex_policy_block() -> str:
    policy = POLICY.read_text(encoding="utf-8").strip()
    return f"{CODEX_POLICY_START}\n{policy}\n{CODEX_POLICY_END}"


def install_codex_policy(destination: Path, replace: bool = False) -> None:
    """Add or refresh our bounded block without owning the user's AGENTS.md."""
    block = codex_policy_block()
    if destination.is_symlink() and destination.resolve() == POLICY.resolve():
        destination.unlink()
        atomic_text(destination, f"{block}\n")
        print(f"migrated policy symlink to managed guidance block: {destination}")
        return
    if destination.is_symlink():
        if replace:
            saved = backup(destination)
            destination.unlink()
            atomic_text(destination, f"{block}\n")
            print(f"replaced Codex guidance symlink; backup: {saved}")
            return
        raise RuntimeError(
            f"{destination} is a symlink not managed by obsidian-memory; review it manually"
        )

    existing = destination.read_text(encoding="utf-8") if destination.is_file() else ""
    start_count = existing.count(CODEX_POLICY_START)
    end_count = existing.count(CODEX_POLICY_END)
    if start_count != end_count or start_count > 1:
        raise RuntimeError(f"{destination} contains malformed obsidian-memory markers")
    saved: Optional[Path] = None
    if start_count == 1:
        pattern = re.compile(
            rf"{re.escape(CODEX_POLICY_START)}.*?{re.escape(CODEX_POLICY_END)}",
            flags=re.DOTALL,
        )
        updated = pattern.sub(lambda _: block, existing)
        action = "refreshed"
    else:
        saved = backup(destination) if existing else None
        separator = "\n\n" if existing.strip() else ""
        updated = f"{existing.rstrip()}{separator}{block}\n"
        action = "added"
    if updated == existing:
        print(f"Codex guidance already current: {destination}")
        return
    atomic_text(destination, updated)
    detail = f"; backup: {saved}" if saved else ""
    print(f"{action} managed Codex guidance: {destination}{detail}")


def preserve_plugin_cache_path(cache_root: Path, old_version: str, new_version: str) -> None:
    """Keep hooks loaded by active threads valid across a cache-busted update."""
    if old_version == new_version:
        return
    current = cache_root / new_version
    if not current.is_dir():
        raise RuntimeError(f"new Codex plugin cache is missing: {current}")
    previous = cache_root / old_version
    if previous.exists():
        return
    if previous.is_symlink():
        previous.unlink()
    previous.parent.mkdir(parents=True, exist_ok=True)
    previous.symlink_to(current, target_is_directory=True)
    print(f"preserved active-thread plugin path: {previous} -> {current}")


def discover_upstream_skills() -> Optional[Path]:
    if not CLAUDE_MARKETPLACES.is_dir():
        return None
    candidates = sorted(
        path / "skills"
        for path in CLAUDE_MARKETPLACES.iterdir()
        if "claude-obsidian" in path.name.lower()
    )
    return next((path.resolve() for path in candidates if path.is_dir()), None)


def link_upstream_skills() -> None:
    source = discover_upstream_skills()
    if source is None:
        print("upstream claude-obsidian skills not found; optional Codex skill bridge skipped")
        return
    CODEX_UPSTREAM_SKILLS.parent.mkdir(parents=True, exist_ok=True)
    if (
        CODEX_UPSTREAM_SKILLS.is_symlink()
        and CODEX_UPSTREAM_SKILLS.resolve() == source
    ):
        print(f"upstream skills already linked: {CODEX_UPSTREAM_SKILLS}")
        return
    if CODEX_UPSTREAM_SKILLS.exists() or CODEX_UPSTREAM_SKILLS.is_symlink():
        raise RuntimeError(
            f"{CODEX_UPSTREAM_SKILLS} already exists; review or move it before installing "
            "the optional upstream skill bridge"
        )
    CODEX_UPSTREAM_SKILLS.symlink_to(source, target_is_directory=True)
    print(f"linked upstream skills: {CODEX_UPSTREAM_SKILLS} -> {source}")


def configure(vault: Path, auto_commit: bool, replace: bool) -> None:
    resolved = vault.expanduser().resolve()
    if not resolved.is_dir() or not (resolved / "wiki").is_dir():
        raise RuntimeError(f"vault must contain wiki/: {resolved}")
    if CONFIG.exists():
        if not replace:
            existing = json.loads(CONFIG.read_text(encoding="utf-8"))
            if existing.get("vault") == str(resolved):
                print(f"configuration already targets vault: {resolved}")
                return
            raise RuntimeError(
                f"{CONFIG} already targets another vault; use --replace-config after reviewing it"
            )
        saved = backup(CONFIG)
        print(f"backed up configuration: {saved}")
    payload = {
        "vault": str(resolved),
        "context_profile": "focused",
        "max_context_chars": 7500,
        "max_context_tokens": 420,
        "max_hot_chars": 900,
        "max_global_tasks": 10,
        "max_project_summaries": 12,
        "auto_commit": auto_commit,
        "commit_paths": ["wiki", "projects", "daily", "inbox"],
        "commit_message_prefix": "wiki: agent memory",
        "recall_provider": "auto",
        "recall_roots": ["wiki", "projects", "daily"],
        "global_memory_root": "wiki/global",
        "native_max_files": 2000,
        "native_max_file_chars": 80000,
        "qmd_enabled": False,
        "qmd_collections": [
            "obsidian-wiki",
            "obsidian-projects",
            "obsidian-daily",
        ],
        "qmd_top_k": 5,
        "qmd_collection_roots": {
            "obsidian-wiki": "wiki",
            "obsidian-projects": "projects",
            "obsidian-daily": "daily",
        },
        "max_recall_tokens": 900,
        "recall_snippet_chars": 280,
    }
    atomic_json(CONFIG, payload)
    CONFIG.chmod(0o600)
    print(f"wrote local configuration: {CONFIG}")


def is_legacy_group(group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    handlers = group.get("hooks")
    if not isinstance(handlers, list):
        return False
    for handler in handlers:
        if not isinstance(handler, dict):
            continue
        command = handler.get("command")
        if isinstance(command, str) and any(part in command for part in LEGACY_COMMAND_FRAGMENTS):
            return True
    return False


def remove_legacy_hooks() -> None:
    if not CLAUDE_SETTINGS.is_file():
        return
    payload = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    hooks = payload.get("hooks")
    if not isinstance(hooks, dict):
        return
    changed = False
    for event in ("SessionStart", "Stop"):
        groups = hooks.get(event)
        if not isinstance(groups, list):
            continue
        retained = [group for group in groups if not is_legacy_group(group)]
        if len(retained) != len(groups):
            changed = True
            if retained:
                hooks[event] = retained
            else:
                hooks.pop(event, None)
    if not changed:
        print("legacy global Claude hooks are already absent")
        return
    saved = backup(CLAUDE_SETTINGS)
    atomic_json(CLAUDE_SETTINGS, payload)
    print(f"removed superseded global Claude hooks; backup: {saved}")


def run(command: list[str], allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(command))
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)
    if result.returncode and not allow_failure:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}")
    return result


def install_products() -> None:
    """Delegate registration to the workspace installer.

    The marketplace is workspace-wide (`ai-workspace`), so registering it is not
    this project's job — `scripts/plugins.py` owns it and installs every plugin
    the catalog declares, this one included. Vault configuration, guidance files,
    and hook cleanup above remain project-specific.
    """
    workspace_installer = ROOT.parent / "scripts" / "plugins.py"
    if not workspace_installer.is_file():
        raise RuntimeError(f"missing workspace installer: {workspace_installer}")
    run([sys.executable, str(workspace_installer), "install"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument(
        "--auto-commit",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Commit configured memory paths at Stop (default: disabled)",
    )
    parser.add_argument("--replace-config", action="store_true")
    parser.add_argument("--replace-guidance", action="store_true")
    parser.add_argument("--keep-legacy-hooks", action="store_true")
    parser.add_argument("--skip-upstream-skill-link", action="store_true")
    parser.add_argument("--skip-product-install", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    configure(args.vault, args.auto_commit, args.replace_config)
    link_policy(CLAUDE_POLICY, args.replace_guidance)
    install_codex_policy(CODEX_POLICY, args.replace_guidance)
    if not args.skip_upstream_skill_link:
        link_upstream_skills()
    if not args.keep_legacy_hooks:
        remove_legacy_hooks()
    if not args.skip_product_install:
        install_products()
    print("installation complete; start new Claude Code and Codex threads")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)

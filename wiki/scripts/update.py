#!/usr/bin/env python3
"""Validate and refresh the shared plugin in Codex and Claude Code."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from install import CODEX_POLICY, install_codex_policy, preserve_plugin_cache_path


ROOT = Path(__file__).resolve().parents[1]
# The marketplace is workspace-wide; only the plugin directory is ours.
WORKSPACE = ROOT.parent
WORKSPACE_INSTALLER = WORKSPACE / "scripts" / "plugins.py"
WORKSPACE_CATALOG = WORKSPACE / "plugins.json"
PLUGIN = ROOT / "plugins" / "obsidian-memory"
MARKETPLACE = "ai-workspace"
PLUGIN_ID = f"obsidian-memory@{MARKETPLACE}"
CODEX_MANIFEST = PLUGIN / ".codex-plugin" / "plugin.json"
CODEX_SKILLS = Path.home() / ".codex" / "skills" / ".system"
CODEX_CACHE = Path.home() / ".codex" / "plugins" / "cache" / MARKETPLACE / "obsidian-memory"


def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, check=True)


def sync_catalog_version() -> None:
    """Promote the cachebuster's version bump to the source catalog.

    The Codex cachebuster edits a generated manifest. Record that new version in
    `plugins.json`, then regenerate both plugin manifests and both marketplace
    manifests from the catalog so no generated file becomes a source of truth.
    """
    codex = json.loads(CODEX_MANIFEST.read_text(encoding="utf-8"))
    catalog = json.loads(WORKSPACE_CATALOG.read_text(encoding="utf-8"))
    entry = next(
        (item for item in catalog["plugins"] if item.get("name") == "obsidian-memory"),
        None,
    )
    if entry is None:
        raise RuntimeError("obsidian-memory is missing from plugins.json")
    entry["version"] = codex["version"]
    WORKSPACE_CATALOG.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    run([sys.executable, str(WORKSPACE_INSTALLER), "sync"])


def main() -> int:
    plugin_creator = CODEX_SKILLS / "plugin-creator"
    skill_creator = CODEX_SKILLS / "skill-creator"
    cachebuster = plugin_creator / "scripts" / "update_plugin_cachebuster.py"
    validate_plugin = plugin_creator / "scripts" / "validate_plugin.py"
    validate_skill = skill_creator / "scripts" / "quick_validate.py"
    for path in (cachebuster, validate_plugin, validate_skill):
        if not path.is_file():
            raise RuntimeError(f"required Codex creator helper not found: {path}")

    previous_versions = (
        {path.name for path in CODEX_CACHE.iterdir()}
        if CODEX_CACHE.is_dir()
        else set()
    )
    previous_versions.add(
        str(json.loads(CODEX_MANIFEST.read_text(encoding="utf-8"))["version"])
    )
    run([sys.executable, "-m", "unittest", "discover", "-s", str(PLUGIN / "tests"), "-v"])
    run(
        [
            "uv",
            "run",
            "--with",
            "pyyaml",
            "python",
            str(validate_skill),
            str(PLUGIN / "skills" / "obsidian-memory"),
        ]
    )
    run(
        [
            "uv",
            "run",
            "--with",
            "pyyaml",
            "python",
            str(validate_plugin),
            str(PLUGIN),
        ]
    )
    # The marketplace manifest lives at the workspace root, not in this project.
    run(["claude", "plugin", "validate", str(WORKSPACE)])
    run([sys.executable, str(cachebuster), str(PLUGIN)])
    sync_catalog_version()
    install_codex_policy(CODEX_POLICY)
    run(["codex", "plugin", "add", PLUGIN_ID, "--json"])
    new_version = str(json.loads(CODEX_MANIFEST.read_text(encoding="utf-8"))["version"])
    for version in sorted(previous_versions):
        preserve_plugin_cache_path(CODEX_CACHE, version, new_version)
    run(["claude", "plugin", "marketplace", "update", MARKETPLACE])
    # Reinstall through the workspace installer so every catalogued plugin —
    # not just this one — ends up on the refreshed marketplace in both agents.
    run([sys.executable, str(WORKSPACE_INSTALLER), "install"])
    print("update complete; start new Claude Code and Codex threads")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)

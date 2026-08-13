#!/usr/bin/env python3
"""Validate, install, inspect, or uninstall the shared personal agent system."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[1]
CLAUDE_SOURCE = ROOT / "claude" / "agents"
CLAUDE_TARGET = Path.home() / ".claude" / "agents"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"
BACKUP_ROOT = Path.home() / ".config" / "shared-agents" / "backups"
CODEX_SOURCE = ROOT / "codex" / "agents"
CODEX_CONTROLLER_PROFILE = ROOT / "codex" / "controller.config.toml"


class Problem(RuntimeError):
    pass


def backup_relative_path(path: Path) -> Path:
    try:
        return path.relative_to(Path.home())
    except ValueError:
        return Path("external") / str(path).lstrip(os.sep)


def ensure_modern_python() -> None:
    if sys.version_info >= (3, 11):
        return
    current = str(Path(sys.executable).resolve())
    for name in ("python3.14", "python3.13", "python3.12", "python3.11"):
        candidate = shutil.which(name)
        if candidate and str(Path(candidate).resolve()) != current:
            os.execv(candidate, [candidate, *sys.argv])
    raise SystemExit("shared-agents requires Python 3.11+ for TOML validation")


class BackupStore:
    """Create recoverable backups only when an install changes existing files."""

    def __init__(self, root: Path | None = None) -> None:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.root = root or BACKUP_ROOT / timestamp
        self.created: list[Path] = []

    def destination(self, path: Path) -> Path:
        return self.root / backup_relative_path(path)

    def preserve(self, path: Path) -> Path | None:
        if not path.exists() and not path.is_symlink():
            return None
        destination = self.destination(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            raise Problem(f"backup destination already exists: {destination}")
        if path.is_symlink():
            destination.symlink_to(os.readlink(path))
        else:
            shutil.copy2(path, destination)
        self.created.append(destination)
        return destination


def run(command: list[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(command))
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode and not allow_failure:
        output = (result.stdout + result.stderr).strip()
        raise Problem(f"{' '.join(command)} failed:\n{output}")
    return result


def claude_agent_sources() -> list[Path]:
    return sorted(CLAUDE_SOURCE.glob("*.md"))


def same_regular_file(source: Path, target: Path) -> bool:
    return (
        target.is_file()
        and not target.is_symlink()
        and source.read_bytes() == target.read_bytes()
    )


def copy_claude_agent(source: Path, target: Path, backups: BackupStore) -> bool:
    if same_regular_file(source, target):
        return False
    if target.exists() or target.is_symlink():
        backups.preserve(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.shared-agents.tmp")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def install_claude_agents(backups: BackupStore) -> list[Path]:
    changed: list[Path] = []
    for source in claude_agent_sources():
        target = CLAUDE_TARGET / source.name
        if copy_claude_agent(source, target, backups):
            changed.append(target)
    return changed


def uninstall_claude_agents() -> list[Path]:
    removed: list[Path] = []
    for source in claude_agent_sources():
        target = CLAUDE_TARGET / source.name
        if same_regular_file(source, target):
            target.unlink()
            removed.append(target)
    return removed


def package_problems() -> list[str]:
    problems: list[str] = []
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "render.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        problems.append("provider files have render drift; run `python3 scripts/render.py`")

    expected_claude = {"controller.md", "task-analyst.md", "Explore.md", "alan-wake.md"}
    actual_claude = {path.name for path in claude_agent_sources()}
    if actual_claude != expected_claude:
        problems.append(
            f"Claude agents are {sorted(actual_claude)}, expected {sorted(expected_claude)}"
        )
    explore = CLAUDE_SOURCE / "Explore.md"
    if explore.is_file():
        text = explore.read_text(encoding="utf-8")
        for required in ("name: Explore", "model: sonnet", "effort: medium"):
            if required not in text:
                problems.append(f"Explore.md is missing {required!r}")

    try:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"agents.json: {exc}"]
    by_id = {agent["id"]: agent for agent in catalog.get("agents", [])}
    if set(by_id) != {"controller", "alan-wake", "repo-explorer", "task-analyst"}:
        problems.append(
            "agents.json must define controller, alan-wake, repo-explorer, and task-analyst"
        )
    if by_id.get("controller", {}).get("codex"):
        problems.append(
            "controller must remain the Codex primary thread, not a spawnable custom agent"
        )
    if by_id.get("controller", {}).get("claude", {}).get("model") != "fable":
        problems.append("Claude controller must use fable")
    if by_id.get("alan-wake", {}).get("claude", {}).get("model") != "opus":
        problems.append("Claude alan-wake must use opus")
    for agent_id in ("repo-explorer", "task-analyst"):
        if by_id.get(agent_id, {}).get("claude", {}).get("model") != "sonnet":
            problems.append(f"Claude {agent_id} must use sonnet")

    for path in CODEX_SOURCE.glob("*.toml"):
        try:
            parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            problems.append(f"{path.relative_to(ROOT)}: invalid TOML: {exc}")
            continue
        for field in (
            "name",
            "description",
            "developer_instructions",
            "model",
            "model_reasoning_effort",
        ):
            if not parsed.get(field):
                problems.append(f"{path.relative_to(ROOT)}: missing {field}")
        if not str(parsed.get("model", "")).startswith("gpt-"):
            problems.append(f"{path.relative_to(ROOT)}: Codex model must be a GPT model")

    try:
        controller_profile = tomllib.loads(
            CODEX_CONTROLLER_PROFILE.read_text(encoding="utf-8")
        )
    except (OSError, tomllib.TOMLDecodeError) as exc:
        problems.append(f"{CODEX_CONTROLLER_PROFILE.relative_to(ROOT)}: invalid TOML: {exc}")
    else:
        if controller_profile.get("model") != "gpt-5.6-sol":
            problems.append("Codex controller profile must use gpt-5.6-sol")
        if controller_profile.get("model_reasoning_effort") != "max":
            problems.append("Codex controller profile must use max reasoning")
        instructions = str(controller_profile.get("developer_instructions", ""))
        if "active shared-agents controller" not in instructions:
            problems.append("Codex controller profile must explicitly activate the controller")
    return problems


def live_problems() -> list[str]:
    problems = package_problems()
    for source in claude_agent_sources():
        target = CLAUDE_TARGET / source.name
        if not same_regular_file(source, target):
            problems.append(f"{target}: missing, stale, or not a regular-file copy")
    try:
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        settings = {}
    except json.JSONDecodeError as exc:
        problems.append(f"{CLAUDE_SETTINGS}: invalid JSON: {exc}")
        settings = {}
    if not isinstance(settings, dict):
        problems.append(f"{CLAUDE_SETTINGS}: must contain a JSON object")
        settings = {}
    if "agent" in settings and settings["agent"] != "controller":
        problems.append("Claude user settings select an agent other than controller")
    return problems


def cmd_render(_: argparse.Namespace) -> int:
    return run([sys.executable, str(ROOT / "scripts" / "render.py")]).returncode


def cmd_check(_: argparse.Namespace) -> int:
    problems = package_problems()
    print(f"{'FAIL' if problems else 'ok  '} shared-agents package")
    for problem in problems:
        print(f"  - {problem}")
    tests = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "tests"), "-v"],
        capture_output=True,
        text=True,
        check=False,
    )
    print(tests.stdout, end="")
    print(tests.stderr, end="", file=sys.stderr)
    if tests.returncode:
        problems.append("shared-agents unit tests failed")
    return 1 if problems else 0


def cmd_install(_: argparse.Namespace) -> int:
    run([sys.executable, str(ROOT / "scripts" / "render.py")])
    problems = package_problems()
    if problems:
        raise Problem("package validation failed:\n" + "\n".join(f"- {p}" for p in problems))
    backups = BackupStore()
    changed = install_claude_agents(backups)
    for path in changed:
        print(f"copied {path}")
    unchanged = len(claude_agent_sources()) - len(changed)
    print(f"unchanged {unchanged} agent file(s)")
    if backups.created:
        print(f"backed up {len(backups.created)} replaced file(s) under {backups.root}")
    return cmd_status(argparse.Namespace())


def cmd_status(_: argparse.Namespace) -> int:
    problems = live_problems()
    print(f"{'FAIL' if problems else 'ok  '} shared-agents live installation")
    for problem in problems:
        print(f"  - {problem}")
    if not problems:
        print("  Claude: controller + 3 standalone agents")
    return 1 if problems else 0


def cmd_uninstall(_: argparse.Namespace) -> int:
    removed = uninstall_claude_agents()
    for path in removed:
        print(f"removed {path}")
    print("preserved modified targets and all backups")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, handler in (
        ("render", cmd_render),
        ("check", cmd_check),
        ("install", cmd_install),
        ("status", cmd_status),
        ("uninstall", cmd_uninstall),
    ):
        subparser = subparsers.add_parser(name)
        subparser.set_defaults(handler=handler)
    args = parser.parse_args()
    return int(args.handler(args))


if __name__ == "__main__":
    ensure_modern_python()
    try:
        raise SystemExit(main())
    except Problem as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
"""Validate, install, inspect, or uninstall the shared personal agent system."""

from __future__ import annotations

import argparse
import hashlib
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
WORKSPACE = ROOT.parent
PLUGIN = ROOT / "plugins" / "shared-agents"
PLUGIN_ID = "shared-agents@ai-workspace"
MARKETPLACE = "ai-workspace"
CODEX_SOURCE = ROOT / "codex" / "agents"
CODEX_TARGET = Path.home() / ".codex" / "agents"
CODEX_CONTROLLER_PROFILE = ROOT / "codex" / "controller.config.toml"
CODEX_CONTROLLER_TARGET = Path.home() / ".codex" / "controller.config.toml"
CLAUDE_STANDALONE = Path.home() / ".claude" / "agents"
CLAUDE_RULE = Path.home() / ".claude" / "rules" / "orchestration.md"
CLAUDE_POLICY = ROOT / "policy" / "claude-orchestration.md"
CLAUDE_GLOBAL = Path.home() / ".claude" / "CLAUDE.md"
CODEX_GLOBAL = Path.home() / ".codex" / "AGENTS.md"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"
BACKUP_ROOT = Path.home() / ".config" / "shared-agents" / "backups"
STATE_FILE = Path.home() / ".config" / "shared-agents" / "install-state.json"
START = "<!-- shared-agents:managed:start -->"
END = "<!-- shared-agents:managed:end -->"
DIGEST_IGNORE = {".orphaned_at", ".in_use", "__pycache__", ".DS_Store", ".git"}


class Problem(RuntimeError):
    pass


def backup_relative_path(path: Path) -> Path:
    try:
        return path.relative_to(Path.home())
    except ValueError:
        return Path("external") / str(path).lstrip(os.sep)


def latest_backup_for(path: Path) -> Path | None:
    if not BACKUP_ROOT.is_dir():
        return None
    relative = backup_relative_path(path)
    candidates = [
        generation / relative
        for generation in BACKUP_ROOT.iterdir()
        if generation.is_dir()
        and ((generation / relative).exists() or (generation / relative).is_symlink())
    ]
    return sorted(candidates)[-1] if candidates else None


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

    def preserve(self, path: Path, *, move: bool = False) -> Path | None:
        if not path.exists() and not path.is_symlink():
            return None
        destination = self.destination(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            raise Problem(f"backup destination already exists: {destination}")
        if move:
            shutil.move(str(path), str(destination))
        elif path.is_symlink():
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


def render_managed(content: str) -> str:
    return f"{START}\n{content.strip()}\n{END}"


def has_managed_block(path: Path, current: str) -> bool:
    starts = current.count(START)
    ends = current.count(END)
    if starts != ends:
        raise Problem(f"{path}: incomplete shared-agents managed block")
    if starts > 1:
        raise Problem(f"{path}: multiple shared-agents managed blocks")
    return starts == 1


def sync_managed_block(path: Path, content: str, backups: BackupStore | None = None) -> bool:
    block = render_managed(content)
    current = path.read_text(encoding="utf-8") if path.is_file() else ""
    if has_managed_block(path, current):
        prefix, remainder = current.split(START, 1)
        _, suffix = remainder.split(END, 1)
        updated = f"{prefix.rstrip()}\n\n{block}{suffix}".strip() + "\n"
    else:
        updated = f"{current.rstrip()}\n\n{block}\n".lstrip("\n")
    if updated == current:
        return False
    if backups:
        backups.preserve(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.shared-agents.tmp")
    temporary.write_text(updated, encoding="utf-8")
    temporary.replace(path)
    return True


def remove_managed_block(path: Path) -> bool:
    if not path.is_file():
        return False
    current = path.read_text(encoding="utf-8")
    if not has_managed_block(path, current):
        return False
    prefix, remainder = current.split(START, 1)
    _, suffix = remainder.split(END, 1)
    updated = f"{prefix.rstrip()}\n\n{suffix.lstrip()}".strip() + "\n"
    path.write_text(updated, encoding="utf-8")
    return True


def ensure_symlink(source: Path, target: Path, backups: BackupStore) -> bool:
    source = source.resolve()
    if target.is_symlink() and target.resolve(strict=False) == source:
        return False
    if target.exists() or target.is_symlink():
        backups.preserve(target, move=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(source)
    return True


def update_claude_settings(backups: BackupStore) -> bool:
    try:
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8")) if CLAUDE_SETTINGS.is_file() else {}
    except json.JSONDecodeError as exc:
        raise Problem(f"{CLAUDE_SETTINGS}: invalid JSON: {exc}") from exc
    if settings.get("agent") == "controller":
        return False
    backups.preserve(CLAUDE_SETTINGS)
    settings["agent"] = "controller"
    CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    return True


def write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.shared-agents.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json_object(path: Path, label: str) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except json.JSONDecodeError as exc:
        raise Problem(f"{path}: invalid {label} JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise Problem(f"{path}: {label} must be a JSON object")
    return value


def capture_install_state(backups: BackupStore) -> None:
    """Record only installer-owned Claude state, preserving the first install."""
    if STATE_FILE.is_file():
        state = read_json_object(STATE_FILE, "shared-agents install state")
        if state.get("version") != 1:
            raise Problem(f"{STATE_FILE}: unsupported shared-agents install state")
        return
    settings = read_json_object(CLAUDE_SETTINGS, "Claude settings")
    prior_settings = settings
    if settings.get("agent") == "controller":
        older_settings_backup = latest_backup_for(CLAUDE_SETTINGS)
        if older_settings_backup is not None:
            prior_settings = read_json_object(
                older_settings_backup, "Claude settings backup"
            )
    retired: list[dict[str, str]] = []
    for source in sorted((PLUGIN / "agents").glob("*.md")):
        target = CLAUDE_STANDALONE / source.name
        if target.exists() or target.is_symlink():
            backup = backups.destination(target)
        else:
            backup = latest_backup_for(target)
        if backup is not None:
            retired.append({"name": source.name, "backup": str(backup)})
    write_json_atomic(
        STATE_FILE,
        {
            "version": 1,
            "claude_agent": {
                "present": "agent" in prior_settings,
                "value": prior_settings.get("agent"),
            },
            "retired_claude_agents": retired,
        },
    )


def restore_install_state() -> bool:
    """Undo owned Claude mutations without overwriting later human choices."""
    if not STATE_FILE.is_file():
        return False
    state = read_json_object(STATE_FILE, "shared-agents install state")
    if state.get("version") != 1:
        raise Problem(f"{STATE_FILE}: unsupported shared-agents install state")
    prior = state.get("claude_agent")
    if not isinstance(prior, dict) or not isinstance(prior.get("present"), bool):
        raise Problem(f"{STATE_FILE}: invalid prior Claude agent state")

    settings = read_json_object(CLAUDE_SETTINGS, "Claude settings")
    if settings.get("agent") == "controller":
        if prior["present"]:
            settings["agent"] = prior.get("value")
        else:
            settings.pop("agent", None)
        write_json_atomic(CLAUDE_SETTINGS, settings)

    allowed_names = {path.name for path in (PLUGIN / "agents").glob("*.md")}
    backup_root = Path(os.path.abspath(BACKUP_ROOT))
    retired = state.get("retired_claude_agents", [])
    if not isinstance(retired, list):
        raise Problem(f"{STATE_FILE}: invalid retired Claude agent state")
    for record in retired:
        if not isinstance(record, dict):
            raise Problem(f"{STATE_FILE}: invalid retired Claude agent record")
        name = record.get("name")
        backup_value = record.get("backup")
        if name not in allowed_names or not isinstance(backup_value, str):
            raise Problem(f"{STATE_FILE}: unsafe retired Claude agent record")
        backup = Path(os.path.abspath(backup_value))
        try:
            backup.relative_to(backup_root)
        except ValueError as exc:
            raise Problem(f"{STATE_FILE}: backup path is outside shared-agents state") from exc
        target = CLAUDE_STANDALONE / str(name)
        if (backup.exists() or backup.is_symlink()) and not (
            target.exists() or target.is_symlink()
        ):
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(backup), str(target))
    STATE_FILE.unlink()
    return True


def install_plugin() -> None:
    run([sys.executable, str(WORKSPACE / "scripts" / "plugins.py"), "sync"])

    if shutil.which("codex"):
        marketplaces = run(["codex", "plugin", "marketplace", "list"], allow_failure=True)
        if MARKETPLACE not in marketplaces.stdout + marketplaces.stderr:
            run(["codex", "plugin", "marketplace", "add", str(WORKSPACE), "--json"])
        run(["codex", "plugin", "remove", PLUGIN_ID], allow_failure=True)
        run(["codex", "plugin", "add", PLUGIN_ID, "--json"])
    else:
        print("codex not on PATH — native TOML agents will still be linked")

    if shutil.which("claude"):
        listing = run(["claude", "plugin", "marketplace", "list", "--json"], allow_failure=True)
        try:
            names = {entry["name"] for entry in json.loads(listing.stdout)}
        except (json.JSONDecodeError, KeyError, TypeError):
            names = set()
        if MARKETPLACE not in names:
            run(["claude", "plugin", "marketplace", "add", str(WORKSPACE), "--scope", "user"])
        else:
            run(["claude", "plugin", "marketplace", "update", MARKETPLACE], allow_failure=True)
        run(
            [
                "claude",
                "plugin",
                "uninstall",
                PLUGIN_ID,
                "--scope",
                "user",
                "--yes",
                "--keep-data",
            ],
            allow_failure=True,
        )
        run(["claude", "plugin", "install", PLUGIN_ID, "--scope", "user"])
        run(
            ["claude", "plugin", "enable", PLUGIN_ID, "--scope", "user"],
            allow_failure=True,
        )
    else:
        print("claude not on PATH — skipped Claude plugin installation")


def retire_claude_standalone_agents(backups: BackupStore) -> list[Path]:
    moved: list[Path] = []
    for source in sorted((PLUGIN / "agents").glob("*.md")):
        target = CLAUDE_STANDALONE / source.name
        preserved = backups.preserve(target, move=True)
        if preserved:
            moved.append(preserved)
    return moved


def install_native_files(backups: BackupStore) -> None:
    capture_install_state(backups)
    for source in sorted(CODEX_SOURCE.glob("*.toml")):
        ensure_symlink(source, CODEX_TARGET / source.name, backups)
    ensure_symlink(CODEX_CONTROLLER_PROFILE, CODEX_CONTROLLER_TARGET, backups)
    retire_claude_standalone_agents(backups)
    ensure_symlink(CLAUDE_POLICY, CLAUDE_RULE, backups)
    sync_managed_block(
        CLAUDE_GLOBAL,
        (ROOT / "policy" / "claude-global.md").read_text(encoding="utf-8"),
        backups,
    )
    sync_managed_block(
        CODEX_GLOBAL,
        (ROOT / "policy" / "codex-global.md").read_text(encoding="utf-8"),
        backups,
    )
    update_claude_settings(backups)


def tree_digest(root: Path) -> str:
    if not root.is_dir():
        return ""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if DIGEST_IGNORE & set(path.relative_to(root).parts) or not path.is_file():
            continue
        digest.update(str(path.relative_to(root)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


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

    try:
        catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"agents.json: {exc}"]
    by_id = {agent["id"]: agent for agent in catalog.get("agents", [])}
    if set(by_id) != {"controller", "alan-wake", "repo-explorer", "task-analyst"}:
        problems.append("agents.json must define controller, alan-wake, repo-explorer, and task-analyst")
    if by_id.get("controller", {}).get("codex"):
        problems.append("controller must remain the Codex primary thread, not a spawnable custom agent")
    if by_id.get("controller", {}).get("claude", {}).get("model") != "fable":
        problems.append("Claude controller must use fable")
    for agent_id in ("alan-wake", "repo-explorer", "task-analyst"):
        if by_id.get(agent_id, {}).get("claude", {}).get("model") != "sonnet":
            problems.append(f"Claude {agent_id} must use sonnet")

    for path in CODEX_SOURCE.glob("*.toml"):
        try:
            parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            problems.append(f"{path.relative_to(ROOT)}: invalid TOML: {exc}")
            continue
        for field in ("name", "description", "developer_instructions", "model", "model_reasoning_effort"):
            if not parsed.get(field):
                problems.append(f"{path.relative_to(ROOT)}: missing {field}")
        if not str(parsed.get("model", "")).startswith("gpt-"):
            problems.append(f"{path.relative_to(ROOT)}: Codex model must be a GPT model")

    try:
        controller_profile = tomllib.loads(CODEX_CONTROLLER_PROFILE.read_text(encoding="utf-8"))
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

    settings = json.loads((PLUGIN / "settings.json").read_text(encoding="utf-8"))
    if settings.get("agent") != "controller":
        problems.append("plugin settings.json must activate controller")
    skill = PLUGIN / "skills" / "shared-agents" / "SKILL.md"
    if not skill.is_file() or not skill.read_text(encoding="utf-8").startswith("---\n"):
        problems.append("shared-agents skill is missing or malformed")
    codex_policy = (ROOT / "policy" / "codex-global.md").read_text(encoding="utf-8")
    if "automatically spawn `alan_wake`" not in codex_policy:
        problems.append("Codex policy must automatically route requested prose to alan_wake")
    return problems


def live_problems() -> list[str]:
    problems = package_problems()
    for source in sorted(CODEX_SOURCE.glob("*.toml")):
        target = CODEX_TARGET / source.name
        if not target.is_symlink() or target.resolve(strict=False) != source.resolve():
            problems.append(f"{target}: not linked to the shared source")
    if (
        not CODEX_CONTROLLER_TARGET.is_symlink()
        or CODEX_CONTROLLER_TARGET.resolve(strict=False) != CODEX_CONTROLLER_PROFILE.resolve()
    ):
        problems.append(f"{CODEX_CONTROLLER_TARGET}: controller launch profile is not installed")
    for source in sorted((PLUGIN / "agents").glob("*.md")):
        target = CLAUDE_STANDALONE / source.name
        if target.exists() or target.is_symlink():
            problems.append(f"{target}: legacy standalone copy still shadows the plugin")
    if not CLAUDE_RULE.is_symlink() or CLAUDE_RULE.resolve(strict=False) != CLAUDE_POLICY.resolve():
        problems.append(f"{CLAUDE_RULE}: not linked to the shared policy")
    for path, policy in (
        (CLAUDE_GLOBAL, ROOT / "policy" / "claude-global.md"),
        (CODEX_GLOBAL, ROOT / "policy" / "codex-global.md"),
    ):
        expected = render_managed(policy.read_text(encoding="utf-8"))
        if not path.is_file() or expected not in path.read_text(encoding="utf-8"):
            problems.append(f"{path}: shared controller block is missing or stale")
    try:
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        settings = {}
    if settings.get("agent") != "controller":
        problems.append("Claude user settings do not activate controller")
    if not settings.get("enabledPlugins", {}).get(PLUGIN_ID):
        problems.append(f"Claude plugin {PLUGIN_ID} is not enabled")

    installed = Path.home() / ".claude" / "plugins" / "installed_plugins.json"
    try:
        records = json.loads(installed.read_text(encoding="utf-8"))["plugins"][PLUGIN_ID]
        live_path = Path(records[0]["installPath"])
        if tree_digest(live_path) != tree_digest(PLUGIN):
            problems.append(f"Claude plugin {PLUGIN_ID} cache is missing or stale")
    except (OSError, json.JSONDecodeError, KeyError, IndexError, TypeError):
        problems.append(f"Claude plugin {PLUGIN_ID} is not installed")

    if shutil.which("codex"):
        listing = subprocess.run(
            ["codex", "plugin", "list"], capture_output=True, text=True, check=False
        )
        if not any(line.startswith(PLUGIN_ID) and "enabled" in line for line in listing.stdout.splitlines()):
            problems.append(f"Codex plugin {PLUGIN_ID} is not installed and enabled")
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
    install_plugin()
    backups = BackupStore()
    install_native_files(backups)
    if backups.created:
        print(f"backed up {len(backups.created)} replaced file(s) under {backups.root}")
    return cmd_status(argparse.Namespace())


def cmd_status(_: argparse.Namespace) -> int:
    problems = live_problems()
    print(f"{'FAIL' if problems else 'ok  '} shared-agents live installation")
    for problem in problems:
        print(f"  - {problem}")
    if not problems:
        print("  Claude: controller + 3 scoped plugin agents")
        print("  Codex: controller profile + global policy + 3 native custom agents")
    return 1 if problems else 0


def cmd_uninstall(_: argparse.Namespace) -> int:
    for source in CODEX_SOURCE.glob("*.toml"):
        target = CODEX_TARGET / source.name
        if target.is_symlink() and target.resolve(strict=False) == source.resolve():
            target.unlink()
    if (
        CODEX_CONTROLLER_TARGET.is_symlink()
        and CODEX_CONTROLLER_TARGET.resolve(strict=False) == CODEX_CONTROLLER_PROFILE.resolve()
    ):
        CODEX_CONTROLLER_TARGET.unlink()
    if CLAUDE_RULE.is_symlink() and CLAUDE_RULE.resolve(strict=False) == CLAUDE_POLICY.resolve():
        CLAUDE_RULE.unlink()
    remove_managed_block(CLAUDE_GLOBAL)
    remove_managed_block(CODEX_GLOBAL)
    if shutil.which("codex"):
        run(["codex", "plugin", "remove", PLUGIN_ID], allow_failure=True)
    if shutil.which("claude"):
        run(["claude", "plugin", "uninstall", PLUGIN_ID, "--scope", "user", "--yes"], allow_failure=True)
    restored = restore_install_state()
    suffix = "; prior Claude state restored" if restored else ""
    print(f"removed shared-agent links, managed blocks, and plugin installs{suffix}; backups were retained")
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

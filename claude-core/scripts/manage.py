#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
HOME = Path.home()
CLAUDE_HOME = Path.home() / ".claude"
BACKUP_ROOT = Path.home() / ".config" / "claude-core" / "backups"
CLAUDE_SOURCE = ROOT / "agents" / "rendered"
CLAUDE_TARGET = CLAUDE_HOME / "agents"
CLAUDE_SETTINGS = CLAUDE_HOME / "settings.json"
MANAGED_SETTINGS_FRAGMENT = ROOT / "settings" / "managed.json"
OWNED_SETTINGS_KEYS = ("hooks", "statusLine", "attribution")

MANAGED_FILES = (
    "CLAUDE.md",
    "chrome-cdp.md",
    "statusline.py",
    "keybindings.json",
    "rules/waiting.md",
    "rules/code-style.md",
    "hooks/f17-ticket-keys.sh",
    "hooks/f17-comment-count.sh",
    "hooks/guard-red-write.py",
    "scripts/verify-run.py",
    "scripts/test-quality-scan.py",
)
MANAGED_DIRECTORIES = (
    "skills/engineering",
    "skills/mr-preflight",
    "skills/review-retro",
)
WORKSPACE_MANAGED = (
    ("wiki/plugins/obsidian-memory/skills/obsidian-memory", "skills/obsidian-memory"),
    ("wiki/plugins/obsidian-memory/skills/global-memory", "skills/global-memory"),
    ("wiki/plugins/obsidian-memory/scripts/obsidian_memory.py", "scripts/obsidian_memory.py"),
    ("wiki/plugins/obsidian-memory/rules/obsidian-vault.md", "rules/obsidian-vault.md"),
    ("codex-pair/plugins/codex-pair/skills/codex-pair", "skills/codex-pair"),
    ("chatgpt-consult/plugins/chatgpt-consult/skills/chatgpt-consult", "skills/chatgpt-consult"),
)
WORKSPACE_DIRECTORIES = frozenset(
    {
        "wiki/plugins/obsidian-memory/skills/obsidian-memory",
        "wiki/plugins/obsidian-memory/skills/global-memory",
        "codex-pair/plugins/codex-pair/skills/codex-pair",
        "chatgpt-consult/plugins/chatgpt-consult/skills/chatgpt-consult",
    }
)
EXTERNAL_MANAGED_FILES = (
    ("git-guards/install", ".config/git-guards/install"),
    ("git-guards/pre-push-foreign-history", ".config/git-guards/pre-push-foreign-history"),
)
REQUIRED_DIRECTORY_FILES = {
    "skills/engineering": (
        "SKILL.md",
        "references/shaping.md",
        "references/minimalism.md",
        "references/debugging.md",
        "references/verification.md",
        "references/second-opinion.md",
        "references/writing.md",
        "references/delivery.md",
        "references/tracking.md",
    ),
    "skills/mr-preflight": (
        "SKILL.md",
        "preflight-snapshot.py",
        "preflight-triage.sh",
        "mr-doctor.sh",
        "mr-doctor-fields.py",
        "harness-delta.py",
        "bench.sh",
        "failure-modes.md",
        "failure-modes-history.md",
    ),
    "skills/review-retro": ("SKILL.md",),
    **{source: ("SKILL.md",) for source in sorted(WORKSPACE_DIRECTORIES)},
}
EXECUTABLES = (
    "hooks/f17-ticket-keys.sh",
    "hooks/f17-comment-count.sh",
    "statusline.py",
    "git-guards/install",
    "git-guards/pre-push-foreign-history",
    "skills/mr-preflight/preflight-triage.sh",
    "skills/mr-preflight/mr-doctor.sh",
    "skills/mr-preflight/bench.sh",
)
MANAGED_DIRECTORY_TARGETS = (
    *MANAGED_DIRECTORIES,
    *(target for source, target in WORKSPACE_MANAGED if source in WORKSPACE_DIRECTORIES),
)
MANAGED_CONTAINERS = ("rules", "hooks", "skills", "agents", *MANAGED_DIRECTORY_TARGETS)
EXTERNAL_CALLERS = ("settings.json", "agents")
CLAUDE_PATH_LITERAL = re.compile(
    r"(?:~|\$HOME|/Users/[^/\s`'\"]+)/\.claude/([A-Za-z0-9_./-]*[A-Za-z0-9_/-])"
)


class Problem(RuntimeError):
    pass


def backup_relative_path(path: Path) -> Path:
    try:
        return path.relative_to(HOME)
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
    raise SystemExit("claude-core requires Python 3.11+")


class BackupStore:
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
        elif path.is_dir():
            shutil.copytree(path, destination, symlinks=True)
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
    temporary = target.with_name(f".{target.name}.claude-core.tmp")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
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


def claude_home_map() -> dict[str, Path]:
    """Map every managed `~/.claude`-relative target to the repository or workspace source behind it."""
    mapping = {rel: ROOT / rel for rel in (*MANAGED_FILES, *MANAGED_DIRECTORIES)}
    mapping.update({target: REPO_ROOT / source for source, target in WORKSPACE_MANAGED})
    return mapping


def managed_links() -> list[tuple[Path, Path]]:
    links = [(source, CLAUDE_HOME / target) for target, source in claude_home_map().items()]
    links.extend((ROOT / source, HOME / target) for source, target in EXTERNAL_MANAGED_FILES)
    return links


def is_managed(rel: str) -> bool:
    rel = rel.rstrip("/")
    if rel.startswith("agents/"):
        return any(rel == f"agents/{source.name}" for source in claude_agent_sources())
    if rel in claude_home_map():
        return True
    return any(rel.startswith(directory + "/") for directory in MANAGED_DIRECTORY_TARGETS)


def managed_source(rel: str) -> Path:
    if rel.startswith("agents/"):
        return CLAUDE_SOURCE / rel.removeprefix("agents/")
    mapping = claude_home_map()
    if rel in mapping:
        return mapping[rel]
    for directory in sorted(MANAGED_DIRECTORY_TARGETS, key=len, reverse=True):
        if rel.startswith(directory + "/"):
            return mapping[directory] / rel.removeprefix(directory + "/")
    return ROOT / rel


def reference_literals(text: str) -> set[str]:
    return {match.group(1) for match in CLAUDE_PATH_LITERAL.finditer(text)}


def managed_text_files() -> list[Path]:
    files = [ROOT / rel for rel in MANAGED_FILES]
    files.append(MANAGED_SETTINGS_FRAGMENT)
    for rel in MANAGED_DIRECTORIES:
        files.extend(sorted(path for path in (ROOT / rel).rglob("*") if path.is_file()))
    files.extend(sorted((ROOT / "agents" / "prompts").glob("*.md")))
    return files


def literals_in(path: Path) -> set[str]:
    try:
        return reference_literals(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return set()


def reference_edges() -> list[tuple[Path, str]]:
    return [(path, rel) for path in managed_text_files() for rel in sorted(literals_in(path))]


def external_caller_files() -> list[Path]:
    files: list[Path] = []
    for name in EXTERNAL_CALLERS:
        path = CLAUDE_HOME / name
        if path.is_dir():
            files.extend(sorted(child for child in path.iterdir() if child.is_file()))
        elif path.is_file():
            files.append(path)
    return files


def link_state(source: Path, target: Path) -> str:
    if target.is_symlink():
        if os.readlink(target) != str(source):
            return "wrong-link"
        return "ok" if target.exists() else "dangling"
    if target.is_dir():
        return "directory"
    if target.exists():
        return "regular"
    return "missing"


def package_problems() -> list[str]:
    problems: list[str] = []
    for rel in MANAGED_FILES:
        source = ROOT / rel
        if not source.is_file() or source.is_symlink():
            problems.append(f"{rel}: must be a regular file in the repository")
    for rel in MANAGED_DIRECTORIES:
        source = ROOT / rel
        if not source.is_dir() or source.is_symlink():
            problems.append(f"{rel}: must be a directory in the repository")
            continue
        for name in REQUIRED_DIRECTORY_FILES[rel]:
            if not (source / name).is_file():
                problems.append(f"{rel}/{name}: required file is missing")
    for source_rel, _ in WORKSPACE_MANAGED:
        source = REPO_ROOT / source_rel
        if source_rel in WORKSPACE_DIRECTORIES:
            if not source.is_dir() or source.is_symlink():
                problems.append(f"{source_rel}: must be a directory in the workspace")
                continue
            for name in REQUIRED_DIRECTORY_FILES[source_rel]:
                if not (source / name).is_file():
                    problems.append(f"{source_rel}/{name}: required file is missing")
        elif not source.is_file() or source.is_symlink():
            problems.append(f"{source_rel}: must be a regular file in the workspace")
    for source_rel, _ in EXTERNAL_MANAGED_FILES:
        source = ROOT / source_rel
        if not source.is_file() or source.is_symlink():
            problems.append(f"{source_rel}: must be a regular file in the repository")
    problems.extend(settings_fragment_problems())
    for rel in EXECUTABLES:
        source = ROOT / rel
        if source.is_file() and not source.stat().st_mode & 0o111:
            problems.append(f"{rel}: must keep its executable bit")
    for path, rel in reference_edges():
        origin = path.relative_to(ROOT)
        if rel.endswith("/"):
            if rel.rstrip("/") not in MANAGED_CONTAINERS:
                problems.append(f"{origin} references unmanaged ~/.claude/{rel}")
        elif not is_managed(rel):
            problems.append(f"{origin} references unmanaged ~/.claude/{rel}")
        elif not managed_source(rel).exists():
            problems.append(f"{origin} references ~/.claude/{rel}, which does not exist in the repository")
    problems.extend(agent_package_problems())
    return problems


def agent_package_problems() -> list[str]:
    problems: list[str] = []
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "render.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        problems.append("rendered agents drift from the catalog; run `python3 scripts/render.py`")

    expected_claude = {"Explore.md", "worker.md", "reviewer.md"}
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
        catalog = json.loads((ROOT / "agents" / "agents.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return problems + [f"agents/agents.json: {exc}"]
    by_id = {agent["id"]: agent for agent in catalog.get("agents", [])}
    expected_models = {
        "repo-explorer": "sonnet",
        "worker": "sonnet",
        "reviewer": "claude-opus-5-5",
    }
    if set(by_id) != set(expected_models):
        problems.append(f"agents.json must define exactly {', '.join(expected_models)}")
    for agent_id, model in expected_models.items():
        if by_id.get(agent_id, {}).get("claude", {}).get("model") != model:
            problems.append(f"Claude {agent_id} must use {model}")
    return problems


HOME_LITERAL = re.compile(r"(?:^|(?<=\s))~/")


def expand_home(value):
    """Rewrite every `~/` path literal in a fragment value to the absolute home directory."""
    if isinstance(value, str):
        return HOME_LITERAL.sub(f"{HOME}{os.sep}", value)
    if isinstance(value, dict):
        return {key: expand_home(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand_home(item) for item in value]
    return value


def settings_fragment() -> dict:
    """The three claude-core-owned settings keys, with home-relative commands made absolute."""
    fragment = json.loads(MANAGED_SETTINGS_FRAGMENT.read_text(encoding="utf-8"))
    return {key: expand_home(fragment[key]) for key in OWNED_SETTINGS_KEYS}


def settings_fragment_problems() -> list[str]:
    origin = MANAGED_SETTINGS_FRAGMENT.relative_to(ROOT)
    try:
        fragment = json.loads(MANAGED_SETTINGS_FRAGMENT.read_text(encoding="utf-8"))
    except OSError:
        return [f"{origin}: managed settings fragment is missing"]
    except json.JSONDecodeError as exc:
        return [f"{origin}: invalid JSON: {exc}"]
    if not isinstance(fragment, dict) or sorted(fragment) != sorted(OWNED_SETTINGS_KEYS):
        return [f"{origin}: must define exactly {', '.join(OWNED_SETTINGS_KEYS)}"]
    return []


def settings_drift() -> list[str]:
    """Report owned keys the live settings are missing or disagree on; stay silent about unreadable settings."""
    if settings_fragment_problems():
        return []
    try:
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        settings = {}
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(settings, dict):
        return []
    problems: list[str] = []
    for key, value in settings_fragment().items():
        if key not in settings:
            problems.append(f"{CLAUDE_SETTINGS}: {key} is missing")
        elif settings[key] != value:
            problems.append(f"{CLAUDE_SETTINGS}: {key} differs from the managed settings fragment")
    return problems


def install_settings(backups: BackupStore) -> bool:
    fragment = settings_fragment()
    try:
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        settings = {}
    except json.JSONDecodeError as exc:
        raise Problem(f"{CLAUDE_SETTINGS}: invalid JSON: {exc}")
    if not isinstance(settings, dict):
        raise Problem(f"{CLAUDE_SETTINGS}: must contain a JSON object")
    if all(settings.get(key) == value for key, value in fragment.items()):
        return False
    backups.preserve(CLAUDE_SETTINGS)
    merged = {**settings, **fragment}
    CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    temporary = CLAUDE_SETTINGS.with_name(f".{CLAUDE_SETTINGS.name}.claude-core.tmp")
    temporary.unlink(missing_ok=True)
    try:
        temporary.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        temporary.replace(CLAUDE_SETTINGS)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def live_problems() -> list[str]:
    problems = package_problems()
    for source, target in managed_links():
        state = link_state(source, target)
        if state != "ok":
            problems.append(f"{target}: {state}, expected symlink -> {source}")
    for path, rel in reference_edges():
        if not (CLAUDE_HOME / rel).exists():
            problems.append(f"{path.relative_to(ROOT)} references ~/.claude/{rel}, which does not resolve")
    for path in external_caller_files():
        for rel in sorted(literals_in(path)):
            if is_managed(rel) and not (CLAUDE_HOME / rel).exists():
                problems.append(f"{path} references ~/.claude/{rel}, which does not resolve")
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
    problems.extend(settings_drift())
    return problems


def replace_with_link(source: Path, target: Path, backups: BackupStore) -> None:
    backups.preserve(target)
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{target.name}.claude-core.tmp"
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    temporary.symlink_to(source)
    temporary.replace(target)


def points_into_managed_root(link: Path) -> bool:
    target = Path(os.readlink(link))
    if not target.is_absolute():
        target = link.parent / target
    normalized = Path(os.path.normpath(target))
    return any(normalized == root or root in normalized.parents for root in (ROOT, REPO_ROOT))


def prune_stale_links() -> list[Path]:
    pruned: list[Path] = []
    for directory in sorted({target.parent for _, target in managed_links()}):
        if not directory.is_dir():
            continue
        for child in sorted(directory.iterdir()):
            if child.is_symlink() and not child.exists() and points_into_managed_root(child):
                child.unlink()
                pruned.append(child)
    return pruned


def install_links(backups: BackupStore) -> list[Path]:
    changed: list[Path] = []
    for source, target in managed_links():
        if link_state(source, target) == "ok":
            continue
        replace_with_link(source, target, backups)
        changed.append(target)
    return changed


def uninstall_links() -> list[Path]:
    removed: list[Path] = []
    for source, target in managed_links():
        if target.is_symlink() and os.readlink(target) == str(source):
            target.unlink()
            removed.append(target)
    return removed


def report(label: str, problems: list[str]) -> None:
    print(f"{'FAIL' if problems else 'ok  '} {label}")
    for problem in problems:
        print(f"  - {problem}")


def cmd_render(_: argparse.Namespace) -> int:
    return run([sys.executable, str(ROOT / "scripts" / "render.py")]).returncode


def cmd_check(_: argparse.Namespace) -> int:
    problems = package_problems()
    report("claude-core package", problems)
    tests = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "tests"), "-v"],
        capture_output=True,
        text=True,
        check=False,
    )
    print(tests.stdout, end="")
    print(tests.stderr, end="", file=sys.stderr)
    if tests.returncode:
        problems.append("claude-core unit tests failed")
    return 1 if problems else 0


def cmd_install(_: argparse.Namespace) -> int:
    run([sys.executable, str(ROOT / "scripts" / "render.py")])
    problems = package_problems()
    if problems:
        raise Problem("package validation failed:\n" + "\n".join(f"- {p}" for p in problems))
    backups = BackupStore()
    for path in prune_stale_links():
        print(f"pruned {path}")
    changed = install_links(backups)
    for path in changed:
        print(f"linked {path}")
    print(f"unchanged {len(managed_links()) - len(changed)} link(s)")
    print("settings fragment " + ("applied" if install_settings(backups) else "unchanged"))
    copied = install_claude_agents(backups)
    for path in copied:
        print(f"copied {path}")
    print(f"unchanged {len(claude_agent_sources()) - len(copied)} agent file(s)")
    if backups.created:
        print(f"backed up {len(backups.created)} replaced path(s) under {backups.root}")
    return cmd_status(argparse.Namespace())


def cmd_status(_: argparse.Namespace) -> int:
    problems = live_problems()
    report("claude-core live installation", problems)
    if not problems:
        print(f"  {len(managed_links())} link(s), {len(claude_agent_sources())} agent file(s), {len(reference_edges())} reference edge(s) resolve; settings fragment in sync")
    return 1 if problems else 0


def cmd_uninstall(_: argparse.Namespace) -> int:
    removed = uninstall_links() + uninstall_claude_agents()
    for path in removed:
        print(f"removed {path}")
    print("preserved unmanaged paths, modified targets, and all backups")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate, install, inspect, uninstall, or render the claude-core configuration for ~/.claude."
    )
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

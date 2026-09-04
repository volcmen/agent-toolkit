#!/usr/bin/env python3
"""Reproduce and validate the user's Bun-global command-line tools."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "manifest.json"
BUN_ROOT = Path.home() / ".bun"
BUN_GLOBAL = BUN_ROOT / "install" / "global"
BUN_BIN = BUN_ROOT / "bin"


class ToolingError(RuntimeError):
    """Raised when the declared global-tool state is invalid or unhealthy."""


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise ToolingError(f"{' '.join(command)} failed: {detail}")
    return result


def load_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolingError(f"cannot read {MANIFEST}: {exc}") from exc
    if manifest.get("schema_version") != 1:
        raise ToolingError("unsupported manifest schema")
    packages = manifest.get("packages")
    if not isinstance(packages, list) or not packages:
        raise ToolingError("manifest packages must be a non-empty array")
    return manifest


def global_package_json() -> dict[str, Any]:
    path = BUN_GLOBAL / "package.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolingError(f"cannot read Bun global state at {path}: {exc}") from exc
    return value if isinstance(value, dict) else {}


def npm_user_globals(allowed: set[str]) -> dict[str, str]:
    if shutil.which("npm") is None:
        return {}
    payload = json.loads(run(["npm", "ls", "-g", "--depth=0", "--json"]).stdout)
    dependencies = payload.get("dependencies", {})
    if not isinstance(dependencies, dict):
        return {}
    return {
        name: str(metadata.get("version", "unknown"))
        for name, metadata in dependencies.items()
        if name not in allowed and isinstance(metadata, dict)
    }


def expected_packages(manifest: dict[str, Any]) -> dict[str, str]:
    return {
        str(package["name"]): str(package["version"])
        for package in manifest["packages"]
    }


def check(deep: bool) -> None:
    manifest = load_manifest()
    if shutil.which("bun") is None:
        raise ToolingError("bun is unavailable")
    state = global_package_json()
    installed = state.get("dependencies", {})
    if not isinstance(installed, dict):
        raise ToolingError("Bun global dependencies are malformed")

    problems: list[str] = []
    for name, version in expected_packages(manifest).items():
        if installed.get(name) != version:
            problems.append(f"{name}: expected {version}, found {installed.get(name)!r}")

    trusted = set(state.get("trustedDependencies", []))
    missing_trust = set(manifest["trusted_dependencies"]) - trusted
    if missing_trust:
        problems.append(f"missing trusted dependencies: {sorted(missing_trust)}")

    for package in manifest["packages"]:
        for binary in package.get("binaries", []):
            expected = (BUN_BIN / binary).resolve()
            discovered = shutil.which(binary)
            if discovered is None:
                problems.append(f"binary unavailable: {binary}")
            elif Path(discovered).resolve() != expected:
                problems.append(
                    f"binary shadowed: {binary} resolves to {discovered}, expected {expected}"
                )

    npm_extras = npm_user_globals(set(manifest["allowed_npm_runtime_packages"]))
    if npm_extras:
        problems.append(f"user-installed npm globals remain: {npm_extras}")

    if problems:
        raise ToolingError("\n".join(problems))

    run(["qmd", "--version"])
    run(["ios", "version"])
    agent_browser_version = run(["agent-browser", "--version"]).stdout.strip()
    if agent_browser_version != "agent-browser 0.35.1":
        raise ToolingError(
            "agent-browser: expected version output "
            f"'agent-browser 0.35.1', found {agent_browser_version!r}"
        )
    if deep:
        run(["qmd", "status"], timeout=60)
    print(
        f"ok: {len(manifest['packages'])} Bun-global tools; "
        "no user-installed npm globals"
    )


def apply() -> None:
    manifest = load_manifest()
    if shutil.which("bun") is None:
        raise ToolingError("bun is unavailable")
    for package in manifest["packages"]:
        spec = f"{package['name']}@{package['version']}"
        command = ["bun", "add", "--global", "--exact"]
        if package.get("trust_package"):
            command.append("--trust")
        command.append(spec)
        env = os.environ.copy()
        if package.get("needs_bun_prefix"):
            env["npm_config_prefix"] = str(BUN_ROOT)
        run(command, env=env)

    state = global_package_json()
    trusted = set(state.get("trustedDependencies", []))
    missing_trust = [
        name for name in manifest["trusted_dependencies"] if name not in trusted
    ]
    if missing_trust:
        run(
            ["bun", "pm", "trust", *missing_trust],
            cwd=BUN_GLOBAL,
            timeout=900,
        )
    check(deep=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "apply"))
    parser.add_argument(
        "--deep",
        action="store_true",
        help="For check, also open the QMD database and inspect index health",
    )
    args = parser.parse_args()
    try:
        if args.command == "apply":
            apply()
        else:
            check(args.deep)
    except (OSError, subprocess.SubprocessError, ToolingError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

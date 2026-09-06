#!/usr/bin/env python3
"""Resolve the qwen-gsd-slice run configuration.

Layers, lowest precedence first:

    config/defaults.json  ->  $QWEN_GSD_CONFIG or ~/.qwen-gsd/config.json
                          ->  QWEN_GSD_<KEY> environment variables
                          ->  qwen_slice.sh command-line flags

`env` prints shell assignments for the wrapper to eval; `show` prints the
effective value and where it came from.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
DEFAULTS_FILE = SKILL_ROOT / "config" / "defaults.json"
BOOL_KEYS = ("safe_mode", "sandbox", "model_check")
PATH_KEYS = ("state_dir",)


def user_config_path() -> Path:
    override = os.environ.get("QWEN_GSD_CONFIG")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".qwen-gsd" / "config.json"


def read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"qwen_config: {path} is not valid JSON: {error}")
    if not isinstance(data, dict):
        raise SystemExit(f"qwen_config: {path} must contain a JSON object")
    return data


def coerce(key: str, value: object) -> object:
    if key in BOOL_KEYS:
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in ("1", "true", "yes", "on"):
            return True
        if normalized in ("0", "false", "no", "off"):
            return False
        raise SystemExit(
            f"qwen_config: {key} must be a boolean "
            "(true/false, yes/no, on/off, or 1/0)"
        )
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return value


def resolve() -> tuple[dict, dict]:
    defaults = read_json(DEFAULTS_FILE)
    if not defaults:
        raise SystemExit(f"qwen_config: defaults missing or empty: {DEFAULTS_FILE}")

    values = dict(defaults)
    sources = {key: "default" for key in defaults}

    user_path = user_config_path()
    for key, value in read_json(user_path).items():
        if key not in defaults:
            raise SystemExit(f"qwen_config: unknown key '{key}' in {user_path}")
        values[key] = coerce(key, value)
        sources[key] = str(user_path)

    for key in defaults:
        env_key = "QWEN_GSD_" + key.upper()
        if env_key in os.environ:
            values[key] = coerce(key, os.environ[env_key])
            sources[key] = f"env:{env_key}"

    for key in PATH_KEYS:
        values[key] = str(Path(str(values[key])).expanduser())

    return values, sources


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("env", "show", "json", "get"), default="show", nargs="?")
    parser.add_argument("key", nargs="?", help="key to print with `get`")
    args = parser.parse_args()

    values, sources = resolve()

    if args.mode == "get":
        if args.key not in values:
            raise SystemExit(f"qwen_config: unknown key '{args.key}'")
        value = values[args.key]
        print(int(value) if isinstance(value, bool) else value)
        return

    if args.mode == "json":
        print(json.dumps(values, indent=2, sort_keys=True))
        return

    if args.mode == "env":
        for key, value in values.items():
            if isinstance(value, bool):
                value = 1 if value else 0
            print(f"QGS_{key.upper()}={shlex.quote(str(value))}")
        return

    print(f"defaults: {DEFAULTS_FILE}")
    print(f"user:     {user_config_path()}" + ("" if user_config_path().is_file() else "  (absent)"))
    width = max(len(key) for key in values)
    for key in sorted(values):
        print(f"{key.ljust(width)}  {str(values[key]).ljust(12)}  <- {sources[key]}")


if __name__ == "__main__":
    main()

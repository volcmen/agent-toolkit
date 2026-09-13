#!/usr/bin/env python3
"""Validate a Qwen model id against the configured providers before spending a run.

Qwen Code 0.21.10 silently falls back to a built-in default when `--model` names
an unknown id: the run exits 0 and reports success while billing the wrong
model. Catch the typo locally instead.

Exit 0 = id is configured; 3 = unknown id; 4 = ambiguous id; 2 = cannot check.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def providers(settings: dict) -> list[dict]:
    entries: list[dict] = []
    for group in (settings.get("modelProviders") or {}).values():
        if isinstance(group, list):
            entries.extend(entry for entry in group if isinstance(entry, dict))
    return entries


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", nargs="?")
    parser.add_argument("--settings", type=Path, default=Path.home() / ".qwen" / "settings.json")
    parser.add_argument("--list", action="store_true", help="print configured ids and exit")
    args = parser.parse_args()

    if not args.settings.is_file():
        raise SystemExit(f"settings not found: {args.settings}")
    try:
        settings = json.loads(args.settings.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"settings not parseable: {error}")

    if not isinstance(settings, dict):
        raise SystemExit("settings must contain a JSON object")
    model_providers = settings.get("modelProviders", {})
    if model_providers is None:
        model_providers = {}
    if not isinstance(model_providers, dict):
        raise SystemExit("modelProviders must contain a JSON object")
    configured_env = settings.get("env", {})
    if configured_env is None:
        configured_env = {}
    if not isinstance(configured_env, dict):
        raise SystemExit("env must contain a JSON object")

    entries = providers(settings)
    if not entries:
        raise SystemExit("no modelProviders configured; cannot validate --model")

    matches = [entry for entry in entries if entry.get("id") == args.model]

    if args.list:
        for entry in entries:
            key = entry.get("envKey") or ""
            state = "ok" if (not key or key in configured_env or key in os.environ) else f"missing:{key}"
            print(f"{entry.get('id')}\t{state}\t{entry.get('name', '')}")
        return

    if not args.model:
        parser.error("model is required unless --list is used")

    if not matches:
        known = ", ".join(sorted({str(entry.get("id")) for entry in entries}))
        print(f"unknown model id: {args.model}")
        print(f"configured: {known}")
        print("qwen would silently fall back to its built-in default model")
        raise SystemExit(3)

    if len(matches) > 1:
        print(f"ambiguous model id: {args.model} matches {len(matches)} provider entries:")
        for entry in matches:
            print(f"  {entry.get('name', '?')} -> {entry.get('baseUrl', '?')}")
        raise SystemExit(4)

    entry = matches[0]
    key = entry.get("envKey")
    if key and key not in configured_env and not (Path.home() / ".qwen" / "no-env-check").exists():
        if key not in os.environ:
            print(f"model {args.model} needs {key}, which is not in settings.env or the environment")
            raise SystemExit(3)
    print(f"model_ok={args.model} provider={entry.get('name', '?')}")


if __name__ == "__main__":
    main()

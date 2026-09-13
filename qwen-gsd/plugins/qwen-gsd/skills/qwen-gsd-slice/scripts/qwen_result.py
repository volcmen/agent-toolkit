#!/usr/bin/env python3
"""Compact one Qwen stream-json log into a few lines.

Reading raw stream-json into the orchestrator costs far more context than the
run itself. Parse the log file instead and print only the decision-relevant
fields.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load(path: Path) -> list[dict]:
    events = []
    with path.open(encoding="utf-8") as source:
        for line in source:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except (json.JSONDecodeError, ValueError):
                continue
    return events


def validate(events: list[dict], requested_model: str = "") -> tuple[int, str]:
    """Return a process code and diagnostic for the wrapper's hard contract."""
    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
    result = next((e for e in reversed(events) if e.get("type") == "result"), None)

    if requested_model:
        actual = init.get("model")
        if not actual:
            return (3, f"MODEL_MISSING requested={requested_model} — init.model was not observed")
        if actual != requested_model:
            return (
                3,
                f"MODEL_MISMATCH requested={requested_model} actual={actual} "
                "— the run did not use the requested model",
            )

    if result is None:
        return (1, "RESULT_NOT_SUCCESS result=MISSING")
    if result.get("subtype") != "success" or result.get("is_error") is not False:
        return (
            1,
            "RESULT_NOT_SUCCESS "
            f"subtype={result.get('subtype', 'MISSING')} is_error={result.get('is_error', 'MISSING')}",
        )
    return (0, "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("log", type=Path)
    parser.add_argument("--exit-code", type=int, default=None)
    parser.add_argument("--text", action="store_true", help="also print the final assistant text")
    parser.add_argument("--validate", action="store_true", help="exit nonzero unless the run satisfies the wrapper contract")
    parser.add_argument("--model", default="", help="requested model required in the init event during validation")
    args = parser.parse_args()

    if not args.log.is_file():
        raise SystemExit(f"Log not found: {args.log}")

    events = load(args.log)
    if not events:
        raise SystemExit(f"Log is empty: {args.log}")

    if args.validate:
        code, message = validate(events, args.model)
        if message:
            print(message, file=sys.stderr)
        raise SystemExit(code)

    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
    result = next((e for e in reversed(events) if e.get("type") == "result"), None)

    tools: dict[str, int] = {}
    for event in events:
        if event.get("type") != "assistant":
            continue
        for block in event.get("message", {}).get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                tools[block.get("name", "?")] = tools.get(block.get("name", "?"), 0) + 1

    print(f"session_id={init.get('session_id') or (result or {}).get('session_id', '?')}")
    print(f"model={init.get('model', '?')} permission_mode={init.get('permission_mode', '?')} cli={init.get('qwen_code_version', '?')}")

    if result is None:
        print("result=MISSING  # run aborted before completion (budget abort, crash, or kill)")
    else:
        usage = result.get("usage", {}) or {}
        fresh = usage.get("input_tokens", 0) - usage.get("cache_read_input_tokens", 0)
        print(
            f"result={result.get('subtype')} is_error={result.get('is_error')} "
            f"turns={result.get('num_turns')} duration_s={round((result.get('duration_ms') or 0) / 1000, 1)}"
        )
        print(
            f"input={usage.get('input_tokens', 0)} cached={usage.get('cache_read_input_tokens', 0)} "
            f"fresh_input={fresh} output={usage.get('output_tokens', 0)}"
        )
        denials = result.get("permission_denials") or []
        if denials:
            print(f"permission_denials={len(denials)}")
        error = result.get("error")
        if error:
            print(f"error={json.dumps(error)[:500]}")

    if tools:
        print(
            "tools_requested="
            + ",".join(f"{k}:{v}" for k, v in sorted(tools.items(), key=lambda kv: -kv[1]))
            + "  # requested, not necessarily executed"
        )
    else:
        print("tools_requested=none  # no edits were attempted")

    if args.exit_code is not None:
        meaning = {0: "ok", 55: "budget abort (--max-wall-time/--max-tool-calls/--max-session-turns)"}.get(
            args.exit_code, "failure"
        )
        print(f"exit_code={args.exit_code}  # {meaning}")

    if args.text and result is not None and result.get("result"):
        print("--- final text ---")
        print(str(result["result"])[:4000])


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Summarize local Qwen Code usage records for one or more sessions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qwen_config import resolve  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", action="append", default=[])
    parser.add_argument("--latest", type=int, default=1)
    parser.add_argument("--project")
    parser.add_argument("--file", type=Path, default=Path.home() / ".qwen" / "usage_record.jsonl")
    args = parser.parse_args()

    if not args.file.is_file():
        raise SystemExit(f"Usage file not found: {args.file}")

    records = []
    with args.file.open(encoding="utf-8") as source:
        for line in source:
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if args.project and record.get("project") != args.project:
                continue
            if args.session and record.get("sessionId") not in args.session:
                continue
            records.append(record)

    latest = {}
    for index, record in enumerate(records):
        key = record.get("sessionId") or f"missing-session-{index}"
        latest.pop(key, None)
        latest[key] = record
    records = list(latest.values())
    if not args.session:
        records = records[-max(1, args.latest) :]
    if not records:
        raise SystemExit("No matching Qwen usage records found")

    totals = {
        key: 0
        for key in (
            "requests", "input", "cached", "output", "thoughts", "tokens",
            "latency_ms", "duration_ms", "tool_calls", "tool_fail", "lines_added", "lines_removed",
        )
    }
    models_seen = set()
    for record in records:
        totals["duration_ms"] += int(record.get("durationMs", 0) or 0)
        tools = record.get("tools", {}) or {}
        totals["tool_calls"] += int(tools.get("totalCalls", 0) or 0)
        totals["tool_fail"] += int(tools.get("totalFail", 0) or 0)
        files = record.get("files", {}) or {}
        totals["lines_added"] += int(files.get("linesAdded", 0) or 0)
        totals["lines_removed"] += int(files.get("linesRemoved", 0) or 0)
        models_seen.update(record.get("models", {}).keys())
        for model in record.get("models", {}).values():
            totals["requests"] += int(model.get("requests", 0) or 0)
            totals["input"] += int(model.get("inputTokens", 0) or 0)
            totals["cached"] += int(model.get("cachedTokens", 0) or 0)
            totals["output"] += int(model.get("outputTokens", 0) or 0)
            totals["thoughts"] += int(model.get("thoughtsTokens", 0) or 0)
            totals["tokens"] += int(model.get("totalTokens", 0) or 0)
            totals["latency_ms"] += int(model.get("totalLatencyMs", 0) or 0)

    fresh = totals["input"] - totals["cached"]
    sessions = sorted({record.get("sessionId", "") for record in records})
    print(f"records={len(records)} sessions={len(sessions)} requests={totals['requests']}")
    print(f"total_tokens={totals['tokens']} input={totals['input']} cached={totals['cached']}")
    print(f"fresh_input={fresh} output={totals['output']} fresh_plus_output={fresh + totals['output']}")
    print(f"thoughts={totals['thoughts']} model_latency_min={totals['latency_ms'] / 60000:.2f}")
    print(
        f"tool_calls={totals['tool_calls']} tool_failures={totals['tool_fail']} "
        f"lines_added={totals['lines_added']} lines_removed={totals['lines_removed']}"
    )
    print("models=" + ",".join(sorted(models_seen)))
    print("session_ids=" + ",".join(sessions))

    limits, _ = resolve()
    for label, actual, limit in (
        ("requests", totals["requests"], int(limits["warn_requests"])),
        ("fresh_plus_output", fresh + totals["output"], int(limits["warn_fresh_plus_output"])),
        ("tool_failures", totals["tool_fail"], int(limits["warn_tool_failures"])),
    ):
        if actual > limit:
            print(f"WARN {label}={actual} exceeds configured warn threshold {limit}")


if __name__ == "__main__":
    main()

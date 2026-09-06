#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import statistics
import time
from pathlib import Path

STATUS_TOOLS = ("jenkins_get_build_status", "consult_status")


def usage_context(usage: dict) -> int:
    return usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)


def read_transcript(path: Path) -> dict:
    turns = tools = compactions = timeouts = status_calls = 0
    first_ctx = None
    max_ctx = cache_read = output = 0
    agents: collections.Counter = collections.Counter()
    for line in path.open(encoding="utf-8", errors="replace"):
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("type") == "summary" or record.get("isCompactSummary"):
            compactions += 1
        message = record.get("message") or {}
        content = message.get("content") if isinstance(message.get("content"), list) else []
        if record.get("type") == "assistant":
            turns += 1
            usage = message.get("usage") or {}
            context = usage_context(usage)
            first_ctx = context if first_ctx is None else first_ctx
            max_ctx = max(max_ctx, context)
            cache_read += usage.get("cache_read_input_tokens", 0)
            output += usage.get("output_tokens", 0)
            for block in content:
                if block.get("type") != "tool_use":
                    continue
                tools += 1
                name = block.get("name", "")
                if name == "Agent":
                    agents[(block.get("input") or {}).get("subagent_type", "general-purpose")] += 1
                if name.split("__")[-1] in STATUS_TOOLS:
                    status_calls += 1
        if record.get("type") == "user":
            for block in content:
                if block.get("type") == "tool_result" and block.get("is_error"):
                    text = block.get("content")
                    text = text if isinstance(text, str) else " ".join(part.get("text", "") for part in text if isinstance(part, dict))
                    if "timed out after" in text:
                        timeouts += 1
    return dict(turns=turns, tools=tools, compactions=compactions, timeouts=timeouts, status_calls=status_calls,
                first_ctx=first_ctx, max_ctx=max_ctx, cache_read=cache_read, output=output, agents=agents)


def summarize(values: list[int | None]) -> str:
    present = sorted(value for value in values if value is not None)
    if not present:
        return "n=0"
    p90 = present[max(int(len(present) * 0.9) - 1, 0)]
    return f"n={len(present)} median={statistics.median(present):.0f} p90={p90:.0f} max={present[-1]:.0f}"


def collect(root: Path, days: float) -> dict:
    horizon = time.time() - days * 86400
    main, sub = [], []
    for path in glob.glob(str(root / "**" / "*.jsonl"), recursive=True):
        if os.path.getmtime(path) < horizon:
            continue
        stats = read_transcript(Path(path))
        if stats["turns"] == 0:
            continue
        (sub if "/subagents/" in path else main).append(stats)
    return {"main": main, "subagents": sub}


def report(data: dict) -> str:
    main, sub = data["main"], data["subagents"]
    agents: collections.Counter = collections.Counter()
    for stats in main:
        agents.update(stats["agents"])
    lines = [
        f"main sessions: {len(main)}  compactions: {sum(s['compactions'] for s in main)}  "
        f"bash timeouts: {sum(s['timeouts'] for s in main)}  status-poll calls: {sum(s['status_calls'] for s in main)}",
        f"  turns       {summarize([s['turns'] for s in main])}",
        f"  first ctx   {summarize([s['first_ctx'] for s in main])}",
        f"  max ctx     {summarize([s['max_ctx'] for s in main])}",
        f"  cache-read  {summarize([s['cache_read'] for s in main])}",
        f"  output      {summarize([s['output'] for s in main])}",
        f"subagent runs: {len(sub)}  cache-read total: {sum(s['cache_read'] for s in sub)}",
        f"  first ctx   {summarize([s['first_ctx'] for s in sub])}",
        f"  turns       {summarize([s['turns'] for s in sub])}",
        f"  agent types {dict(agents.most_common(6))}",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize Claude Code session transcripts: context growth, compactions, waits, subagent cost.")
    parser.add_argument("--days", type=float, default=7)
    parser.add_argument("--root", type=Path, default=Path.home() / ".claude" / "projects")
    args = parser.parse_args()
    print(report(collect(args.root, args.days)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

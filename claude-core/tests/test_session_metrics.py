#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("session_metrics", ROOT / "scripts" / "session-metrics.py")
metrics = importlib.util.module_from_spec(SPEC)
sys.modules["session_metrics"] = metrics
SPEC.loader.exec_module(metrics)


def assistant(usage: dict, tools: list[dict] | None = None) -> dict:
    content = [{"type": "tool_use", "id": f"t{i}", "name": t["name"], "input": t.get("input", {})} for i, t in enumerate(tools or [])]
    return {"type": "assistant", "message": {"usage": usage, "content": content}}


def tool_error(text: str) -> dict:
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t0", "is_error": True, "content": text}]}}


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


class SessionMetrics(unittest.TestCase):
    def test_transcript_statistics_are_derived_from_usage_and_tool_blocks(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_jsonl(root / "proj" / "s1.jsonl", [
                assistant({"input_tokens": 10, "cache_read_input_tokens": 50000, "cache_creation_input_tokens": 5000},
                          [{"name": "Bash", "input": {"command": "ls"}}, {"name": "mcp__jenkins-mcp-jbob__jenkins_get_build_status"}]),
                tool_error("Exit code 143 Command timed out after 10m 0s"),
                {"type": "summary", "summary": "compacted"},
                assistant({"input_tokens": 20, "cache_read_input_tokens": 120000, "cache_creation_input_tokens": 0, "output_tokens": 700},
                          [{"name": "Agent", "input": {"subagent_type": "Explore"}}, {"name": "Agent", "input": {}}]),
            ])
            write_jsonl(root / "proj" / "s1" / "subagents" / "agent-a.jsonl", [
                assistant({"input_tokens": 5, "cache_read_input_tokens": 7000, "cache_creation_input_tokens": 500, "output_tokens": 40}),
            ])
            data = metrics.collect(root, days=1)
        self.assertEqual(len(data["main"]), 1)
        self.assertEqual(len(data["subagents"]), 1)
        main = data["main"][0]
        self.assertEqual((main["turns"], main["tools"], main["compactions"], main["timeouts"], main["status_calls"]), (2, 4, 1, 1, 1))
        self.assertEqual((main["first_ctx"], main["max_ctx"], main["cache_read"], main["output"]), (55010, 120020, 170000, 700))
        self.assertEqual(main["agents"], {"Explore": 1, "general-purpose": 1})
        self.assertEqual(data["subagents"][0]["first_ctx"], 7505)

    def test_report_names_every_headline_metric(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_jsonl(root / "p" / "s.jsonl", [assistant({"input_tokens": 1, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 3, "output_tokens": 4})])
            text = metrics.report(metrics.collect(root, days=1))
        for needle in ("main sessions: 1", "compactions: 0", "status-poll calls: 0", "first ctx   n=1 median=6", "subagent runs: 0"):
            self.assertIn(needle, text)

    def test_percentiles_use_the_ninetieth_position(self) -> None:
        self.assertEqual(metrics.summarize(list(range(1, 11))), "n=10 median=6 p90=9 max=10")
        self.assertEqual(metrics.summarize([None, 4]), "n=1 median=4 p90=4 max=4")
        self.assertEqual(metrics.summarize([]), "n=0")


if __name__ == "__main__":
    unittest.main()

"""Offline tests for the session-bg hook plugin's state writer."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "plugin" / "scripts" / "sbg_state.py"
HOOKS = ROOT / "plugin" / "hooks" / "hooks.json"
KNOWN_HINTS = {
    "start", "thinking", "tool", "error", "waiting",
    "subagent-start", "subagent-stop", "compacting", "idle", "end",
}
STATE_FILES = ("session.json", "status.json", "override.json", "error.json", "journey.json")


def run_hook(hint, payload=None, state_dir=None, env_extra=None):
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)
    for key in list(env):
        if key.startswith("CODEX_"):
            del env[key]
    if state_dir is not None:
        env["SBG_STATE"] = str(state_dir)
    else:
        env.pop("SBG_STATE", None)
    if env_extra:
        env.update(env_extra)
    stdin = "" if payload is None else json.dumps(payload)
    return subprocess.run(
        [sys.executable, "-S", str(SCRIPT), hint],
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
    )


def read_session(state_dir):
    return json.loads((Path(state_dir) / "session.json").read_text(encoding="utf-8"))


def read_journey(state_dir):
    return json.loads((Path(state_dir) / "journey.json").read_text(encoding="utf-8"))


class HintCoverageTests(unittest.TestCase):
    def test_start_sets_mode_and_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {
                "hook_event_name": "SessionStart",
                "session_id": "sess-1",
                "cwd": "/repo",
                "transcript_path": "/tmp/t.jsonl",
            }
            result = run_hook("start", payload, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            data = read_session(tmp)
            self.assertEqual(data["mode"], "start")
            self.assertEqual(data["agent"], "claude")
            self.assertEqual(data["session_id"], "sess-1")
            self.assertEqual(data["cwd"], "/repo")
            self.assertIsNone(data["tool"])
            self.assertIsNone(data["tool_kind"])
            self.assertEqual(data["subagents"], 0)
            self.assertEqual(data["seq"], 1)

    def test_user_prompt_submit_sets_prompt_and_mode_thinking(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {
                "hook_event_name": "UserPromptSubmit",
                "prompt": "x" * 200,
                "session_id": "s",
                "cwd": "/repo",
            }
            result = run_hook("thinking", payload, tmp)
            self.assertEqual(result.returncode, 0)
            data = read_session(tmp)
            self.assertEqual(data["mode"], "thinking")
            self.assertIsNone(data["prompt"])

    def test_pre_tool_use_sets_tool_and_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = [
                ("Bash", "exec"),
                ("Write", "edit"),
                ("Edit", "edit"),
                ("MultiEdit", "edit"),
                ("NotebookEdit", "edit"),
                ("Read", "read"),
                ("Glob", "read"),
                ("Grep", "read"),
                ("LSP", "read"),
                ("WebFetch", "web"),
                ("WebSearch", "web"),
                ("Task", "task"),
                ("Agent", "task"),
                ("mcp__linear__list_issues", "mcp"),
                ("SomeCustomTool", "other"),
            ]
            for tool_name, expected_kind in samples:
                payload = {"hook_event_name": "PreToolUse", "tool_name": tool_name, "session_id": "s", "cwd": "/repo"}
                result = run_hook("tool", payload, tmp)
                self.assertEqual(result.returncode, 0)
                data = read_session(tmp)
                self.assertEqual(data["mode"], "tool")
                self.assertEqual(data["tool"], tool_name)
                self.assertEqual(data["tool_kind"], expected_kind, tool_name)

    def test_post_tool_use_sets_mode_thinking_without_touching_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "keep me"}, tmp)
            result = run_hook("thinking", {"hook_event_name": "PostToolUse", "tool_name": "Bash"}, tmp)
            self.assertEqual(result.returncode, 0)
            data = read_session(tmp)
            self.assertEqual(data["mode"], "thinking")
            self.assertIsNone(data["prompt"])

    def test_post_tool_use_failure_sets_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("error", {"hook_event_name": "PostToolUseFailure"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "error")

    def test_stop_failure_sets_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("error", {"hook_event_name": "StopFailure"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "error")

    def test_permission_request_sets_waiting(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("waiting", {"hook_event_name": "PermissionRequest"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "waiting")

    def test_notification_sets_waiting(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("waiting", {"hook_event_name": "Notification"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "waiting")

    def test_subagent_start_increments_and_keeps_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Bash"}, tmp)
            result = run_hook("subagent-start", {"hook_event_name": "SubagentStart"}, tmp)
            self.assertEqual(result.returncode, 0)
            data = read_session(tmp)
            self.assertEqual(data["subagents"], 1)
            self.assertEqual(data["mode"], "tool")

    def test_subagent_stop_decrements_and_clamps_at_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("subagent-stop", {"hook_event_name": "SubagentStop"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["subagents"], 0)
            run_hook("subagent-start", {"hook_event_name": "SubagentStart"}, tmp)
            run_hook("subagent-start", {"hook_event_name": "SubagentStart"}, tmp)
            run_hook("subagent-stop", {"hook_event_name": "SubagentStop"}, tmp)
            run_hook("subagent-stop", {"hook_event_name": "SubagentStop"}, tmp)
            result = run_hook("subagent-stop", {"hook_event_name": "SubagentStop"}, tmp)
            self.assertEqual(read_session(tmp)["subagents"], 0)

    def test_precompact_sets_compacting(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("compacting", {"hook_event_name": "PreCompact"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "compacting")

    def test_postcompact_sets_thinking(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("thinking", {"hook_event_name": "PostCompact"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "thinking")

    def test_stop_and_interrupt_set_idle(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("idle", {"hook_event_name": "Stop"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "idle")
            result = run_hook("idle", {"hook_event_name": "Interrupt"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["mode"], "idle")

    def test_seq_increments_across_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("start", {"hook_event_name": "SessionStart"}, tmp)
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "hi"}, tmp)
            result = run_hook("idle", {"hook_event_name": "Stop"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["seq"], 3)

    def test_agent_detected_from_codex_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook(
                "start",
                {"hook_event_name": "SessionStart"},
                tmp,
                env_extra={"CODEX_SESSION_ID": "abc"},
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["agent"], "codex")

    def test_agent_unknown_without_any_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("start", {"hook_event_name": "SessionStart"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(read_session(tmp)["agent"], "unknown")


class SafetyTests(unittest.TestCase):
    def test_unset_sbg_state_exits_zero_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("start", {"hook_event_name": "SessionStart"}, state_dir=None)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_malformed_stdin_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ)
            env["SBG_STATE"] = tmp
            result = subprocess.run(
                [sys.executable, "-S", str(SCRIPT), "start"],
                input="{not json",
                capture_output=True,
                text=True,
                env=env,
                cwd=str(ROOT),
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")

    def test_empty_stdin_exits_zero_and_writes_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("start", payload=None, state_dir=tmp)
            self.assertEqual(result.returncode, 0)
            self.assertTrue((Path(tmp) / "session.json").is_file())

    def test_unknown_hint_exits_zero_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook("not-a-real-hint", {"hook_event_name": "Stop"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertFalse((Path(tmp) / "session.json").exists())

    def test_end_removes_all_state_files_and_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "pane"
            state_dir.mkdir()
            run_hook("start", {"hook_event_name": "SessionStart"}, state_dir)
            for name in ("status.json", "override.json", "error.json"):
                (state_dir / name).write_text("{}", encoding="utf-8")
            result = run_hook("end", {"hook_event_name": "SessionEnd"}, state_dir)
            self.assertEqual(result.returncode, 0)
            for name in STATE_FILES:
                self.assertFalse((state_dir / name).exists(), name)
            self.assertEqual([p.name for p in state_dir.iterdir()], [".writer.lock"])

    def test_end_leaves_directory_when_other_files_remain(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "pane"
            state_dir.mkdir()
            run_hook("start", {"hook_event_name": "SessionStart"}, state_dir)
            (state_dir / "fx.log").write_text("hello", encoding="utf-8")
            result = run_hook("end", {"hook_event_name": "SessionEnd"}, state_dir)
            self.assertEqual(result.returncode, 0)
            self.assertFalse((state_dir / "session.json").exists())
            self.assertTrue(state_dir.exists())
            self.assertTrue((state_dir / "fx.log").exists())

    def test_invocation_is_fast(self):
        with tempfile.TemporaryDirectory() as tmp:
            start = time.monotonic()
            result = run_hook("start", {"hook_event_name": "SessionStart"}, tmp)
            elapsed = time.monotonic() - start
            self.assertEqual(result.returncode, 0)
            self.assertLess(elapsed, 0.1, f"invocation took {elapsed * 1000:.1f} ms")


class JourneyTests(unittest.TestCase):
    def test_start_creates_journey_with_repo_from_cwd(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as repo:
            repo_path = Path(repo) / "my-project"
            (repo_path / "src").mkdir(parents=True)
            (repo_path / ".git").mkdir()
            result = run_hook(
                "start",
                {"hook_event_name": "SessionStart", "source": "startup", "session_id": "a", "cwd": str(repo_path / "src")},
                tmp,
            )
            self.assertEqual(result.returncode, 0)
            journey = read_journey(tmp)
            self.assertEqual(journey["v"], 2)
            self.assertEqual(journey["repo"], "my-project")
            self.assertEqual(journey["prompts"], 0)
            self.assertEqual(journey["tools"], 0)
            self.assertEqual(journey["tool_kinds"], {"exec": 0, "edit": 0, "read": 0, "web": 0, "task": 0, "mcp": 0, "other": 0})
            self.assertEqual(journey["files"], {})
            self.assertEqual(journey["subagents_peak"], 0)
            self.assertEqual(journey["recent"][0]["kind"], "embark")

    def test_tools_are_counted_by_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "echo hi"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "/repo/a.py"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "/repo/b.rs"}}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["tools"], 3)
            self.assertEqual(journey["tool_kinds"]["exec"], 1)
            self.assertEqual(journey["tool_kinds"]["edit"], 1)
            self.assertEqual(journey["tool_kinds"]["read"], 1)

    def test_files_counted_by_extension_from_edit_write_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": "/repo/main.py"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "/repo/lib.rs"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "/repo/app.ts"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "NotebookEdit", "tool_input": {"notebook_path": "/repo/nb.ipynb"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": "/repo/Makefile"}}, tmp)
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": "/repo/NOTES"}}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["files"]["py"], 1)
            self.assertEqual(journey["files"]["rs"], 1)
            self.assertEqual(journey["files"]["ts"], 1)
            self.assertEqual(journey["files"]["ipynb"], 1)
            self.assertEqual(journey["files"]["makefile"], 1)
            self.assertEqual(journey["files"]["none"], 1)

    def test_files_counted_by_extension_from_bash_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "pytest tests/test_foo.py -q"}}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["files"]["py"], 1)

    def test_glob_uses_pattern_free_path_argument(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Glob", "tool_input": {"pattern": "*.py", "path": "/repo/src"}}, tmp)
            journey = read_journey(tmp)
            self.assertNotIn("py", journey["files"])
            self.assertEqual(journey["files"].get("none"), 1)

    def test_prompts_and_words_accumulate(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "fix the flaky test in checkout module"}, tmp)
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "fix the flaky test again please"}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["prompts"], 2)
            self.assertIsNone(journey["last_prompt"])
            self.assertIn("flaky", journey["words"])
            self.assertLessEqual(len(journey["words"]), 8)

    def test_post_tool_use_thinking_does_not_count_as_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("thinking", {"hook_event_name": "PostToolUse", "tool_name": "Bash"}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["prompts"], 0)

    def test_errors_waits_compactions_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("error", {"hook_event_name": "PostToolUseFailure"}, tmp)
            run_hook("error", {"hook_event_name": "StopFailure"}, tmp)
            run_hook("waiting", {"hook_event_name": "PermissionRequest"}, tmp)
            run_hook("compacting", {"hook_event_name": "PreCompact"}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["errors"], 2)
            self.assertEqual(journey["waits"], 1)
            self.assertEqual(journey["compactions"], 1)

    def test_subagent_peak_tracks_the_maximum(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("subagent-start", {"hook_event_name": "SubagentStart"}, tmp)
            run_hook("subagent-start", {"hook_event_name": "SubagentStart"}, tmp)
            run_hook("subagent-stop", {"hook_event_name": "SubagentStop"}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(journey["subagents"], 1)
            self.assertEqual(journey["subagents_peak"], 2)

    def test_recent_ring_capped_at_64(self):
        with tempfile.TemporaryDirectory() as tmp:
            for _ in range(70):
                run_hook("tool", {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "echo hi"}}, tmp)
            journey = read_journey(tmp)
            self.assertEqual(len(journey["recent"]), 64)
            self.assertEqual(journey["recent"][-1]["k"], "tool")

    def test_clear_resets_journey(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("start", {"hook_event_name": "SessionStart", "source": "startup", "session_id": "a"}, tmp)
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "some prior work happened here"}, tmp)
            self.assertEqual(read_journey(tmp)["prompts"], 1)
            run_hook("start", {"hook_event_name": "SessionStart", "source": "clear", "session_id": "a"}, tmp)
            self.assertEqual(read_journey(tmp)["prompts"], 0)

    def test_resume_keeps_journey_when_session_id_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("start", {"hook_event_name": "SessionStart", "source": "startup", "session_id": "same"}, tmp)
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "some prior work happened here"}, tmp)
            self.assertEqual(read_journey(tmp)["prompts"], 1)
            run_hook("start", {"hook_event_name": "SessionStart", "source": "resume", "session_id": "same"}, tmp)
            self.assertEqual(read_journey(tmp)["prompts"], 1)

    def test_resume_resets_journey_when_session_id_differs(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook("start", {"hook_event_name": "SessionStart", "source": "startup", "session_id": "one"}, tmp)
            run_hook("thinking", {"hook_event_name": "UserPromptSubmit", "prompt": "some prior work happened here"}, tmp)
            self.assertEqual(read_journey(tmp)["prompts"], 1)
            run_hook("start", {"hook_event_name": "SessionStart", "source": "resume", "session_id": "two"}, tmp)
            self.assertEqual(read_journey(tmp)["prompts"], 0)

    def test_end_deletes_journey(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "pane"
            state_dir.mkdir()
            run_hook("start", {"hook_event_name": "SessionStart", "source": "clear"}, state_dir)
            self.assertTrue((state_dir / "journey.json").exists())
            run_hook("end", {"hook_event_name": "SessionEnd"}, state_dir)
            self.assertFalse((state_dir / "journey.json").exists())


class HooksManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(HOOKS.read_text(encoding="utf-8"))

    def _iter_hook_commands(self):
        for event_matchers in self.manifest["hooks"].values():
            for matcher_block in event_matchers:
                for hook in matcher_block["hooks"]:
                    yield hook

    def test_every_command_references_plugin_root_script(self):
        for hook in self._iter_hook_commands():
            self.assertIn("${CLAUDE_PLUGIN_ROOT}/scripts/sbg_state.py", hook["command"])
            self.assertIn("sbg_state.py", hook["commandWindows"])

    def test_every_hint_is_known(self):
        for hook in self._iter_hook_commands():
            hint = hook["command"].rsplit(" ", 1)[-1]
            self.assertIn(hint, KNOWN_HINTS, hook["command"])

    def test_every_timeout_is_at_most_two_seconds(self):
        for hook in self._iter_hook_commands():
            self.assertLessEqual(hook["timeout"], 2)
            self.assertGreaterEqual(hook["timeout"], 1)

    def test_expected_events_are_present(self):
        expected = {
            "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
            "PostToolUseFailure", "StopFailure", "PermissionRequest", "Notification",
            "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
            "Stop", "Interrupt", "SessionEnd",
        }
        self.assertEqual(set(self.manifest["hooks"].keys()), expected)


if __name__ == "__main__":
    unittest.main()

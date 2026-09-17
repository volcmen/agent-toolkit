"""Offline tests for the optional sbg_director.py background director."""
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
STATE_SCRIPT = ROOT / "plugin" / "scripts" / "sbg_state.py"
DIRECTOR_SCRIPT = ROOT / "plugin" / "scripts" / "sbg_director.py"

VALID_MOOD = {
    "motif": "forest",
    "palette": ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff"],
    "tempo": 1.0,
    "title": "Test Scene",
    "mood": "calm",
}

STUB_DIRECTOR = """
import os
path = os.path.join(os.environ["SBG_STATE"], "stub-ran.txt")
with open(path, "a", encoding="utf-8") as handle:
    handle.write("run\\n")
"""


def run_director(args, state_dir, env_extra=None):
    env = dict(os.environ)
    env["SBG_STATE"] = str(state_dir)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-S", str(DIRECTOR_SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
    )


def run_state_hook(hint, payload, state_dir, env_extra=None):
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)
    for key in list(env):
        if key.startswith("CODEX_"):
            del env[key]
    env["SBG_STATE"] = str(state_dir)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-S", str(STATE_SCRIPT), hint],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
    )


def write_json(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def wait_until(condition, deadline_seconds=5.0, interval=0.05):
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return condition()


class DryRunPromptTests(unittest.TestCase):
    def test_dry_run_prompt_contains_repo_and_languages(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            write_json(state_dir / "journey.json", {
                "repo": "widget-service",
                "files": {"py": 10, "rs": 4, "ts": 1},
                "words": ["refactor", "flaky"],
                "last_prompt": "fix the flaky test",
            })
            result = run_director(["--dry-run"], state_dir)
            self.assertEqual(result.returncode, 0)
            self.assertIn("widget-service", result.stdout)
            self.assertIn("py", result.stdout)
            self.assertLessEqual(len(result.stdout.strip()), 600)


class FakeModeTests(unittest.TestCase):
    def test_fake_writes_validated_mood(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            result = run_director(["--fake", json.dumps(VALID_MOOD)], state_dir)
            self.assertEqual(result.returncode, 0)
            mood = json.loads((state_dir / "mood.json").read_text(encoding="utf-8"))
            self.assertEqual(mood["v"], 1)
            self.assertEqual(mood["source"], "haiku")
            self.assertEqual(mood["motif"], "forest")
            self.assertEqual(len(mood["palette"]), 5)
            self.assertEqual(mood["tempo"], 1.0)
            self.assertEqual(mood["title"], "Test Scene")
            self.assertEqual(mood["mood"], "calm")

    def test_fake_with_bad_motif_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            bad = dict(VALID_MOOD, motif="volcano")
            result = run_director(["--fake", json.dumps(bad)], state_dir)
            self.assertEqual(result.returncode, 0)
            self.assertFalse((state_dir / "mood.json").exists())

    def test_fake_with_four_colours_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            bad = dict(VALID_MOOD, palette=VALID_MOOD["palette"][:4])
            result = run_director(["--fake", json.dumps(bad)], state_dir)
            self.assertEqual(result.returncode, 0)
            self.assertFalse((state_dir / "mood.json").exists())

    def test_fake_tempo_out_of_range_is_clamped(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            hot = dict(VALID_MOOD, tempo=9.0)
            result = run_director(["--fake", json.dumps(hot)], state_dir)
            self.assertEqual(result.returncode, 0)
            mood = json.loads((state_dir / "mood.json").read_text(encoding="utf-8"))
            self.assertEqual(mood["tempo"], 2.0)


class HookSpawnTests(unittest.TestCase):
    def test_hook_spawns_nothing_when_director_is_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            payload = {"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s"}
            result = run_state_hook("thinking", payload, state_dir)
            self.assertEqual(result.returncode, 0)
            time.sleep(0.2)
            self.assertFalse((state_dir / "director.lock").exists())
            self.assertFalse((state_dir / "mood.json").exists())

    def test_hook_spawns_nothing_when_event_is_not_user_prompt_submit(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            write_json(state_dir / "override.json", {"v": 1, "director": True})
            payload = {"hook_event_name": "PostToolUse", "tool_name": "Bash"}
            result = run_state_hook("thinking", payload, state_dir)
            self.assertEqual(result.returncode, 0)
            time.sleep(0.2)
            self.assertFalse((state_dir / "director.lock").exists())

    def test_hook_with_director_on_spawns_stub_and_locks(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            write_json(state_dir / "override.json", {"v": 1, "director": True})
            stub_path = state_dir / "stub_director.py"
            stub_path.write_text(STUB_DIRECTOR, encoding="utf-8")
            director_cmd = "{} {}".format(sys.executable, stub_path)
            payload = {"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s"}
            result = run_state_hook("thinking", payload, state_dir, env_extra={"SBG_DIRECTOR_CMD": director_cmd})
            self.assertEqual(result.returncode, 0)

            marker = state_dir / "stub-ran.txt"
            self.assertTrue(wait_until(lambda: marker.exists()))
            self.assertTrue((state_dir / "director.lock").exists())
            self.assertEqual(marker.read_text(encoding="utf-8").count("run"), 1)

            second = run_state_hook("thinking", payload, state_dir, env_extra={"SBG_DIRECTOR_CMD": director_cmd})
            self.assertEqual(second.returncode, 0)
            time.sleep(0.3)
            self.assertEqual(marker.read_text(encoding="utf-8").count("run"), 1)

    def test_hook_respawns_once_lock_is_old(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            write_json(state_dir / "override.json", {"v": 1, "director": True})
            stub_path = state_dir / "stub_director.py"
            stub_path.write_text(STUB_DIRECTOR, encoding="utf-8")
            director_cmd = "{} {}".format(sys.executable, stub_path)
            payload = {"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s"}

            run_state_hook("thinking", payload, state_dir, env_extra={"SBG_DIRECTOR_CMD": director_cmd})
            marker = state_dir / "stub-ran.txt"
            self.assertTrue(wait_until(lambda: marker.exists()))

            old = time.time() - 200
            os.utime(state_dir / "director.lock", (old, old))

            run_state_hook("thinking", payload, state_dir, env_extra={"SBG_DIRECTOR_CMD": director_cmd})
            self.assertTrue(wait_until(lambda: marker.read_text(encoding="utf-8").count("run") == 2))


if __name__ == "__main__":
    unittest.main()

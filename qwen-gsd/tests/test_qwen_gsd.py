#!/usr/bin/env python3
"""Behavior tests for the Qwen GSD plugin helpers."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import stat
import signal
import time
from unittest import mock
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


PROJECT = Path(__file__).resolve().parents[1]
SKILL = PROJECT / "plugins" / "qwen-gsd" / "skills" / "qwen-gsd-slice"
SCRIPTS = SKILL / "scripts"


def clean_environment() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if not key.startswith(("QWEN_GSD_", "QGS_"))}


def run_script(name: str, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged = clean_environment()
    merged["PYTHONDONTWRITEBYTECODE"] = "1"
    if env:
        merged.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPTS / name), *args],
        text=True,
        capture_output=True,
        check=False,
        env=merged,
    )


class Configuration(unittest.TestCase):
    def test_layers_user_config_then_environment(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text(json.dumps({"wall_time": "12m", "max_turns": 9}), encoding="utf-8")
            result = run_script(
                "qwen_config.py",
                "json",
                env={"QWEN_GSD_CONFIG": str(config), "QWEN_GSD_MAX_TURNS": "7"},
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        self.assertEqual(values["wall_time"], "12m")
        self.assertEqual(values["max_turns"], 7)
        self.assertEqual(values["max_tool_calls"], 200)

    def test_rejects_unknown_user_config_keys(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"max_tuns": 7}', encoding="utf-8")
            result = run_script("qwen_config.py", "json", env={"QWEN_GSD_CONFIG": str(config)})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown key 'max_tuns'", result.stderr)

    def test_rejects_invalid_boolean_values(self) -> None:
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"safe_mode": "sometimes"}', encoding="utf-8")
            result = run_script("qwen_config.py", "json", env={"QWEN_GSD_CONFIG": str(config)})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("safe_mode", result.stderr)
        self.assertIn("boolean", result.stderr)

    def test_shell_assignments_do_not_execute_config_contents(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / "injected"
            literal = f"$(touch {marker})"
            config = root / "config.json"
            config.write_text(json.dumps({"state_dir": literal}), encoding="utf-8")
            env = clean_environment()
            env.update({"QWEN_GSD_CONFIG": str(config), "PYTHONDONTWRITEBYTECODE": "1"})
            command = f'eval "$({sys.executable} {SCRIPTS / "qwen_config.py"} env)"; printf "%s" "$QGS_STATE_DIR"'
            result = subprocess.run(
                ["bash", "-c", command], text=True, capture_output=True, check=False, env=env
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, literal)
            self.assertFalse(marker.exists(), "config contents were executed by shell eval")


class ModelCheck(unittest.TestCase):
    def settings(self, path: Path) -> None:
        path.write_text(
            json.dumps(
                {
                    "env": {"QWEN_KEY": "configured"},
                    "modelProviders": {
                        "openai": [
                            {"id": "qwen-fast", "name": "Fast", "envKey": "QWEN_KEY"},
                            {"id": "qwen-deep", "name": "Deep"},
                        ]
                    },
                }
            ),
            encoding="utf-8",
        )

    def test_accepts_configured_model(self) -> None:
        with TemporaryDirectory() as tmp:
            settings = Path(tmp) / "settings.json"
            self.settings(settings)
            result = run_script("qwen_model_check.py", "qwen-fast", "--settings", str(settings))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("model_ok=qwen-fast provider=Fast", result.stdout)

    def test_lists_models_without_a_dummy_model_argument(self) -> None:
        with TemporaryDirectory() as tmp:
            settings = Path(tmp) / "settings.json"
            self.settings(settings)
            result = run_script("qwen_model_check.py", "--list", "--settings", str(settings))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("qwen-fast\tok\tFast", result.stdout)
        self.assertIn("qwen-deep\tok\tDeep", result.stdout)

    def test_model_list_accepts_credentials_from_process_environment(self) -> None:
        with TemporaryDirectory() as tmp:
            settings = Path(tmp) / "settings.json"
            settings.write_text(
                json.dumps(
                    {
                        "env": {},
                        "modelProviders": {
                            "test": [
                                {"id": "qwen-fast", "name": "Fast", "envKey": "LIVE_KEY"}
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            result = run_script(
                "qwen_model_check.py",
                "--list",
                "--settings",
                str(settings),
                env={"LIVE_KEY": "configured"},
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("qwen-fast\tok\tFast", result.stdout)

    def test_malformed_settings_shape_has_actionable_error(self) -> None:
        malformed = (
            ([], "settings must contain a JSON object"),
            ({"modelProviders": []}, "modelProviders must contain a JSON object"),
            ({"modelProviders": {}, "env": []}, "env must contain a JSON object"),
        )
        for payload, message in malformed:
            with self.subTest(payload=payload):
                with TemporaryDirectory() as tmp:
                    settings = Path(tmp) / "settings.json"
                    settings.write_text(json.dumps(payload), encoding="utf-8")
                    result = run_script(
                        "qwen_model_check.py", "--list", "--settings", str(settings)
                    )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def test_rejects_unknown_model_without_calling_qwen(self) -> None:
        with TemporaryDirectory() as tmp:
            settings = Path(tmp) / "settings.json"
            self.settings(settings)
            result = run_script("qwen_model_check.py", "typo", "--settings", str(settings))

        self.assertEqual(result.returncode, 3)
        self.assertIn("silently fall back", result.stdout)


class ResultSummary(unittest.TestCase):
    def run_events(self, events: list[dict], *args: str) -> subprocess.CompletedProcess[str]:
        with TemporaryDirectory() as tmp:
            log = Path(tmp) / "run.jsonl"
            log.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            return run_script("qwen_result.py", str(log), *args)

    def test_compacts_stream_log_into_decision_fields(self) -> None:
        events = [
            {
                "type": "system",
                "subtype": "init",
                "session_id": "abc",
                "model": "qwen-fast",
                "permission_mode": "yolo",
                "qwen_code_version": "0.21.10",
            },
            {
                "type": "assistant",
                "message": {"content": [{"type": "tool_use", "name": "write_file"}]},
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "num_turns": 2,
                "duration_ms": 1500,
                "usage": {
                    "input_tokens": 100,
                    "cache_read_input_tokens": 40,
                    "output_tokens": 20,
                },
            },
        ]
        with TemporaryDirectory() as tmp:
            log = Path(tmp) / "run.jsonl"
            log.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            result = run_script("qwen_result.py", str(log), "--exit-code", "0")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("session_id=abc", result.stdout)
        self.assertIn("fresh_input=60 output=20", result.stdout)
        self.assertIn("tools_requested=write_file:1", result.stdout)

    def test_validation_requires_observed_requested_model(self) -> None:
        result = self.run_events(
            [{"type": "result", "subtype": "success", "is_error": False}],
            "--validate",
            "--model",
            "qwen-fast",
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("MODEL_MISSING", result.stderr)

    def test_validation_requires_exact_success_result(self) -> None:
        init = {"type": "system", "subtype": "init", "model": "qwen-fast"}
        invalid = (
            {"type": "result", "subtype": "cancelled", "is_error": False},
            {"type": "result", "subtype": "success"},
            {"type": "result", "subtype": "success", "is_error": True},
        )
        for event in invalid:
            with self.subTest(event=event):
                result = self.run_events([init, event], "--validate", "--model", "qwen-fast")
                self.assertEqual(result.returncode, 1)
                self.assertIn("RESULT_NOT_SUCCESS", result.stderr)

    def test_validation_accepts_exact_success_and_matching_model(self) -> None:
        result = self.run_events(
            [
                {"type": "system", "subtype": "init", "model": "qwen-fast"},
                {"type": "result", "subtype": "success", "is_error": False},
            ],
            "--validate",
            "--model",
            "qwen-fast",
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class LedgerClassification(unittest.TestCase):
    def load_module(self):
        spec = importlib.util.spec_from_file_location("qwen_log", SCRIPTS / "qwen_log.py")
        if spec is None or spec.loader is None:
            self.fail("could not load qwen_log.py")
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(SCRIPTS))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        return module

    def test_budget_abort_warns_that_edits_may_exist(self) -> None:
        module = self.load_module()
        status, reason, hint = module.classify(55, None, "", [{"type": "system"}])
        self.assertEqual((status, reason), ("fail", "budget_abort"))
        self.assertIn("edits already on disk", hint)

    def test_success_requires_exact_structured_success(self) -> None:
        module = self.load_module()
        invalid = (
            {"subtype": "cancelled", "is_error": False},
            {"subtype": "success"},
            {"subtype": "success", "is_error": True},
        )
        for result in invalid:
            with self.subTest(result=result):
                status, reason, _ = module.classify(0, result, "", [{"type": "result"}])
                self.assertEqual(status, "fail")
                self.assertNotEqual(reason, "success")

        status, reason, _ = module.classify(
            0,
            {"subtype": "success", "is_error": False},
            "",
            [{"type": "result"}],
        )
        self.assertEqual((status, reason), ("ok", "success"))

    def test_direct_ledger_writes_are_private(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            config = root / "config.json"
            config.write_text(json.dumps({"state_dir": str(state)}), encoding="utf-8")
            env = clean_environment()
            env.update(
                {
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "qwen_log.py"),
                    "note",
                    "--phase",
                    "review",
                    "--status",
                    "pass",
                    "--message",
                    "checked",
                ],
                text=True,
                capture_output=True,
                check=False,
                env=env,
                preexec_fn=lambda: os.umask(0o022),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((state / "runs.jsonl").stat().st_mode), 0o600)


class UsageSummary(unittest.TestCase):
    def test_uses_latest_cumulative_snapshot_for_requested_session(self) -> None:
        records = [
            {
                "sessionId": "slice-1",
                "durationMs": 1000,
                "tools": {"totalCalls": 2, "totalFail": 0},
                "files": {"linesAdded": 3, "linesRemoved": 1},
                "models": {
                    "qwen-fast": {
                        "requests": 1,
                        "inputTokens": 100,
                        "cachedTokens": 40,
                        "outputTokens": 10,
                        "thoughtsTokens": 5,
                        "totalTokens": 115,
                        "totalLatencyMs": 500,
                    }
                },
            },
            {
                "sessionId": "slice-1",
                "durationMs": 2000,
                "tools": {"totalCalls": 3, "totalFail": 1},
                "files": {"linesAdded": 4, "linesRemoved": 1},
                "models": {
                    "qwen-fast": {
                        "requests": 2,
                        "inputTokens": 200,
                        "cachedTokens": 80,
                        "outputTokens": 20,
                        "thoughtsTokens": 10,
                        "totalTokens": 230,
                        "totalLatencyMs": 750,
                    }
                },
            },
        ]
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            usage = root / "usage.jsonl"
            usage.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            config = root / "config.json"
            config.write_text("{}", encoding="utf-8")
            result = run_script(
                "qwen_usage.py",
                "--session",
                "slice-1",
                "--file",
                str(usage),
                env={"QWEN_GSD_CONFIG": str(config)},
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("records=1 sessions=1 requests=2", result.stdout)
        self.assertIn("fresh_input=120 output=20 fresh_plus_output=140", result.stdout)
        self.assertIn("tool_calls=3 tool_failures=1", result.stdout)


class Wrapper(unittest.TestCase):
    def test_fresh_session_does_not_depend_on_uuidgen(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "config.json"
            config.write_text(
                json.dumps({"model": "", "state_dir": str(root / "state")}),
                encoding="utf-8",
            )
            prompt = root / "brief.md"
            prompt.write_text("Make no changes.\n", encoding="utf-8")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            qwen = fake_bin / "qwen"
            qwen.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            qwen.chmod(0o755)
            uuidgen = fake_bin / "uuidgen"
            uuidgen.write_text("#!/bin/sh\nexit 77\n", encoding="utf-8")
            uuidgen.chmod(0o755)
            env = clean_environment()
            env.update(
                {
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPTS / "qwen_slice.sh"),
                    "--prompt-file",
                    str(prompt),
                    "--dry-run",
                    "--no-model-check",
                ],
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(
            result.stdout,
            re.compile(r"session=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"),
        )

    def test_runtime_artifacts_are_private(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            logs = state / "logs"
            logs.mkdir(parents=True)
            state.chmod(0o755)
            logs.chmod(0o755)
            config = root / "config.json"
            config.write_text(
                json.dumps({"model": "qwen-valid", "state_dir": str(state)}),
                encoding="utf-8",
            )
            settings_dir = root / ".qwen"
            settings_dir.mkdir()
            (settings_dir / "settings.json").write_text(
                json.dumps(
                    {
                        "modelProviders": {
                            "test": [{"id": "qwen-valid", "name": "Valid"}]
                        }
                    }
                ),
                encoding="utf-8",
            )
            prompt = root / "brief.md"
            prompt.write_text("Make no changes.\n", encoding="utf-8")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            qwen = fake_bin / "qwen"
            init = json.dumps(
                {"type": "system", "subtype": "init", "model": "qwen-valid"}
            )
            success = json.dumps(
                {"type": "result", "subtype": "success", "is_error": False}
            )
            qwen.write_text(
                f"#!/bin/sh\nprintf '%s\\n' '{init}' '{success}'\n",
                encoding="utf-8",
            )
            qwen.chmod(0o755)
            env = clean_environment()
            env.update(
                {
                    "HOME": str(root),
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            result = subprocess.run(
                ["bash", str(SCRIPTS / "qwen_slice.sh"), "--prompt-file", str(prompt)],
                text=True,
                capture_output=True,
                check=False,
                env=env,
                preexec_fn=lambda: os.umask(0o022),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((state / "logs").stat().st_mode), 0o700)
            artifacts = [state / "runs.jsonl", *(state / "logs").iterdir()]
            self.assertGreaterEqual(len(artifacts), 3)
            for artifact in artifacts:
                with self.subTest(artifact=artifact.name):
                    self.assertEqual(stat.S_IMODE(artifact.stat().st_mode), 0o600)

            custom_log = root / "custom.jsonl"
            custom_stderr = root / "custom.stderr"
            custom_log.write_text("old log\n", encoding="utf-8")
            custom_stderr.write_text("old stderr\n", encoding="utf-8")
            custom_log.chmod(0o644)
            custom_stderr.chmod(0o644)

            custom_result = subprocess.run(
                [
                    "bash",
                    str(SCRIPTS / "qwen_slice.sh"),
                    "--prompt-file",
                    str(prompt),
                    "--log",
                    str(custom_log),
                ],
                text=True,
                capture_output=True,
                check=False,
                env=env,
                preexec_fn=lambda: os.umask(0o022),
            )

            self.assertEqual(custom_result.returncode, 0, custom_result.stderr)
            self.assertEqual(stat.S_IMODE(custom_log.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(custom_stderr.stat().st_mode), 0o600)

    def test_rejects_wrapper_owned_pass_through_arguments(self) -> None:
        protected = (
            "--model",
            "--bare",
            "--output-format",
            "--session-id",
            "--resume",
            "--approval-mode",
            "--max-wall-time",
            "--max-session-turns",
            "--max-tool-calls",
            "--max-subagent-depth",
            "--safe-mode",
            "--sandbox",
        )
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "config.json"
            config.write_text(
                json.dumps({"model": "", "state_dir": str(root / "state")}),
                encoding="utf-8",
            )
            prompt = root / "brief.md"
            prompt.write_text("Make no changes.\n", encoding="utf-8")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            qwen = fake_bin / "qwen"
            qwen.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            qwen.chmod(0o755)
            env = clean_environment()
            env.update(
                {
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            for option in protected:
                with self.subTest(option=option):
                    result = subprocess.run(
                        [
                            "bash",
                            str(SCRIPTS / "qwen_slice.sh"),
                            "--prompt-file",
                            str(prompt),
                            "--dry-run",
                            "--no-model-check",
                            "--",
                            option,
                        ],
                        text=True,
                        capture_output=True,
                        check=False,
                        env=env,
                    )
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("unsupported pass-through argument", result.stderr)

    def test_shell_success_with_cancelled_result_exits_nonzero(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            config = root / "config.json"
            config.write_text(
                json.dumps({"model": "qwen-valid", "state_dir": str(state)}),
                encoding="utf-8",
            )
            settings_dir = root / ".qwen"
            settings_dir.mkdir()
            (settings_dir / "settings.json").write_text(
                json.dumps(
                    {
                        "modelProviders": {
                            "test": [{"id": "qwen-valid", "name": "Valid"}]
                        }
                    }
                ),
                encoding="utf-8",
            )
            prompt = root / "brief.md"
            prompt.write_text("Make no changes.\n", encoding="utf-8")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            qwen = fake_bin / "qwen"
            init = json.dumps(
                {"type": "system", "subtype": "init", "model": "qwen-valid"}
            )
            cancelled = json.dumps(
                {"type": "result", "subtype": "cancelled", "is_error": False}
            )
            qwen.write_text(
                f"#!/bin/sh\nprintf '%s\\n' '{init}' '{cancelled}'\n",
                encoding="utf-8",
            )
            qwen.chmod(0o755)
            env = clean_environment()
            env.update(
                {
                    "HOME": str(root),
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            result = subprocess.run(
                ["bash", str(SCRIPTS / "qwen_slice.sh"), "--prompt-file", str(prompt)],
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )
            ledger = [
                json.loads(line)
                for line in (state / "runs.jsonl").read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(result.returncode, 1)
        self.assertIn("RESULT_NOT_SUCCESS", result.stderr)
        self.assertIn("exit_code=1  # failure", result.stdout)
        self.assertNotIn("exit_code=0  # ok", result.stdout)
        self.assertEqual(ledger[-1]["status"], "fail")

    def test_resume_uses_ledger_model_before_validating_changed_default(self) -> None:
        session = "11111111-1111-4111-8111-111111111111"
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            state.mkdir()
            (state / "runs.jsonl").write_text(
                json.dumps(
                    {
                        "kind": "run",
                        "session": session,
                        "model_actual": "qwen-valid",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            config = root / "config.json"
            config.write_text(
                json.dumps({"model": "stale-default", "state_dir": str(state)}),
                encoding="utf-8",
            )
            settings_dir = root / ".qwen"
            settings_dir.mkdir()
            (settings_dir / "settings.json").write_text(
                json.dumps(
                    {
                        "modelProviders": {
                            "test": [{"id": "qwen-valid", "name": "Valid"}]
                        }
                    }
                ),
                encoding="utf-8",
            )
            prompt = root / "brief.md"
            prompt.write_text("Make no changes.\n", encoding="utf-8")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            qwen = fake_bin / "qwen"
            qwen.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            qwen.chmod(0o755)
            env = clean_environment()
            env.update(
                {
                    "HOME": str(root),
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPTS / "qwen_slice.sh"),
                    "--prompt-file",
                    str(prompt),
                    "--resume",
                    session,
                    "--dry-run",
                ],
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--model qwen-valid", result.stdout)
        self.assertNotIn("stale-default", result.stdout + result.stderr)

    def test_resume_revalidates_model_restored_from_ledger(self) -> None:
        session = "22222222-2222-4222-8222-222222222222"
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            state.mkdir()
            (state / "runs.jsonl").write_text(
                json.dumps(
                    {
                        "kind": "run",
                        "session": session,
                        "model_actual": "removed-model",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            config = root / "config.json"
            config.write_text(
                json.dumps({"model": "qwen-valid", "state_dir": str(state)}),
                encoding="utf-8",
            )
            settings_dir = root / ".qwen"
            settings_dir.mkdir()
            (settings_dir / "settings.json").write_text(
                json.dumps(
                    {
                        "modelProviders": {
                            "test": [{"id": "qwen-valid", "name": "Valid"}]
                        }
                    }
                ),
                encoding="utf-8",
            )
            prompt = root / "brief.md"
            prompt.write_text("Make no changes.\n", encoding="utf-8")
            marker = root / "qwen-ran"
            fake_bin = root / "bin"
            fake_bin.mkdir()
            qwen = fake_bin / "qwen"
            qwen.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 99\n", encoding="utf-8")
            qwen.chmod(0o755)
            env = clean_environment()
            env.update(
                {
                    "HOME": str(root),
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "QWEN_GSD_CONFIG": str(config),
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPTS / "qwen_slice.sh"),
                    "--prompt-file",
                    str(prompt),
                    "--resume",
                    session,
                ],
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("model check failed for 'removed-model'", result.stderr)
            self.assertFalse(marker.exists(), "Qwen ran before the restored model was validated")



class ReviewRegressions(unittest.TestCase):
    def test_fallback_selection_is_visible_in_summary_and_ledger(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / 'config.json'
            config.write_text(json.dumps({'state_dir': str(root / 'state')}))
            log = root / 'run.jsonl'
            events = [
                {'type': 'system', 'subtype': 'init', 'model': 'fast', 'session_id': 's'},
                {'type': 'system', 'subtype': 'model_fallback', 'data': {'fromModel': 'fast', 'toModel': 'deep', 'statusCode': 429, 'fallbackIndex': 0}},
                {'type': 'assistant', 'message': {'model': 'fast', 'content': []}},
                {'type': 'result', 'subtype': 'success', 'is_error': False},
            ]
            log.write_text(''.join(json.dumps(e) + '\n' for e in events))
            summary = run_script('qwen_result.py', str(log))
            self.assertIn('model=deep', summary.stdout)
            self.assertIn('fallback attempted: fast -> deep', summary.stdout)
            result = run_script('qwen_log.py', 'record', '--log', str(log), '--exit-code', '0', env={'QWEN_GSD_CONFIG': str(config)})
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads((root / 'state/runs.jsonl').read_text())
            self.assertEqual(record['model_actual'], '')
            self.assertEqual(record['model_selected'], 'deep')
            self.assertIn('model fallback attempted: fast -> deep', record['warnings'])

    def test_model_settings_accept_jsonc_without_damaging_urls(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'settings.json'
            path.write_text('''{
  // user configuration
  "modelProviders": {"test": [{"id": "fast", /* note */ "name": "Fast", "baseUrl": "https://example.com/v1?x=//"}]}
}''')
            result = run_script('qwen_model_check.py', 'fast', '--settings', str(path))
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_ambiguous_provider_diagnostic_omits_url_credentials(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'settings.json'
            path.write_text(json.dumps({'modelProviders': {'test': [
                {'id': 'fast', 'baseUrl': 'https://alice:password-value@example.com/v1?key=secret-value'},
                {'id': 'fast', 'baseUrl': 'https://second.example.com/v1'},
            ]}}))
            result = run_script('qwen_model_check.py', 'fast', '--settings', str(path))
            self.assertEqual(result.returncode, 4)
            self.assertIn('example.com', result.stdout)
            for secret in ('alice', 'password-value', 'secret-value'):
                self.assertNotIn(secret, result.stdout + result.stderr)

    def test_resume_ledger_uses_cumulative_usage_without_adding_prior_snapshot(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / 'config.json'
            config.write_text(json.dumps({'state_dir': str(root / 'state'), 'warn_fresh_plus_output': 250}))
            log = root / 'run.jsonl'
            for tokens in (110, 220):
                events = [
                    {'type': 'system', 'subtype': 'init', 'model': 'fast', 'session_id': 'session'},
                    {'type': 'result', 'subtype': 'success', 'is_error': False, 'usage': {'input_tokens': tokens}},
                ]
                log.write_text(''.join(json.dumps(e) + '\n' for e in events))
                result = run_script('qwen_log.py', 'record', '--log', str(log), '--exit-code', '0', env={'QWEN_GSD_CONFIG': str(config)})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('warning=', result.stdout)
            records = [json.loads(line) for line in (root / 'state/runs.jsonl').read_text().splitlines()]
            self.assertEqual(records[-1]['fresh_plus_output'], 220)

    def test_subprocess_environment_does_not_inherit_live_qwen_overrides(self):
        with mock.patch.dict(os.environ, {'QWEN_GSD_STATE_DIR': '/do-not-write-here', 'QWEN_GSD_MODEL': 'live-model'}):
            self.assertNotIn('QWEN_GSD_STATE_DIR', clean_environment())
            self.assertNotIn('QWEN_GSD_MODEL', clean_environment())

    def test_interrupting_wrapper_stops_qwen_and_its_descendant(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signum=signum), TemporaryDirectory() as tmp:
                root = Path(tmp)
                fake_bin = root / 'bin'
                fake_bin.mkdir()
                heartbeat = root / 'heartbeat'
                child_code = (
                    'import signal,time,pathlib; '
                    'signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGINT, signal.SIG_IGN); '
                    f'p=pathlib.Path({str(heartbeat)!r}); '
                    '\nwhile True: p.write_text(str(time.time_ns())); time.sleep(0.02)\n'
                )
                qwen = fake_bin / 'qwen'
                qwen.write_text(f'#!{sys.executable}\nimport os,signal,subprocess,sys,time,pathlib\n'
                    'signal.signal(signal.SIGTERM, signal.SIG_IGN)\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\n'
                    f'pathlib.Path({str(root / "pid")!r}).write_text(str(os.getpid()))\n'
                    f'subprocess.Popen([sys.executable, "-c", {child_code!r}], start_new_session=True)\n'
                    'time.sleep(30)\n')
                qwen.chmod(0o755)
                prompt = root / 'prompt.md'
                prompt.write_text('fixture only')
                config = root / 'config.json'
                config.write_text(json.dumps({'state_dir': str(root / 'state'), 'model': ''}))
                env = {**clean_environment(), 'QWEN_GSD_CONFIG': str(config), 'PATH': f'{fake_bin}:{os.environ["PATH"]}'}
                process = subprocess.Popen(['bash', str(SCRIPTS / 'qwen_slice.sh'), '--prompt-file', str(prompt), '--no-model-check'],
                                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    deadline = time.monotonic() + 8
                    while not heartbeat.exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(heartbeat.exists())
                    process.send_signal(signum)
                    stdout, stderr = process.communicate(timeout=8)
                    self.assertEqual(process.returncode, 128 + signum, stdout + stderr)
                    final = heartbeat.read_text()
                    time.sleep(0.1)
                    self.assertEqual(heartbeat.read_text(), final, 'descendant is still running')
                    records = [json.loads(line) for line in (root / 'state/runs.jsonl').read_text().splitlines()]
                    self.assertEqual([r['reason'] for r in records if r['kind'] == 'run'], ['killed'])
                finally:
                    if (root / 'pid').exists():
                        try:
                            os.killpg(int((root / 'pid').read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    if process.poll() is None:
                        process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()

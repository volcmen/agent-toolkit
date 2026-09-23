#!/usr/bin/env python3
"""Prove idle recovery and checkpoint preservation through the real host protocol."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("state_smoke", ROOT / "scripts/state-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main():
    with tempfile.TemporaryDirectory(prefix="sbg-recovery-") as tmp:
        pane = Path(tmp)
        script = pane / "fortress.lua"
        script.write_text((ROOT / "plugins/fx/fortress.lua").read_text() + """
local original_step = step
function step(dt, state)
  if state.params.palette == "fault" then error("injected recovery fault") end
  original_step(dt, state)
end
""")
        env = dict(os.environ, SBG_STATE=tmp, SBG_SCRIPT=str(script), SBG_FPS="20", SBG_SEED="9")
        proc = subprocess.Popen([str(ROOT / "plugins/target/release/sbg-fx")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        try:
            proc.stdin.write(json.dumps({"pty_update": {"size": [120, 35], "cells": [], "cursor": [0, 0]}}) + "\n")
            proc.stdin.flush()

            def read(name):
                path = pane / (name + ".json")
                return json.loads(path.read_text()) if path.exists() else {}

            def override(**fields):
                target = pane / "override.json"
                temp = pane / "override.tmp"
                temp.write_text(json.dumps(fields))
                temp.replace(target)

            def wait_status(status, timeout=4):
                until = time.monotonic() + timeout
                while time.monotonic() < until:
                    smoke.frames(proc, .15)
                    value = read("runtime")
                    if value.get("status") == status:
                        return value
                raise AssertionError(f"expected {status}, got {read('runtime')}")

            wait_status("running")
            for hint, payload in [("start", {"session_id": "recovery-smoke"}),
                                  *[("tool", {"tool_name": "Edit"}) for _ in range(18)]]:
                subprocess.run(["python3", "-S", str(ROOT / "plugin/scripts/sbg_state.py"), hint],
                               input=json.dumps(payload), text=True, env=env, check=True)
            smoke.frames(proc, 1.3)
            override(params={"paused": True})
            smoke.frames(proc, 1.3)
            before = read("fortress")
            assert before["world_state"]["counts"]["tools"] >= 18

            override(params={"palette": "fault", "paused": True})
            until = time.monotonic() + 4
            while time.monotonic() < until and read("runtime").get("active", {}).get("kind") != "builtin":
                smoke.frames(proc, .15)
            failed = read("runtime")
            assert failed["active"]["kind"] == "builtin", failed
            assert failed["requested"]["kind"] == "script"
            assert "failures" in failed["reason"]
            assert read("error")["phase"] == "step", "good render hid a failing step"

            # Clearing a fault, tool state or settings must not bypass cooldown.
            override(enabled=False, params={"paused": False})
            wait_status("disabled")
            smoke.frames(proc, 5.5)
            assert read("runtime")["active"]["kind"] == "builtin"
            override(params={"paused": True})
            wait_status("paused")
            smoke.frames(proc, 1.2)
            assert read("runtime")["active"]["kind"] == "builtin", "pause was overridden"
            assert read("fortress") == before, "fallback changed the saved checkpoint"

            # Resume after the deadline; no new session/tool/name input occurs.
            override(params={"paused": False})
            recovered = wait_status("running")
            assert recovered["active"] == recovered["requested"]
            smoke.frames(proc, 1.3)
            after = read("fortress")
            assert after["world_state"] == before["world_state"], "recovery changed earned history"
            assert after["seq"] == before["seq"], "recovery replayed event rewards"
            assert after["status"]["studio"]["now"] > before["status"]["studio"]["now"], "world did not resume"
            assert not (pane / "error.json").exists()

            # Exercise a second fault and verify automatic idle retry at its
            # deadline, with no override/event/name write at the recovery time.
            override(params={"palette": "fault"})
            failed = wait_status("recovering")
            override(params={})
            smoke.frames(proc, .6)
            assert read("runtime")["active"]["kind"] == "builtin", "override bypassed backoff"
            remaining = max(0, failed["retry_at"] - time.time())
            recovered = wait_status("running", remaining + 4)
            assert recovered["active"]["kind"] == "script"

            override(effect="stars")
            wait_status("running")
            smoke.frames(proc, 1.2)
            selected = read("runtime")
            assert selected["requested"] == {"kind": "builtin", "name": "stars"}
            assert selected["active"] == selected["requested"]
            assert selected["retry_at"] is None
            print("PASS recovery: bounded faults, truthful runtime, backoff, idle retry, checkpoint/history, pause/disable and explicit builtin")
        finally:
            proc.stdin.close()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

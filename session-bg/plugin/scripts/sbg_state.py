import os
import sys

if not os.environ.get("SBG_STATE"):
    sys.exit(0)

import json
import time

HINTS = (
    "start", "thinking", "tool", "error", "waiting",
    "subagent-start", "subagent-stop", "compacting", "idle", "end",
)
TOOL_KIND = {
    "Bash": "exec", "Write": "edit", "Edit": "edit", "MultiEdit": "edit",
    "NotebookEdit": "edit", "Read": "read", "Glob": "read", "Grep": "read",
    "LSP": "read", "WebFetch": "web", "WebSearch": "web", "Task": "task",
    "Agent": "task",
}
STATE_FILES = ("session.json", "status.json", "override.json", "error.json")


def read_payload():
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def read_previous(state_dir):
    try:
        with open(os.path.join(state_dir, "session.json"), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def detect_agent(payload):
    if os.environ.get("CLAUDECODE"):
        return "claude"
    if any(name.startswith("CODEX_") for name in os.environ):
        return "codex"
    if isinstance(payload, dict) and "transcript_path" in payload:
        return "claude"
    return "unknown"


def tool_kind_for(tool):
    if not tool:
        return None
    if tool in TOOL_KIND:
        return TOOL_KIND[tool]
    return "mcp" if tool.startswith("mcp__") else "other"


def compute_mode(hint, previous):
    if hint in ("subagent-start", "subagent-stop"):
        return previous.get("mode", "idle")
    return hint


def compute_subagents(hint, previous):
    prev = previous.get("subagents", 0)
    prev = prev if isinstance(prev, int) else 0
    if hint == "subagent-start":
        prev += 1
    elif hint == "subagent-stop":
        prev -= 1
    return max(prev, 0)


def compute_prompt(payload, previous):
    prompt = payload.get("prompt")
    if payload.get("hook_event_name") == "UserPromptSubmit" and isinstance(prompt, str):
        return prompt[:80]
    return previous.get("prompt")


def write_state(state_dir, data):
    os.makedirs(state_dir, exist_ok=True)
    target = os.path.join(state_dir, "session.json")
    tmp = os.path.join(state_dir, ".session.json.{}.tmp".format(os.getpid()))
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(tmp, target)


def cleanup(state_dir):
    for name in STATE_FILES:
        try:
            os.remove(os.path.join(state_dir, name))
        except OSError:
            pass
    try:
        os.rmdir(state_dir)
    except OSError:
        pass


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in HINTS:
        return
    hint = sys.argv[1]
    state_dir = os.environ["SBG_STATE"]
    if hint == "end":
        cleanup(state_dir)
        return
    payload = read_payload()
    previous = read_previous(state_dir)
    tool = payload.get("tool_name")
    seq = previous.get("seq", 0)
    data = {
        "v": 1,
        "ts": time.time(),
        "agent": detect_agent(payload),
        "session_id": payload.get("session_id") or previous.get("session_id"),
        "cwd": payload.get("cwd") or previous.get("cwd"),
        "mode": compute_mode(hint, previous),
        "event": payload.get("hook_event_name"),
        "tool": tool,
        "tool_kind": tool_kind_for(tool),
        "subagents": compute_subagents(hint, previous),
        "prompt": compute_prompt(payload, previous),
        "seq": seq + 1 if isinstance(seq, int) else 1,
    }
    write_state(state_dir, data)


try:
    main()
except Exception:
    pass
sys.exit(0)

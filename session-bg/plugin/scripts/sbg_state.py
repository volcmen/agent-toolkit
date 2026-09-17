"""Hook entry point that feeds session-bg's per-pane control channel."""
import os
import sys

if not os.environ.get("SBG_STATE"):
    sys.exit(0)

import json
import re
import shlex
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
TOOL_KIND_BUCKETS = ("exec", "edit", "read", "web", "task", "mcp", "other")
STATE_FILES = ("session.json", "status.json", "override.json", "error.json", "journey.json")
RECENT_LIMIT = 64
DIRECTOR_LOCK_SECONDS = 120
STOPWORDS = frozenset((
    "this", "that", "with", "from", "have", "what", "when", "where", "which",
    "would", "could", "should", "about", "there", "their", "these", "those",
    "being", "doing", "does", "dont", "wont", "into", "your", "just", "like",
    "need", "want", "make", "file", "files", "code", "please", "thanks",
    "check", "looks", "looking", "also", "then", "than", "them", "they",
    "will", "been", "only", "some", "such", "more",
))
WORD_RE = re.compile(r"[a-z]+")


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


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def read_previous(state_dir):
    return read_json(os.path.join(state_dir, "session.json")) or {}


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


def write_json_atomic(state_dir, filename, data):
    os.makedirs(state_dir, exist_ok=True)
    target = os.path.join(state_dir, filename)
    tmp = os.path.join(state_dir, ".{}.{}.tmp".format(filename, os.getpid()))
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


def find_git_root(cwd):
    path = os.path.abspath(cwd)
    for _ in range(8):
        if os.path.isdir(os.path.join(path, ".git")):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent
    return None


def repo_name_for(cwd):
    if not cwd:
        return None
    root = find_git_root(cwd)
    base = root or cwd
    name = os.path.basename(base.rstrip(os.sep))
    return name or base


def ext_from_path(path):
    base = os.path.basename(path)
    if not base:
        return None
    if base.lower() == "makefile":
        return "makefile"
    root, dot, ext = base.rpartition(".")
    if not dot or not root:
        return "none"
    return ext.lower()


def ext_from_bash_command(command):
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    for token in tokens:
        if token.startswith("-"):
            continue
        if "/" in token or "." in token:
            ext = ext_from_path(token)
            if ext:
                return ext
    return None


def extract_ext(payload):
    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    if tool == "Bash":
        command = tool_input.get("command")
        if isinstance(command, str):
            return ext_from_bash_command(command)
        return None
    for key in ("file_path", "notebook_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return ext_from_path(value)
    return None


def tokenize(text):
    if not isinstance(text, str):
        return []
    return [word for word in WORD_RE.findall(text.lower()) if len(word) >= 4 and word not in STOPWORDS]


def top_words(counts, limit=8):
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [word for word, _ in items[:limit]]


def push_recent(journey, entry):
    recent = journey.setdefault("recent", [])
    recent.append(entry)
    if len(recent) > RECENT_LIMIT:
        del recent[: len(recent) - RECENT_LIMIT]


def blank_journey(agent, repo, cwd, now):
    return {
        "v": 1,
        "ts": now,
        "started_at": now,
        "agent": agent,
        "repo": repo,
        "cwd": cwd,
        "prompts": 0,
        "tools": 0,
        "tool_kinds": {kind: 0 for kind in TOOL_KIND_BUCKETS},
        "files": {},
        "errors": 0,
        "compactions": 0,
        "waits": 0,
        "subagents": 0,
        "subagents_peak": 0,
        "last_prompt": None,
        "words": [],
        "word_counts": {},
        "recent": [],
    }


def load_journey(state_dir):
    return read_json(os.path.join(state_dir, "journey.json")) or {}


def update_journey(hint, payload, previous_session, state_dir, agent, cwd, subagents):
    now = time.time()
    existing = load_journey(state_dir)
    repo = repo_name_for(cwd)
    if hint == "start":
        source = payload.get("source")
        prev_session_id = previous_session.get("session_id")
        new_session_id = payload.get("session_id")
        same_session = prev_session_id is not None and prev_session_id == new_session_id
        if source == "clear" or not same_session or not existing:
            journey = blank_journey(agent, repo, cwd, now)
        else:
            journey = existing
    else:
        journey = existing if existing else blank_journey(agent, repo, cwd, now)

    journey["ts"] = now
    journey["agent"] = agent
    journey["cwd"] = cwd
    journey["repo"] = repo or journey.get("repo")
    journey.setdefault("tool_kinds", {kind: 0 for kind in TOOL_KIND_BUCKETS})
    journey.setdefault("files", {})
    journey.setdefault("word_counts", {})
    journey.setdefault("words", [])
    journey.setdefault("recent", [])

    if hint == "thinking" and payload.get("hook_event_name") == "UserPromptSubmit":
        prompt = payload.get("prompt") or ""
        journey["prompts"] += 1
        journey["last_prompt"] = prompt[:120]
        for word in tokenize(prompt):
            journey["word_counts"][word] = journey["word_counts"].get(word, 0) + 1
        journey["words"] = top_words(journey["word_counts"])
        push_recent(journey, {"t": now, "k": "prompt"})
    elif hint == "tool":
        tool = payload.get("tool_name")
        kind = tool_kind_for(tool) or "other"
        journey["tools"] += 1
        journey["tool_kinds"][kind] = journey["tool_kinds"].get(kind, 0) + 1
        ext = extract_ext(payload)
        entry = {"t": now, "k": "tool", "tool": tool}
        if ext:
            journey["files"][ext] = journey["files"].get(ext, 0) + 1
            entry["ext"] = ext
        push_recent(journey, entry)
    elif hint == "error":
        journey["errors"] += 1
        push_recent(journey, {"t": now, "k": "error"})
    elif hint == "waiting":
        journey["waits"] += 1
        push_recent(journey, {"t": now, "k": "wait"})
    elif hint == "compacting":
        journey["compactions"] += 1
        push_recent(journey, {"t": now, "k": "compact"})
    elif hint in ("subagent-start", "subagent-stop"):
        journey["subagents"] = subagents
        journey["subagents_peak"] = max(journey.get("subagents_peak", 0), subagents)
        push_recent(journey, {"t": now, "k": "subagent"})

    write_json_atomic(state_dir, "journey.json", journey)


def strip_agent_env(env):
    return {
        key: value
        for key, value in env.items()
        if not key.startswith("CLAUDE") and not key.startswith("CODEX_")
    }


def spawn_director(state_dir):
    import subprocess

    override_cmd = os.environ.get("SBG_DIRECTOR_CMD")
    if override_cmd:
        try:
            command = shlex.split(override_cmd)
        except ValueError:
            return
    else:
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sbg_director.py")
        command = [sys.executable, "-S", script]
    env = strip_agent_env(os.environ)
    env["SBG_STATE"] = state_dir
    try:
        subprocess.Popen(
            command,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError:
        pass


def maybe_spawn_director(hint, payload, state_dir):
    if hint != "thinking" or payload.get("hook_event_name") != "UserPromptSubmit":
        return
    override = read_json(os.path.join(state_dir, "override.json"))
    if not isinstance(override, dict) or override.get("director") is not True:
        return
    lock_path = os.path.join(state_dir, "director.lock")
    now = time.time()
    try:
        mtime = os.stat(lock_path).st_mtime
    except OSError:
        mtime = None
    if mtime is not None and (now - mtime) < DIRECTOR_LOCK_SECONDS:
        return
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(lock_path, "a", encoding="utf-8"):
            pass
        os.utime(lock_path, None)
    except OSError:
        return
    spawn_director(state_dir)


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
    agent = detect_agent(payload)
    cwd = payload.get("cwd") or previous.get("cwd")
    subagents = compute_subagents(hint, previous)
    data = {
        "v": 1,
        "ts": time.time(),
        "agent": agent,
        "session_id": payload.get("session_id") or previous.get("session_id"),
        "cwd": cwd,
        "mode": compute_mode(hint, previous),
        "event": payload.get("hook_event_name"),
        "tool": tool,
        "tool_kind": tool_kind_for(tool),
        "subagents": subagents,
        "prompt": compute_prompt(payload, previous),
        "seq": seq + 1 if isinstance(seq, int) else 1,
    }
    write_json_atomic(state_dir, "session.json", data)
    update_journey(hint, payload, previous, state_dir, agent, cwd, subagents)
    maybe_spawn_director(hint, payload, state_dir)


try:
    main()
except Exception:
    pass
sys.exit(0)

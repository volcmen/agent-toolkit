"""Hook entry point that feeds session-bg's per-pane control channel."""
import os
import sys

if not os.environ.get("SBG_STATE"):
    sys.exit(0)

import json
import hashlib
import uuid
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
    "Agent": "task", "exec_command": "exec", "write_stdin": "exec",
    "apply_patch": "edit", "read_file": "read", "spawn_agent": "task",
    "web.run": "web", "web__run": "web",
}
TOOL_KIND_BUCKETS = ("exec", "edit", "read", "web", "task", "mcp", "other")
STATE_FILES = ("session.json", "status.json", "override.json", "error.json", "journey.json", "fortress.json", "legends.json")
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
WORD_RE = re.compile(r"[A-Za-z]{4,16}")
SENSITIVE = frozenset(("password", "secret", "token", "apikey", "authorization", "bearer", "credential", "credentials", "private", "passwd"))
EXTENSIONS = frozenset("py rs ts tsx js jsx lua go c h cpp hpp java kt swift rb sh bash zsh fish json yaml yml toml md txt css html sql ipynb makefile none".split())
SCHEMA_VERSION = 2
WORD_LIMIT = 64


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
    short = tool.removeprefix("functions.")
    if short in TOOL_KIND:
        return TOOL_KIND[short]
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
    # Never persist raw prompts, including snippets left by older writers.
    return None


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
    result, suppress = [], False
    # Reject entire compound tokens. Splitting a URL/key/email into words leaks it.
    for raw in text[:8192].split():
        word = raw.strip(".,!?;:()[]{}\"'")
        lower = word.lower()
        if lower in SENSITIVE:
            suppress = True
            continue
        if suppress:
            suppress = False
            continue
        if any(part in lower for part in ("secret", "password", "token", "apikey")):
            continue
        if not WORD_RE.fullmatch(word) or lower in STOPWORDS:
            continue
        # Mixed internal capitals often denote generated identifiers.
        if word != word.lower() and word != word.capitalize():
            continue
        result.append(lower)
        if len(result) >= 32:
            break
    return result


def counter_digest(journey):
    fields = ("prompts", "tools", "errors", "compactions", "waits", "subagents", "subagents_peak")
    return ":".join(str(journey.get(key, 0)) for key in fields) + ":" + ":".join(
        str(journey.get("tool_kinds", {}).get(key, 0)) for key in TOOL_KIND_BUCKETS)


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
        "v": 2,
        "schema_version": SCHEMA_VERSION,
        "epoch": uuid.uuid4().hex,
        "seq": 0,
        "tick": 0,
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
    previous_id = previous_session.get("session_id")
    next_id = payload.get("session_id")
    same = previous_id is not None and previous_id == next_id
    if previous_id is None and next_id is None and payload.get("source") == "resume":
        same = True
    reset = hint == "start" and (payload.get("source") == "clear" or not same)
    fresh = reset or not existing or existing.get("schema_version") != SCHEMA_VERSION
    journey = blank_journey(agent, repo, cwd, now) if fresh else existing
    if fresh and hint == "start":
        subagents = 0
    journey.update(ts=now, agent=agent, cwd=cwd, repo=repo or journey.get("repo"), last_prompt=None)
    journey["session_id"] = hashlib.sha256(str(payload.get("session_id") or previous_session.get("session_id") or journey["epoch"]).encode()).hexdigest()[:16]
    journey["tick"] = max(journey.get("tick", 0), int(max(0, now - journey["started_at"]) * 4))

    def emit(kind, data=None):
        journey["seq"] += 1
        aliases = {"tool_failed": "error", "wait_open": "wait", "subagent_start": "subagent", "subagent_stop": "subagent"}
        entry = {"seq": journey["seq"], "kind": kind, "tick": journey["tick"], "payload": data or {},
                 "t": now, "k": aliases.get(kind, kind)}
        if kind == "tool":
            entry["tool"] = data["kind"]
            if data.get("ext"):
                entry["ext"] = data["ext"]
        push_recent(journey, entry)

    if fresh:
        emit("embark")
        if existing and existing.get("schema_version") != SCHEMA_VERSION:
            # Old records may contain raw snippets: keep aggregates only.
            for key in ("prompts", "tools", "errors", "compactions", "waits", "subagents", "subagents_peak"):
                journey[key] = max(0, int(existing.get(key, 0)))
            for key in TOOL_KIND_BUCKETS:
                journey["tool_kinds"][key] = max(0, int(existing.get("tool_kinds", {}).get(key, 0)))
            journey["seq"] += 1
            journey["recent"] = []
    pending_permission = previous_session.get("waiting_for_permission", previous_session.get("event") == "PermissionRequest")
    if pending_permission and hint not in ("waiting", "subagent-start", "subagent-stop"):
        outcome = "resolved"
        error = str(payload.get("error", "")).lower()
        denied = payload.get("permission_decision") == "deny" or "denied" in error or "declined" in error
        if denied:
            outcome = "declined"
        elif payload.get("hook_event_name") == "PostToolUse":
            outcome = "fulfilled"
        emit("wait_resolved", {"outcome": outcome})
        if denied and hint == "error":
            hint = "thinking"
    if hint == "thinking" and payload.get("hook_event_name") == "UserPromptSubmit":
        journey["prompts"] += 1
        for word in tokenize(payload.get("prompt")):
            journey["word_counts"][word] = journey["word_counts"].get(word, 0) + 1
        journey["word_counts"] = dict(sorted(journey["word_counts"].items(), key=lambda kv: (-kv[1], kv[0]))[:WORD_LIMIT])
        journey["words"] = top_words(journey["word_counts"])
        emit("prompt", {"words": journey["words"]})
    elif hint == "tool":
        kind = tool_kind_for(payload.get("tool_name")) or "other"
        ext = extract_ext(payload)
        ext = ext if ext in EXTENSIONS else ("other" if ext else None)
        journey["tools"] += 1
        journey["tool_kinds"][kind] += 1
        if ext:
            journey["files"][ext] = journey["files"].get(ext, 0) + 1
        emit("tool", {"kind": kind, "ext": ext})
    elif hint == "error":
        journey["errors"] += 1
        emit("tool_failed", {"class": "tool" if payload.get("hook_event_name") == "PostToolUseFailure" else "session"})
    elif hint == "waiting":
        if payload.get("hook_event_name") == "PermissionRequest" or payload.get("notification_type") == "permission_prompt":
            if not pending_permission:
                journey["waits"] += 1
                emit("wait_open")
    elif hint == "compacting":
        journey["compactions"] += 1
        emit("compact")
    elif hint in ("subagent-start", "subagent-stop"):
        journey["subagents"] = subagents
        journey["subagents_peak"] = max(journey["subagents_peak"], subagents)
        emit(hint.replace("-", "_"), {"count": subagents})
    elif hint == "start" and not fresh:
        emit("resume")
    elif hint == "thinking" and payload.get("hook_event_name") == "PostToolUse":
        emit("success", {"kind": tool_kind_for(payload.get("tool_name")) or "other"})
    elif hint == "idle":
        emit("idle")
    journey["counter_digest"] = counter_digest(journey)
    write_json_atomic(state_dir, "journey.json", journey)
    return journey


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


def main_locked():
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
        "waiting_for_permission": (
            previous.get("waiting_for_permission", False) if hint in ("subagent-start", "subagent-stop")
            else hint == "waiting" and (payload.get("hook_event_name") == "PermissionRequest" or payload.get("notification_type") == "permission_prompt")
        ),
        "event": payload.get("hook_event_name"),
        "tool": tool,
        "tool_kind": tool_kind_for(tool),
        "subagents": subagents,
        "prompt": compute_prompt(payload, previous),
        "seq": seq + 1 if isinstance(seq, int) else 1,
    }
    journey = update_journey(hint, payload, previous, state_dir, agent, cwd, subagents)
    data["subagents"] = journey["subagents"]
    if hint == "error" and journey["recent"][-1]["kind"] == "wait_resolved" and journey["recent"][-1]["payload"].get("outcome") == "declined":
        data["mode"] = "thinking"
    write_json_atomic(state_dir, "session.json", data)
    maybe_spawn_director(hint, payload, state_dir)


def main():
    # All hook invocations, including subagents, share the same read/modify/write lock.
    # Keep the lock inode across SessionEnd to avoid two independent lock owners.
    import fcntl
    state_dir = os.environ["SBG_STATE"]
    if len(sys.argv) < 2 or sys.argv[1] not in HINTS:
        return
    os.makedirs(state_dir, exist_ok=True)
    with open(os.path.join(state_dir, ".writer.lock"), "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        main_locked()


try:
    main()
except Exception:
    pass
sys.exit(0)

"""Local, exact-session display names. Never derive a title from prompt text."""
from __future__ import annotations

import fcntl
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import unicodedata

READ_LIMIT = 512 * 1024
ANSI = re.compile(r"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])")


def clean_name(value):
    if not isinstance(value, str):
        return ""
    value = ANSI.sub("", value[:2048])
    return " ".join("".join(c for c in value if not unicodedata.category(c).startswith("C") or c in "\n\t").split())[:160]


def read_json(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def atomic_json(path, data):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.name.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=True))
    tmp.replace(path)


class Names:
    def __init__(self):
        self.key = None
        self.stamps = {}
        self.cached = {}

    def records(self, path, session_id, kind, field, id_field):
        """Read only a bounded tail when a metadata log changes; keep last good name."""
        try:
            stat = path.stat()
            stamp = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            if self.stamps.get(path) == stamp:
                return self.cached.get(path)
            with path.open("rb") as handle:
                start = max(0, stat.st_size - READ_LIMIT)
                handle.seek(start)
                if start:
                    handle.readline(READ_LIMIT)
                for line in handle.read(READ_LIMIT).splitlines():
                    try:
                        row = json.loads(line)
                    except (ValueError, UnicodeError):
                        continue
                    if isinstance(row, dict) and row.get(id_field) == session_id and (kind is None or row.get("type") == kind) and isinstance(row.get(field), str):
                        self.cached[path] = clean_name(row[field])
            self.stamps[path] = stamp
        except OSError:
            pass
        return self.cached.get(path)

    def resolve(self, session):
        sid = session.get("session_id")
        agent = session.get("agent")
        if sid and sid == os.environ.get("CODEX_THREAD_ID"):
            agent = "codex"
        key = (agent, sid, session.get("transcript_path"))
        if self.key != key:
            self.key, self.stamps, self.cached = key, {}, {}
        if not isinstance(sid, str) or not sid:
            return None
        if agent == "codex":
            base = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
            # `title` may contain the first prompt. Only `name` is a display name.
            databases = sorted(base.glob("state_*.sqlite"), key=lambda p: int(p.stem.split("_")[-1]) if p.stem.split("_")[-1].isdigit() else -1, reverse=True)
            for path in databases[:1]:
                try:
                    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.05)) as conn:
                        row = conn.execute("SELECT name FROM threads WHERE id = ?", (sid,)).fetchone()
                    if row is not None:
                        return clean_name(row[0])
                except sqlite3.Error:
                    pass
            return self.records(base / "session_index.jsonl", sid, None, "thread_name", "id")
        if agent == "claude":
            path = session.get("transcript_path")
            if isinstance(path, str) and Path(path).is_absolute():
                result = self.records(Path(path), sid, "custom-title", "customTitle", "sessionId")
                if result is not None:
                    return result
                # A resumed transcript may be too large for its original title
                # to be in the bounded tail. Read only the exact index entry.
                try:
                    with Path(path).with_name("sessions-index.json").open("rb") as handle:
                        index = json.loads(handle.read(READ_LIMIT))
                    for entry in index.get("entries", []):
                        if isinstance(entry, dict) and entry.get("sessionId") == sid and isinstance(entry.get("customTitle"), str):
                            return clean_name(entry["customTitle"])
                except (OSError, ValueError, AttributeError):
                    pass
        return None


def apply_name(state_dir, names, session, journey):
    """Decorate the caller's current state without rereading or rewriting it."""
    override = read_json(state_dir / "override.json")
    manual = clean_name(override.get("session_name"))
    automatic = names.resolve(session)
    if automatic is not None:
        session["detected_name"] = automatic
    fallback = Path(session.get("cwd") or "session").name or "session"
    title = manual or session.get("detected_name") or clean_name(fallback)
    session["session_name"] = title
    # Compatibility with already-running sbg-fx binaries: generic journey fields
    # are already exposed to Lua. This is presentation metadata, never identity.
    if journey:
        journey["session_name"] = title


def refresh_locked(state_dir, names):
    """Caller holds the hook writer lock. Name updates never touch event clocks."""
    session_path = state_dir / "session.json"
    session = read_json(session_path)
    if not session:
        return False
    before = dict(session)
    journey_path = state_dir / "journey.json"
    journey = read_json(journey_path)
    journey_name = journey.get("session_name")
    apply_name(state_dir, names, session, journey)
    if session != before:
        atomic_json(session_path, session)
    if journey and journey.get("session_name") != journey_name:
        atomic_json(journey_path, journey)
    return session.get("session_name") != before.get("session_name")


def refresh(state_dir, names):
    state_dir = Path(state_dir)
    try:
        with (state_dir / ".writer.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return refresh_locked(state_dir, names)
    except (OSError, ValueError, TypeError):
        return False


class NameWatcher:
    """Owned by the launcher: no detached processes or per-frame database reads."""
    def __init__(self, state_dir):
        import threading
        self.state_dir = state_dir
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True, name="sbg-session-name")

    def run(self):
        names = Names()
        while not self.stop.is_set():
            refresh(self.state_dir, names)
            self.stop.wait(1)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=1)


if __name__ == "__main__":
    # Upgrade bridge for an already-running launcher. Exits with its owner.
    import argparse
    import time
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", type=int, required=True)
    args = parser.parse_args()
    names = Names()
    while args.parent > 1:
        try:
            os.kill(args.parent, 0)
        except OSError:
            break
        refresh(Path(os.environ["SBG_STATE"]), names)
        time.sleep(1)

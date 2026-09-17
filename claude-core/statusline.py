#!/usr/bin/env python3
"""NoTraffic Claude Code status line — simplified 2-line (balanced).

line 1: [Model] · 📁 dir · 🌿 branch +staged ~modified · ⇄ PR#n(state, clickable)
line 2: ████░░░░░░ 42% · 💰 $0.12 · ⏱ 3m

Pure Python 3 stdlib — no jq, no pip. Reads session JSON on stdin, prints stdout.
Git calls cached per session_id (5s) so it stays fast.
Test: echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"'"$PWD"'"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":0.12,"total_duration_ms":200000},"session_id":"t"}' | python3 statusline.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time

RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
CYAN, GREEN, YELLOW, RED, MAGENTA, GREY = (
    "\033[36m", "\033[32m", "\033[33m", "\033[31m", "\033[35m", "\033[90m",
)


def colorize(text: str, *codes: str) -> str:
    return "".join(codes) + text + RESET


def link(url: str, text: str) -> str:
    """OSC 8 clickable hyperlink (plain text in terminals that don't support it)."""
    return f"\033]8;;{url}\a{text}\033]8;;\a"


def get(d, *keys, default=None):
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
    return cur if cur is not None else default


def git_info(cwd: str, session_id: str) -> dict:
    # session_id comes from stdin JSON — strip anything path-like before using it
    # in a predictable /tmp filename (avoids symlink games).
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", session_id)[:64]
    cache = os.path.join(tempfile.gettempdir(), f"ntc-statusline-{safe_id}")
    try:
        if time.time() - os.path.getmtime(cache) < 20:
            return json.loads(open(cache).read())
    except (OSError, ValueError):
        pass

    info: dict = {}

    def git(*args: str) -> str:
        try:
            return subprocess.check_output(
                ["git", *args], cwd=cwd, stderr=subprocess.DEVNULL, text=True, timeout=2
            ).strip()
        except (subprocess.SubprocessError, OSError):
            return ""

    if git("rev-parse", "--git-dir"):
        info["branch"] = git("branch", "--show-current") or git("rev-parse", "--short", "HEAD")
        info["staged"] = len([x for x in git("diff", "--cached", "--numstat").splitlines() if x])
        info["modified"] = len([x for x in git("diff", "--numstat").splitlines() if x])
    try:
        with open(cache, "w") as fh:
            json.dump(info, fh)
    except OSError:
        pass
    return info


def bar(pct: int, width: int = 12) -> str:
    """Gradient context bar: filled cells shade green→yellow→red by position, so
    the color shows how deep into the window you are. Empty cells are grey."""
    filled = max(0, min(width, round(pct * width / 100)))
    out, prev = [], None
    for i in range(width):
        if i < filled:
            frac = i / max(1, width - 1)
            color = GREEN if frac < 0.55 else YELLOW if frac < 0.8 else RED
            char = "█"
        else:
            color, char = GREY, "░"
        if color != prev:              # emit a color code only when the run changes
            out.append(color)
            prev = color
        out.append(char)
    out.append(RESET)
    return "".join(out)


def fmt_duration(ms: int) -> str:
    s = ms // 1000
    h, m = s // 3600, (s % 3600) // 60
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m"
    return f"{s}s"


def human_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n // 1000}k"
    return str(n)


def fmt_reset(epoch: float) -> str:
    """Time remaining until a rate-limit window resets."""
    delta = int(epoch - time.time())
    if delta <= 0:
        return "now"
    h, m = delta // 3600, (delta % 3600) // 60
    return f"{h}h {m}m" if h else f"{m}m"


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        print("[statusline] no input")
        return

    cwd = get(data, "workspace", "current_dir", default=get(data, "cwd", default=os.getcwd()))
    session_id = get(data, "session_id", default="default")

    # ── line 1: identity ─────────────────────────────────────────────────────
    seg1 = [colorize(f"[{get(data, 'model', 'display_name', default='?')}]", CYAN, BOLD)]
    effort = get(data, "effort", "level")
    if effort:
        seg1.append(colorize(f"⚡{effort}", DIM))
    seg1.append(f"📁 {os.path.basename(cwd.rstrip('/')) or cwd}")

    g = git_info(cwd, session_id)
    if g.get("branch"):
        parts = [colorize(f"🌿 {g['branch']}", MAGENTA)]
        if g.get("staged"):
            parts.append(colorize(f"+{g['staged']}", GREEN))
        if g.get("modified"):
            parts.append(colorize(f"~{g['modified']}", YELLOW))
        seg1.append(" ".join(parts))

    pr_num = get(data, "pr", "number")
    if pr_num:
        state = get(data, "pr", "review_state")
        color = {"approved": GREEN, "changes_requested": RED, "pending": YELLOW, "draft": GREY}.get(state, DIM)
        pr_url = get(data, "pr", "url")
        txt = f"⇄ PR#{pr_num}" + (f"({state})" if state else "")
        seg1.append(colorize(link(pr_url, txt) if pr_url else txt, color))

    # ── line 2: metrics ──────────────────────────────────────────────────────
    pct = int(get(data, "context_window", "used_percentage", default=0) or 0)
    tin = int(get(data, "context_window", "total_input_tokens", default=0) or 0)
    size = int(get(data, "context_window", "context_window_size", default=200000) or 200000)
    ctx = f"{bar(pct)} {pct}%"
    if tin:                                         # current session token usage
        ctx += colorize(f" ({human_tokens(tin)}/{human_tokens(size)})", DIM)
    seg2 = [ctx]

    cost = float(get(data, "cost", "total_cost_usd", default=0) or 0)
    seg2.append(colorize(f"💰 ${cost:.2f}", YELLOW))
    seg2.append(f"⏱ {fmt_duration(int(get(data, 'cost', 'total_duration_ms', default=0) or 0))}")

    # next rate-limit reset — nearest available window (5h preferred, else 7d)
    for key in ("five_hour", "seven_day"):
        reset = get(data, "rate_limits", key, "resets_at")
        if reset:
            seg2.append(colorize(f"🔄 {fmt_reset(reset)}", DIM))
            break

    sep = "  "
    print(sep.join(seg1))
    print(sep.join(seg2))
    publish_session_bg(data, pct, tin, size, cost, g.get("branch"))


def publish_session_bg(data, pct, tin, size, cost, branch) -> None:
    """Feed context usage to session-bg (sbg) when this session runs inside it."""
    state_dir = os.environ.get("SBG_STATE")
    if not state_dir:
        return
    try:
        import time
        payload = {
            "v": 1,
            "ts": time.time(),
            "context_pct": pct,
            "tokens": tin,
            "context_size": size,
            "cost_usd": cost,
            "duration_ms": int(get(data, "cost", "total_duration_ms", default=0) or 0),
            "lines_added": int(get(data, "cost", "total_lines_added", default=0) or 0),
            "lines_removed": int(get(data, "cost", "total_lines_removed", default=0) or 0),
            "model": get(data, "model", "display_name"),
            "branch": branch,
        }
        target = os.path.join(state_dir, "status.json")
        tmp = f"{target}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp, target)
    except Exception:
        pass


if __name__ == "__main__":
    main()

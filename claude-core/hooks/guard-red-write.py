#!/usr/bin/env python3
"""PreToolUse(Bash): deny command shapes that route around the local git guard,
forge commit identity, or delete remote refs.

Heredoc bodies are stripped before matching, so writing *about* these commands
(rule text, documentation, a test fixture) is not a match - only an actual
invocation is.
"""
import json
import re
import sys


def strip_heredocs(cmd):
    out, i = [], 0
    for m in re.finditer(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", cmd):
        tag = m.group(2)
        rest = cmd[m.end():]
        body = re.search(r"(^|\s)" + re.escape(tag) + r"(\s|$)", rest)
        end = m.end() + (body.end() if body else len(rest))
        if m.start() < i:
            continue
        out.append(cmd[i:m.end()])
        i = end
    out.append(cmd[i:])
    return "".join(out)


RULES = [
    (r"\bgit\b[^;&|]*\bpush\b[^;&|]*(--no-verify|\s-n(\s|$))",
     "a push that skips the pre-push guard. Fix the guard or get explicit "
     "authorization; never route around it."),
    (r"\bgit\b[^;&|]*(-c\s+core\.hooksPath|config[^;&|]*core\.hooksPath)",
     "relocating the hooks path, which disables the installed git guard."),
    (r"\b(rm|mv|chmod|truncate)\b[^;&|]*\.git/hooks/",
     "deleting or disabling a git hook. The guard stays installed; report what "
     "it blocked instead."),
    (r"\bgit\s+send-pack\b|\bgit\b[^;&|]*\bpush\b[^;&|]*--mirror",
     "a raw transport push that bypasses pre-push entirely."),
    (r"\bgit\b[^;&|]*\bpush\b[^;&|]*(--delete\b|\s:[A-Za-z0-9_./-]+)",
     "deleting a remote ref - a RED WRITE that needs the user's explicit "
     "authorization naming that ref."),
    (r"(^|[;&|]\s*|\s)GIT_(COMMITTER|AUTHOR)_(EMAIL|NAME)=",
     "overriding git author/committer identity. Publishing under another "
     "person's identity is forgery; hiding my own defeats a review control."),
    (r"(^|[;&|]\s*|\s)(GIT_GUARD_OFF|GIT_ALLOW_FOREIGN_HISTORY)=",
     "turning off the git guard. Report what it blocked and why."),
    (r"\bgit\s+config\b(?![^;&|]*--(get|list|get-all|get-regexp))[^;&|]*"
     r"\buser\.(email|name)\b\s+\S",
     "rewriting a clone's git identity. Ask the user first - this is how a "
     "colleague's commits end up committed under their name."),
]


def main():
    try:
        cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "") or ""
    except Exception:
        return 0
    text = strip_heredocs(cmd.replace("\n", " "))
    for pattern, why in RULES:
        if re.search(pattern, text):
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "Blocked by guard-red-write: " + why,
            }}))
            return 0
    return 0


sys.exit(main())

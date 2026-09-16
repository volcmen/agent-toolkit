#!/usr/bin/env python3
"""PreToolUse(Bash): catch accidental git guard, identity, and remote-ref changes."""
import json
import re
import shlex
import sys


def tokens(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    return list(lexer)


def strip_heredocs(command):
    output, pending = [], []
    for line in command.splitlines(keepends=True):
        if pending:
            tag, tabs = pending[0]
            candidate = line.rstrip("\r\n")
            if (candidate.lstrip("\t") if tabs else candidate) == tag:
                pending.pop(0)
            output.append("\n")
            continue
        output.append(line)
        try:
            words = tokens(line)
        except ValueError:
            continue
        for index, word in enumerate(words[:-1]):
            if word == "<<":
                tag = words[index + 1]
                tabs = tag.startswith("-")
                if tag == "-":
                    if index + 2 >= len(words):
                        continue
                    tag = words[index + 2]
                elif tabs:
                    tag = tag[1:]
                pending.append((tag, tabs))
    return "".join(output)


def command_reason(words):
    while words and words[0].rsplit("/", 1)[-1] in ("env", "command", "exec", "sudo"):
        wrapper = words[0].rsplit("/", 1)[-1]
        words = words[1:]
        while words and words[0].startswith("-"):
            option = words[0]
            if wrapper == "command" and option in ("-v", "-V"):
                return None
            if wrapper == "env" and option in ("-S", "--split-string") and len(words) > 1:
                try:
                    words = tokens(words[1]) + words[2:]
                except ValueError:
                    return None
                break
            takes_value = (wrapper == "env" and option in ("-u", "--unset", "-C", "--chdir")) or (wrapper == "sudo" and option in ("-u", "-g", "-h", "-C", "-T")) or (wrapper == "exec" and option == "-a")
            words = words[2:] if takes_value else words[1:]
            if option == "--":
                break
    while words and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        key = words[0].split("=", 1)[0]
        if re.fullmatch(r"GIT_(COMMITTER|AUTHOR)_(EMAIL|NAME)", key):
            return "overriding git author/committer identity. Ask the user first."
        if key in ("GIT_GUARD_OFF", "GIT_ALLOW_FOREIGN_HISTORY"):
            return "turning off the git guard. Report what it blocked and why."
        words = words[1:]
    if not words:
        return None
    program = words[0].rsplit("/", 1)[-1]
    args = words[1:]
    if program in ("bash", "sh", "zsh"):
        for index, option in enumerate(args):
            if option.startswith("-") and not option.startswith("--") and "c" in option[1:]:
                return reason(args[index + 1]) if index + 1 < len(args) else None
    if program in ("rm", "mv", "chmod", "truncate") and any(".git/hooks/" in arg for arg in args):
        return "deleting or disabling a git hook. Report what the guard blocked."
    if program != "git":
        return None
    index = 0
    while index < len(args) and args[index].startswith("-"):
        option = args[index]
        if option in ("-c", "--config-env") and index + 1 < len(args):
            key = args[index + 1].split("=", 1)[0].lower()
            if key == "core.hookspath" or key in ("user.email", "user.name"):
                return "overriding git hooks or commit identity. Ask the user first."
        if option in ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"):
            index += 2
        else:
            if option.startswith("-c") and option[2:].split("=", 1)[0].lower() in ("core.hookspath", "user.name", "user.email"):
                return "overriding git hooks or commit identity. Ask the user first."
            index += 1
    if index >= len(args):
        return None
    subcommand, args = args[index], args[index + 1:]
    if subcommand == "send-pack" or (subcommand == "push" and "--mirror" in args):
        return "a raw transport push that bypasses pre-push entirely."
    if subcommand == "push":
        if "--no-verify" in args:
            return "a push that skips the pre-push guard. Fix the guard or get explicit authorization."
        if any(arg == "--delete" or (arg.startswith("-") and not arg.startswith("--") and "d" in arg[1:]) or re.fullmatch(r":[A-Za-z0-9_./-]+", arg) for arg in args):
            return "deleting a remote ref requires the user's explicit authorization naming that ref."
    if subcommand == "config":
        if any(arg in ("--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "get", "list") for arg in args):
            return None
        for position, arg in enumerate(args):
            if arg.lower() in ("user.email", "user.name", "core.hookspath"):
                if position + 1 < len(args) or any(a.startswith("--unset") for a in args) or "unset" in args:
                    return "rewriting git identity or hooks configuration. Ask the user first."
    return None


def reason(command):
    try:
        words = tokens(strip_heredocs(command))
    except ValueError:
        return None
    segment = []
    for word in words + [";"]:
        if word and all(char in ";&|()\n" for char in word):
            why = command_reason(segment)
            if why:
                return why
            segment = []
        else:
            segment.append(word)
    return None


def decision(permission, why):
    return json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": permission,
        "permissionDecisionReason": why,
    }})


def main(stdin=None):
    try:
        command = json.load(stdin or sys.stdin).get("tool_input", {}).get("command", "") or ""
    except (ValueError, AttributeError):
        print(decision("ask", "guard-red-write could not read the command payload; confirm this Bash call by hand."))
        return 0
    why = reason(command)
    if why:
        print(decision("deny", "Blocked by guard-red-write: " + why))
    return 0


if __name__ == "__main__":
    sys.exit(main())

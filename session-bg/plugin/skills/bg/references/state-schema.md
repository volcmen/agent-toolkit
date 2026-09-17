# session-bg control channel schema

Each pane gets its own directory, `SBG_STATE=~/.cache/sbg/panes/<pane>/`, set
by `bin/sbg` before launch. Every writer owns one file in that directory and
writes it atomically (tmp file in the same directory, then `os.replace`).
`sbg-fx` merges all of them each frame by polling mtimes; there are no locks
and no read-modify-write races.

## `session.json` — written by the hook plugin

```
{
  "v": 1,
  "ts": <float epoch seconds>,
  "agent": "claude" | "codex" | "unknown",
  "session_id": <string|null>,
  "cwd": <string|null>,
  "mode": "start" | "idle" | "thinking" | "tool" | "waiting" | "error" | "compacting",
  "event": <hook event name, string|null>,
  "tool": <tool name, string|null>,
  "tool_kind": "exec" | "edit" | "read" | "web" | "task" | "mcp" | "other" | null,
  "subagents": <int, >= 0>,
  "prompt": <first 80 chars of the last user prompt, string|null>,
  "seq": <monotonically increasing int>
}
```

`mode` is set from the triggering hook, except `SubagentStart`/`SubagentStop`,
which only adjust `subagents` (clamped to `>= 0`) and carry the previous
`mode` forward. `prompt` is only updated on `UserPromptSubmit`; every other
event carries the previous value forward.

## `journey.json` — cumulative per-session counters, written by the hook plugin

```
{
  "v": 1,
  "ts": <float epoch seconds>,
  "started_at": <float epoch seconds>,
  "agent": "claude" | "codex" | "unknown",
  "repo": <basename of the git toplevel above cwd, or cwd itself, string|null>,
  "cwd": <string|null>,
  "prompts": <int>,
  "tools": <int>,
  "tool_kinds": {"exec": <int>, "edit": <int>, "read": <int>, "web": <int>, "task": <int>, "mcp": <int>, "other": <int>},
  "files": {"<ext>": <int>, ...},
  "errors": <int>,
  "compactions": <int>,
  "waits": <int>,
  "subagents": <int, current>,
  "subagents_peak": <int>,
  "last_prompt": <first 120 chars of the last user prompt, string|null>,
  "words": [<up to 8 lowercase words>],
  "word_counts": {"<word>": <int>, ...},
  "recent": [{"t": <float>, "k": "tool" | "prompt" | "error" | "wait" | "compact" | "subagent", "tool": <string|omitted>, "ext": <string|omitted>}, ...]
}
```

`sbg_state.py` is the sole writer and only ever reads and rewrites its own
file (atomic tmp-then-`os.replace`, same as `session.json`). Counters
accumulate for the life of the session: `files` keys are lowercase
extensions with no dot (`"none"` for an extensionless path, `"makefile"` for
`Makefile`), taken from `file_path` / `notebook_path` / a pattern-free `path`
argument, or, for `Bash`, the extension of the first path-like token in
`tool_input.command`. `word_counts` is the running tally behind `words`,
which holds the top 8 by count (ties broken alphabetically) drawn from
lowercase alphabetic tokens of at least 4 characters, minus a small
stopword list, across every prompt. `recent` is capped at the last 64
entries.

`SessionStart` (hint `start`) with `source: "clear"` always resets
`journey.json` to a fresh session. `source: "resume" | "compact" | "startup"`
keeps the existing file when its `session_id` (compared against the
previous `session.json`) matches the new one, and resets it otherwise.
`SessionEnd` (hint `end`) deletes `journey.json` along with the other state
files.

## `mood.json` — written by `sbg_director.py`

```
{
  "v": 1,
  "ts": <float epoch seconds>,
  "source": "haiku" | "codex",
  "motif": "forest" | "skyline" | "reef" | "circuit" | "office",
  "palette": [<5 "#rrggbb" strings>],
  "tempo": <float, 0.5-2.0>,
  "title": <string, <= 24 chars>,
  "mood": <string, one word>
}
```

Optional and off by default. Written only when the `director` override key
is `true` and `sbg_director.py` produced a validated mood; a failed or
skipped run writes nothing. Not cleaned up by `SessionEnd`.

## `director.lock` — throttle marker for the director spawn

An empty file whose mtime marks the last spawn attempt. `sbg_state.py`
touches it before launching `sbg_director.py` and will not spawn another
one while the lock is younger than 120 seconds. Not cleaned up by
`SessionEnd`.

## `status.json` — written by the Claude Code statusline

```
{
  "v": 1,
  "ts": <float epoch seconds>,
  "context_pct": <float 0-100>,
  "tokens": <int>,
  "context_size": <int>,
  "cost_usd": <float>,
  "duration_ms": <int>,
  "model": <string>,
  "branch": <string|null>
}
```

Only present when `SBG_STATE` is set in the environment the statusline runs
in. Codex has no equivalent hook, so this file is simply absent for Codex
sessions and treated as neutral by `sbg-fx`.

## `override.json` — written by `sbg set` / the `/bg` skill

```
{
  "v": 1,
  "ts": <float epoch seconds>,
  "effect": <builtin effect name, string|null>,
  "script": <path to a Lua script, string|null>,
  "params": {
    "density": <float|null>,
    "speed": <float|null>,
    "hue": <float|null>,
    "opacity": <float|null>,
    "palette": <string|null>
  },
  "mode": <pinned mode, string|null>,
  "frozen": <bool>,
  "enabled": <bool>,
  "director": <bool, optional>
}
```

`override.json` takes precedence over `status.json`, which takes precedence
over `session.json`. An unset (`null`) field means "no override; fall
through." `director` (absent by default, meaning off) opts the pane into
the optional, token-spending director: when `true`, `sbg_state.py` spawns
`sbg_director.py` in the background on the next `UserPromptSubmit` to
refresh `mood.json`, throttled by `director.lock`.

## Related files (not user-facing writers)

- `error.json` — `{ts, phase, message}`, written by `sbg-fx` itself when a
  script fails; read by `sbg doctor` and surfaced by `sbg state`.
- `fx.log` — `sbg-fx` diagnostics, also read by `sbg doctor`.

`SessionEnd` removes `session.json`, `status.json`, `override.json`,
`error.json`, and `journey.json`, and the pane directory itself if it is
left empty. `mood.json`, `director.lock`, and `fx.log` are left behind since
they are not per-conversation state.

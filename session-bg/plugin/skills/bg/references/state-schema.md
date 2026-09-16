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
  "enabled": <bool>
}
```

`override.json` takes precedence over `status.json`, which takes precedence
over `session.json`. An unset (`null`) field means "no override; fall
through."

## Related files (not user-facing writers)

- `error.json` — `{ts, phase, message}`, written by `sbg-fx` itself when a
  script fails; read by `sbg doctor` and surfaced by `sbg state`.
- `fx.log` — `sbg-fx` diagnostics, also read by `sbg doctor`.

`SessionEnd` removes `session.json`, `status.json`, `override.json`, and
`error.json`, and the pane directory itself if it is left empty.

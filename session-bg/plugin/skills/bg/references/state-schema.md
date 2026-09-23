# session-bg control channel schema

Each pane gets its own directory, `SBG_STATE=~/.cache/sbg/panes/<pane>/`, set
by `bin/sbg` before launch. Every writer owns one file in that directory and
writes it atomically (tmp file in the same directory, then `os.replace`).
`sbg-fx` merges them each frame by polling mtimes. The hook writer serializes
concurrent read/modify/write operations with `.writer.lock`.

## `runtime.json` — written by the running host

The host atomically refreshes this heartbeat about once a second and on effect
transitions. It is diagnostic output, never an input or authority for selecting
an effect. `sbg state` and `sbg doctor` show it alongside user overrides.

```json
{
  "v": 1,
  "ts": 1789725000.0,
  "pid": 1234,
  "status": "recovering",
  "requested": {"kind": "script", "path": "/path/to/fortress.lua"},
  "active": {"kind": "builtin", "name": "matrix"},
  "fps": 12.0,
  "reason": "repeated script failures",
  "retry_at": 1789725005.0
}
```

Status is `running`, `recovering`, `paused` or `disabled`. The active choice is
the loaded effect, even when paused/disabled; disabled reports zero FPS and no
scheduled retry. Reason and retry time are null during healthy operation.
Check heartbeat age: a stale record is not proof of a currently running host.
Older binaries have no runtime heartbeat, so the CLI reports unknown.

Retries use 5/10/20/40/60-second backoff, reset after 30 seconds of healthy
operation. Pause and disable suspend attempts. Selecting another effect resets
recovery; changing session metadata or unrelated settings does not bypass it.
Successful recovery reloads `fortress.json` using the ordinary restore contract.

## `session.json` — written by the hook plugin

```
{
  "v": 1,
  "ts": <float epoch seconds>,
  "agent": "claude" | "codex" | "unknown",
  "session_id": <string|null>,
  "session_name": <sanitized display name, <=160 characters>,
  "cwd": <string|null>,
  "mode": "start" | "idle" | "thinking" | "tool" | "waiting" | "error" | "compacting",
  "event": <hook event name, string|null>,
  "tool": <tool name, string|null>,
  "tool_kind": "exec" | "edit" | "read" | "web" | "task" | "mcp" | "other" | null,
  "subagents": <int, >= 0>,
  "prompt": null,
  "seq": <monotonically increasing int>
}
```

`mode` is set from the triggering hook, except `SubagentStart`/`SubagentStop`,
which only adjust `subagents` (clamped to `>= 0`) and carry the previous
`mode` forward. `prompt` is null for every event; no raw snippets are retained. `waiting_for_permission` distinguishes real permission
requests from idle notifications and is internal to hook routing.

`sbg_name.py` shares `.writer.lock` with the hooks. A launcher-owned thread polls
once a second and updates only `session_name` and `detected_name`, plus the
compatibility `journey.session_name` field. It never advances event timestamps,
sequence or counters. Codex reads only the exact thread's explicit SQLite `name`
(not `title`, which can be a prompt); older clients can use `thread_name` in
`session_index.jsonl`. Claude reads matching `custom-title`/`customTitle` records
from the hook's `transcript_path`, or `customTitle` from `sessions-index.json`.
Log reads are bounded to 512 KiB; malformed reads retain the last known title.
`transcript_path` and `detected_name` are internal local metadata. Missing names
fall back to the working-directory basename. Identity changes clear old names.

## `journey.json` — legacy v1 shape (read-only compatibility)

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
  "motif": <string, legacy; ignored by the Fortress-only world.lua>,
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
  "effort": <string|null>,
  "branch": <string|null>
}
```

`effort` is Claude Code's reasoning effort level. The host passes `low`,
`medium`, `high`, `xhigh` or `max` to scripts and treats anything else as absent.

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
  "session_name": <optional display override; empty restores automatic names>,
  "params": {
    "density": <float|null>,
    "speed": <float|null>,
    "hue": <float|null>,
    "opacity": <float|null>,
    "palette": <string|null>,
    "fortress": <optional settlement name>,
    "difficulty": "calm" | "classic" | "chaos",
    "presentation": "auto" | "compact",
    "reduced_motion": <bool, default false>,
    "paused": <bool, default false>,
    "scene": "studio" | "settlement", default "studio"; "office" is rejected by sbg set,
    "glyphs": "unicode" | "ascii", default "unicode"
  },
  "mode": <pinned mode, string|null>,
  "frozen": <bool>,
  "enabled": <bool>,
  "director": <bool, optional>
}
```

`override.json` takes precedence over `status.json`, which takes precedence
over `session.json`. An unset (`null`) field means "no override; fall
through." No field reports whether the window is hidden, focused or occluded; use
`paused` or `enabled` to stop the effect instead of inferring visibility.
`director` (absent by default, meaning off) opts the pane into
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

## Fortress v2 event stream and checkpoints

The current writer emits `journey.v = journey.schema_version = 2`. Each journey
has a fresh `epoch`, hashed `session_id`, monotonic event `seq`, nondecreasing
4 Hz `tick`, and `counter_digest`. `recent` holds at most 64 events:

```json
{"seq": 42, "kind": "tool", "tick": 480, "payload": {"kind": "edit", "ext": "rs"}, "k": "tool", "t": 0, "tool": "edit", "ext": "rs"}
```

`k/t/tool/ext` are bounded compatibility fields for other motifs. `tool` is a
whitelisted kind, not a raw tool name. Events are `embark`, `resume`, `prompt`,
`tool`, `success`, `tool_failed`, `wait_open`, `wait_resolved`, `subagent_start`,
`subagent_stop`, `compact`, `idle`. Success comes from PostToolUse; starts do
not imply success. Permission denial closes a mandate without incrementing
errors. Idle notifications do not create mandates.

The digest is a colon-separated sequence: prompts, tools, errors, compactions,
waits, subagents, subagents_peak, then exec/edit/read/web/task/mcp/other counts.
It is a reconciliation checksum, not a cryptographic integrity guarantee.
`prompt` and `last_prompt` are always null, including on migration. Whole tokens
containing keys/paths/URLs/emails are rejected before extracting subject words;
only alphabetic words 4–16 characters survive, with a credential-label deny-list.
`words` has at most 8 entries, `word_counts` 64 and extensions use a fixed allow-list.
This heuristic is not a general secret detector; raw prompts are never persisted.

Concurrent hooks hold `.writer.lock` across reading and writing both owned files.
Readers still use atomic rename, so cannot observe partial JSON. The lock inode
is retained at SessionEnd to avoid split lock ownership. End removes journey,
session, status, override, errors and Fortress outputs. A schema-1 journey migrates
only its aggregate counters and discards prompt text and the unsequenced ring.
Missing history is reported once as `chronicle_gap`. Clear or a new session
starts a fresh epoch; same-session resume/compact preserve sequence.

The Rust host alone writes `fortress.json` and `legends.json`, at most once per
second. Lua's optional `checkpoint()` returns data; no filesystem access is added.
The converter rejects executable values, deep tables, >20,000 nodes and >256 KiB.
`fortress.json` has `{schema_version, seq, counter_digest, world_state, legends,
summary, status}`. Restore requires matching schema and identity. `world_state`
stays at the event watermark; temporary visual projection advances the fixed
clock between hooks. Render FPS and animation speed cannot alter this history.
`legends.json` holds the current bounded announcements and eviction counts for
`sbg legends`. No model is called during replay.

`override.params` additionally accepts `fortress` (2–24 ASCII letters, spaces,
hyphens), `paused` (bool), `difficulty` (`calm|classic|chaos`). Existing versions
of unrelated motifs ignore these keys. Pause freezes the displayed world and
event consumption; on unpause the ring is consumed or aggregates reconciled.
Schema changes that reinterpret event semantics require a version bump and an
explicit aggregate-only migration; never replay an old ring with new meanings.

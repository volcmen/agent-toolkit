# session-bg Lua scripting API

A script lives at `~/.config/sbg/fx/NAME.lua` (`$SBG_FX_DIR` overrides the
directory). `sbg-fx` hot-reloads it on save: stat mtime+len, debounce, compile
and `init` in a scratch state, and only swap on success. A broken script keeps
the last good version running; the failure lands in `<SBG_STATE>/error.json`
and `sbg doctor`.

## Entry points

```lua
function init(ctx)        end   -- called on load and on resize
function resize(ctx)      end   -- optional; falls back to init(ctx) if absent
function step(dt, state)  end   -- advance your simulation
function render(fx, state) end  -- paint the frame
```

`ctx`:

| Field | Type | Meaning |
|---|---|---|
| `w`, `h` | int | grid size in cells |
| `seed` | int | stable per pane, feed to `sbg.rng(seed)` |
| `density` | float | starting density hint |
| `fps` | int | target frames per second |

`dt` passed to `step` is already scaled by `state.mod.speed`.

`state`:

| Field | Type | Meaning |
|---|---|---|
| `mode` | string | `start` `idle` `thinking` `tool` `waiting` `error` `compacting` `end` |
| `tool` | string\|nil | raw tool name from the last `PreToolUse` |
| `tool_kind` | string\|nil | `exec` `edit` `read` `web` `task` `mcp` `other` |
| `agent` | string | `claude` `codex` `unknown` |
| `session_name` | string | sanitized live display title; also available as `journey.session_name` for older hosts; never a world identity |
| `context_pct` | float | 0..100, Claude only (0 for Codex) |
| `cost` | float | running cost in USD, Claude only |
| `model` | string\|nil | model name, Claude only |
| `effort` | string | reasoning effort `low` `medium` `high` `xhigh` `max`, Claude only; `""` when absent or unknown |
| `prompt` | string\|nil | null/empty in v2 (raw prompts are never persisted) |
| `age` | float | seconds since the current mode started |
| `changed` | bool | true on the frame the merged state actually changed |
| `mod.speed` | float | already folded into `dt` |
| `mod.density` | float | suggested drawing-density multiplier |
| `mod.hue` | float | hue shift the host applies to your output after `render` |
| `mod.bright` | float | brightness multiplier the host applies after `render` |
| `mod.burst` | float | 0..1, decays after a tool call; use for one-shot spawns/flashes |
| `params.density` `.speed` `.hue` `.opacity` `.palette` | number\|string\|nil | user knobs from `sbg set` |
| `params.presentation` | string | `auto` (default) or `compact`; viewport layout only |
| `params.reduced_motion` | bool | stationary scenery and no flashes; event consumption and local time continue |
| `params.paused` | bool | freeze event consumption, local time and presentation clock |
| `params.scene` | string | `studio` (default) or `settlement`; the removed `office` and invalid values fall back to `studio` |
| `params.glyphs` | string | `unicode` (default) or `ascii`; the Studio maps every symbol to ASCII when `ascii` |
| `lines_added` `lines_removed` | number | diff size accumulated this session |
| `duration` | number | seconds of wall-clock session time |
| `branch` | string | git branch from the statusline, `""` when unknown |
| `journey` | table | session counters, see below (may be `{}`) |
| `mood` | table | derived look, see below (may be `{}`) |

### `state.journey`

Monotonic counters for the whole session. Every field may be missing, so read
them as `local j = state.journey or {}` and `tonumber(j.tools) or 0`.

| Field | Type | Meaning |
|---|---|---|
| `started_at` | number | epoch seconds when the session began |
| `repo` | string | repository/workspace name |
| `prompts` | int | user prompts submitted ("chapters") |
| `tools` | int | tool calls so far |
| `tool_kinds` | table | `{exec, edit, read, web, task, mcp, other}` counts |
| `files` | table | `{ext = count}` of files touched |
| `errors` | int | failed tool calls |
| `compactions` | int | context compactions |
| `waits` | int | permission/user waits |
| `subagents` | int | subagents alive now |
| `subagents_peak` | int | most subagents alive at once |
| `last_prompt` | nil | null in v2; raw prompts are never stored |
| `words` | table | array of at most 8 filtered alphabetic subject words |
| `recent` | array | up to 64 newest `{t, k, tool, ext}` events, oldest first |

### `state.mood`

| Field | Type | Meaning |
|---|---|---|
| `motif` | string | legacy request; `world.lua` is Fortress only and ignores it |
| `palette` | array | five `"#rrggbb"` strings; parse with `sbg.hex(tonumber(s:sub(2, 7), 16))` |
| `tempo` | number | suggested motion multiplier |
| `title` | string | a name for the session |
| `mood` | string | a one-word label |

The host applies `mod.hue`, `mod.bright`, and an error tint to every glyph
your script emits, after `render` returns. Do not re-apply `mod.hue`/`mod.bright`
yourself — react to shape and behavior instead (spawn more, move faster, change
which glyphs you draw).

## `fx` (passed to `render`)

- `fx:put(x, y, ch, r, g, b)` — paint one cell. `x`, `y` are 0-based; `r`,
  `g`, `b` are floats in `0..1`; `ch` is a single character. Cells already
  drawn on by the host application are filtered out for you.
- `fx:clear()` — remove everything you painted this frame.
- `fx:count()` — how many cells you have painted so far this frame.
- `fx:size()` — returns `w, h`, the current grid size (same as `ctx.w/h`).
- `sbg.text(fx, x, y, str, r, g, b)` — paint a whole string on one row, one
  cell per character, spaces left transparent; returns how many cells landed.
- `sbg.text_center(fx, y, str, r, g, b)` — the same, horizontally centred.

## The `sbg` table

```lua
sbg.rng(seed)          -- deterministic RNG object
  :f()                   -- float in [0, 1)
  :range(a, b)            -- float in [a, b)
  :below(n)                -- integer in [0, n), 0-based
  :chance(p)                 -- boolean, true with probability p

sbg.noise2(x, y)        -- 2D value noise, [-1, 1]
sbg.noise3(x, y, z)     -- 3D value noise, [-1, 1]
sbg.fbm(x, y, octaves)  -- fractal brownian motion, [-1, 1]

sbg.ramp(name, t)       -- r, g, b for t in [0, 1]
                        -- names: matrix ember ice tokyonight mono warn

sbg.mix(r1, g1, b1, r2, g2, b2, t)  -- lerp between two colours
sbg.scale(r, g, b, k)               -- multiply brightness, clamped [0, 1]
sbg.hex(0xRRGGBB)                   -- -> r, g, b in [0, 1]
sbg.shift_hue(r, g, b, turns)       -- rotate hue by `turns` (1.0 = full turn)

sbg.glyphs.fortress  -- ASCII Fortress vocabulary, see fortress-glyphs.md
sbg.glyphs.matrix    -- katakana/digit/symbol set (matrix rain)
sbg.glyphs.blocks     -- "▁".."█" eight-level block ramp
sbg.glyphs.shades      -- "░" "▒" "▓" "█"
sbg.glyphs.braille      -- all 256 braille characters, indexed 1..256
sbg.glyphs.ascii         -- ".":"-" "=" "+" "*" "#" "%" "@"
sbg.glyphs.dots           -- "·" "•" "∙" "●"
sbg.glyphs.box             -- box-drawing characters
sbg.glyphs.sprites          -- ☺ ☻ ♟ ♙ ⚙ ☕ ✎ ⌨ ▣ ▤ ▥ ▦ ▧ ▨ ▩ ♥ ★ * ✧ ⚡ ☁ ☂ ☀ ☾
sbg.glyphs.tree              -- │ ┃ ╱ ╲ ╭ ╮ ╯ ╰ Y y v ^ ♠ ♣ * ° •

sbg.braille(mask8)     -- 8-bit dot mask -> one braille character

sbg.hsl(h, s, l)       -- hue/saturation/lightness in [0, 1] -> r, g, b
sbg.hash(str)          -- stable non-negative integer hash of a string
sbg.pick(list, key)    -- list[hash(key) % #list + 1]; deterministic choice
sbg.time()             -- seconds since the plugin started (NOT epoch; do not
                       --  compare it with journey timestamps)

sbg.lerp(a, b, t)
sbg.clamp(v, lo, hi)
sbg.smoothstep(edge0, edge1, x)
sbg.wrap(v, n)          -- wrap v into [0, n)
```

## Sandbox

A fresh `_ENV` exposes only `math`, `string`, `table`, `select`, `ipairs`,
`pairs`, `next`, `type`, `tostring`, `tonumber`, `error`, `assert`, `pcall`,
`unpack`, and `sbg`. There is no `io`, `os`, `require`, `load`, `debug`, or
`coroutine` — keep your own state in upvalues declared at file scope (see
`template.lua`), not in files or the environment. Memory is capped at 8 MiB
and a frame that runs past roughly 3M instructions is aborted; a script that
consistently blows the time budget gets its pane's fps halved, and one that
has three consecutive frames over three times its frame budget falls back to
the builtin effect. A single scheduling/I/O stall does not cause fallback.
Three failed whole step/render pairs also trigger recovery; one successful half
cannot erase the other half's error. The host retries the selected script with
5/10/20/40/60-second backoff, restored checkpoints, and no dependence on new
hook events. Pause/disable suspends retry; an explicit builtin cancels it.
`runtime.json` reports requested versus active effect, heartbeat, reason and
next retry. This policy requires a newly launched host; Lua hot reload does
not replace an already-running Rust binary.

## House rules for a good script

- Keep coverage under ~40% of the grid: `fx:count() / (ctx.w * ctx.h)`.
- Be deterministic given `ctx.seed` — do not use anything outside `sbg.rng`
  for randomness.
- Keep colours dim. The host multiplies your output by `state.mod.bright`,
  and a `waiting` pulse or tool `burst` can stack on top, so start well under
  full brightness (see the ports in `plugins/fx/*.lua` for reference levels).
- React to `state.mode`, `state.mod.burst`, `state.context_pct`, `state.age`,
  and `state.changed` — not to `state.mod.hue`/`state.mod.bright`, which the
  host already applies for you.
- For a journey-driven world, rebuild the whole scene from the counters when
  `state.changed` flips and the counters actually differ, instead of
  accumulating per-frame state. Replays then match frame for frame and memory
  stays bounded. Keep growth monotonic and scroll or fade the oldest parts once
  the canvas is full.
- Guard everything the session may not have yet: `local j = state.journey or {}`,
  `tonumber(j.tools) or 0`, `type(j.repo) == "string"`. A pane can be 1x1.

## The Fortress HUD

`plugins/fx/fortress/plaque.lua` is presentation-only state bundled into
`fortress.lua`/`world.lua`. Row 3 of each edge strip shows the mode with the
running tool on the left (`| Bash`, `thinking...`, `waiting ?`, `error !`,
`compacting ~~`, `idle zz` after a minute) and a `ctx [====----] 42%` meter on
the right (hidden when `context_pct` is 0). The bottom-left HUD line lists
tools and `+added/-removed` and brightens for two seconds after a change. A
milestone replaces the mode label for four seconds: `* renamed` (the title also
flashes amber), `* 50 tools`, `* +250 lines`, `* context 50%`, `* chapter 3`,
`* compacted`, `* helper joins`, `! error 2`. None of this touches
simulation history or checkpoints.

With `scene=studio`, `Studioview.hud` owns the edges instead. Row 0 carries
the session name on the left and the `◉ label` lamp on the right (`Editing`,
`Thinking ⋯`, `Your move`, a blinking `Approve?` while a `wait_open` is
unresolved, `Bug ¤`, `Filing`, `Break`). Rows 1–2 show `⌂ repo ⎇ branch`,
`model ▰▰▱▱` effort pips and `ctx ▰▰▰▱ 62%`. The foot shows the nonzero
tallies `✦ ◆ ◇ ■ ○ ¤`, a braille sparkline of tools per 15 s from
`journey.recent`, the tier meter, `Day N · hh:mm` (09:00 + pct × 7.2 min, Day =
compactions + 1) and a short ticker for the latest event. An element whose
field is absent is hidden, never shown as zero, and a numeric field that does
not fit its slot is hidden rather than clipped. The HUD is drawn at priority 0,
so the budget never sheds it.

## Fortress checkpoint lifecycle

Optional `checkpoint()` returns a bounded plain table for fixed, host-owned
`fortress.json`/`legends.json`; optional `restore(record)` receives the last saved
record after init/resize. A script must validate version and identity before use.
No arbitrary read/write API is exposed. Optional `foreground_halo()` returns 0 or
1; Fortress uses 1 and semantic colours (no global hue/error tint).

`params.fortress`, `params.paused`, `params.difficulty` carry validated user
controls. `params.presentation=auto` packs rooms/HUD and ambient scenery into
the current grid; explicit `compact` retains an edge-only settlement and a
clear centre. Both respect foreground occupancy and its one-cell halo;
`params.reduced_motion` freezes scenery and removes pulses without pausing event
consumption. Both are separate from `paused`. Headers and footers shrink to the
grid; context meters drop the bar before dropping a complete percentage, and
waiting/error modes are never displaced by toasts. New parameters require the
current host binary, while layout updates hot-reload in older running hosts.
For the complete v2 journey schema, migration and replay semantics,
see [state-schema.md](state-schema.md#fortress-v2-event-stream-and-checkpoints).
The host exposes no hidden-window, focus or occlusion signal; use
`sbg set paused=true` or `sbg set enabled=false` to stop the effect instead.

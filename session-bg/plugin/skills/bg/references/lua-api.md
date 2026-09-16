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
| `context_pct` | float | 0..100, Claude only (0 for Codex) |
| `cost` | float | running cost in USD, Claude only |
| `model` | string\|nil | model name, Claude only |
| `prompt` | string\|nil | first ~80 chars of the last user prompt |
| `age` | float | seconds since the current mode started |
| `changed` | bool | true on the frame the merged state actually changed |
| `mod.speed` | float | already folded into `dt` |
| `mod.density` | float | suggested drawing-density multiplier |
| `mod.hue` | float | hue shift the host applies to your output after `render` |
| `mod.bright` | float | brightness multiplier the host applies after `render` |
| `mod.burst` | float | 0..1, decays after a tool call; use for one-shot spawns/flashes |
| `params.density` `.speed` `.hue` `.opacity` `.palette` | number\|string\|nil | user knobs from `sbg set` |

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

sbg.glyphs.matrix    -- katakana/digit/symbol set (matrix rain)
sbg.glyphs.blocks     -- "▁".."█" eight-level block ramp
sbg.glyphs.shades      -- "░" "▒" "▓" "█"
sbg.glyphs.braille      -- all 256 braille characters, indexed 1..256
sbg.glyphs.ascii         -- ".":"-" "=" "+" "*" "#" "%" "@"
sbg.glyphs.dots           -- "·" "•" "∙" "●"
sbg.glyphs.box             -- box-drawing characters

sbg.braille(mask8)     -- 8-bit dot mask -> one braille character

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
blows it badly falls back to the builtin effect.

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

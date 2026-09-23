---
name: bg
description: Inspect and control a session-bg animated terminal background — show the current per-pane state, switch the running effect or a custom Lua script, tune animation parameters (density, speed, hue), pin or unpin a mode, enable or disable the effect, and author new animations live. Use when the user asks about their terminal background, session-bg, sbg, or wants to change or build how the pane animation looks or behaves.
---

# session-bg control

`session-bg` paints a live, per-pane animated background driven by the
running Claude Code or Codex session's state (idle, thinking, running a
tool, waiting on a permission prompt, and so on). This skill covers the
day-to-day `sbg` commands, and how to author a new animation on the fly.

## Show the current state

```
sbg state
```

Prints the merged view for this pane: current mode, effect or script,
active parameters, subagent count, and the last recorded error, if any. Use
this first when something on screen looks stuck or wrong — see
`references/state-schema.md` for exactly what each field means and which
file it comes from. `sbg doctor` additionally reports the fx script
directory, how many scripts are in it, and the contents of `error.json`
when a script is currently broken.

Current hosts also write `runtime.json`: actual versus requested effect,
heartbeat, fallback reason and next retry. Check this before assuming the
selected script is running. Old hosts may not report runtime status; a fresh,
advancing Fortress checkpoint proves activity more reliably than file presence.
The host retries failures with bounded backoff, suspended by pause/disable.
Rust host changes require a new session launch; Lua edits hot-reload in place.

## Switch the effect

```
sbg set effect=stars
```

Built-in effects: `matrix`, `plasma`, `waves`, `stars`.

## Tune parameters

```
sbg set density=0.5 speed=1.5 hue=0.2
```

`density`, `speed`, and `hue` can be set together or individually. Values
are clamped to safe ceilings by the plugin, so an aggressive value degrades
gracefully instead of flooding the pane.

## Pin or unpin a mode

Normally the mode (`idle`, `thinking`, `tool`, `waiting`, `error`,
`compacting`, `end`, …) follows the session automatically. To freeze it on
one mode: `sbg set mode=waiting`. To release the pin: `sbg set mode=`.

## Enable or disable

```
sbg set enabled=false
sbg set enabled=true
```

## Custom Lua animations (`sbg fx`)

```
sbg fx list                 # builtins, plus scripts in ~/.config/sbg/fx/
sbg fx new my-effect         # copy the annotated template there, refuses to overwrite
sbg fx path my-effect          # print the script's path
sbg fx edit my-effect            # open $VISUAL/$EDITOR on it
sbg fx use my-effect               # switch this pane to that script, live
sbg fx use matrix                    # switch to a builtin by name instead
sbg fx use off                         # clear the script override
```

`sbg install` copies the shipped ports (`matrix.lua`, `plasma.lua`,
`waves.lua`, `stars.lua`, `context-bars.lua`, `pulse.lua`, the living worlds
below, and `template.lua`) into `~/.config/sbg/fx/` without overwriting
anything already there.

### Living worlds

`world.lua` is the Fortress bundle: the session's own history drawn as a
settlement, so a long session looks nothing like a short one. Growth is
monotonic and comes from `state.journey`; `state.mood.motif` is ignored. The
earlier generative motifs (forest, skyline, reef, circuit, sakura, kana, shrine,
hangar, dojo, hud, studyroom, sparkfield, dust) were removed.

`fortress.lua` and `world.lua` are generated from `plugins/fx/fortress/*.lua`
by `python3 scripts/world/bundle.py`; check coverage with
`lua scripts/world/drive.lua` (frame preview:
`lua scripts/world/show.lua world [tools] [mode] [W] [H] [ctx_pct]`); never
hand-edit the generated copies.

### Authoring a new animation live

1. `sbg fx new NAME` — creates `~/.config/sbg/fx/NAME.lua` from the
   heavily-commented template and prints its path.
2. Edit the file (by hand, or with `sbg fx edit NAME`). `sbg-fx` hot-reloads
   on save: it compiles the new version in a scratch state and only swaps
   in on success.
3. `sbg fx use NAME` once, then keep saving — no need to re-run `use` after
   each edit; the running script updates in place.
4. If a save breaks the script (syntax error, runtime error, banned
   library), the previous good version keeps animating. Check what broke
   with `sbg doctor` or by reading `<SBG_STATE>/error.json` (`sbg state`
   also surfaces the last error).

Full API — `init`/`step`/`render`, the `sbg` helper table (rng, noise,
colour ramps, glyph sets), the sandbox limits, and `fx:put`/`clear`/`count`
— is in `references/lua-api.md`. The control-channel file formats
(`session.json`, `status.json`, `override.json`, `error.json`, `runtime.json`) are in
`references/state-schema.md`.

### Tasteful defaults

- Keep coverage under ~40% of the grid (`fx:count() / (w * h)`).
- React to `state.mode`, `state.mod.burst`, `state.context_pct`, and
  `state.age` for shape and behaviour — the host already applies
  `mod.hue`/`mod.bright` and an error tint to everything you paint, so
  don't re-apply those yourself.
- Keep colours dim; a `waiting` pulse or tool burst stacks brightness on
  top of whatever you emit.
- Be deterministic given `ctx.seed` (use only `sbg.rng`, never wall-clock
  randomness) so the same pane looks the same across restarts.

### Fortress

`world.lua` is the Fortress simulation and the default for every pane;
`sbg fx use fortress` selects the same effect explicitly. Its default scene is
the Studio: a cutaway game-dev tower on the right edge. The HUD shows the
session name, `⌂ repo ⎇ branch`, a `◉ mode` lamp, `model ▰▰▱▱` effort pips,
`ctx ▰▰▰▱ 62%`, tool tallies with a braille sparkline, the tier meter and a
working-day clock. The crew works at lit stations only while a real tool beat
is open, chases a `¤` bug after a failure, runs an errand to the YOU door while
a permission waits and takes coffee breaks when the session is quiet; floors
grow through five tiers with tools and prompts. The contract is
`notes/studio/prd.md`.

`scene=settlement` keeps the edge-district view. Workers build edge districts,
caravans visit, decisions appear at the gate, and compaction seals a gallery.
The header follows the current session name and updates on rename. Construction
progresses from a blueprint to fittings over fifteen tool events per room;
the HUD shows the next room, completed rooms and settlement rank. Progress
describes activity, never code quality. Builders move while tools run.

In the settlement, the HUD row under the title follows the session: the mode with the running
tool (`| Bash`, `thinking...`, `waiting ?`, `error !`, `compacting ~~`,
`idle zz` after a minute) on the left and a `ctx [====----] 42%` meter on the
right; the bottom-left line lists tools and `+added/-removed`. Milestones
replace the mode label for four seconds (`* renamed`, `* 50 tools`,
`* context 50%`, `* chapter 3`, `* compacted`, `* helper joins`, `! error 2`)
and a rename flashes the title amber. `/rename` or
`sbg set session_name=...` shows within about a second.
Waiting and error labels take priority over milestone toasts. Meters and counters
shorten to complete values when an edge strip is narrow.

```
sbg set fortress="Amber Hall" difficulty=calm
sbg set session_name="Parser workshop"  # optional display override
sbg set session_name=                   # restore automatic session name
sbg set paused=true         # freeze the Fortress view and consumption
sbg set paused=false        # catch up from the event ring; report any gap
sbg set presentation=compact # edge-only settlement and smaller HUD
sbg set presentation=auto    # adapt detail and room packing to the pane
sbg set reduced_motion=true # still scenery, no flashes; earned progress continues
sbg set reduced_motion=false # restore animated colony life
sbg set scene=studio        # default: game-dev studio tower on the right edge
sbg set scene=settlement    # landscape and edge-district view
sbg set glyphs=ascii        # ASCII-only Studio for fonts that misrender symbols
sbg legends 12              # recent safe announcements
sbg state                  # includes year, season, population, wealth and stress
```

Profiles are `calm`, `classic` and `chaos`. They affect future flavour/stress;
no control rewrites past legends. Naming after embark records a rename. Speed,
density, resize and cosmetic phase never change recorded history. Raw prompt
snippets are no longer written; only filtered, bounded subject words are used.
Missing events produce an explicit chronicle gap. A denied permission is a
neutral decision. No paid director calls are required.

Fortress derives its layout from the actual pane grid, with readable room sizes,
more room columns in wide panes, and miniature rooms in narrow or short panes.
There is no reference resolution. The settlement fills empty space with a brighter
landscape: trees, flowers, rocks, mushrooms, a flowing stream, bridges, rabbits
and butterflies. Foreground text and its one-cell halo always take priority.
Explicit `presentation=compact` keeps the middle 64% clear; very small panes
prioritize title, mode and progress over decoration. Reduced motion is separate
from pause: ecology time and event consumption continue. New host parameters
require the current `sbg-fx` process; a Lua hot reload alone cannot add them to an
older binary. The adaptive layout itself applies immediately on hot reload.

The launcher's local watcher checks the exact Codex thread name or Claude custom
title once per second, including while idle. Hooks also refresh names. A session
already running before this upgrade needs the new launcher for continuous
polling. Names fall back to the working directory, wrap across two edge rows,
and do not change world identity or history. Long names are clipped and
unsupported glyphs use `?`; full sanitized names appear in `sbg state --json`.

The host exposes no hidden-window, focus or occlusion signal; use
`sbg set paused=true` or `sbg set enabled=false` instead of relying on
window visibility.

Source modules live in `plugins/fx/fortress/{glyphs,sim,life,plaque,landscape,studioview,studio,render,adapter}.lua`.
`fortress.lua` and `world.lua` are generated: run
`python3 scripts/world/bundle.py` after changes. Validate via
`python3 scripts/check.py`. Glyphs and visual rules:
[fortress-glyphs.md](references/fortress-glyphs.md).

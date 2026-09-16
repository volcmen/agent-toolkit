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
`waves.lua`, `stars.lua`, `context-bars.lua`, `pulse.lua`, `template.lua`)
into `~/.config/sbg/fx/` without overwriting anything already there.

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
(`session.json`, `status.json`, `override.json`, `error.json`) are in
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

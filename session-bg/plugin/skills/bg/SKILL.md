---
name: bg
description: Inspect and control a session-bg animated terminal background — show the current per-pane state, switch the running effect, tune animation parameters (density, speed, hue), pin or unpin a mode, and enable or disable the effect. Use when the user asks about their terminal background, session-bg, sbg, or wants to change how the pane animation looks or behaves.
---

# session-bg control

`session-bg` paints a live, per-pane animated background driven by the running
Claude Code or Codex session's state (idle, thinking, running a tool, waiting
on a permission prompt, and so on). This skill covers the day-to-day `sbg`
commands for looking at and steering that background from inside a session.

## Show the current state

```
sbg state
```

Prints the merged view for this pane: current mode, effect, active
parameters, subagent count, and the last recorded error, if any. Use this
first when something on screen looks stuck or wrong — see
`references/state-schema.md` for exactly what each field means and which
file it comes from.

## Switch the effect

```
sbg set effect=stars
```

Replaces the running effect immediately. Valid built-in effects are `matrix`,
`plasma`, `waves`, and `stars`.

## Tune parameters

```
sbg set density=0.5 speed=1.5 hue=0.2
```

`density`, `speed`, and `hue` can be set together or individually. Values are
clamped to safe ceilings by the plugin, so an aggressive value degrades
gracefully instead of flooding the pane.

## Pin or unpin a mode

Normally the mode (`idle`, `thinking`, `tool`, `waiting`, `error`,
`compacting`, …) follows the session automatically. To freeze it on one mode:

```
sbg set mode=waiting
```

To release the pin and let the session drive the mode again:

```
sbg set mode=
```

## Enable or disable

```
sbg set enabled=false
sbg set enabled=true
```

Turns the background animation off or back on for this pane without killing
the session.

## What's next

Custom, user-authored animations (`sbg fx`, Lua scripting) are Phase 2 of
this project and are not available yet. This skill will grow scripting and
authoring guidance once that phase ships.

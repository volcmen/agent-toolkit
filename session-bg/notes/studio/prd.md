# Studio — product requirements

Status: accepted 2026-09-23. Tracker: epic [MY-188](https://linear.app/my-perosnnal/issue/MY-188),
milestone M6 — Studio, sub-issues MY-189…MY-197. Supersedes the idle office
(`notes/fortress/office.md`, gate MY-174 closed with the verdict "revise").
Extends [../fortress/design.md](../fortress/design.md): Fortress history,
legends, counters and safety rules stay as specified there; this note owns what
the default scene draws.

## Problem

The idle office drew two fictional coworkers in three ASCII rooms
(`[=] [#] [C] [:] [!] ||`). David's review of a live pane found it dull, empty
and silent about the real session; the farm landscape around it competed for
attention. A background that is fun but says nothing about the work is noise.

## Goal

A glance at the right edge of the pane answers: *which session is this, where
is it, what is the agent doing, how much has been done, how full is the
context, how hard is it thinking.* The answer is a small living game-dev studio
in a cutaway tower, in the spirit of Game Dev Tycoon, Tiny Tower, RimWorld and
Dwarf Fortress. It stays behind chat text, never competes with it, and costs no
more CPU than the scene it replaces.

## Non-goals

- Background colour or images; the host paints truecolor foreground glyphs only.
- Input, management UI, currencies to spend, model-generated text, paid calls.
- Fictional progress that looks like real work; offline catch-up.
- Physical terminal matrix and three-hour soak (MY-138, MY-142 keep them).

## Signals

Every visual that claims session state reads a real field from the host state
(`plugin/skills/bg/references/state-schema.md`). Raw prompts, paths and tool
output never reach Lua.

| Question | Field | Visual |
|---|---|---|
| Which session | `session_name` | HUD title at row 0, x 0 (rename-safe); neon roof sign above the tower |
| Where | `journey.repo`, `branch` | `⌂ repo ⎇ branch` on HUD row 1; the branch moves to row 2 when it does not fit |
| Doing what | `mode`, `tool_kind`, `wait_open` | mode lamp `◉ label`; the staffer for the tool kind works at a lit station; thinking at the whiteboard with `⋯`; plain waiting is a steady amber lamp and "Your move"; an unresolved permission while `mode=='waiting'` blinks the lamp and sends an errand to the YOU door; error drops a `¤` bug that a staffer chases; compacting sends the archivist to the library; idle is coffee, couch and window; end turns the lights off floor by floor |
| How much | durable `counts.tools`, `counts.tool_kinds`, `counts.prompts`, `counts.errors`; `j.recent` | point bubbles rise from a station on each `success`: `◆` edit/other, `◇` read, `■` exec, `○` web/mcp, `✓` task; tallies `✦ ◆ ◇ ■ ○ ¤`; braille sparkline of tools per 15 s |
| Helpers | `subagent_start`/`subagent_stop` counts, live `subagents` | up to three contractors `♙` enter at the lobby door, ride the lift to a hotdesk and walk out when their subagent stops |
| Context | `context_pct`, `counts.compactions` | `ctx ▰▰▰▱ 62%`; working-day clock `Day N · hh:mm`, 09:00 + pct × 7.2 min, Day = compactions + 1; no clock when `context_pct ≤ 0` (Codex) |
| Effort | `effort` (new, Claude only) | `model ▰▰▱▱` pips: low 1, medium 2, high 3, xhigh/max 4; hidden when absent |
| Progress | points = tools + prompts | tier grows the tower; tier meter bottom-right |

Tallies count tools started (the durable counter); bubbles mark successes. The
crew's own routine (coffee, walking, reading) is decoration and never implies
work happened: a work pose exists only while a real beat is open.

## Tiers

| Tier | Name | Points | Floors (bottom → top) | Staff |
|---|---|---|---|---|
| T1 | Garage | 0 | garage · loft (YOU) | 2 |
| T2 | Startup | 45 | lobby · dev · lab · boss | 4 |
| T3 | Studio | 135 | lobby · dev · library · servers · design · boss | 6 |
| T4 | HQ | 315 | T3 plus hotdesk and qa | 8 |
| T5 | Tower | 675 | T4 plus roof terrace and antenna | 10 |

The lobby is always the ground floor and YOU/boss always the top. When a pane
fits fewer floors than the tier program, rooms merge in this order and keep
their stations: hotdesk→dev, qa→servers, library→servers, design→boss, lab→dev,
servers→dev, library→dev, loft→garage, lobby→dev, boss→dev.

## Crew

Roles map to tool kinds: developer (edit/other), researcher (read), operator
(exec), liaison (web/mcp and task delegation), archivist (compaction).
Contractors stand for running subagents. Staff use `☻`, contractors `♙`. A tier
that lacks a role folds its work: operator→developer, liaison→researcher,
archivist→researcher.

- A `tool` event opens a beat. A `success` closes the oldest open beat of the
  same kind, `tool_failed` closes the oldest open beat, and a prompt, idle or
  compaction closes them all. A beat lasts at least 12 ticks (3 s) so short
  tools are still visible; an unclosed beat stays open while the live mode is a
  turn (tool, thinking, waiting, error) and otherwise ends at the ring's last
  event.
- Each role works its oldest open beats first, as many as it has staff. Work
  displaces incidents but never other work, and any free staffer covers an
  incident whose own role is busy.
- Incidents: a `¤` bug chase for 10 s after `tool_failed` (cut short by the
  next failure, held while the mode is `error`); the archivist carries files to
  the library after a compaction by the same rule; an errand to the YOU door
  while a permission waits; the whiteboard with `⋯` while thinking with no open
  beat.
- Up to four point bubbles rise for 8 ticks after a success, above the station
  where its beat was worked.
- Without work or an incident each staffer follows a seeded routine per 80-tick
  slot (`Sim.roll(seed, slot, id, 4)`): coffee, couch, window or a stroll on the
  home floor. The routine never takes a work station, so a lit desk always
  means a live beat.
- Walking costs 2 ticks per cell along the floor and the lift shaft; one actor
  per station and cell. An actor reports its destination station from the
  start of its walk, so the station lights up as soon as the beat opens.
  Reduced motion draws actors at their destinations, holds the idle routine on
  one slot and hides contractors on their way out.
- The planner is a pure function `Studio.plan(cache, scene)` with
  `scene = {seed, layout, recent, live = {mode, subagents}, now, quiet}`,
  returning `{actors, marks}`: actors carry `id, role, class, beat, since, x, y,
  floor, moving, station`, marks are bugs and bubbles. `cache` is a memo keyed
  by every input, never state. Same inputs give the same frame, so restart, hot
  reload and resize need no crew checkpoint.
- Studio clock in ticks (4/s):
  `now = max(prev_now + real_dt*4, j.tick + floor(max(0, age)*4))` for schema 2
  journeys, else `world.clock + floor(elapsed*4)`. Paused freezes it; reduced
  motion keeps it running, draws actors at their stations and stops blinking.

## Cast

`Studioview.cast(frame, layout, clock)` turns a planner frame into draw items
for the tower; `clock = {now, quiet, ending}`.

- Draw order, first item wins its cell: marks (bugs, bubbles), then per actor
  its glyph, the prop it holds one row above (`⋯` thinking, `◉` errand lamp
  blinking every 2 ticks, `▥` files), and its lit station screen; then the
  lift car and the ambient lights. The cast draws before the static tower, so
  crew walk in front of furniture.
- Colours: actors by class (work and thinking white, errand amber, chase red,
  carry and contractors violet, idle dim); a lit station and every mark take
  the job colour (edit green, read screen blue, exec amber, web violet, task
  green, bug red) at 1.3 × brightness.
- Ambient: every rack carries a green `∙` LED that goes dark for 2 ticks in
  every 6, every coffee machine a `°` steam puff showing 3 ticks in every 6,
  both only on free cells and staggered by position. From T2 the `◘` car rides the shaft between the ground and top floor,
  one row per 2 ticks. Reduced motion keeps LEDs steady, hides steam and parks
  the car at the ground floor.
- Closing (`mode == 'end'`): no crew and no ambient; floors dim to 0.45 from the
  top, one floor per second (4 ticks per floor); reduced motion dims them all
  at once.

## Layout

The tower is a pure function of width, height, tier and presentation.

- Width `TW = compact ? strip-2 : clamp(floor(w*0.30), 22, 52)` with
  `strip = floor(w*0.18)`; right edge `x1 = w-3` because the own backend owns
  the last column and the halo is one cell; `x0 = x1-TW+1`.
- Column x0 is the wall, x0+1 the shaft (`╫` ladder at T1, `╎` rail with a `◘`
  car from T2), x0+2 the shaft wall; rooms span x0+3..x1-1.
- Floor height 4 (three interior rows and a slab); head and foot 3 rows when
  h ≥ 12; floors that fit `floor((bottom-top-2)/4)`; the roof sign sits on the
  row above the roof, always at y ≥ 1.
- Worked sizes: 80×24 → TW 24, 4 floors; 120×35 → TW 36, 6; 200×60 → TW 52,
  13; compact 120 → TW 19 at x 99..117.
- Strip form: a one-line status row (`▌garage│dev│lab▐`) when TW < 14, x0 ≤
  strip, or no floor fits.
- Foreground occupancy and its halo mask everything, as for scenery.

## HUD

| Corner | Content |
|---|---|
| Top-left | title (row 0); `⌂ repo ⎇ branch` (row 1, branch to row 2 if needed) |
| Top-right | `◉ label` · `model ▰▰▱▱` · `ctx ▰▰▰▱ 62%` |
| Bottom-left | `✦12 ◆31 ◇40 ■22 ○3 ¤1` and the braille sparkline |
| Bottom-right | `T3 Studio ▰▰▰▱▱` · `Day 1 · 13:28` · announcement ticker |

HUD text stays on rows 0–2 and h-3..h-1; central-band cells never leave
1 ≤ y ≤ h-2 except the title row and footer rows already allowed.

## Glyphs

Host additions (S1): `⌂ ⎇ ▰ ▱ ◉ ◆ ◇ ■ ○ ¤ ✓ ✗ ⋯ ◘ ☼`, on top of the existing
box drawing, block, braille, halfwidth katakana and whitelisted symbols. No
emoji-capable code points. `glyphs=ascii` maps every Studio glyph to ASCII for
fonts or terminals that misrender them.

## Performance and safety

- Density budget unchanged: 22% target, 25% hard cap; the static layer uses at
  most 0.7 × budget and sheds decor, then duplicate furniture, then floors.
- The static layer is cached per layout; the cast draws first and the static
  tower fills every cell the cast left. Release render p95 < 3 ms at 200×60;
  sustained ≤ 3% of one core at 12 fps.
- Life, landscape and the Sim projection do not run for the Studio; the Sim
  world still records counters, legends and the ticker.
- Old checkpoints with an `office` record restore the world and ignore the record.

## Controls

`sbg set scene=studio|settlement` (default studio), `glyphs=unicode|ascii`,
plus the existing `presentation`, `reduced_motion`, `paused`, `density`.
`scene=office` is rejected with a pointer to `scene=studio`; the host maps a
stale `office` override to the Studio.

## Acceptance

- Each signal row above has a scripted scenario whose frame shows its visual,
  and removing the field hides it.
- Goldens at 80×24, 120×35, 200×60 (frames 0, 120, 300) inspected before writing.
- Property tests: layout bounds and budget over random viewports; planner
  purity, resize, batch and restart invariance, truthfulness, traceability,
  caps and reservations; cast bounds, vocabulary, lit stations, stillness under
  reduced motion and ambient motion within 4 ticks.
- Top-heavy liveness: at 80×24, 120×35 and 200×60 across all tiers the lower
  floors change within 1.2 s; reduced motion keeps the tower still across slot
  boundaries.
- `python3 scripts/check.py` and workspace `python3 scripts/plugins.py check`
  pass; release timing and bench within budget.
- David's 30-second first look names the session, location, current status and
  effort, and his keep/revise verdict is recorded in MY-197.

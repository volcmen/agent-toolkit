# Fortress — simulation contract

Status: implementation contract, 2026-09-17. Tracker: [MY-125](https://linear.app/my-perosnnal/issue/MY-125).
The settlement view described here is `scene=settlement`; the default scene is
the Studio ([../studio/prd.md](../studio/prd.md)), which keeps this history,
legends and safety contract.

The fortress is a quiet chronicle of a coding session: an original ASCII settlement
with workers, specialist workshops, visiting caravans and remembered achievements.
It needs no input. Foreground text always wins. Progress measures activity, never
code quality, productivity, money spent or human worth.

## Signals and meaning

| Signal | Meaning | Rules |
|---|---|---|
| start / embark | Founder, planning desk, workshop, gate | Identity derives from repo, session and schema; resumes keep it. |
| prompt | New chapter and safe engraving subject | Only bounded alphabetic keywords; no raw prompt or prompt fragments. |
| thinking | Planning / scholarship | Cosmetic planner glow; no fake completed work. |
| tool exec / edit / read | Mechanic / Mason / Archivist jobs | Source event grants practice XP, not a claim that tests passed. |
| web / mcp | Visiting caravan | Only whitelisted source kind and safe subject, no server names or result text. |
| task / subagent start, stop | Recruitment / arrival, departure | Task calls alone never invent a resident. Actual start/stop counts govern population. |
| wait_open | Mandate at gate | Permission waits only; idle notifications are not mandates. |
| wait_resolved | Decision recorded | Fulfilled, declined or unknown resolved are neutral. Never call denial a failure. |
| tool_failed | Local ambush, repeated failures become raid / siege | No fatalities; resolution or timeout clears every incident. No punishment loop. |
| success | Recovery | Only an observed successful tool completion, never the next tool start. |
| idle | Rest, fellowship, engraving | Needs soften; no survival/economy simulation. |
| compact | Seal gallery, open deeper level, year-end legend | Preserve artifacts and summaries; clear transient jobs and incidents. |
| context_pct | Spring <25, summer <50, autumn <75, winter otherwise | Visual observation, not history or a clock. Codex missing context stays spring. |
| lines_added / removed | Construction / quarried material | Neither deletion nor zero growth is failure; no quality score. |
| tool_kinds / files | Workshop practice / material flavour | Sorted tie-breaking; unknown extensions collapse to other. |
| cost | Unused | Never a score or unlock condition. |

Workers have six skills (plan, exec, edit, read, trade, craft), four soft needs
(rest, craft, knowledge, fellowship), and content/focused/strained/inspired moods.
Job ownership uses best matching skill, then stable dwarf id. Jobs expire even if
a completion hook is lost. Residents follow routes through doors and outside
corridors; their routines and screen coordinates are presentation state.

Profiles: `classic` uses ambush/raid/siege at 1/3/6 failures in 90 seconds;
`calm` halves stress gain and uses setback/recovery language; `chaos` adds flavour
without raising stress or changing success, XP or past legends. Cooldown is 30
seconds after recovery. No death, food, combat mechanics or tantrum spirals.

## Authority, clocks and persistence

Ordered v2 events `{seq, kind, tick, payload}` are authoritative. Tick is a
nondecreasing 4 Hz offset since embark, assigned at the writer, not by rendering.
Counters are checkpoints. A ring gap creates one explicit `chronicle_gap`; reconcile
aggregate totals without fabricating individual historical jobs or achievements.
New sessions and clear create new epochs; resume and compaction preserve sequence.
Hook read/modify/write is serialized with a per-pane lock; atomic rename alone
cannot prevent concurrent subagent updates being lost.

Simulation advances at fixed ticks, independent of render FPS and speed knobs.
Event processing advances to each event's tick; same seed and ordered events at
the same final tick yield the same state. Cosmetic phase and viewport are excluded
from snapshots. PRNG is a portable event-keyed integer hash `(seed,seq,tag)`; no
shared RNG, `sbg.time`, wall-clock randomness or unordered iteration decisions.
Long gaps use analytic decay and bounded expiry rather than replaying empty ticks.
The host may reduce visual FPS, without changing logical time or event order.

A host-owned `fortress.json` checkpoint holds schema, identity, sequence, counter
digest and world state. Lua can return a bounded checkpoint; it cannot choose a
file path or use I/O. Restore only for matching schema/identity, then consume the
ring. Missing snapshots reconstruct from available events and counters and report
incomplete history. Atomic snapshots and `legends.json` are written at most once
per second. Resize only rebuilds layout; render never mutates simulation.

Caps: 12 live dwarves, 48 rooms, 96 loose items, 32 jobs, 8 incidents,
16 artifacts, 128 legends and 16 queued announcements. Extra migrants become crew counts; items become stock
counts; old rooms become sealed galleries. IDs increase monotonically. Summaries
retain evicted legend counts; current arcs retain their opening sequence.

## Viewport and visual vocabulary

ASCII is the portable default. Main objects use semantic colours: cool grey,
amber decisions/strain, muted red incidents, violet artifacts, seasonal floor tint.
No emoji, wide glyphs, borrowed DF names or assets. [Glyph contract](../../plugin/skills/bg/references/fortress-glyphs.md).

Each edge district uses `floor(columns × 0.18)` cells, with no fixed maximum
width. Buildings and HUD remain on the edges; the default landscape uses empty
space across the body of the pane. Foreground occupancy and its one-cell halo
mask all scenery. This replaces the permanently blank middle after the user's
2026-09-18 screenshot feedback. Room packing derives from available
columns and rows: 6–18 cells wide, 4–8 rows tall, with a corridor outside each
column. More space adds room columns and rows rather than stretching buildings.
Visible rooms alternate between wings and always include the latest building site.
Gardens sit directly below the rooms instead of at the pane's bottom. The ecology's logical 12×6 grid is
independent of these viewport crops.

When a strip cannot fit a nine-cell room and corridor, or a full header/footer
plus a room cannot fit vertically, `auto` selects miniature rooms and a compact
HUD while retaining scenery that fits. The header and footer shrink with
available height. Extremely small panes show only the labels that fit.
`presentation=compact` explicitly keeps the middle 64% empty at any size and
omits the surrounding landscape, floor texture and falling particles. Density
remains independently adjustable.

The cached landscape uses seeded groves, rock outcrops, flowers, mushrooms,
wheat, a winding stream and crossings. Small plants fill gaps where a full
sprite cannot fit. Wildlife, foliage, water and campfires animate from the
existing local-life clock. They are cosmetic scenery, never extra agents,
earned rooms or achievements. Brighter source colours and a night-light floor
keep silhouettes legible after default idle dimming and compositor opacity.

`reduced_motion=true` uses a static daytime scene and stationary residents while
the actual local life clock and event consumption continue. Host brightness
pulses, error tint, plaque flashes and spinners are disabled. New earned rooms,
names and counters still appear. Pause separately freezes the presentation clock
and event consumption. Neither resize nor either presentation control writes
simulation history, counters, legends or PRNG state.

Status and announcements stay on the edges and are clipped, never horizontally
scrolled through the text. Rendering emits essential objects first and then rooms,
furniture, items, ambient detail. A hard 25% budget overrides cosmetic density;
normal target 22%, or 15% in explicit compact mode. A busy foreground can reduce
visible coverage to zero. Palette shading is cached once per frame.

## Worked timelines (announcements in order)

### Five minutes

0:00: “The founders raise the gate of Emberhold.”
0:20 prompt: “A new chapter begins: parser.”
0:40 edit: a Mason works; routine jobs need no announcement.
1:00 web: “A caravan reaches the gate, bearing parser.”
1:08: “The caravan departs; its findings join the archive.”
2:00 permission: “A mandate awaits judgment at the gate.”
2:05 denial: “The mandate is declined. The work continues.”
5:00 idle: workers rest; no failure or penalty.

### Thirty minutes

The embark and chapter lines precede “A specialist arrives below” twice, from two
SubagentStart events. At 10:00, 10:15, 10:30 failures open an ambush then escalate
to a raid. A successful completion at 10:35 announces “The raid is broken; work
resumes.” Residents depart on their actual stop events. At 20+ minutes, an eligible
Skilled worker may claim a workshop; 8–12 ticks later a named masterwork is recorded.
Missing success expires the incident with “The watch stands down” rather than
claiming a successful test. No siege is invented from these three failures.

### Three hours, two compactions

Embark, chapters, ordered caravan/migrant arcs and occasional masterworks precede
the 60-minute compaction: “Year 1 closes…” then “A deep rumble passes; the old
gallery is sealed.” Year 2 / z1 begins, retaining artifacts. The same pair at 120
minutes opens year 3 / z2. An artifact can recur only after 25 minutes; the final
chronicle contains bounded entries plus exact eviction counts. A disconnected
interval emits “A passage of the chronicle is missing; totals are reconciled.”
It never invents the missing story. Fixtures exercise the temporal structure;
procedural names and rendered lines are generated from the implementation.

## Field audit

`state.mode/tool_kind/age/mod.burst`: cosmetic reactions; `changed`: refresh hint.
`context_pct`, `lines_added`, `lines_removed`: observed season/construction/quarry.
`params.density`: bounded cosmetic density; `speed`: animation only; `hue/opacity`:
host output; `palette`: unused in Fortress. `params.fortress/paused/difficulty`:
explicit controls. `mod.speed`: undo for the logical clock; `mod.density`: unused;
`mod.hue/bright`: host only. `tool`, `agent`, `cost`, `model`, `prompt`, `duration`:
unused by simulation. Raw prompt fields remain null in v2.

`journey.schema_version/v/epoch/seq/tick/recent/counter_digest`: replay contract.
`repo/session_id`: hashed identity source; `started_at/ts`: writer clock metadata.
`prompts/tools/tool_kinds/files/errors/compactions/waits/subagents/subagents_peak`:
reconciliation. `words`: safe subject candidates. `word_counts`: bounded source
aggregation, unused by Lua. `last_prompt/cwd/agent`: unused. `mood.motif` selects
world only; `mood.palette/tempo/title/mood/ts` are unused by Fortress to preserve
semantic colour and safe names. Unknown fields are ignored, never rendered.

## Inspiration review

Reviewed 2026-09-17: [Labor](https://dwarffortresswiki.org/index.php/Labor),
[Needs](https://dwarffortresswiki.org/index.php/Needs),
[Strange mood](https://dwarffortresswiki.org/index.php/Strange_mood),
[Mandate](https://dwarffortresswiki.org/index.php/Mandate),
[Siege](https://dwarffortresswiki.org/index.php/Siege),
[Legends](https://dwarffortresswiki.org/index.php/Legends).
The inspiration is specialist labour, readable symbolic spaces and an emergent
chronicle. This contract deliberately excludes survival penalties and copies no
names, text or assets from the game.

## Announcement presentation

A 16-entry priority queue uses four-second slots. Incidents and artifacts can
preempt routine announcements; ordinary messages are offered at most once per
20 simulation seconds. Full text is retained in legends independently of ticker
selection. Narrow panes show a short event label and safe subject at opposite
edges rather than fragments of a sentence across the central landscape.

## Visible progression and session identity

M5 adds a separate display title that follows the agent's explicit session name.
The title is presentation metadata, never part of the world's identity hash or
legends. It can change while paused. Two edge rows show the name with clipping;
the settlement keeps its own generated or explicitly chosen name below it.

Three starter rooms are complete. Room four begins as a blueprint. Each fifteen
tool events completes one room and opens the next site, up to 48 rooms. The
outline fills in stages (plan, base, raise, fit) from those counters; time,
spending and animation speed cannot earn construction. At 6, 12, 24 and 48
completed rooms the settlement becomes Outpost, Village, Citadel and Capital.
Room completions and rank changes produce bounded legends only when their
actual event crosses the threshold. Reconciliation shows aggregate progress
without fabricating reward announcements. Existing v2 snapshots remain valid.

The latest site stays visible when old rooms leave a small viewport. Builders
travel within rooms during tool activity; movement is cosmetic. The next-room
meter, completed-room total and final completion state use fixed edge segments.

## Autonomous life

MY-163 adds a bounded living layer in `fortress/life.lua`. The design draws on
the [official Dwarf Fortress description](https://bay12games.com/dwarves/features.html)
of residents working, relaxing and using shared spaces, and
[Golly's Conway rule specification](https://golly.sourceforge.io/Help/Algorithms/QuickLife.html).
The implementation is original code and ASCII art.

The layer has its own elapsed time, advanced with unscaled active seconds.
It never mutates event counters, skills, rooms, agent population or legends.
The checkpoint's optional `life` record stores a version, world seed and elapsed
seconds. Old v2 world checkpoints remain valid; an absent or invalid life record
starts the local day at dawn. Matching reloads restore this clock. Pause freezes
it; resize rebuilds only layout; rendering cannot advance it. Time while the
effect is not running does not count as off-screen survival simulation.

A 12×6 finite garden follows B3/S23 with dead boundaries and simultaneous
generations once per second. Seeded gliders, blinkers and a few fertile cells
germinate every 48 generations. Between these explicit reseed points, local
birth and survival rules determine the pattern. Reconstructing any elapsed
time needs at most 47 generations, bounding reload and catch-up cost. Both
edge gardens show different views of the same ecology, independent of viewport.

Residents have deterministic, staggered routines: walk, read/craft/gather/tend,
return and rest. They travel along orthogonal routes through doors and outside
corridors. Room/garden destinations remain in the same district, keeping the
centre clear. Nearby gatherers exchange a visible chat gesture. Actual jobs
still affect the action glyph; no routine invents completed work or arrivals.

An ambient day is 120 seconds, divided into dawn/day/dusk/night. Weather changes
in seeded 40-second periods. Scenery dims at night while readable labels,
residents, lamps and campfires retain their colour. River ripples, cats and
sparse rain provide activity even with one resident. The layer uses the same
ASCII, foreground halo and density budget as the settlement.

Verification: known block, blinker and glider patterns; cadence equivalence;
checkpoint reconstruction and corrupt-record fallback; bounded long gaps;
door-only resident routes; unchanged earned history; pause, resize and hot
reload through the real plugin protocol. Existing physical-terminal release
reviews remain independent of this automated evidence.

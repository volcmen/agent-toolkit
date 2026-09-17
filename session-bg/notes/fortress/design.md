# Fortress office — simulation contract

Status: implementation contract, 2026-09-17. Tracker: [MY-125](https://linear.app/my-perosnnal/issue/MY-125).

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
a completion hook is lost. Dwarves appear symbolically at a worksite; no pathfinding.

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

ASCII is the portable default. Main objects use dim semantic colours: cool grey,
amber decisions/strain, muted red incidents, violet artifacts, seasonal floor tint.
No emoji, wide glyphs, borrowed DF names or assets. [Glyph contract](../../plugin/skills/bg/references/fortress-glyphs.md).

| Viewport | Placement | Protected centre |
|---|---|---|
| below 60×16 | Compact edge status, only what fits | Every cell outside the strip |
| 60×16–119×34 | 8–14 column left district; small right gate | At least middle 60% |
| 120×35–159×44 | Two edge districts | Middle 60% |
| 160×45 and larger | Dual wings with additional rooms | Middle 60% |

Status and announcements stay on the edges and are clipped, never horizontally
scrolled through the text. Rendering emits essential objects first and then rooms,
furniture, items, ambient detail. A hard 25% budget overrides cosmetic density;
normal target 10–15%. A busy foreground can reduce visible coverage to zero.

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
edges rather than fragments of a sentence across the protected centre.

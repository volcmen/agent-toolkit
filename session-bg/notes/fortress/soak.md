# Fortress validation — 2026-09-17

Branch: `feat/fortress-office`, in `agent-toolkit/session-bg`. This report
separates accelerated simulation from wall-clock terminal validation.

## Idle office — 2026-09-20

MY-167–MY-174 add the Tiny R&D Office as the default `scene`; `settlement`
keeps the previous rendering. Contract: `office.md`. Tree is uncommitted after
`5e998c3`.

- Project gate passed on the final tree with nothing else running: 119 Python
  and 43 Rust tests, recovery and real-protocol smokes (scene switch, pause
  freezing `office.elapsed`, restart keeping `office.facts`, corrupt `office`
  record falling back with `status.office.reset`), 821,954 fortress, 998,564
  office, 269,275 officeview, 1,843,961 presentation and 39,556 landscape
  assertions, nine unchanged settlement goldens, nine new office goldens,
  Tattoy PTY smoke. Release render p95 1.523 ms in that run.
- An earlier gate run failed only `test_invocation_is_fast` (117.9 ms against
  100 ms) while a worker compiled concurrently; the clean rerun passed.
- Office pacing over 200 seeds × 45 simulated minutes: first demo p10/p50/p90
  69/165/275 s; bench 389/739/1716 s; 198/200 reach the bench. Simulated
  minutes, not an observation.
- Previews at 80×24, 120×35 and 200×60 inspected:
  `~/.cache/sbg/previews/office-20260920/`; regenerate with
  `lua scripts/world/office-preview.lua`.
- Not done: the 45-minute real-time observation (MY-174), physical terminal
  captures and the three-hour soak remain open.

## Adaptive presentation — 2026-09-18

MY-160 adds fluid room packing, miniature rooms for narrow/short panes, a compact
HUD and reduced motion. The Fortress-only world and live plaque remain intact.
The current working tree is local and uncommitted after `5e998c3`.

- Project gate passed: 35 Rust tests, 114 Python tests, deterministic replay,
  life/plaque suites, nine reviewed goldens, real protocol checks and Tattoy PTY smoke.
- Full workspace gate passed: 1,702 tests in 458.514 seconds, including all
  project suites and catalog validation. The final paused-waiting change also
  passed a separate Rust and real-protocol run.
- Adaptive properties cover 640 arbitrary size/preset combinations, tiny and
  zero-sized grids, and 180 resize/presentation changes with checkpoint parity.
  The current dedicated run passes 1,260,681 assertions. Reduced-motion frames
  remain identical across changing ambient times while earned events still apply.
- Protocol smoke covers 37×9, 53×17, 77×23, 103×13, 181×19, 333×47 and 120×35
  with busy foreground, one-cell halo, centre clearance, live renaming, controls,
  paused waiting mode, resize and ecology hot reload. No history or clock reset.
- Release sandbox sample: 2.515 ms p95 at 200×60, below the 3 ms target. This is
  a single sample under concurrent local load, not a long-term performance claim.
- Renderer previews inspected at 120×35, 77×23, 103×13, 53×17, 237×41 and a
  compact 103×29. Local artifacts: `~/.cache/sbg/previews/adaptive-fortress-20260918/`.
- Both active panes (13 and 22) logged a successful live reload. Settlement
  identity, tool totals, rooms and ecology time were retained; neither had a
  script error. Backups: `~/.cache/sbg/backups/20260918-adaptive-090815/`.
- Session-bg 1.0.0 matches both agent caches. The refresh command returned 1
  solely for the existing unrelated Qwen/Claude `UNLINKED` entry. Both current
  and legacy 1.2.2 hook entry points were retained and verified to avoid the
  previous missing-script Stop-hook loop.

The adaptive Lua layout is live. New `presentation` and `reduced_motion` host
parameters require a newly launched `sbg-fx`; existing processes retain their
old binary. The physical terminal matrix and three-hour real-time soak remain
MY-138 and MY-142; the synthetic previews do not close those gates.

## Observed automated evidence

| Check | Result |
|---|---|
| Rust unit and sandbox tests | 33 passed, including checkpoint restore, resize, width gate, substitution logging and foreground halo |
| Python boundary / launcher / hook tests | 107 passed; covers concurrent hooks, permission outcomes, private inputs and controls |
| Deterministic replay | 100 repetitions of 10,000 events; batches 1, 7 and 64 agree |
| Snapshot continuation | Restored and uninterrupted states have identical hashes; resize preserves history |
| 100,000-event stress run | All entity and queue caps hold; about 7.4 KiB memory difference between 20k and 100k after full GC |
| Simulation event p95 | 0.021 ms in the Lua harness, under 0.5 ms target |
| Layout + scenery cache p95 | 0.549 ms at 48 rooms / 200×60, under 1 ms target |
| Release sandbox render p95 | 1.13 ms at 200×60 with 12 residents and mature rooms, under 3 ms target; observed runs varied 0.63–1.58 ms under local load |
| Pure rendering | 1,000 renders leave simulation hash unchanged |
| Viewport properties | 500 sizes from 60×16 through 240×70; no overlapping rooms or protected-centre painting; density ≤25% |
| Nine golden frames | 80×24, 120×35, 200×60 at 0/120/300 tools; 6.95–15% coverage at normal density |
| Three-hour synthetic recording | 1,273 events; year 3 after two compactions, 7 artifacts, 128 retained legends plus bounded summary counts |
| Busy foreground protocol smoke | Zero emitted cells on occupied cells or their one-cell halo; centre clear; pause, decisions, checkpoint and private-input filtering pass |
| Visual review | Seven modes inspected at 80×24; narrow announcements use complete compact labels, ASCII workers, dim semantic colours and a clear centre |

The tests exercise the simulation, real mlua sandbox, serialized Tattoy plugin
protocol and PTY compositor. The seeded fixtures contain synthetic subjects only.
Rendering and layout are separate from simulation decisions. Files are generated
explicitly and compared during the gate, not silently refreshed by a test.

## Four-pane wall-clock sample

`python3 scripts/bench.py 4 15 fortress`, sampled at 14 seconds, 200×60,
12 fps, 500-tool aggregate checkpoint, 12 residents. Each pane has an isolated
state directory. `ps` reports percent of one CPU core:

| Pane | sbg-fx CPU | sbg-fx RSS | Tattoy CPU | Tattoy RSS |
|---|---:|---:|---:|---:|
| 1 | 2.6% | 5,856 KiB | 5.0% | 40,416 KiB |
| 2 | 2.8% | 5,872 KiB | 5.0% | 38,320 KiB |
| 3 | 2.5% | 5,776 KiB | 4.7% | 40,592 KiB |
| 4 | 2.3% | 6,016 KiB | 4.2% | 39,600 KiB |

This is a short sample, not a long-term CPU guarantee. Tattoy is still the
compositor and its cost is additional to the effect process.

## Regression found during release checks

The previous smoke harness deleted a shared user Tattoy log. Concurrent gates
could erase each other's startup evidence and produce a false failure. Smoke
runs now isolate cache, state and logs in a temporary directory and close their
PTY descriptor; they no longer delete the user's log. The isolated smoke passed.

## Remaining evidence

- A three-hour **real-time** run in a physical terminal has not been performed.
- Five-minute physical kitty / zellij-in-kitty / Ghostty / WezTerm checks have
  not been performed; PTY smoke is not a substitute for that support matrix.
- Extended visual review at 200×60 and long-session narrative variety remain
  release review work. Generic caravan/incident templates can repeat; this run
  does not claim the T16 “no repeated line in 30 minutes” criterion.
- Optional milestone-only LLM flavour is not implemented or tested; Fortress
  uses deterministic templates and no paid calls.

The authoritative remaining work is MY-138 and MY-142 in Linear. Do not mark
those release gates Done based on this accelerated report.

## Reproduce

```sh
python3 scripts/check.py
cargo test --manifest-path plugins/Cargo.toml --release fortress_checkpoint -- --nocapture
lua scripts/world/replay.lua tests/fixtures/fortress/three-hour.lua --legends
python3 scripts/bench.py 4 15 fortress
# Repository root:
python3 scripts/plugins.py check
```

## M5 session titles and construction — follow-up validation

The working tree after `5e998c3` adds exact-session name polling, staged room
construction, five settlement ranks, a next-room meter and moving builders.
The changes are local and uncommitted. This follow-up does not close the
physical-terminal matrix or three-hour real-time release gates above.

- Full workspace gate: **1,702 tests passed** in 259.600 seconds. The session-bg
  gate includes 33 Rust tests and 114 Python tests, plus replay, stress, golden,
  protocol and Tattoy PTY checks.
- Name tests cover a live SQLite rename and name clearing, Claude transcript
  rename, partial metadata, exact-session isolation, safe fallback, manual
  override release, 24 concurrent hooks and launcher watcher shutdown.
- All nine updated goldens pass; normal-density coverage is 7.98–15%.
  Foreground/halo and protected-centre protocol checks pass at 80×24, 120×35
  and 200×60. Paused rename and resize preserve the checkpoint; resume does
  not duplicate a legend. Pausing a moving builder no longer changes position.
- The 100×10k replay and 100k-event stress gates pass. A separate release
  sandbox render check measured p95 **0.812 ms** at 200×60.
- In the current live pane, the new managed Fortress script loaded without an
  error record. A temporary display override changed through the running
  launcher watcher, returned to the automatic name, and preserved the paused
  world. The pane was returned to normal animation with automatic naming.
- The terminal smoke harness now explicitly permits Tattoy inside its own
  isolated PTY when invoked from an sbg-wrapped shell. Previously Tattoy's
  nesting guard prevented startup. State smoke also removes the inherited
  script selection before testing built-in effects.
- Both agents' installed hook scripts match this checkout at the mandated
  plugin version 1.0.0. Compatibility scripts were retained at the previous
  cache path after the first refresh exposed stale hook references.

Kitty visual inspection could not be performed: the computer-use tool refused
access to that app. Live state and protocol validation do not replace visual
review on the remaining physical-terminal matrix.

## Autonomous colony life — MY-163

The living-world follow-up adds resident routes and routines, a Conway garden,
day/night, weather, water, cats, lamps and campfires. Earned history remains in
the existing simulation; local ecology has a separate compact checkpoint.

- The final workspace gate passed **1,702 tests in 248.442 seconds**, including
  the extended session-bg gate and all other workspace projects.
- The new Lua life suite passed **2,882 assertions**: stable blocks, oscillating
  blinkers, a four-generation glider, isolated-cell death, frame-cadence
  equivalence, reload reconstruction, corrupt-record fallback, bounded long
  gaps, door-only routes, pause, resize and unchanged earned history.
- All nine reviewed goldens pass at **6.87–15%** normal coverage. The current
  site, garden, activity and weather remain visible at the target sizes.
- Real plugin protocol smoke passes at 80×24, 120×35 and 200×60, now including
  a script hot reload while paused: both the ecology checkpoint and earned
  world remain identical, then the life clock advances again on resume.
- A release sandbox sample measured **0.753 ms render p95** at 200×60. The
  existing 100×10k replay and 100k-event stress checks pass.
- Day and night render previews were visually inspected. A gardener covering
  the garden label was fixed, and lamps/campfires retain warm colour at night.
  A natural five-resident synthetic scene produced visible chatting at 154s.
- Managed local effects were backed up and refreshed. The current pane loaded
  the ecology without a script error, retained its settlement and session name,
  froze both world and life during pause, and resumed local time without any
  additional hook event. Original pause settings were restored.

An accelerated preview generated directly from the renderer shows a complete
120-second day in 15 seconds. It is a synthetic render, not a native terminal
screenshot. The physical terminal matrix and real-time three-hour soak are
still open; this follow-up does not claim those gates.

## Visible landscape follow-up — 2026-09-18

The user's screenshot showed faint edge rooms and an almost empty middle. The
new default uses that unused space for a brighter landscape, protected by the
existing foreground mask and one-cell halo. Trees, rocks, mushrooms, wheat,
flowers, a stream/pool, bridges, rabbits, butterflies and campfires accompany
resident routines. Gardens sit beside the buildings and rooms have furnishings.
Explicit compact mode retains a clear middle. Scenery does not earn progress.

`landscape.lua` caches seeded geometry and spatial reservations; whole plant
silhouettes survive density pruning. The reservation lookup avoids instruction
budget overruns at 419×87. `render.lua` shades the palette once per frame and
batches adjacent equal-colour glyphs through the existing native text API.
Forty-eight exact-cell/colour comparisons prove the batched and individual
paths agree. All nine reviewed goldens remain unchanged by those optimizations,
at 21.98–22% coverage before foreground masking (25% hard ceiling).

Final focused checks passed: 821,954 simulation/layout assertions, 5,237 life
assertions, 26 plaque checks, 1,843,961 adaptive assertions, 39,556 landscape
assertions, generated-bundle parity and all nine goldens. Real-protocol checks
passed through 419×87, with full-screen foreground masking, pause, compact/quiet
controls, live rename and checkpoint/hot-reload preservation. The smoke now
waits for an observed post-pause checkpoint write, avoiding an old race against
the one-second checkpoint flush interval; it also inspects runtime-error logs.

An earlier full workspace gate passed 1,702 reported tests in 630.059 seconds.
The final rerun, after text batching, reported one timing failure in the 114
Python checks: hook invocation took 122.4 ms against a 100 ms limit. An isolated
rerun also missed it at 117.9 ms. The final workspace run is **not fully green**.
The latest native 12-resident/8-incident render benchmark preserved history over
1,000 frames but measured p95 4.00 ms under machine load, above its 3 ms target.
An earlier, less-loaded sample before batching was 2.47 ms. MY-137 retains the
strict timing review; thresholds were not relaxed to hide these results.

Both managed effects and active panes received the update, retaining colony
identity, rooms, counters and ecology. Bundle SHA-256:
`142984e46094e464b0358883308a2e187128ec8c7ae04a55c4a7992c410b8cc2`.
A later synchronized host stall logged p95 876.9/947.8 ms and switched both panes
to builtin fallback without creating `error.json`. Re-selecting Fortress restored
it from saved state without restarting the terminal sessions. Fresh, advancing
Fortress checkpoints verified recovery. MY-166 tracks tolerance of transient
stalls, bounded automatic recovery and actual-runtime health reporting; absent
`error.json` or a matching source hash alone is insufficient evidence of health.

Session-bg 1.0.0 was force-refreshed and matches both agent caches. Current and
legacy 1.2.2 hook entry points were retained, byte-verified and invoked safely
outside a pane. The installer still reports the unrelated Qwen/Claude UNLINKED
row; session-bg itself is current. Source changes remain uncommitted.

Source-rendered previews, before/after comparison, a real-time animation sample,
generators and provenance are in `~/.cache/sbg/previews/visible-fortress-20260918/`.
They use fixed idle brightness 0.8 and opacity 0.6 for a consistent comparison,
with a synthetic foreground mask. They are not physical-terminal captures.
The physical matrix and real-time three-hour soak remain open. MY-158, MY-159
and MY-161 now contain concrete quest, guild and recap proposals; these later
features have not been implemented.


## 2026-09-18 — host recovery follow-up (MY-166)

The live fallback was traced to a single outlier becoming the p95 of a short
window. `plugins/src/health.rs` now requires three consecutive frames over 3×
the frame budget before performance fallback. Sustained moderate cost still
halves FPS. Fake-time tests cover isolated 900 ms stalls, repeated expensive
frames, moderate throttling, backoff and pause/disable.

The host distinguishes requested and active effects and retries with
5/10/20/40/60-second backoff; it resets after 30 healthy seconds. Hook/name
updates cannot bypass the cooldown, and idle recovery needs no event. User
selection cancels pending recovery; pause and disable suspend retries.
`runtime.json` records active/requested choices, heartbeat, reason and retry
at about 1 Hz. `sbg doctor` labels old heartbeats stale instead of inferring
health from the selected script.

Script failures count whole step/render pairs. A good half-frame no longer
erases a failed half or prevents fallback. Successful initialization alone
cannot replace the last proved source. Failed init restores a proved source
or requests host recovery. A healthy replacement clears the previous error
only after a complete frame.

Observed checks: 42 Rust tests pass; seven session-name tests and twelve CLI
state/control tests pass. `scripts/recovery-smoke.py` passed actual protocol
fault injection, error visibility, pause/disable, checkpoint/history retention,
idle retry after backoff and explicit builtin selection. The Fortress protocol
resize/foreground smoke also passed through 419×87. The new full workspace
check is running; append its result below rather than changing earlier results.

Tattoy 0.1.8 source at `b1af54b4bc6a1ec5288f865bb4af19f09facf286`
([loader](https://github.com/tattoy-org/tattoy/blob/tattoy-v0.1.8/crates/tattoy/src/loader.rs),
[plugin lifecycle](https://github.com/tattoy-org/tattoy/blob/tattoy-v0.1.8/crates/tattoy/src/tattoys/plugins.rs))
starts plugins once and has no plugin-only restart on config updates. No active
terminal was restarted or killed. The new binary is for the next session
launch; the earlier Lua landscape is already hot-loaded. Both legacy panes
had fresh advancing checkpoints after the last CLI recovery. An old host can
still hit its old fallback policy until relaunched; do not claim the Rust fix
is active in those processes.

Name helpers now load SQLite only for Codex metadata, and threading only for
the launcher-owned watcher. End-of-session cleanup includes runtime.json.
Session-bg 1.0.0 matches both live plugin caches; legacy 1.2.2 hook entrypoints
remain byte-verified and safely invoked. The forced workspace install still
returns the separate pre-existing Qwen/Claude UNLINKED warning.


A later observation caught another fallback in the idle legacy pane. The
selected Fortress was restored through the CLI, then a session-bound migration
helper (`scripts/legacy-recovery.py`) was started for each existing host. This
helper requires an exact legacy fallback log and stale checkpoint, retries by
touching only the selected override inode's mtime, honors pause/disable, and
backs off 5–60 seconds. It preserves settings bytes and event/checkpoint files.
It exits when its specific host PID/start-time disappears or runtime.json
appears; newly launched hosts do not need it. No terminal process was restarted.

Two helper boundary tests passed. An isolated protocol probe compiled the
original `5e998c3` host loop with the current Lua adapter/state modules as
`sbg-fx-legacy-probe`, induced a real fallback, repaired only the Lua source,
and proved the helper's mtime retry revived the idle script with identical
settings and a preserved checkpoint. Probe/provenance are retained with the
visual artifacts. This is a test of the old watcher/fallback loop, not a claim
that the old installed Rust process was hot-replaced. Fresh advancing
checkpoints were observed in both live panes afterward. The short sampling
record includes the earlier stalled interval and its CLI recovery; it is not
a three-hour soak.


Final full workspace gate: **PASS**, 1,705 reported tests in 731.583 seconds.
Catalog and all project checks passed, including session-bg's hook 100 ms
assertion, 42 Rust tests, 117 Python tests, protocol recovery, arbitrary-grid
Fortress smoke, Lua/property/replay/golden checks and Tattoy PTY smoke. The
saved gate output is `workspace-check-final.log` beside the visual artifacts.
This supersedes the earlier failed hook-latency gate. The separate strict
3 ms native renderer benchmark was not rerun or relaxed: its latest loaded
sample remains 4.00 ms, so MY-137 remains in Review. MY-166 remains in Review
for native-host adoption and the real-time soak, with a working migration
helper on each old live host. Final source is uncommitted after `5e998c3`.

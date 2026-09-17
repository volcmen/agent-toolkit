# Fortress validation — 2026-09-17

Branch: `feat/fortress-office`, in `agent-toolkit/session-bg`. This report
separates accelerated simulation from wall-clock terminal validation.

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

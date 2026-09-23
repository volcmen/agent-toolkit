# Native backend measurements — 2026-09-22

The active-output sample uses native text updates targeting 2 Hz, the same
200×60 office/seed/state, and a 6 fps target. Both effects remained healthy and
reported 6 fps with the revised CPU guard. The machine had substantial unrelated
load, so these sequential short samples are indicative, not a dedicated-host
capacity result. CPU, memory and emitted terminal bytes are all included here.

| Backend | CPU, one core | Median RSS | Terminal output |
|---|---:|---:|---:|
| Managed Tattoy + sbg-fx | 4.18% | 40.88 MiB | 232 bytes/s |
| Native Rust, in-process effects | 1.03% | 6.79 MiB | 381 bytes/s |

The native sample used about 75% less backend CPU and 83% less resident memory;
it emitted 149 additional terminal bytes/s. Target fps is a configured budget,
not proof that the OS delivered every frame on this loaded host. This sample
includes damage-aware clearing and the CPU guard; it predates the final Claude
incremental-style/save-slot fixes. Raw data:
[active-output sample](measurements/2026-09-22-active-output.json).

The guard's diagnostics captured a Tattoy effect render taking 626.24 ms elapsed
but only 4.14 ms of thread CPU. This supports excluding descheduling from the
effect CPU budget while retaining elapsed latency in reports. The native final
render in its sample used 1.81 ms CPU / 2.16 ms elapsed.

A separate native-only run targeting **12 fps** stayed healthy and measured
**1.23% of one core**, **6.72 MiB median RSS**, and **268 terminal bytes/s** over
30 seconds with the same 2 Hz update workload. This is short-run evidence for
the CPU target, not a completed sustained/physical terminal gate.
[Raw 12 fps sample](measurements/2026-09-22-native-12fps.json).

## Visible-animation follow-up

The user's next report exposed a missing check: the office could sit entirely
behind the TUI while the lower free area remained static. A healthy clock or
nonzero frame count was insufficient. The shared Lua scene now reserves the
office/captions and adds ambient grounds with at most 4% extra pane coverage.
At 80x24, 120x35 and 200x60, 117 of 119 half-second samples now change visible
glyphs below a synthetic top-half foreground, versus zero before. Reduced motion
keeps all 119 comparisons stationary. These are accelerated scene regressions,
not the outstanding uninterrupted physical observation gate.

The added motion costs rendering work. A 20-second native sample at 200x60,
target 12 fps and 2 Hz native updates measured **3.10% of one core**, **7.10 MiB
median RSS**, and **3,182 output bytes/s**. It stayed healthy at the configured
12 fps. This is slightly above the 3% target; it does not establish the sustained
performance gate. The earlier tables describe the older, less active scene.
[Raw visibility-fix sample](measurements/2026-09-22-visible-animation.json).

The full workspace gate subsequently passed 1,721 tests (787.373 seconds),
including all project suites. The generated bundles were hot-reloaded into the
active panes with checkpoints preserved and no new script errors.

Final unsent headless TUI probes observed **52 changed lower-body glyphs in Claude**
and **128 in Codex** across 2.1 seconds, with one input marker in each. Codex
retained 306 shaded spaces. Backend CPU was 0.335 s / 17.77 s in Claude (~1.89%
core) and 0.562 s / 26.23 s in Codex (~2.14%). These fixtures do not replace
physical kitty/zellij verification. Metrics: [Claude](measurements/2026-09-22-claude-animation.json),
[Codex](measurements/2026-09-22-codex-animation.json).

## Studio — 2026-09-23

The Studio replaced the office as the default scene. Every number below comes
from the same loaded host (load average 6–21 on 10 cores). They are short
samples, not the sustained soak.

**Release render.** `cargo test --release studio_busy_frame_budget -- --nocapture`
times one scripted session at 200×60. The session is busy at T5: 700 tools, 3
contractors and a 64-event recent window, drawing 773 glyphs and 12 crew. Its
elapsed p95 was 2.08–2.95 ms in four repository runs at load 12–14, under the
3 ms budget. A copy timed with thread CPU measured p50 1.40–1.42 ms and p95
1.97–2.01 ms.

**Glyph memo.** Before this fix the same test measured CPU p50 1.80 ms and p95
2.32–2.35 ms. At load 19 its elapsed p95 of 5.31 ms failed the budget.
Profiling showed the HUD re-splitting its dozen strings into code points every
frame. `glyphs.lua` now memoises that pure split, bounded to 512 strings, and
`Glyphs.chars` still returns a fresh copy. In standalone Lua this cut the HUD
from 0.36 to 0.11 ms per frame and the whole render from 1.13 to 0.82 ms.

**Sustained CPU (`bench.py`).** `python3 scripts/bench.py 4 15 fortress` runs the
Studio default with a v1 journey through managed Tattoy. The script now sets
`TATTOY_NEST=allow` like the other Tattoy harnesses; without it, inside a
Tattoy pane, it sampled only exited processes. sbg-fx measured:

| Build | Samples, % of one core (`ps %CPU`) |
|---|---|
| With the memo | 1.6–1.9, 1.8–1.9, 1.70, 2.50 (means per run) |
| Without the memo | 3.15 (load 15), 2.50, 2.78 |

Every memo sample is within the 3% target.

**Backend comparison (`bench-backends.py`, 12 fps, 30 s):**

| Workload | Backend | CPU, one core | Median RSS | Terminal output |
|---|---|---:|---:|---:|
| updates | Native Rust | 0.93% | 6.11 MiB | 722 bytes/s |
| updates | Tattoy + sbg-fx | 4.26% | 48.82 MiB | 1,290 bytes/s |
| busy | Native Rust | 2.03% | 6.43 MiB | 2,691 bytes/s |
| busy | Tattoy + sbg-fx | 80.92%, 74.84% | 80.53 MiB | 4,617 bytes/s |

The office's last native sample on the updates workload at 12 fps measured
3.10%.

Tattoy itself dominates the busy Tattoy figure. Over one 27-second window,
Tattoy used 19.88 s of CPU (73.6% of one core) and its sbg-fx 0.71 s (2.6%).
No earlier busy baseline exists. Raw data:
[updates](measurements/2026-09-23-studio-updates.json),
[busy](measurements/2026-09-23-studio-busy.json).

**Settlement.** The settlement, now `scene=settlement`, still misses its 3 ms
release budget. `fortress_checkpoint` measured CPU p95 3.6–4.1 ms with 2,640
glyphs. An interleaved A/B showed the memo is neutral there (p95 3.72/4.06 ms
with it, 3.95/4.02 ms without); see [soak.md](../fortress/soak.md).

## Initial quiet baseline

Initial controlled quiet run, macOS arm64, 200×60 cells, the same office Lua
bundle/seed/state and 6 fps. Samples cover 30 seconds after three seconds of
startup. CPU is the process CPU-time delta divided by elapsed time, expressed
as a percentage of one core. Tattoy includes its separate effect process; the
native application is excluded from both measurements.
Raw data: [initial quiet sample](measurements/2026-09-22-initial-quiet.json).

| Backend | CPU, one core | Median RSS | Terminal output |
|---|---:|---:|---:|
| Managed Tattoy + sbg-fx | 3.09% | 46.78 MiB | 318 bytes/s |
| Native Rust, in-process effects | 1.40% | 6.67 MiB | 182 bytes/s |

This initial sample indicates about 55% less backend CPU work and 86% less
resident memory on this quiet workload. It is a short observation, not a
universal speedup or a prediction for every terminal/application. Both hosts
reported 6 fps and a healthy script. The native renderer subsequently gained
damage-aware clearing and a resource heartbeat; rerun the command below when
evaluating a new checkout.

Final headless startup/typing/paste probes (current native code) preserved one
copy of each unsent marker and emitted background diffs:

| App | Elapsed | Backend CPU time | Peak RSS | Background/erase diffs |
|---|---:|---:|---:|---:|
| Codex 0.155.1 | 23.94 s | 0.244 s (~1.02% core) | 5.02 MiB | 247 |
| Claude 2.1.278 | 15.21 s | 0.147 s (~0.96% core) | 5.33 MiB | 18 |

Codex retained 309 shaded spaces. No prompt was submitted. These are headless
startup observations using the same observer library, not sustained working
sessions, independent emulator parity, or a Tattoy comparison. Raw metrics:
[Codex](measurements/2026-09-22-codex-startup.json),
[Claude](measurements/2026-09-22-claude-startup.json).

The first 2 Hz native-output implementation emitted too much decoration because
it erased the entire office before every update. It was replaced with affected-cell
clearing: a regression now verifies that 100 updates to a separate row emit zero
background erase bytes. Scrolling and incomplete protocols retain full erasure.

Later samples on both backends were rejected because the shared effect guard throttled
to 3 fps or fell back to a builtin while unrelated builds and applications loaded
the machine. They are not usable comparative performance evidence. The benchmark
now rejects changed fps/fallback rather than crediting reduced animation as a
speed improvement. No sustained busy-output comparison is claimed from those runs.

Those failures also motivated separating render-thread CPU cost from elapsed
time in the shared guard. macOS/Linux now charge CPU time against the unchanged
thresholds; runtime diagnostics retain both values. Descheduling alone should
not restart a healthy effect. The initial quiet table predates this refinement;
the healthy final active sample above includes it.

Reproduce with isolated synthetic children, without starting an AI session:

```sh
python3 scripts/bench-backends.py --seconds 30 --workload quiet --output /tmp/sbg-quiet.json
python3 scripts/bench-backends.py --seconds 30 --workload updates --output /tmp/sbg-updates.json
python3 scripts/bench-backends.py --seconds 30 --workload busy --output /tmp/sbg-busy.json
```

Run sequentially without concurrent builds. The harness samples CPU time rather
than `ps %CPU`, includes both Tattoy processes, uses fresh pane state, drains the
outer PTY, records output bytes and rejects unhealthy effects. It only terminates
its own fixtures. `--backends own` runs the native side alone.

For a live native session, `sbg doctor` reports the latest CPU sample, peak RSS,
renderer p95 and skipped painting opportunities. These counters are also in
`sbg state --json` under `backend`. Skipped opportunities do not mean lost input
or native output. Simulation and health ticks continue during busy output.

Remaining gates: independent repeated samples at common viewport sizes,
long-running busy and quiet sessions, physical kitty/zellij validation, and
reflow/resize parity before changing the default. See [parity.md](parity.md).

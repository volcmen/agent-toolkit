# Fortress implementation and agent handoff

Linear owns task state: [session-bg](https://linear.app/my-perosnnal/project/session-bg-930b20f0f536).
Do not duplicate changing task status here. The project has native M0–M4
milestones and issue dependencies. Work in the `agent-toolkit` repository,
`session-bg/` directory. This implementation is on `feat/fortress-office`.

| Deliverable | Linear | Source / verification |
|---|---|---|
| Meaning and safety contract | MY-127 | `notes/fortress/design.md`; exact signals, worked timelines, unused fields |
| Glyphs and visual vocabulary | MY-128 | `plugin/skills/bg/references/fortress-glyphs.md`; nine goldens |
| Ordered private event feed | MY-129 | `plugin/scripts/sbg_state.py`; hook concurrency, schema, migration and secret fixtures |
| Replay clock and PRNG | MY-130 | `plugins/fx/fortress/sim.lua`; 100 × 10k replay, batches 1/7/64 |
| Bounded entities | MY-131 | `sim.lua`; 100k-event cap checks and snapshot continuation |
| Jobs, practice and needs | MY-132 | `sim.lua`; skill milestones, expiry, stress recovery |
| Story arcs | MY-133 | `sim.lua`; arrivals, caravans, neutral mandates, escalation and timeout |
| Seasons and chapters | MY-134 | `sim.lua`, `render.lua`; exact season edges and two-compaction fixture |
| Edge districts | MY-135 | `render.lua`; 500 random viewports, no overlaps or centre intersection |
| Density budget | MY-136 | `render.lua`; 25% ceiling, 7–15% normal goldens, cached scenery |
| Animated workers | MY-137 | `render.lua`; seven-mode contact-sheet review and pure-render hash test |
| Foreground and glyph safety | MY-138 | `frame.rs`, `api.rs`; real-protocol busy foreground smoke; physical terminal matrix remains |
| Bounded legends | MY-139 | `sim.lua`, host checkpoint, `sbg legends`; exact eviction counts and arc references |
| Artifacts | MY-140 | `sim.lua`; skilled eligibility, 25-minute completion cooldown and genealogy |
| Controls | MY-141 | `bin/sbg`, `state.rs`, `/bg`; name, pause, profiles and legends |
| Release validation / progression | MY-142 | `notes/fortress/soak.md`; real-time 3h soak and optional director extension remain |

## Agent execution contract

1. Read the latest Linear issue and dependency evidence. Select one observable
   outcome, preserve unrelated changes, and update the existing issue.
2. Edit `fortress/{sim,render,adapter}.lua`, then run
   `python3 scripts/world/bundle.py`. Never hand-edit generated `office.lua`,
   `fortress.lua` or `world.lua`.
3. Keep simulation history independent of render cadence, viewport and cosmetic
   RNG. Prove any event changes with batch replay and checkpoint continuation.
4. Use synthetic inputs. Do not log prompts, tool results, paths or credentials
   into fixture recordings or legends. No paid model runs are needed for checks.
5. Run `python3 scripts/check.py`. It includes Rust checks, Python boundaries,
   real protocol smoke, Lua replay/caps/layout, goldens and Tattoy PTY smoke.
   From the repository root run `python3 scripts/plugins.py check` for release.
6. Goldens only change via `lua scripts/world/golden.lua --write` after visual
   inspection. Check release timing with
   `cargo test --manifest-path plugins/Cargo.toml --release fortress_checkpoint -- --nocapture`.
7. Close issues only with observed acceptance evidence. A simulated three-hour
   timeline is not a three-hour real-time terminal soak.

## Remaining release gates

- Run at least five minutes in real kitty, zellij in kitty, Ghostty and WezTerm;
  capture alignment, foreground safety, resize, readability and input parity.
  Existing tests exercise Tattoy in a PTY, not those physical terminal surfaces.
- Run the three-hour real-time soak and record CPU/RSS throughout. The committed
  fixture covers three simulated hours and the stress test 100,000 events.
- Validate long-session announcement variety and progression. Presentation uses
  a bounded priority queue, four-second slots, routine throttling and compact
  edge labels; the full text remains in `sbg legends`.
- Optional later work: milestone-only director lines with persisted event-hash
  caching and deterministic fallback. It is not required to run Fortress; the
  existing director remains opt-in. Do not spend tokens as part of validation.
- Own compositor work (MY-126 / MY-143–153) remains separate. Keep Tattoy as the
  current backend until terminal conformance and performance gates are met.

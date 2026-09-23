# Fortress implementation and agent handoff

Linear owns task state: [session-bg](https://linear.app/my-perosnnal/project/session-bg-930b20f0f536).
Do not duplicate changing task status here. The project has native M0–M5
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
| Density budget | MY-136 | `render.lua`; 25% ceiling, 22% default target (15% compact), cached scenery |
| Animated workers and visible landscape | MY-137 | `render.lua`, `landscape.lua`; seven-mode review, fresh-session coverage, foreground masking and pure-render hash test |
| Foreground and glyph safety | MY-138 | `frame.rs`, `api.rs`; real-protocol busy foreground smoke; physical terminal matrix remains |
| Bounded legends | MY-139 | `sim.lua`, host checkpoint, `sbg legends`; exact eviction counts and arc references |
| Artifacts | MY-140 | `sim.lua`; skilled eligibility, 25-minute completion cooldown and genealogy |
| Controls | MY-141 | `bin/sbg`, `state.rs`, `/bg`; name, pause, profiles and legends |
| Release validation / progression | MY-142 | `notes/fortress/soak.md`; real-time 3h soak and optional director extension remain |
| Live session title | [MY-156](https://linear.app/my-perosnnal/issue/MY-156) | `plugin/scripts/sbg_name.py`; exact-session metadata, rename polling, concurrent hooks and watcher shutdown |
| Earned construction and ranks | [MY-157](https://linear.app/my-perosnnal/issue/MY-157) | `sim.lua`, `render.lua`; staged rooms, moving builders, progress HUD and bounded milestone legends |
| Opt-in quest board | [MY-158](https://linear.app/my-perosnnal/issue/MY-158) | Follow-up: observable event milestones and persistent completion |
| Guild mastery | [MY-159](https://linear.app/my-perosnnal/issue/MY-159) | Follow-up: visible specialization and earned badges |
| Adaptive layout and motion controls | [MY-160](https://linear.app/my-perosnnal/issue/MY-160) | `render.lua`, `plaque.lua`, `state.rs`; fluid room packing, compact HUD, reduced motion; `scripts/world/tests/presentation.lua` and protocol resize smoke |
| Chapter recap | [MY-161](https://linear.app/my-perosnnal/issue/MY-161) | Follow-up: earned buildings, milestones and next unlock |
| Autonomous colony life | [MY-163](https://linear.app/my-perosnnal/issue/MY-163) | `life.lua`, `render.lua`; daily routines, Conway garden, weather, routes and checkpointed local time |
| Fortress default and live HUD | [MY-164](https://linear.app/my-perosnnal/issue/MY-164) | `plugins/fx/fortress/plaque.lua`, `render.lua`, `state.rs` (`branch`); Fortress-only `world.lua`, mode label, meter, progress line, milestone toasts; `scripts/world/tests/plaque.lua` |
| Recovery after host stalls | [MY-166](https://linear.app/my-perosnnal/issue/MY-166) | `plugins/src/health.rs`, `main.rs`; consecutive-frame guard, bounded idle retries, runtime heartbeat; `scripts/recovery-smoke.py` checks history, pause/disable and selection |
| Idle-office contract | [MY-167](https://linear.app/my-perosnnal/issue/MY-167) | `notes/fortress/office.md`; visibility finding, clocks, chains, events, presentation forms; `lua scripts/world/office-preview.lua` regenerates the annotated 80×24 / 120×35 / 200×60 concept frames under `~/.cache/sbg/previews/` |
| Office jobs, events and consequences | [MY-170](https://linear.app/my-perosnnal/issue/MY-170) | `plugins/fx/fortress/office.lua`; `scripts/world/tests/office.lua` proves batching determinism, restore idempotence, beat ranges, reservations, causality, cooldowns, anti-repetition, interruption, alternate runs |
| Three-room office and compact strip | [MY-169](https://linear.app/my-perosnnal/issue/MY-169) | office view in `render.lua`/`officeview.lua`; `scripts/world/tests/officeview.lua`; `tests/golden/office/` |
| Session sign and founder marker | [MY-168](https://linear.app/my-perosnnal/issue/MY-168) | office view sign over the Studio door, plaque rows keep the full title |
| Readable intentions and consequences | [MY-173](https://linear.app/my-perosnnal/issue/MY-173) | captions, whiteboard marks, prop states; occlusion checks in `officeview.lua` and `fortress-smoke.py` |
| Whiteboard project board | [MY-158](https://linear.app/my-perosnnal/issue/MY-158) | `office:scene().board_title/board_marks`; rendered in the Studio |
| Prototype-bench renovation | [MY-171](https://linear.app/my-perosnnal/issue/MY-171) | `office.lua` renovation chain; bench changes later fetch/assemble stations; restore keeps it |
| First playable observation gate | [MY-174](https://linear.app/my-perosnnal/issue/MY-174) | 45-minute real-time observation remains; accelerated tests do not substitute |
| Codex panel backgrounds | [MY-175](https://linear.app/my-perosnnal/issue/MY-175) | `patches/tattoy-0.1.8-compat.patch`, `scripts/build-tattoy.py`, `scripts/color-smoke.py`; native color replies, protected colored spaces, verified managed backend |
| Batched input and paste | [MY-176](https://linear.app/my-perosnnal/issue/MY-176) | Compatibility patch and `scripts/input-smoke.py`; exact input bytes, bounded queue, shortcut/paste separation, 50 KiB real PTY fixture |

## M6 — Studio

The idle office rows above are superseded (MY-174 verdict "revise",
2026-09-23); MY-196 removed the office code, tests and goldens. Contract:
[../studio/prd.md](../studio/prd.md); epic
[MY-188](https://linear.app/my-perosnnal/issue/MY-188).

| Deliverable | Linear | Source / verification |
|---|---|---|
| Host glyph gate | [MY-189](https://linear.app/my-perosnnal/issue/MY-189) | `frame.rs`; `accepted_glyphs_are_single_cell` |
| Effort end-to-end | [MY-190](https://linear.app/my-perosnnal/issue/MY-190) | `claude-core/statusline.py`, `state.rs`, `script.rs` |
| Codepoint-aware text | [MY-191](https://linear.app/my-perosnnal/issue/MY-191) | `fortress/glyphs.lua`; `scripts/world/tests/glyphs.lua`; settlement goldens unchanged |
| Tower layout | [MY-192](https://linear.app/my-perosnnal/issue/MY-192) | `fortress/studioview.lua`; `scripts/world/tests/studioview.lua` |
| Studio HUD | [MY-193](https://linear.app/my-perosnnal/issue/MY-193) | `studioview.lua`, `plaque.lua` |
| Crew planner | [MY-194](https://linear.app/my-perosnnal/issue/MY-194) | `fortress/studio.lua`; `scripts/world/tests/studio.lua` |
| Crew rendering and adapter | [MY-195](https://linear.app/my-perosnnal/issue/MY-195) | `studioview.lua`, `adapter.lua`; `tests/golden/studio/` |
| Studio default, office removed | [MY-196](https://linear.app/my-perosnnal/issue/MY-196) | `state.rs`, `bin/sbg`, `fortress-smoke.py` |
| Performance gate and observation | [MY-197](https://linear.app/my-perosnnal/issue/MY-197) | `studio_busy_frame_budget`, `scripts/bench.py` |

## Agent execution contract

1. Read the latest Linear issue and dependency evidence. Select one observable
   outcome, preserve unrelated changes, and update the existing issue.
2. Edit `fortress/{glyphs,sim,life,plaque,landscape,studioview,studio,render,adapter}.lua`, then run
   `python3 scripts/world/bundle.py`. Never hand-edit generated
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

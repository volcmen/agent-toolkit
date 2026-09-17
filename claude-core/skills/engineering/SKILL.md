---
name: engineering
description: Use for any non-trivial engineering task — implementing a feature, fixing a bug, refactoring, designing a change, debugging a failure or test, or reviewing my own change before handoff. Routes the work through shape → build → verify → ship and loads only the reference for the live phase. Not for trivial lookups or prose-only requests.
---

# Engineering

One skill, four phases. Read the reference for the phase you are in; skip the
rest. `CLAUDE.md` invariants apply throughout and are not repeated here.

| Phase | Load when | Reference |
|---|---|---|
| Shape | the request is vague, symptom-based, conflicting, solution-first, or crosses components | `references/shaping.md` |
| Build | about to write or change code | `references/minimalism.md` |
| Build — a failure | any bug, failing test, unexpected behavior, before proposing a fix | `references/debugging.md` |
| Verify | about to say done, fixed, passing, or before a commit | `references/verification.md` |
| Ship | worktree, branch, MR, tracking, merge, handoff | `references/delivery.md` |
| Any phase — ongoing tasks and personal follow-up | Linear intake, next actions, blockers, handoff | `references/tracking.md` |
| Any phase — a second model would help | codex-pair, `/codex:rescue`, ChatGPT | `references/second-opinion.md` |
| Any phase — text a human will read | Slack, Jira, MR text, review, email, docs | `references/writing.md` |

## Proportionality

Work directly when the change is clear and its diff fits one sentence. Enter
plan mode when the approach is materially uncertain, the code is unfamiliar,
the change crosses components, or failure is costly. Shape inline; use
`Explore` for one bounded repository question only when isolated context saves
meaningful main-thread context, and keep tightly coupled phases in the main
thread. Specify a model on every agent call; the controller prompt holds the
routing.

## Report

Lead with the outcome, then the key decision, the main changes, the checks you
observed, and the remaining risk. A failed or skipped check is named, never
implied away.

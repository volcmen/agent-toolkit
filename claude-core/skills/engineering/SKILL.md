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

## Recurring work

The phase tells you how to work; this tells you what a request is made of.

| Request | Collect | Deliverable |
|---|---|---|
| Prepare a ticket for development | the ticket, the workspace map, the owning repositories, their tests | the affected repositories, the change plan, the open questions |
| Investigate a failure or incident | the symptom, logs, the code path, runtime state, the data | the cause, or the hypotheses that would separate it, each with its check |
| Land a change | the ticket, the owning repository, the tests that already cover it | the change, the checks observed, commit and MR once authorised |
| Answer a question about the system or its data | repository documentation, code, read-only queries | the answer and the evidence it rests on |
| Verify a deploy or release | the pipeline, the deploy, the running version, errors, service state | the version actually running and the deviations found |

Before changing anything in a cross-repository task, name the repositories it
touches, the link between their merge requests, and the order they merge in.

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

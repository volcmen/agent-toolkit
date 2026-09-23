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
| Ship | worktree, branch, MR, review feedback, tracking, merge, handoff, peer sessions | `references/delivery.md` |
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
the change crosses components, or failure is costly. Shape inline and keep
tightly coupled phases in the main thread.

## Delegation

Delegate only when isolated context, scoped tools, or an independent view
saves more than the brief costs. Every brief carries one objective, the
relevant paths and constraints, ownership, the expected output, and its
verification, sized to finish well inside one context window; split long work
into sequential slices. Parallelize only when writes cannot overlap. Worker
results are evidence, not authority: read the diff and the reported check
output before relying on them.

- `Explore` on Sonnet: one bounded read-only repository question → a compact
  report.
- `worker` on Sonnet: one bounded implementation, fix, test, or analysis slice
  → changed files and observed checks.
- `reviewer` on Opus 5.5: one completed diff, MR head, or set of review
  comments → evidenced findings and coverage gaps; `mr-preflight` and review
  feedback use it.
- `general-purpose` only when a slice needs web, MCP, or skills.

These agents pin their own model: omit `model` for them, except to escalate a
`worker`. The per-call `opus` alias resolves to an older Opus, so a review that
needs the strongest model goes to `reviewer`. Built-in agents always get a
`model`; never rely on model inheritance and keep `CLAUDE_CODE_SUBAGENT_MODEL`
unset:

- `sonnet` — default worker for analysis, exploration, implementation, tests,
  debugging, and research; pass `sonnet` explicitly when dispatching built-in
  agents. Reviews go to `reviewer`, never a built-in agent.
- `haiku` — only mechanical, low-risk, non-code lookups you will re-check.
- `opus` — architecture or public-interface trade-offs, security, concurrency,
  data integrity, or subtle correctness; escalate because the decision is
  difficult or high-risk.
- `fable` — never dispatch it as a worker.

## Report

Lead with the outcome, then the key decision, the main changes, the checks you
observed, and the remaining risk. A failed or skipped check is named, never
implied away.

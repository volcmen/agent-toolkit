# DDR-0008: Routing is graded against a fixture, and low confidence parks the card

- Status: accepted
- Date: 2026-07-29

## Context

Eight realistic tickets were run through real triage to check whether role
routing actually works. Five landed correctly. The three failures shared a shape:

| Ticket | Landed on | Should have been | Confidence |
|---|---|---|---|
| "review MR !442 before we merge it" | `backend` | `reviewer` | 0.92 |
| "compare Temporal vs Airflow, recommend one" | `devops` | `researcher` | 0.74 |
| "security review of the SSO integration" (in a fanout) | `generalist` | `reviewer` | 0.93 |

Every miss sent a card whose deliverable is a *judgement* to a role that *writes
code*, confidently. `read_only: true` on `reviewer`/`researcher`/`designer` is
what applies `codex -s read-only` and Claude's tool allowlist, so the failure mode
was not merely cosmetic: it removed the sandbox. And the failures were biased in
one direction — toward more privilege, never less.

Two causes, neither of them the model's fault:

- The triage prompt said "research before implementation, review after it, docs
  last", which reads as *review is a graph stage*. A standalone review card looked
  illegitimate; the rationale for the `backend` misroute said exactly that: "no
  separate implementation requested."
- The descriptions lacked the vocabulary a real ticket uses — MR, PR, diff, audit,
  "X vs Y", "recommend" — so domain words ("payments", "orchestration") won.

Separately, a ninth ticket ("make the app better") scored 0.42 and was promoted
straight to `ready`. `--min-confidence` only decided whether to escalate to the
next provider; a low-confidence plan from the *last* provider was applied as-is.
The docs told the human that below 0.6 means "too vague to route", and nothing
enforced it — `ab daemon` would have spent a worker run on it unattended.

## Decision

**Routing is measured, not assumed.** `evals/routing.json` holds nine tickets
written the way a human files them, each with the role that must own it, whether a
read-only role is required, and what the pre-fix behaviour was.
`bun run eval:routing` replays them through real triage on a throwaway board and
scores the result. It is not part of `bun run check` because it spends one triage
call per ticket. Result after the fix: **9/9**, up from 5/8.

**Descriptions carry trigger vocabulary, and implementers name the owner.**
`reviewer` and `researcher` now lead with the deliverable ("judges code someone
else already wrote", "answers an open question from sources") and list the phrases
tickets actually contain. `backend` and `devops` explicitly disclaim judgement
work. The triage prompt now tells the model to decide what the *deliverable* is
before looking at subject matter, and states that a standalone review, audit, or
research card is complete on its own.

**Below `triageMinConfidence` (default 0.6) the card parks.** The plan is written
onto the card as a readable proposal, no children are created, the card goes to
`blocked` with the score in its reason, and nothing dispatches until a human
sharpens it and sends it back to triage. Escalation bar and apply bar are the same
number.

**`roster()` may clip a description but never drop a role.** This one was found by
the eval: the sharpened descriptions overflowed the old 1400-char budget, which
truncated the alphabetical tail, so `researcher` and `reviewer` vanished from the
prompt entirely. `asPlan` then remapped the unknown names to the fallback role and
*every* judgement card landed on `generalist` — a worse result than the bug being
fixed, with correct descriptions on disk. Unknown role names are now reported on
the outcome and surfaced by `ab triage`.

## Consequences

- Editing a `description:` is a graded change: run `bun run eval:routing`. A
  fixture entry records what regressed and why, so the reason survives.
- `bun run check` stays free and offline. Routing quality needs a paid run, so it
  is a separate, explicit command.
- A vague ticket now costs one triage call instead of one triage call plus a
  worker run, and the human sees the model's proposal rather than a guess already
  in flight. The cost is a card that stops instead of proceeding, which is the
  intended trade.
- `ab roles` exits nonzero and explains a rejected `SOUL.md`, and `ab roles
  --reseed` restores the shipped souls — an upgrade that sharpens descriptions can
  now actually reach an existing board.
- Role `budget_usd`/`max_turns` now also reach single-card triage results, not
  only fanout children; a capped role was previously getting the full per-card
  ceiling whenever triage did not split.

## Alternatives

- **Hard-code a routing rule** (`/\b(MR|PR|review)\b/ → reviewer`). Fast and
  testable offline, but it fights the model instead of informing it, and every
  phrasing it misses fails silently. The descriptions are the documented
  extension point; users write their own roles there.
- **Accept low confidence and let the worker discover the problem.** That is what
  the code did. It spends a metered run to learn what a 0.42 score already said.
- **Block instead of park, with no proposal.** Loses the model's work and gives
  the human nothing to react to; the proposal is the cheapest part of the call.
- **Grade routing in `bun run check`.** Would make the gate cost money and depend
  on provider availability, and CI would fail for reasons unrelated to the diff.

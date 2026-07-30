# DDR-0004: Children inherit handoffs and goal ancestry, never transcripts

- Status: accepted
- Date: 2026-07-27

## Context

The naive way to give a downstream card context is to paste the upstream worker's
output into it. That makes a graph cost quadratically: card 5 carries the output
of cards 1-4, card 6 carries 1-5. It is also the main way an "autonomous" board
quietly becomes unaffordable.

The opposite failure is a card three levels deep that has no idea what the
original goal was, and re-derives or contradicts it.

## Decision

Two bounded mechanisms, both assembled in `src/context.ts`:

1. **HANDOFF** — every worker is instructed to end with at most 6 short lines:
   what changed, where, what the next card needs. That block is stored on the card
   and is the *only* thing children receive from a parent (clipped to
   `context.handoffChars`, default 800). Parsing tolerates the literal `\n` that
   models sometimes emit.
2. **Goal ancestry** (from Paperclip) — the chain of ancestor card titles up to
   the root goal, clipped to `context.ancestryChars` (default 1200). A worker
   knows the mission in ~5 lines instead of a pasted brief.

Every other part of the prompt is capped too: body 4000 chars, at most 6 parents.
The role soul goes first so provider prefix caching can hit across cards.

`BLOCKED: <reason>` is the symmetric mechanism for stopping: it parks the card
with a one-line reason and clears the failure counter, because an honest stop is
not a failure.

## Consequences

- Graph cost grows linearly with cards, not quadratically.
- A card's full prompt is inspectable before spending anything: `ab plan <id>`
  prints the exact system + user text and an approximate token count.
- Information is genuinely lost between cards — a handoff cannot carry
  everything. That is the intended trade: if a child needs more, the parent's log
  is on disk and `ab attach` reopens the actual session.

## Alternatives

- **Pass full transcripts**: correct in principle, quadratic in practice.
- **Shared scratch file the workers append to**: unbounded growth with no owner,
  and it invites two workers to write the same file concurrently.
- **Summarise the parent with another model call**: an extra billed call per edge
  when the worker can produce the summary for free as its last act.

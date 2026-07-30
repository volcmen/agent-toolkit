# DDR-0003: Budget is a gate, not a report

- Status: accepted
- Date: 2026-07-27

## Context

An autonomous board's failure mode is not only a wrong answer; it can also be a
loop that spends a provider allowance unattended. A consecutive-failure breaker
does not cap successful but expensive runs, while report-only budgets arrive
after the spend has happened.

## Decision

Two admission ceilings, enforced by an atomic SQLite reservation **before**
every metered model call:

- `budget.perCardUsd` (default $1.50), overridable per card via `budget_usd:`
- `budget.perDayUsd` (default $10) across one board's UTC ledger day
- plus `budget.perCardTurns` (default 24) as a turn cap passed to the runner
- `budget.perRunReserveUsd` (default $1.50) as the configured worker worst case;
  triage reserves the sum of provider `maxUsd` values

A breach **parks the card** (`blocked` + the reason) instead of retrying. Cost and
tokens are ledgered per card and per kind (`triage:codex`, `run:claude`, …), so
`ab stats` attributes spend rather than just totalling it.

Subscription-billed and unknown-price runtimes may report $0 but real tokens;
both are recorded. This is not a provider-side kill switch: if actual spend can
exceed the configured reservation, the board only learns that after completion.
The exact ledger remains available through `ab stats`; it is omitted from the
primary dashboard because it is an operational admission safeguard, not
authoritative daily billing or useful board-level status.

## Consequences

- Concurrent dispatchers cannot reserve known worst-case metered spend beyond a
  card or day ceiling.
- Provider-side account limits remain necessary for a true monetary stop on
  subscription/unknown-price runtimes or misconfigured worst-case amounts.
- Cost attribution answers "what did the board spend today, on what" without a
  provider dashboard.
- Reservations are only as good as their configured worst case and reported
  actual cost. Codex reports tokens but not price,
  so a codex-only board's usd total reads $0 — the token column is the honest
  signal there, and the price table in `budget.ts` covers the metered models.

## Alternatives

- **Report-only budgets**: visible after the fact, useless at 3am. Rejected.
- **Breaker only**: catches crash loops, not expensive success loops.
- **Provider-side limits**: correct but coarse — they fail the whole seat rather
  than the one misbehaving card.

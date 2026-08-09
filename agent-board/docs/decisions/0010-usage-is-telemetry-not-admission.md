# DDR-0010: Usage is telemetry, not admission

- Status: accepted
- Date: 2026-07-30

## Context

The original board tried to enforce guessed per-card and per-day dollar limits
by reserving worst-case spend before model calls. That mechanism was misleading:
subscription runtimes often report no dollar price, estimates were not provider
kill switches, and valid work could be parked because of a local accounting
guess.

## Decision

Dollar-based admission is removed. Dispatch eligibility depends on atomic
concurrency capacity, per-role capacity, dependency state, ownership, and a
current valid card snapshot.

Tokens and provider-reported dollars remain in the SQLite ledger and are exposed
by `ab stats` and card history. They are post-run telemetry only and never block
triage or execution.

The execution controls that remain are explicit and enforceable: concurrency,
per-role concurrency, timeouts, stale-worker recovery, failure breakers, bounded
context, and the `maxTurns` value supported by Claude.

## Consequences

- A local dollar counter can no longer stop unrelated valid cards.
- Board behavior no longer depends on incomplete or guessed pricing data.
- Existing board files containing the former money fields continue to load; the
  loader discards those fields and preserves the old turn setting as `maxTurns`.
- Provider-side account controls remain the correct place for a true monetary
  stop.

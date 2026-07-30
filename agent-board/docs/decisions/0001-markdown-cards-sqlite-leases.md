# DDR-0001: Cards are markdown, leases are SQLite

- Status: accepted
- Date: 2026-07-27

## Context

A SQLite-only board makes atomic claiming straightforward but keeps the work
opaque: a card cannot be read in an editor, diffed in git, or hand-fixed when a
model writes a bad spec. The opposite extreme (`kanban-md`) keeps everything in
markdown and pays for it with cooperative locking that can race, plus an awkward
home for a cost ledger.

## Decision

Split by mutability:

- **Cards are markdown** under `board/cards/*.md` — frontmatter is the contract,
  the body is the spec. Written atomically (temp file + rename). This is the
  source of truth; hand edits win and a test asserts that.
- **Leases and accounting are SQLite** at `board/.state/board.db` — claims,
  heartbeats, run history, failure counters, cost/token ledger. Gitignored,
  derived, safe to delete.

The claim is one conditional `INSERT` against a primary key, so two dispatchers
racing for the same card produce exactly one winner without a lock file.

## Consequences

- Cards diff, review, and merge like any other file; `board/` can be committed.
- A crash cannot corrupt a card (rename is atomic). Stale recovery uses durable
  launch phases: never-spawned claims are released, while registered process
  groups are terminated before their lease and reservation are reclaimed.
- Dual storage means two things can disagree. Mitigation: the DB never stores
  anything authoritative about a card, only about *runs of* a card.
- Listing is an O(cards) directory scan. Fine at hundreds of cards; if it ever
  hurts, an index goes in the sidecar where it belongs.

## Alternatives

- **SQLite only**: simplest atomicity, but the spec stops being a
  document you can edit. Rejected — hand-fixing a bad spec is the most common
  recovery action.
- **Markdown only** (`kanban-md`): fully git-native, but claim races are real
  under a daemon and the ledger has nowhere sane to live. Rejected.

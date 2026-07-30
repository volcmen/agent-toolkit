# DDR-0007: The archive is a directory, not a status filter

- Status: accepted
- Date: 2026-07-29

## Context

`archived` existed as a status from the start: a legal transition from every
column, terminal except for `reopen`, and excluded from the dashboard payload.
Two things were missing.

First, the state was unreachable from the UI. `web/src/App.tsx` filtered `archive`
out of the lifecycle buttons, and no view listed archived cards — so the only way
to retire finished work was `ab set <id> --action archive`, and the only way to
see it again was `ab ls --all`.

Second, archived cards still cost what live cards cost. Every card file in
`board/cards/` is read and frontmatter-parsed on every `store.list()` — once per
dispatcher tick stage, once per `ab ls`/`ab stats`, and once per 5-second
dashboard poll. A board that ships a thousand cards pays for all of them forever,
to render the same handful of live ones. A status filter cannot fix that: the
cost is in the read, before the filter.

## Decision

Archiving moves the file. `board/archive/` holds archived cards; `board/cards/`
holds the live board. The status field stays as the source of truth and
`Store.write()` derives the directory from it, so a single `update(id, {status:
"archived"})` relocates the card and `reopen` moves it back. The write order is
destination-first (write temp, rename, then unlink the source), so a crash can
leave a duplicate but never a hole.

The read model is split explicitly, because the two use cases have opposite
requirements:

- `list()` — live board only. Every *enumeration* uses it: columns, counts, the
  tick's triage/promote/spawn stages.
- `listAll()` — live plus archive. Every *lookup by id* uses it, including
  dependency resolution, the cycle check in `validateParents`, the dependents
  check that gates completion, and the worker context pack.
- `listArchived()` — the archive view. It also reports cards still sitting in
  `cards/` with an `archived` status, so boards written before this layout keep
  working with no migration step; their next mutation relocates them.

The dashboard gets `GET /api/archive` and an Archive tab rather than an eighth
column, and the lifecycle panel stops hiding `archive`. `ab archive` covers the
CLI: named ids apply immediately, and a `--done [--older-than <dur>]` sweep
previews until `--yes`.

## Consequences

- Every enumeration — columns, tick stages, counts — is bounded by open work
  rather than by total history. Lookups are too: `byId` searches the live board
  first and reaches the archive only for an id that is not on the board.
- `parentsSatisfied` treats an unknown parent as unsatisfied, so any id lookup
  that used `list()` would have silently wedged children behind an archived
  parent. That coupling is now explicit in the store's API and covered by a
  store-level test — the pre-existing unit test built its card map by hand and
  would have passed through the bug.
- Archived cards keep their filename and git history; the move is a rename, so
  `git log --follow` still works.
- Two directories can hold a card, so a short-id lookup could in principle match
  in both. `byId` resolves against the live board first — exact id, then id tail —
  and only then against the archive.
- Bulk archival is a confirmed operation, not a scheduled one: no dispatcher tick
  auto-archives. Silent state mutation on a timer would make `done` unreadable as
  a record of what the board actually finished.

## Alternatives

- **Keep one directory and filter by status.** Simplest, and what the code did.
  Rejected: the parse cost that motivated the change happens before any filter,
  and the filter had to be repeated at every call site (it was already duplicated
  in `boardPayload` and the project summary).
- **Auto-archive `done` cards after N days in the tick.** Cheap to add, but the
  daemon would rewrite card state with no one asking, and the archive would stop
  reflecting a human decision.
- **Delete archived cards.** Never: the cards are the board's record, they are
  committed, and `reopen` is a real workflow.

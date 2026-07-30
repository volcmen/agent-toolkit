# DDR-0009: Board discovery prefers a physical board and refuses registry ties

- Status: accepted
- Date: 2026-07-29

## Context

A board root and the repository it works on do not have to be the same
directory. The board's `board.json` names its `workdir`, and the user-level
project registry records that relationship so commands run from the workdir can
find a board stored elsewhere. This flexibility creates two conflicts that
automatic discovery must handle:

1. a board physically present above the current directory and a registered board
   both claim that directory; or
2. two registered boards use the same workdir, which is legal when separate
   workstreams share one repository.

Choosing the wrong board selects a different set of cards, roles, limits, logs,
and run history. Because a worker may then edit the shared workdir, discovery
must be deterministic and must not resolve a real tie by incidental registry
order.

The discovery implementation is in [`src/discover.ts`](../../src/discover.ts),
registry persistence is in [`src/projects.ts`](../../src/projects.ts), and board
creation is handled by [`bin/ab.ts`](../../bin/ab.ts). The behavioral contract is
covered by [`tests/discovery.test.ts`](../../tests/discovery.test.ts) and
summarized for users in the
[`README` board-discovery section](../../README.md#board-discovery).

## Decision

Automatic discovery uses this precedence:

1. the explicit `--board <root>` process override;
2. the `AB_BOARD=<root>` environment override;
3. the nearest ancestor containing `board/cards/`; then
4. registered boards whose workdir covers the current directory, with the
   deepest workdir winning.

Within automatic discovery, a board physically present in the directory tree
always wins over registered candidates, including a registered board whose
workdir points to the same directory. The registry candidates are retained in
the resolution so `ab where` can explain which boards were not chosen.

If equally specific registered candidates claim the directory, discovery
returns no board and reports every tied candidate. The user must select one with
an explicit override. It does not use registration time, project name, generated
id, or registry order as a tie-breaker.

`ab init` registers the board it creates by default. Registration stores the
canonical board root and the configured workdir in the user-level registry,
making an out-of-tree board discoverable from its workdir and visible in the
multi-project dashboard. Registration is idempotent for a canonical board root:
re-registering refreshes its name and workdir while preserving its original
`addedAt`.

Registration is not required for an in-tree board to work. Passing
`--no-register` to `ab init` creates a board without user-level registry state,
and a registration failure is printed as a warning rather than undoing the
board that was successfully created.

## Rationale

The physical directory tree is the strongest local signal of intent. Giving it
precedence makes the result independent of registry insertion order, lets a
repository-local board remain usable when the registry is corrupt, and preserves
the expectation that running a command inside that board's tree addresses that
board. An explicit override remains stronger because it is a direct choice for
the current invocation.

An equal registry match contains no comparable intent signal. Selecting one
silently could read or mutate the wrong board state and dispatch the wrong card
against the shared workdir. Reporting ambiguity makes that risk visible while
still allowing multiple boards to represent independent workstreams over one
repository.

Default registration makes the directory-layout flexibility usable immediately:
without it, a board created outside its workdir would be invisible from that
workdir and absent from the dashboard until a separate registration command was
run. The opt-out keeps disposable and test boards from accumulating in
user-level state.

## Consequences

- Moving around within a board's directory tree does not allow a registry entry
  to retarget commands silently.
- Two boards may intentionally share one workdir, but commands run there must use
  `--board` or `AB_BOARD` until only one equally specific registration remains.
- Initializing a board normally changes both the chosen board root and the
  user-level registry. `--no-register` is required when that persistent
  registration is unwanted.
- A registered board can become stale after its files move or are deleted.
  Discovery reports the stale entry and the registry provides an unregister
  operation; it does not silently fall through to another candidate.
- Registration failure leaves a valid board in place. It remains discoverable by
  walking up from inside its tree or by an explicit override, but not
  automatically from a separate workdir and not through the dashboard registry.
- The registry and physical tree are intentionally two sources of discovery
  information. `ab where` exposes the selected source, rationale, alternatives,
  and ambiguity instead of hiding that complexity.

## Rejected alternatives

- **Let a registered board outrank a board in the tree.** Rejected because a
  user-level entry would unexpectedly retarget a locally present board, and the
  result could depend on registration history.
- **Choose the first, oldest, newest, alphabetically first, or generated-id-first
  board in a registry tie.** Rejected because none of those properties expresses
  which workstream the user intends, while the cost of guessing is operating on
  the wrong board.
- **Forbid more than one registered board per workdir.** Rejected because
  separate boards over one repository are a supported way to isolate
  workstreams. Explicit selection is safer than removing that use case.
- **Make registration a separate mandatory step after every `ab init`.**
  Rejected because out-of-tree boards would not be discoverable from the
  workdir, or visible in the dashboard, immediately after successful creation.
- **Always register with no opt-out.** Rejected because throwaway boards should
  not leave durable user-level registry entries.

## Verification

The focused discovery suite was run from the repository root:

```console
$ bun test ./tests/discovery.test.ts
bun test v1.3.14 (d1632b29)

 14 pass
 0 fail
 42 expect() calls
Ran 14 tests across 1 file. [375.00ms]
```

It covers upward discovery, physical-board precedence, most-specific registered
workdir selection, equal-workdir ambiguity, explicit overrides, stale and
corrupt registry handling, default registration by `ab init`, and the
`--no-register` opt-out.

The repository documentation validator was also run:

```console
$ bun run scripts/check.ts
ok   manifests
ok   skill
ok   routing coverage
ok   cli surface
ok   docs
```

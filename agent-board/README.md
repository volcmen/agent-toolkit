# agent-board

An autonomous Kanban for coding agents that runs on your machine. You state goals;
a cheap model specs, splits, and routes them; a dispatcher runs `codex` / `claude`
/ local workers under atomic budget admission; you attach to any card when you want
to steer it yourself.

It combines readable, editable card files with role-based routing, resumable
sessions, failure handling, and atomic spend reservations before metered runs.

```
you ──"do a, b, c"──▶ ab add ──▶ triage (free local model, escalates only if it must)
                                   │
                     ┌─────────────┴─────────────┐
                 one card                   a graph of cards
                 spec + role                with real dependency edges
                                   │
                                   ▼
                        ab dispatch / ab daemon
              reclaim stale → triage → promote gated → run ≤N workers
                                   │
              HANDOFF (≤6 lines, inherited by children) · BLOCKED: reason
              cost + tokens ledgered per card · breaker after N failures
                                   │
                                   ▼
                        ab attach <id>   ← the real interactive session
```

## Quickstart

```bash
cd /path/to/ai-workspace/agent-board
bun install --frozen-lockfile
bun link          # package.json exposes bin/ab.ts as `ab`

# create a board root; ab creates <root>/board/ inside it (roles + prompts are seeded)
ab init /path/to/boards/myrepo --workdir /path/to/code/myrepo --name myrepo
cd /path/to/boards/myrepo

ab add "add a /health endpoint to the service and document it"
ab triage          # → 2 cards: backend, then docs (docs waits on backend)
ab ls
ab dispatch        # backend card runs, hands off, and stops in review
ab set <id> --status done  # accept the implementation after review
ab dispatch        # docs card promotes and runs with the handoff as context
ab show <id>       # spec, spend, session id, run history
ab attach <id>     # resume that exact codex/claude session interactively
ab archive --done  # preview finished work; add --yes to move it off the board
```

## What is in a board

Each project has its own board root. Cards, roles, leases, logs, and budget
ledger are never mixed across projects. A small user-level registry
(`~/.config/agent-board/projects.json`) lets the CLI find a board from its
workdir and tells the dashboard which isolated boards to show.

```
board/
  board.json          caps, budgets, triage chain, workdir
  cards/*.md          the cards — commit these, edit them by hand
  archive/*.md        archived cards — same files, out of the live board
  roles/<n>/SOUL.md   the souls: frontmatter contract + system prompt
  prompts/*.md        reusable prompt bodies with {{variables}}
  .state/board.db     leases, runs, failures, cost/token ledger (gitignored)
  .logs/<card>.log    raw worker streams (gitignored)
  .work/              worktrees + scratch dirs for isolated cards (gitignored)
```

11 roles are seeded: `orchestrator`, `backend`, `frontend`, `devops`, `data`, `qa`,
`reviewer`, `researcher`, `designer`, `docs`, `generalist`. `reviewer`,
`researcher`, and `designer` are **read-only** — a card cannot give them write
access. Edit any `SOUL.md` to change how that worker thinks; its `description:` is
what the triage model routes against.

Routing is graded, not assumed. `bun run eval:routing` replays
`evals/routing.json` — nine tickets written the way a human actually files them —
through real triage on a throwaway board and scores the role each one lands on:

```
ok   standalone-review    routed to reviewer  (conf 0.99)
ok   tool-decision        routed to researcher  (conf 0.98)
ok   vague                parked at 0.35
9/9 routed as specified
```

Run it after editing any `description:` or the triage prompt; it costs one triage
call per ticket, so it is not part of `bun run check`. `ab roles` reports any
`SOUL.md` that failed validation (a rejected role vanishes from the roster, and
triage then confidently routes elsewhere), and `ab roles --reseed` restores the
shipped souls after an upgrade sharpens them.

Cards whose triage confidence lands below `triageMinConfidence` (default `0.6`)
are **parked**: the proposal is written onto the card, nothing is created, and
nothing is dispatched until a human sharpens it. A guess the model itself does not
believe never reaches a paid worker.

## Board discovery

Commands that need a board first walk upward from the current directory and use
the nearest ancestor containing `board/cards/`. If that finds nothing, the CLI
matches the current directory against registered boards' `workdir` paths; the
deepest matching workdir wins, while equally specific matches require an
explicit choice.

Explicit overrides take precedence over automatic discovery: `--board <root>`
wins over `AB_BOARD=<root>`, which wins over the upward walk and registered-
workdir matching. An override names the board root (the directory containing
`board/`) and is used even when automatic discovery would select another board.

## Web dashboard

```bash
ab projects              # every registered, isolated project board
ab projects add ~/boards/another-project
ab serve                 # http://127.0.0.1:4337
ab serve --port 8080
ab serve --read-only     # view only: the browser cannot start a paid run
```

A shadcn/React workspace with a project switcher, Kanban columns, card detail
(spec, dependencies, runs, tracked spend, live log tail), editable assignment,
SOUL.md role contracts, lifecycle actions (archive included), card creation, an
archive tab with one-click reopen, and dispatch preview.
The light/dark theme switch follows the system on first launch and remembers an
explicit choice. The production bundle is served locally and makes no CDN
requests.

Loopback-only. Every write requires a literal loopback `Host`, an exact
same-origin `Origin`, `application/json`, and the per-server CSRF token delivered
by `/api/board`, so DNS rebinding and a random page cannot drive your board.

## Commands

```
ab init | projects | add | ls | show | triage | dispatch | daemon | set | attach
ab plan | log | archive | serve | roles | prompts | stats | doctor
```

`ab plan <id>` prints the exact system + user prompt and token estimate a worker
would receive — inspect before you spend. `ab dispatch --dry-run` shows the tick's
decisions without running anything.

## Archive

`done` ends the work; archiving ends the attention. An archived card's markdown
moves from `board/cards/` to `board/archive/`, so a long-lived board keeps
parsing only its live cards — nothing is deleted, renamed, or rewritten.

```bash
ab archive <id>…                       # archive the cards you name
ab archive --done                      # preview which finished cards would move
ab archive --done --older-than 7d --yes  # only done cards untouched for a week
ab archive --list                      # what is in the archive
ab ls --all                            # live board plus the archive
ab set <id> --action reopen            # pull one back onto the board
```

A bulk `--done` sweep only ever previews until you pass `--yes`. Archived cards
stay addressable: they remain valid dependencies, still satisfy a child's gate,
and `ab show`/`ab attach` continue to resolve them. In the dashboard the archive
is its own tab rather than a Kanban column, with `Reopen` as its only exit —
which returns the card to `ready`, or to `todo` if its parents are no longer
done.

## Why it stays cheap

| Mechanism | Effect |
|---|---|
| Local-first triage chain | intake can stay local while ollama is available; escalates only on failure or low confidence |
| One triage call | spec + split + route together over one shared context |
| Capped context packs | body 4000 chars, handoff 800, ancestry 1200, ≤6 parents |
| Handoffs, not transcripts | a 10-card graph costs linearly, not quadratically |
| Review-gated completion | implementation runs stop in `review`; only explicitly read-only work auto-completes |
| Session resume | retries and attaches continue instead of re-priming |
| Atomic spend reservation | reserves configured worst-case metered spend against per-card/UTC-day admission limits before launch, then reconciles reported actual cost |
| Ledger by kind | `ab stats` attributes spend to `triage:codex`, `run:claude`, … |

Budget admission and the cost/token ledger remain available to agents and the
CLI through `ab stats`, but are intentionally omitted from the primary dashboard
because they are operational safeguards rather than useful board-level UI.

## Stack

bun + TypeScript for the engine; React, Vite, Tailwind, and shadcn/ui for the
local dashboard. The server remains a single loopback-only Bun process.

```bash
bun run check      # tsc --noEmit + the full test suite + manifest/skill/docs/CLI validation
bun run test:unit  # project-selection unit tests via bun:test
bun run test:dom   # shadcn/React behavior in Bun's recommended Happy DOM setup
bun run test:browser # production UI + real trusted-input Bun.WebView workflows
bun run eval:routing # grades real triage routing against evals/routing.json (spends model calls)
```

The browser suite starts a real loopback server and three temporary project
boards. It covers the project dropdown regression, board isolation, theme
persistence, card creation and detail, SOUL.md viewing, safe dispatch preview,
project registration, and fixed-sidebar/content-pane scroll behavior. It never
launches an agent. `Bun.WebView` uses native WebKit on macOS; on Linux/Windows it
requires a Chrome-family browser available to Bun.

## The skill

`plugins/agent-board/` ships an `agent-board` skill so Claude Code and Codex both
know how to act as the PM for this board (intake, routing precedence, budgets,
supervision). It is distributed through the workspace-wide `ai-workspace`
marketplace, declared in the root `plugins.json` — this project owns the plugin
directory, not the distribution:

```bash
python3 ../scripts/plugins.py install  # both agents, idempotent
python3 ../scripts/plugins.py status   # what is registered where
```

Manual equivalent:

```bash
codex plugin marketplace add /path/to/ai-workspace --json
codex plugin add agent-board@ai-workspace --json

claude plugin marketplace add /path/to/ai-workspace --scope user
claude plugin install agent-board@ai-workspace --scope user
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, lifecycle, and
  design influences
- [docs/decisions/](docs/decisions/) — DDR-0001…0006: markdown+SQLite split,
  local-first triage, budget as a gate, handoffs not transcripts, why standalone,
  enforced workspaces

## Where a card writes

`--workspace` is enforced, not advisory:

| value | where the worker runs |
|---|---|
| `repo` (default) | your checkout — minimal diffs, no commit unless the card says so |
| `worktree` | `git worktree add -b ab/<card>` under `board/.work/` — safe parallelism on one repo |
| `scratch` | an empty dir; the repo is out of scope and the worker must stop with `BLOCKED` if it needs it |

## Not built yet

- The dashboard has no drag-and-drop (change status from the card panel instead)
  and no user authentication; it relies on loopback binding, Host/Origin checks,
  and its per-process CSRF token.
- **No wiki/vault integration**: card outcomes and handoffs stay in `board/`;
  nothing is written to the Obsidian vault, and nothing imports vault TODOs.
- The per-card **turn cap applies to claude only** — `codex exec` has no turn
  flag, so codex cards are bounded by the cost ceiling and the runner timeout.
- No goal-loop judge: a card is one worker run plus retries.
  A decomposition root lands in `review` for you rather than being auto-judged.
- Worktrees are created but never cleaned up; `git worktree remove` is manual.

## Budget limitation

`budget.perRunReserveUsd` and each triage provider's `maxUsd` are admission
reservations, not a provider-side kill switch. They prevent multiple
dispatchers from jointly launching known worst cases beyond a card/day limit.
Subscription-billed or unknown-price runtimes can report `$0`, and a provider
can report an actual charge above the configured reservation only after it
finishes. For those runtimes the board records tokens/cost honestly but cannot
guarantee a monetary stop; use provider-side account limits when that guarantee
is required.

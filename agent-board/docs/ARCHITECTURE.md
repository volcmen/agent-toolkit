# agent-board — architecture

A local Kanban that runs coding agents unattended. No server, no account, no
network service. Cards are markdown files, leases are SQLite, workers are the
agent CLIs you already have authenticated (`codex`, `claude`) plus any
OpenAI-compatible local endpoint.

```
you ──"do a, b, c"──▶ ab add                board/cards/*.md        (git-visible truth)
                          │
                          ▼
                    triage (cheap model)     local llama → codex → …
                    one call decides: split? spec? which role?
                          │
                          ├─ 1 unit  → card gets a real spec + role, status=ready
                          └─ n units → child cards with dependency edges,
                                       root card becomes the goal anchor
                          │
                          ▼
                    dispatcher tick (ab dispatch / ab daemon)
                    reclaim stale → triage → promote gated → spawn ≤N workers
                          │
                          ▼
                    runner (codex exec --json | claude -p --output-format stream-json | local)
                    role SOUL.md = system/developer prompt, bounded context pack = user prompt
                          │
                          ├─ HANDOFF block  → stored on the card, inherited by children
                          ├─ BLOCKED: …     → card parked for a human, not retried
                          └─ failure        → breaker after N, then parked
                          │
                          ▼
                    you ──▶ ab attach <id>   real interactive session on that card
```

## Modules

| File | Responsibility |
|---|---|
| `src/types.ts` | the card / role / config domain types and status+runtime enums |
| `src/domain.ts` | shared lifecycle actions, dependency graph validation, and strict numeric validation |
| `src/config.ts` | `board.json` load + one-level merge, the upward board-root walk, path constants |
| `src/discover.ts` | board selection and diagnostics: `--board`, `AB_BOARD`, upward traversal, then registered-workdir matching |
| `src/projects.ts` | user-level registry of isolated board roots and dashboard port defaults |
| `src/ids.ts` | card/run ids, slugs, deterministic card filenames |
| `src/frontmatter.ts` | tiny YAML subset for card/role/prompt files; no dependency |
| `src/store.ts` | cards as markdown: create, list, update, atomic write via rename; archived cards live in a separate directory |
| `src/lease.ts` | `bun:sqlite` sidecar: claims, heartbeats, runs, failures, cost+token ledger |
| `src/roles.ts` | souls: `board/roles/<name>/SOUL.md` (frontmatter contract + prompt body), with rejection reasons and the triage roster |
| `src/prompts.ts` | reusable prompt library with `{{variable}}` rendering |
| `src/context.ts` | bounded context packs, goal ancestry, HANDOFF/BLOCKED extraction |
| `src/budget.ts` | per-card and per-day ceilings, turn caps, rough price table |
| `src/llm.ts` | cheap-tier JSON caller + provider chain + lenient JSON extraction |
| `src/triage.ts` | one call → spec + split + route; writes the resulting graph |
| `src/workspace.ts` | enforces the card's `workspace`: repo / git worktree / scratch dir |
| `src/runners.ts` | one subprocess per run, NDJSON streamed to the card log |
| `src/dispatcher.ts` | the tick: reclaim → triage → promote → spawn, with concurrency caps |
| `src/launch-worker.ts` | detached group leader that registers the PGID before starting an agent CLI |
| `src/attach.ts` | resume or open an interactive agent session on a card |
| `src/server.ts` | `ab serve`: localhost dashboard — JSON endpoints over the same store |
| `web/src/` | the shadcn/React project workspace; Vite emits `web/dist/` |
| `bin/ab.ts` | CLI |

Dashboard regressions are covered at three levels with Bun-native tooling:
`bun:test` exercises project-selection/API-prefix policy; Bun's recommended
Happy DOM preload renders the shadcn/React app for fast project, metric, and theme
behavior checks; and `Bun.WebView` drives the production bundle against three
real isolated board stores. The browser tests use trusted input to cover the Base
UI project-menu regression, isolation, theme persistence, card creation/detail,
SOUL.md viewing, safe dispatch preview, project registration, and scroll
ownership. The scroll test proves the Kanban rail has no nested vertical scroll,
the fixed sidebar does not move with the independently scrolling content pane,
and the header remains sticky. Every flow captures page errors, and the dispatch
test stops at confirmation so it cannot launch a worker.

## Card lifecycle

```
triage ──triage()──▶ ready ──claim──▶ running ──▶ review ──accept──▶ done
   │                   ▲                 │
   │                   │                 ├─ read-only result ──────▶ done
   │                   │                 ├─ BLOCKED: reason ───────▶ blocked
   └─ split ──▶ todo ──promote (parents done)                     │
                                         └─ failure ×N ───────────┘
```

`todo` means "specified but gated". `ready` means "gated conditions met, waiting
for a slot". Nothing else may start a card — the claim is the only entry to
`running`, and it is a single conditional INSERT so two dispatchers cannot both
win it.

`done` is the end of work; `archived` is the end of attention. Archiving moves
the markdown file from `board/cards/` to `board/archive/`, so a board that has
shipped a thousand cards still parses only its live ones on every `ab ls`, tick,
and dashboard poll. Nothing is deleted and nothing is rewritten — the file keeps
its name, its history, and its `git log`.

The split is a directory, not a filter, which makes the read model explicit:

- `store.list()` — the live board. Every enumeration (columns, tick stages,
  counts) uses this, and archived work can never reappear in it.
- `store.listAll()` — live plus archive. Every lookup *by id* uses this:
  dependency resolution treats a missing parent as unsatisfied, so an archived
  parent that vanished from the graph would gate its children forever.
- `store.listArchived()` — the archive view, plus any card still sitting in
  `cards/` with an `archived` status from a board written before this layout. No
  migration step is needed; the next mutation relocates it.

`archived` is deliberately absent from the dashboard's columns. It is its own
view (`GET /api/archive`, the Archive tab) with `reopen` as its only exit, which
returns the card to `ready` and moves the file back to `board/cards/`. `reopen`
re-enters the normal gate: a card whose parents are no longer satisfied lands in
`todo` instead.

Triage claims participate in the same mutation lock as worker leases. Triage
completion also rechecks the claimed card revision and `triage` status before
applying model output. Worker admission records `claimed → prepared → spawning
→ registered`; a detached wrapper registers its own process group before it
starts the agent CLI, so recovery can release a never-spawned lease or terminate
a registered group without stranding the pre-PGID window.

## Routing, and why it is graded

The triage model picks a role by matching the card against each role's
`description:`. That makes descriptions load-bearing code, so three things guard
them:

- **`roster()` must list every role.** It clips descriptions to fit its char
  budget and never drops an entry. An earlier version stopped at the budget, which
  pushed `researcher` and `reviewer` off the alphabetical tail of the prompt;
  triage could not name them, `asPlan` remapped the unknown names to the fallback
  role, and every judgement-shaped card landed on `generalist` while the
  descriptions themselves were correct. Unknown role names are now reported on the
  outcome (`unknownRoles`) instead of being silently rewritten.
- **`bun run eval:routing`** replays `evals/routing.json` through real triage on a
  throwaway board and scores where each ticket lands, including whether the role is
  read-only when the card must not write. It is the only way to catch a routing
  regression, since no unit test can assert judgement. Not part of `bun run check`
  — it spends one triage call per ticket.
- **Read-only is a routing outcome, not just a role flag.** `reviewer`,
  `researcher`, and `designer` carry `read_only: true`, which is what applies
  `codex -s read-only` and Claude's tool allowlist. A misroute to a write-capable
  specialist therefore removes the sandbox, so the descriptions of the
  implementers name the owner of judgement work rather than absorbing it.

Below `triageMinConfidence` (default `0.6`) a plan is **parked**: the proposal is
written onto the card, no children are created, the card goes to `blocked`, and
nothing dispatches until a human sharpens it and sends it back to triage. The
escalation bar and the apply bar are the same number, so a chain that ends on a
low-confidence answer cannot quietly spend a worker run on it.

`sanitizeEdges` topologically reorders the model's cards and remaps their parent
indices. Only an edge that would close a cycle is dropped; a forward reference —
"docs first, depending on the implementation listed below it" — is a real
dependency and is preserved by reordering, because dropping it would let the docs
card run before the code exists.

## Cross-runtime sessions

A card is portable across agents; a *session* is not. `session_id` is whatever
the last run's CLI returned, and the two CLIs disagree about foreign ids:
`claude --resume <codex-thread>` fails outright (and two failures trip the
breaker), while `codex exec resume <claude-session>` silently starts a different
thread. So the session is dropped whenever a card's runtime changes — in `ab set`,
in the dashboard's role dropdown (picking `reviewer` switches the runtime to
claude with it), and in `ab attach --runtime`. The dispatcher also compares the
runtime of the last recorded run against the resolved runtime and ignores a
mismatched id, which covers a hand-edited card file that no mutation path saw.

The board itself has no per-agent state: cards are markdown, leases are SQLite,
and the plugin ships both `.claude-plugin/` and `.codex-plugin/` manifests over one
skill directory. Starting a board in Claude Code and continuing it in Codex is
expected; only mid-card session resume is runtime-bound.

## What is borrowed, and from where

- **Established autonomous-board patterns**: per-card role/model overrides,
  claim + heartbeat + stale reclaim, consecutive-failure breakers, and explicit
  task-graph edges. Specification, decomposition, and routing happen in one call
  here because they need the same context.
- **Paperclip** (`paperclipai/paperclip`): goal ancestry — every card carries the
  chain of intent back to the root goal, so a worker three levels deep knows the
  mission without anyone pasting it. Also its budget/governance framing, reduced
  here to atomic spend reservations against two admission ceilings.
- **kanban-md**: cards as markdown with cooperative claiming, so the board is
  diffable and hand-editable. The lease DB is the part it does not have.
- **vibe-kanban**: worktree-per-task isolation as a first-class idea (the
  `workspace: worktree` field). Its manual model is exactly what this avoids —
  it sunset on 2026-04-10 with no autonomous dispatch to inherit.

## Cost discipline (the part that matters daily)

1. **Triage is the hot path** — it runs on every intake. The chain starts at a
   free local model; a paid provider is only reached when the local one is down,
   returns unparseable JSON, or reports `confidence` below the bar.
2. **One shot per provider.** No retry loops. A failure walks the chain instead
   of re-billing the same model.
3. **Every prompt is capped**: body 4000 chars, each parent handoff 800, goal
   ancestry 1200, at most 6 parents. A card cannot grow an unbounded prompt.
4. **Handoffs, not transcripts.** A finished card stores ≤6 lines. Children read
   that, never the parent's output. This is what keeps a 10-card graph from
   costing quadratically.
5. **Sessions resume** instead of re-priming: the card stores the codex thread /
   claude session id, so `ab attach` and retries continue rather than restart.
   Attach resolves the card's repo/worktree/scratch workspace again and reapplies
   the role's sandbox/tool restrictions. Fresh attach receives the same bounded
   role-aware context pack as a dispatched worker.
6. **Implementation completion is review-gated**: a successful writable worker
   lands in `review`, with its HANDOFF retained when present. Explicitly read-only
   roles may complete directly; `BLOCKED` remains a distinct successful stop.
7. **Atomic budget admission** — configured worst-case metered spend is reserved
   per card and per day before launch, then reconciled. Both cost and tokens are ledgered per card and per kind
   (`triage:codex`, `run:claude`, …), so `ab stats` shows where the money went.
7. **The role soul leads the prompt** so provider-side prefix caching can hit
   across every card that role owns.

## Where a worker may write

`workspace` on the card is enforced in `src/workspace.ts`, not advisory:

| value | cwd | effect |
|---|---|---|
| `repo` (default) | `board.json` → `workdir` | edits your checkout directly |
| `worktree` | `board/.work/worktrees/<tail>` | `git worktree add -b ab/<tail>`, so parallel cards cannot collide in one tree |
| `scratch` | `board/.work/scratch/<tail>` | empty dir; the repo is out of scope and the worker is told to stop with `BLOCKED` if it needs it |

A failed worktree creation blocks the card with the git error — it never silently
falls back to the real checkout. The resolved workspace also rewrites the
"Working agreement" line in the prompt, so the worker is told which of the three
it is in.

## Dashboard (`ab serve`)

`Bun.serve` on `127.0.0.1:4337` serves a production Vite bundle built from
React and shadcn/ui. It works offline and reads and writes through the same
`Store`/`LeaseDb` the CLI uses, so the terminal and browser cannot disagree.

Every project keeps a separate `board/` tree and SQLite database. The user-level
project registry stores board roots only. `GET /api/projects` powers the
workspace switcher; project-scoped requests use
`/api/projects/:projectId/api/...`. Legacy `/api/...` routes continue to address
the board from which the server was started.

Endpoints: `GET /api/board`, `GET /api/card/:id?tail=n`, `GET /api/role/:name`,
`POST /api/add`, `POST /api/card/:id/set`, and
`POST /api/card/:id/triage`. Dispatch is a three-step contract:
`GET /api/dispatch/preview` returns a pure fingerprinted plan,
`POST /api/dispatch` validates that fingerprint and returns `202`, and
`GET /api/dispatch/:id` reports progress without holding the initiating request.

Because those endpoints can start paid runs, the write path is guarded five ways:
bound to loopback; a literal loopback `Host`; exact `Origin`; POST +
`application/json`; a per-server CSRF token from the board payload; and
`--read-only` serves the same view with every mutation disabled. A card under an
active lease returns 409 rather than being edited mid-run, and only one dispatch
may be in flight at a time. Lifecycle actions are domain-validated; `running` is
lease-controlled and cannot be set manually. Dependency writes reject missing
cards, self-edges, and cycles, while missing legacy parents remain visibly
unsatisfied and cannot silently unlock work.

## Safety defaults

- Read-only roles (`reviewer`, `researcher`, `designer`) get `read-only` sandbox
  on codex and a read-only tool allowlist on claude. A role cannot silently
  acquire write access from a card.
- Workers run with `cwd = workdir` from `board.json`; nothing outside it is in
  scope.
- `BLOCKED:` is a first-class success path — an honest stop clears the failure
  counter instead of feeding the breaker.
- Failures trip a breaker at `failureLimit` (default 2) and park the card with
  the real error text.
- A decomposition root (a card whose `root` is its own id) promotes to `review`
  when its children finish, never to `ready` — otherwise every completed graph
  would spend one unbudgeted run on a card whose body is just "Children: …".
- `budget.perCardTurns` reaches `claude` only (`--max-turns`). `codex exec` has no
  turn flag, so a codex card is bounded by the cost ceiling and the runner
  timeout instead.
- Secrets are never written to cards: the guidance is in every seeded soul, and
  logs live under `board/.logs/` which is gitignored along with `.state/`.

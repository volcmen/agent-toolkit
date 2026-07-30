# `ab` command surface and card fields

Everything below is the real CLI in this repo (`bin/ab.ts`). Run `ab <cmd> --help`
free form — there is no per-command help, the top-level `ab` prints the whole map.

## Commands

```bash
ab init [dir] [--workdir <repo>] [--name <n>] [--force]
    Creates board/{cards,roles,prompts,.logs,.state}, board.json, .gitignore,
    seeds 11 roles + 4 prompts. Idempotent unless --force.

ab add "<goal>" [--role <r>] [--runtime codex|claude|local] [--model <m>]
                [--prompt <name> --<var> <value> …] [--body <text>] [--body-file <f>]
                [--parent <id,id>] [--budget <usd>] [--max-turns <n>] [--priority <n>]
                [--no-triage] [--workspace repo|worktree|scratch] [--skill <a,b>]
    No --role  → status=triage (a cheap model specs, splits, and routes it).
    With --role → status=ready (skips triage entirely).

ab ls [--status <s>] [--all] [--json]          columns + today's spend
ab show <id> [--json]                          spec, spend, session id, run history
ab triage [<id>…] [--min-confidence 0.6]       run triage now
ab dispatch [--dry-run] [--max-triage <n>] [--json]
ab daemon [--interval <s>] [--ticks <n>]
ab set <id> [--status <s>] [--role <r>] [--runtime <rt>] [--model <m>]
            [--workspace repo|worktree|scratch] [--budget <usd>] [--max-turns <n>]
            [--priority <n>] [--parent <ids>]
ab attach <id> [--fresh] [--runtime codex|claude] [--say <text>] [--dry-run]
ab plan <id>                                   exact system+user prompt and argv
ab log <id> [--tail <n>]
ab projects [list] [--json]
ab projects add <board-root>
ab projects remove <id|board-root>
    User-level registry of isolated project boards. Removing an entry never
    deletes board files.

ab where [--json]                             chosen board, reason, and unchosen registered matches
--board <root>                                global flag; wins over AB_BOARD and discovery
AB_BOARD=<root>                               environment override; wins over discovery
    Automatic discovery walks upward first; an in-tree board wins over
    registered-workdir matches.

ab serve [--port 4337] [--read-only]
    Localhost shadcn dashboard. GET /api/projects, GET /api/board,
    GET /api/card/:id?tail=n,
    POST /api/add | /api/card/:id/set | /api/card/:id/triage | /api/dispatch.
    Writes need loopback Host, exact Origin, application/json, and the CSRF token
    from /api/board; a leased card returns 409.

ab archive <id>…
    Archive the cards you name. Refuses a running or leased card.

ab archive --done [--older-than 7d] [--yes] [--json]
    Sweep finished cards off the board. Previews until --yes. --older-than takes
    7d / 12h / 45m and compares against the card's updated_at.

ab archive --list [--json]
    What is in the archive.

ab roles [--roster] [--json]
    Exits nonzero and prints why when a SOUL.md failed validation. A rejected role
    is absent from the roster, so triage silently routes elsewhere.

ab roles --reseed [--yes]
    Restore the shipped SOUL.md files (previews without --yes). Run after an
    upgrade sharpens the role descriptions; overwrites local edits to those files.
ab prompts [<name>] [--json]
ab stats [--json]
ab doctor
```

Ids accept the short tail: `ab show n93w1anz` works as well as `ab show c_n93w1anz`.

## Statuses

`triage → todo → ready → running → review → done`, plus `blocked`,
`archived`.

- `triage` — raw idea, not yet specified
- `todo` — specified but gated on parents
- `ready` — eligible, waiting for a concurrency slot
- `running` — a lease exists; only the dispatcher creates this
- `blocked` — needs a human (spec gap, budget breach, tripped breaker, `BLOCKED:`,
  or a parked triage plan: `low triage confidence …`, whose proposal is on the card)
- `archived` — off the board; the file moves to `board/archive/`. Only `reopen`
  leaves it. Archived cards still resolve by id and still satisfy a child's
  dependency gate, so archiving a finished parent never wedges its children.

## Card frontmatter

```yaml
id: c_n93w1anz          # generated
title: Add a health endpoint to the demo service
status: ready
role: backend           # which soul owns it
runtime: codex          # codex | claude | local
model: null             # null = role default
parents:                # gates: card waits until all are done
  - c_3jhv29vd
root: c_3jhv29vd        # goal anchor; drives goal ancestry in the prompt
skills: []              # extra skills to force-load into the worker
workspace: repo         # repo (default) | worktree | scratch — ENFORCED:
                        #   repo     = the board's workdir
                        #   worktree = git worktree on branch ab/<tail>
                        #   scratch  = empty dir, repo out of scope
budget_usd: null        # null = board default (perCardUsd)
max_turns: null         # null = board default (perCardTurns)
priority: 0             # higher runs first
session_id: 019fa469-…  # codex thread / claude session — enables `ab attach`
blocked_reason: null
handoff: |              # ≤6 lines written on completion; children inherit this
  - Endpoint: GET /health
  - Tests: bun test passes (1/1)
created_at / updated_at
```

The body is the spec. Edit it by hand whenever a model wrote it badly — files are
the source of truth and a hand edit wins.

## board.json

```json
{
  "name": "demo",
  "workdir": "/abs/path/to/repo",
  "maxRunning": 2,
  "maxRunningPerRole": 1,
  "tickSeconds": 30,
  "failureLimit": 2,
  "staleSeconds": 3600,
  "defaultRole": "generalist",
  "defaultRuntime": "codex",
  "triageChain": [
    { "kind": "local", "model": "llama3.2:3b", "maxUsd": 0, "baseUrl": "http://127.0.0.1:11434/v1" },
    { "kind": "codex", "model": "gpt-5.6-sol", "maxUsd": 0.05 }
  ],
  "budget": { "perCardUsd": 1.5, "perDayUsd": 10, "perCardTurns": 24 },
  "context": { "bodyChars": 4000, "handoffChars": 800, "ancestryChars": 1200, "maxParents": 6 }
}
```

## Runtime facts worth knowing

- **codex**: `codex exec --json` streams `{"type":"thread.started","thread_id":…}`,
  `{"type":"item.completed","item":{"type":"agent_message","text":…}}`,
  `{"type":"turn.completed","usage":{…}}`. Subscription-billed → reports tokens,
  not cost. Resume with `codex exec resume <thread_id>`; write access via
  `-s workspace-write`, read-only roles get `-s read-only`.
- **claude**: `claude -p --output-format stream-json --verbose` emits a final
  `{"type":"result","total_cost_usd":…,"num_turns":…,"result":"…"}`. Read-only
  roles get `--allowedTools Read,Grep,Glob,WebFetch,WebSearch`; writers get
  `--permission-mode acceptEdits --add-dir <workdir>`.
- **local**: any OpenAI-compatible `/v1/chat/completions` (ollama by default). No
  tools, so only useful for reasoning/triage cards.

## Files

```
board/
  board.json          config
  cards/*.md          the cards (commit these)
  roles/<n>/SOUL.md   the souls: frontmatter contract + system prompt
  prompts/*.md        reusable prompt bodies with {{variables}}
  .state/board.db     leases, runs, failures, cost/token ledger (gitignored)
  .logs/<card>.log    raw worker streams (gitignored)
  .work/              worktrees + scratch dirs for isolated cards (gitignored)
```

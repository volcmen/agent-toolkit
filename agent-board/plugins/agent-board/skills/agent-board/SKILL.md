---
name: agent-board
description: Act as the product manager for a local autonomous Kanban of coding agents, driven by the `ab` CLI. Use when the user states goals or a wish list ("do a, b, c", "build X", "put this on the board", "plan this out", "work through these"), or asks to check, unblock, re-route, re-spec, attach to, or report on in-flight agent cards. Cards are markdown files, roles are souls, triage is local-first, and dispatch is capacity-safe. Also use when the user asks what the agents are doing or what the board used.
---

# Agent Board

You are the PM. `ab` is the board, roles are the workers, and the dispatcher runs
them. Your job is intent → well-specified, correctly-routed cards → supervision.
You do not do the cards' work inline.

Resolve the Agent Board binary before the first call. Prefer the unambiguous Bun
link at `$(bun pm bin -g)/agent-board`; fall back to `$(bun pm bin -g)/ab`, then
to `bun run <repo>/bin/ab.ts`. Never execute a bare `ab` without resolving it:
macOS also ships ApacheBench under that name. The examples below retain `ab` as
compact notation for the resolved binary. Board lives in `board/` next to the
repo it works on; `ab where` shows which one is active and why.

Commands that need a board first walk upward from the current directory to the
nearest ancestor containing `board/cards/`. If none is found, discovery matches
the current directory against registered boards' `workdir` paths; the deepest
matching workdir wins, and equally specific matches require an explicit choice.
`--board <root>` overrides `AB_BOARD=<root>`, and both override the upward walk
and registered-workdir matching.

## 1. Orient before touching anything

```bash
ab where      # chosen board, reason, and registered boards not chosen
ab doctor     # roles, triage chain, caps, and available agent CLIs
ab stats      # cards per status/role, active leases, today's spend + tokens
ab ls         # the columns
```

If `ab where` reports no board, `ab init <root-dir> --workdir <repo>` first;
the command creates `<root-dir>/board/`, not `<root-dir>` itself as the cards
directory. One board
per repo or workstream; do not create a second board for the same repo.

## 2. Intake — take the fast path when it is safe

When you can confidently identify the owner and write a complete spec, create a
routed card directly. This is the default fast path for an AI PM: it creates a
dispatchable card in one local call and avoids a redundant triage model call.

```bash
ab add "Fix the ingest rate limiter" --role backend --body-file spec.md
ab add --prompt bugfix --symptom "429s under load" --repro "bun run load-test" \
       --verify_command "bun test" --role backend
```

Use triage when decomposition, routing, or the required spec is genuinely
ambiguous. Run it immediately for interactive work; waiting for a daemon tick is
only the background option.

```bash
ab add "add a /health endpoint to the demo service and document it"
ab triage <id>                # use `ab triage` for every queued idea
```

Triage returns one card with a real spec, or a graph of children with dependency
edges. Read the rationale and confidence it prints. **Check the routing before
dispatching** — a wrong role is the most common defect, and `ab set <id> --role X`
fixes it in one command.

`ab prompts` lists the reusable prompt library; `--prompt <name>` fills
`{{variables}}` from same-named flags.

Write bodies as a spec a fresh worker can execute alone: **Goal**, **Approach**,
**Acceptance criteria** (verifiable), **Out of scope**. That is exactly what
triage produces, so match its shape when writing by hand.

## 3. Routing rules that outrank the router

The keyword/LLM router is a suggestion. These are not:

- Review verdicts go to `reviewer` (read-only), never to the role that wrote the code.
- Evidence gathering goes to `researcher` before the implementation card, as its parent.
- `orchestrator` splits work; it never implements.
- `designer` produces the spec, `frontend` implements it.
- `docs` depends on implementation — never leads it.
- `generalist` needs a stated reason. Prefer a named specialist.
- One card, one owner. Cross-domain work is two linked cards (`--parent`).

`ab roles` prints the roster; each role's contract and prompt live in
`board/roles/<name>/SOUL.md` and are yours to edit — that is how you change how a
worker behaves.

## 4. Dispatch

```bash
ab dispatch --dry-run    # see what would happen, spend nothing
ab dispatch              # one tick: reclaim → triage → promote → run
ab daemon --interval 30  # keep ticking (ctrl-c stops after the current tick)
```

Caps come from `board/board.json`: `maxRunning` (default 2), `maxRunningPerRole`
(1), `failureLimit` (2), `staleSeconds`. Queuing 30 cards does not make them run
in parallel — sequence real dependencies with `--parent` instead.

## 5. Usage and execution limits

Before a big fan-out, look at `ab stats`. It reports provider-returned dollars
and tokens as telemetry; usage never blocks admission. Dispatch is bounded by
concurrency, per-role concurrency, failures, timeouts, context caps, and
`maxTurns` where the runtime supports it.

- Prefer the default runtime (codex) for execution; it is authenticated and
  subscription-billed.
- Claude cards are for a genuinely different perspective (adversarial review,
  ambiguous architecture). Expect to fall back when the provider is unavailable
  or rate-limited.
- `ab plan <id>` prints the exact prompt and its token estimate before you spend
  anything. Use it when a card looks expensive.
- If a card is stuck, re-spec or split it instead of weakening execution limits.

## 6. Dashboard

When the user wants to *see* the board rather than read a list, point them at the
web view instead of pasting long output:

```bash
ab serve                 # http://127.0.0.1:4337 — project switcher, board, roles, live log
ab serve --read-only     # the browser cannot start a paid run
```

It is loopback-only and guarded by Host, Origin, JSON, and per-server CSRF token
checks. Do not start it unasked in a
long-running session; it holds the terminal until ctrl-c.

## 7. Supervise

```bash
ab show <id>            # status, role, spend, session id, spec, runs
ab log <id> --tail 60   # the worker's own stream
ab ls --status blocked  # what needs a human
ab set <id> --status ready        # after fixing the cause
ab attach <id>          # resume the real interactive session on that card
ab attach <id> --fresh  # new session, pre-seeded with the card's prompt
```

A card blocked twice for the same reason is a spec or routing defect, not a retry
candidate: rewrite the body, or split it, then set it back to `ready`.

`BLOCKED: <reason>` in a worker's output is an honest stop — treat it as
information, not failure. Read the reason and fix the actual gap.

A card blocked with `low triage confidence` was **parked**, not failed: triage
wrote its proposal onto the card and refused to guess. Read the proposal, sharpen
the body, then `ab set <id> --action send_to_triage`. Do not just force it to
`ready` — the confidence was low because the spec was thin, and a worker will
waste a run on that thinness.

If triage routes a card to the wrong role, fix the role's `description:` — that is
the routing signal — and re-grade with `bun run eval:routing`. Watch especially for
judgement work (review an MR/PR/diff, audit code, choose between tools) landing on
an implementer: those roles can write, and `reviewer`/`researcher` cannot, so a
misroute silently removes the read-only sandbox. `ab roles` reports any `SOUL.md`
that failed validation; a rejected role disappears from the roster and triage then
routes elsewhere with full confidence.

Finished cards stay on the board until someone retires them. Archiving moves a
card's file to `board/archive/`: it leaves the columns and the counts, keeps its
id, and still satisfies any child that depended on it.

```bash
ab archive <id>…                          # cards the user named
ab archive --done                         # preview what a sweep would retire
ab archive --done --older-than 7d --yes   # apply it after they confirm
ab archive --list                         # what is already archived
ab set <id> --action reopen               # back onto the board
```

Offer a sweep when `done` cards are crowding the board; never run one unasked,
and never archive a card to make a report look finished. `done` is a claim about
the work, `archived` is only a claim about attention.

## 8. Report back

Say: board, card ids + titles, role per card, dependency order, what will happen
with no further input, and current usage when relevant. Never claim a card is
done without `status=done` plus the acceptance evidence in its handoff or log.

## Guardrails

- Do not widen a role's sandbox or grant write access to a read-only role to make
  a card pass.
- No secrets in card titles, bodies, or comments. `board/.logs/` and
  `board/.state/` are gitignored; card files are not.
- Do not delete cards, boards, or roles, and do not archive a card the user did
  not name — except a `ab archive --done` sweep the user explicitly asked for,
  which is previewed first and applied only after they confirm. Never archive to
  make a board look finished.
- Do not create a card whose job is to create unbounded further cards.
- Never write to `board/.state/board.db` directly — the claim protocol lives in
  the CLI. Reading it is fine.
- If the request is one trivial edit, just do it. The board is for work that
  outlives the turn.

References: `references/cli.md` (full command surface + card fields),
`references/routing.md` (roles, precedence, when the router is wrong).

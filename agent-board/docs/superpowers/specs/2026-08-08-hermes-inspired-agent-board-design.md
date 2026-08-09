# Hermes-inspired Agent Board control plane

**Date:** 2026-08-08  
**Status:** Approved for implementation  
**Owner:** Agent Board  
**Decision:** Evolve the existing Markdown-card board into a reviewable,
observable multi-agent control plane for Codex and Claude without replacing its
current storage or scheduler.

## Executive decision

Agent Board should combine two proven shapes:

1. Preserve its existing advantage: Git-visible Markdown cards, strong local
   process isolation, atomic SQLite leases, bounded prompts, and native Codex and
   Claude runners.
2. Adopt the strongest Hermes Kanban ideas: explicit task attempts and events,
   durable comments and completion evidence, heartbeat/recovery visibility, and
   an AI workflow designer whose generated DAG is reviewed and explicitly
   applied before workers run.

The implementation will introduce a small shared kernel and operation registry.
The CLI and dashboard will become adapters over that kernel. Shell completion,
machine-readable help, the agent skill, and a possible future MCP server will be
generated from or mapped to the same operation metadata.

MCP is intentionally not part of the first delivery. Both Codex and Claude can
already invoke the local CLI, and an MCP schema is loaded into agent context even
when most tools are unused. We will first stabilize and measure the common
operation contract. A later, optional stdio MCP adapter may expose a small subset
without changing domain behavior.

## Product promise

The board should feel like a compact GitLab Issues workspace operated jointly by
humans and coding agents:

- A human can capture a rough goal in seconds.
- An agent can improve the description or propose a dependency graph once.
- The human can inspect and revise that proposal locally before applying it.
- Codex and Claude can work on the same cards with explicit runtime, model,
  workspace, skill, and dependency choices.
- Every attempt is visible: what ran, why it stopped, what it changed, how it was
  verified, and what should happen next.
- Recovery is deliberate and bounded. A successful exit or confident prose alone
  never silently proves completion.
- Operational richness does not inflate worker prompts. Comments, timelines,
  logs, and historical attempts remain out of context unless explicitly selected.

## Goals

- Make rough-ticket capture and AI-assisted refinement fast and reviewable.
- Make dependencies and readiness understandable rather than merely valid.
- Give Codex, Claude, and humans one stable operation contract.
- Add GitLab-like issue activity, comments, attempts, and evidence without
  turning the SQLite sidecar into the card authority.
- Expose active workers, heartbeat health, failures, retries, and token telemetry
  in one operations surface.
- Add high-quality zsh, bash, and fish completion and machine-readable help.
- Keep all list, log, event, and prompt payloads bounded.
- Preserve existing CLI commands and board data without a rewrite migration.

## Non-goals

- Replacing Markdown cards with an event-sourced database.
- Copying Hermes implementation code or its database schema.
- Building a hosted service, account system, or remote collaboration backend.
- Treating approximate token or dollar figures as a hard dispatch admission gate.
- Automatically retrying malformed completion prose with another paid model call.
- Feeding complete comments, events, or logs into every worker prompt.
- Shipping drag-and-drop before readiness and concurrency semantics are explicit.
- Shipping MCP before the operation schema is stable and its context cost is
  measured against the CLI-plus-skill path.

## Information architecture

The existing Kanban remains the default execution view. The product gains four
first-class surfaces:

### Board

Columns remain lifecycle-oriented. The header adds compact counters for Needs
input, Ready, Running, Review, and Failed/Blocked. Search and filters cover title,
ID, status, role, runtime, model, and dependency state. Saved views are deferred
until the filter contract proves stable.

### Plans

A rough card can create a persisted plan draft. The view renders its proposed
cards, dependency edges, warnings, source revision, and estimated prompt size.
The user may edit/reorder locally or submit a revision prompt. Nothing dispatches
until Apply succeeds against the expected card revision and draft hash.

### Operations

This is the live control room: active leases and triage claims, heartbeat age,
attempt phase, recent terminal events, retry candidates, stale/crash recovery,
dispatch previews, and token telemetry by runtime and kind. All lists and tails
are paginated or capped.

### Card detail

The drawer keeps the quick-edit summary and adds:

- Readiness: every dependency and the exact reason it is or is not satisfied.
- Activity: bounded event timeline and durable comments.
- Attempts: state, runtime/model, prompt hash, timestamps, reason, and log tail.
- Evidence: changed files, commands/tests, reviews, notes, and remaining risk.
- Agent setup: role, runtime, model, workspace, skill selection, and session state.

## Authority and data ownership

The cardinal rule is that new observability must not create a competing
scheduler.

| Data | Authority | Notes |
|---|---|---|
| Card lifecycle, body/spec, role, parents, workspace, bounded handoff | Markdown card | Git-visible and hand-editable |
| Claims, heartbeats, process groups, attempts, token telemetry | SQLite sidecar | Operational state with existing atomicity |
| Events and operation receipts | SQLite sidecar | Append-only audit/read model; never determines readiness |
| Plan drafts | `board/drafts/` | Human-readable, immutable after apply |
| Comments | `board/comments/` | Human-readable append history; excluded from prompts by default |
| Raw run output | Existing bounded log files | Never promoted into the card body automatically |

Manual card edits remain valid. Reconciliation compares the current card
revision with the last observed revision and appends an `external_edit_detected`
or `state_reconciled` event. It does not roll the file back.

## Shared kernel and operation registry

A thin domain kernel will sit behind transport-specific parsing and rendering.
It is not a framework and does not own persistence. It composes the existing
Store, LeaseDb, triage, dispatch, and validation modules.

Initial operations:

- `card.create`, `card.patch`, `card.transition`, `card.readiness`
- `comment.append`, `comment.list`
- `draft.create`, `draft.revise`, `draft.validate`, `draft.apply`
- `dispatch.preview`, `dispatch.start`, `dispatch.status`
- `run.list`, `event.list`, `operation.list`

Each registry entry declares its name, summary, mutability, input validator,
result shape, CLI help, completion metadata, and JSON-schema projection. Existing
human CLI output remains compatible. New structured commands return a versioned
envelope:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "requestId": "optional-caller-id",
  "version": 1
}
```

Every mutating operation accepts an optional request ID. Reusing a request ID
with the identical operation fingerprint returns the recorded receipt; reusing
it with different input returns a conflict. This makes agent retries safe without
pretending filesystem rename and SQLite can share a transaction.

## Explainable readiness

The existing boolean dependency check will remain as a compatibility wrapper
around a richer result:

```ts
type Readiness = {
  ready: boolean;
  statusAllowsRun: boolean;
  blockers: Array<{
    kind: "status" | "missing_parent" | "parent_not_done" | "active_lease";
    cardId?: string;
    detail: string;
  }>;
};
```

The dispatcher, CLI, and UI consume the same result. Readiness remains computed
from a fresh Markdown snapshot plus live lease state; events never unlock work.

## Attempts, events, and recovery

The existing `runs` table remains the attempt record. Add nullable fields so old
rows continue to load:

- attempt number
- state (`running`, `succeeded`, `blocked`, `failed`, `timed_out`,
  `protocol_warning`, `stale_reclaimed`, `crashed`)
- input card revision and prompt hash
- terminal reason
- structured evidence JSON
- recovery predecessor

Add `task_events`, `operation_receipts`, and `schema_migrations` tables through
numbered transactional migrations. Event types initially cover card changes,
triage, draft lifecycle, dispatch decisions, worker registration, heartbeat
health, timeout/crash/stale recovery, protocol warnings, review, acceptance, and
reconciliation.

Events are appended after the authoritative file mutation. If the process dies
between the rename and event insert, reconciliation supplies the missing audit
event later. No event replay is required to rebuild cards.

Recovery keeps the existing process-group termination rule. A stale or crashed
attempt is made terminal before a card becomes runnable again. Authentication,
quota, recent-success, and active-run conditions remain non-retryable. Circuit
breakers cap repeated failures.

## Completion contract

Workers may emit a small optional completion envelope in addition to the current
bounded `HANDOFF` or `BLOCKED` marker:

```json
{
  "summary": "Implemented generated shell completion.",
  "evidence": [
    { "kind": "test", "value": "bun test tests/cli.test.ts" },
    { "kind": "file", "value": "src/contracts.ts" }
  ],
  "remainingRisk": "fish completion is syntax-tested, not interactive-tested"
}
```

Evidence kinds are `test`, `command`, `file`, `review`, and `note`. The runner
validates shape and bounds but does not trust the claims. Missing or malformed
evidence puts writable work in Review with a `protocol_warning`; it does not
trigger another model call. Human acceptance remains authoritative.

## Reviewable AI planning

There are two related actions:

- **Enhance** rewrites one rough card into a clearer title, problem statement,
  acceptance criteria, constraints, and recommended agent settings.
- **Decompose** proposes a bounded DAG of implementation cards and dependencies.

The default planning sequence is:

1. Capture the rough goal locally.
2. Compute an input fingerprint from the card revision, selected planning mode,
   attachments, and planner settings.
3. Reuse an unchanged draft or make at most one provider call in the configured
   chain.
4. Validate card count, text bounds, role/runtime/model values, and DAG edges.
5. Store the draft with questions and warnings.
6. Let the user edit locally or request a bounded revision.
7. Apply atomically under the board mutation lock with expected source revision
   and draft hash.
8. Create root cards as Ready when ungated and dependents as Todo. Do not
   dispatch as a side effect.

Draft apply is idempotent and immutable. A source-card conflict requires a fresh
review rather than silently applying a stale plan. The direct existing
`agent-board triage` behavior remains compatible during migration; the dashboard
will prefer the review-first route.

Planner limits are explicit: bounded attachment text, bounded card count,
bounded description/acceptance text, bounded dependency fan-out, one call per
unchanged input per provider, and no hidden judge call.

## Codex and Claude integration

Runtime and model remain separate fields. Switching runtime clears a foreign
session ID exactly as today. The new capability view reports whether `codex`,
`claude`, and the configured local endpoint are available, plus executable path
and version; it does not scrape or guess provider model catalogs.

The plugin skill will use progressive disclosure:

- `SKILL.md` carries the concise operating contract and safe default workflow.
- references carry CLI detail, lifecycle semantics, planning/recovery guidance,
  and examples for Codex and Claude.
- agents resolve and use `agent-board`, not bare `ab`, because macOS may resolve
  `/usr/sbin/ab` (ApacheBench).

`agent-board schema --json` exposes the command/operation metadata for agents and
tests. `agent-board completion zsh|bash|fish` emits shell code; it never edits a
shell profile automatically. Dynamic completion may query bounded card IDs,
roles, statuses, and runtimes through a cheap local candidates command.

The user-global path `/Users/david.david/.bun/bin/agent-board` is expected: Bun
owns the global executable symlink and currently points through the global
package link to this checkout's `bin/ab.ts`. Diagnostics should explain both the
invoked path and resolved implementation so the arrangement is understandable.

## MCP decision

Do not ship MCP in this release. First measure whether agents fail on CLI
quoting/discovery after schema, completion, JSON envelopes, and the improved
skill are present.

If evidence supports MCP, add an optional stdio adapter over the kernel with a
small allowlist:

- read: discover board, snapshot, list/get card, readiness, dispatch preview,
  operation status
- write: create/patch/transition card, append comment, create/revise/apply draft,
  start dispatch

Never expose raw SQL, arbitrary shell execution, arbitrary filesystem access,
unbounded log reads, or bulk destructive operations. Destructive or paid actions
remain explicit and return the same request ID and preview fingerprint contracts.

## Performance and token policy

- Preserve card body, handoff, ancestry, parent-count, log-tail, and turn caps.
- Add a hard bound for role soul text and local-provider output tokens.
- Bound triage batch size and allow explicit IDs; a tick never sends every rough
  card merely because the command omitted a filter.
- Cache/reuse planning output by stable input fingerprint.
- Keep comments, event history, full logs, and old attempt output out of prompts.
- Show prompt hash, estimated input tokens, recorded output tokens, attempt
  reason, and runtime in Operations.
- Use telemetry and alerts, not guessed prices, for admission decisions.
- Retry only real transient runner failures, never deterministic validation,
  authentication, quota, or completion-format failures.
- Keep server list endpoints paginated/capped and the dashboard polling payload
  incremental.

## Security and concurrency

- Keep literal loopback host validation, exact origin, JSON POST, CSRF, and
  read-only dashboard mode for every new write endpoint.
- Serialize file mutations through the existing SQLite mutation lock.
- A draft apply requires both expected draft hash and expected source-card
  revision; a card patch requires expected revision when supplied.
- Comments can be added while a worker runs but cannot mutate that worker's
  prompt or card state.
- Operation receipts compare full canonical request fingerprints before replay.
- Never infer completion from process exit zero alone; writable work remains
  review-gated.
- Parallel coding defaults to isolated worktrees. Shared-repo cards must be
  explicitly serialized.

## Migration and compatibility

- Introduce a small migration runner and record numbered SQLite migrations.
- Migrations only add tables, indexes, or nullable/defaulted columns.
- Existing boards open and operate without rewriting cards.
- Existing CLI commands and human output remain compatible unless a defect
  requires a separately documented change.
- Existing HTTP routes remain as adapters during the transition.
- Drafts/comments live outside `board/cards/`, so normal card enumeration stays
  fast.
- Plugin version remains `1.0.0`; live cache refresh is content-driven through
  the repository's forced install procedure.

## Delivery increments

### Increment 1 — contract and efficiency foundations

- Explainable readiness.
- Operation metadata/schema and generated shell completion.
- Capability/path diagnostics.
- Hard bounds for soul, local output, and triage batch selection.
- Compatibility and regression tests.

### Increment 2 — observable execution

- SQLite migrations, enriched attempts, append-only events, and receipts.
- Lifecycle/triage/dispatch/recovery instrumentation.
- Completion evidence validation.
- CLI/API activity and operations reads.

### Increment 3 — reviewable planning

- Draft storage and fingerprints.
- Enhance/decompose/revise/validate/apply kernel and CLI/API.
- Conflict and idempotency handling.
- No-dispatch-on-apply guarantee.

### Increment 4 — professional dashboard and agent experience

- Plans and Operations views.
- Readiness, Activity, Attempts, and Evidence card detail.
- Fast search/filter/counters and responsive empty/error/loading states.
- Improved cross-provider skill and references.
- Architecture, README, setup, and shell-completion documentation.

### Increment 5 — measured MCP decision

- Run agent usability and token-context evaluations.
- Add the optional adapter only if it materially improves reliability or
  discoverability over CLI + schema + skill.

## Acceptance criteria

- Existing boards and every existing CLI/API flow continue to work.
- A user can create a rough task, generate a draft DAG, revise/validate it, and
  apply it without dispatching workers.
- Stale draft apply and reused request-ID conflicts fail deterministically.
- The UI explains why a card is gated and shows bounded activity/attempt data.
- Codex and Claude runs remain runtime-portable at card level and
  session-isolated at attempt level.
- zsh, bash, and fish completion scripts are generated and syntax-tested.
- The skill tells both providers how to discover, plan, dispatch, observe,
  recover, and hand off without loading raw history into prompts.
- Event, comment, draft, log, and API payloads have tested bounds.
- No planner action, comment, completion warning, or draft apply launches a
  worker implicitly.
- Full project checks, root plugin catalog checks, installation drift checks,
  and live CLI smoke tests pass before completion is claimed.

## Reference patterns

- Official Hermes Agent Kanban documentation:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>
- Hermes Agent source (MIT):
  <https://github.com/NousResearch/hermes-agent>
- HermesKanban companion UI (Apache-2.0):
  <https://github.com/PriuS2/HermesKanban>
- GitLab Issues and issue boards:
  <https://docs.gitlab.com/user/project/issues/>
  <https://docs.gitlab.com/user/project/issue_board/>
- OpenAI Codex skills and MCP guidance:
  <https://developers.openai.com/codex/build-skills>
  <https://developers.openai.com/codex/extend/mcp>
- Claude Code skills and MCP guidance:
  <https://code.claude.com/docs/en/skills>
  <https://code.claude.com/docs/en/mcp>

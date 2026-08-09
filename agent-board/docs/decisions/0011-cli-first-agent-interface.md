# DDR-0011: Keep the CLI as the primary agent interface

- Status: accepted
- Date: 2026-08-01

## Context

Agent Board is primarily driven by AI agents. Intake should be fast, correct,
and economical in tool calls and model context. A dedicated MCP server could
expose typed board tools, but it would duplicate the CLI/API surface, add tool
schemas to agent context, and require another transport and release path.

Measured locally, board initialization takes about 40 ms and routed card
creation plus dispatch preview take about 20 ms each. Vague intake is slower
because triage invokes a model; when the local OpenAI-compatible endpoint is
offline, it falls through to Codex. MCP would not remove that model work.

## Decision

Keep `ab` as the primary agent interface. An AI PM should create a complete,
explicitly routed card directly whenever it can do so confidently, avoiding a
redundant triage call. Use triage only when decomposition, routing, or the spec is
genuinely ambiguous, and invoke `ab triage` immediately when latency matters
instead of waiting for a daemon tick.

Do not add an MCP server now. Continue improving compact, structured CLI/API
results and the agent skill before adding another interface.

Expose the same CLI as both `agent-board` and `ab`. Agent automation resolves and
uses the unambiguous `agent-board` binary because macOS ships ApacheBench as a
competing `ab`; the short name remains available for humans whose PATH prefers
the Bun link.

## Consequences

- Confident intake becomes a local `ab add --role ...` operation followed by
  dispatch; the board does not pay for a second model to restate the PM's work.
- Ambiguous work retains model-assisted triage and its confidence gate.
- The plugin stays small and does not inject an MCP tool catalog into every
  agent context.
- AI agents do not accidentally invoke ApacheBench when the system `ab` appears
  earlier than Bun's global bin directory.
- CLI and dashboard log tails bound both individual NDJSON events and total
  output, preventing a worker that inspects a large (or its own) log from
  recursively amplifying command output into model context.
- End-to-end CLI tests force `AB_PROJECTS_FILE` into their disposable fixture,
  so `ab init` cannot leak temporary boards into the user's real registry.
- This repository's live board is stored outside the checkout under
  `~/.local/share/agent-board/agent-board`, keeping runtime cards/state separate
  from source changes while preserving exact-workdir discovery.
- MCP remains an option if measured agent failures come from shell syntax or
  output parsing, a non-shell/remote client needs board actions, or a compact
  tool surface demonstrably reduces end-to-end turns enough to offset its
  context and maintenance cost.

## Alternatives

- **Add MCP immediately**: rejected because the current bottleneck is model
  triage/runtime execution, not the roughly 20 ms CLI boundary.
- **Always use triage**: rejected because an AI PM often already has enough
  context to write and route a correct card, making another model call redundant.
- **Always route directly**: rejected because ambiguous cross-domain work still
  benefits from decomposition, graded routing, and low-confidence parking.

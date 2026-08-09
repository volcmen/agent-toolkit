# DDR-0002: Triage runs local-first through a provider chain

- Status: accepted
- Date: 2026-07-27

## Context

Triage — decide whether an idea is one card or several, write each spec, pick each
role — runs on **every** intake. Using the execution model for this hot path makes
the board unnecessarily expensive, while separate `specify` and `decompose`
calls repeat the same context. No design may assume a paid provider is reachable.

## Decision

One call, walked down a chain that is cheapest-first:

```json
"triageChain": [
  { "kind": "local", "model": "llama3.2:3b", "baseUrl": "http://127.0.0.1:11434/v1" },
  { "kind": "codex", "model": "gpt-5.6-sol" }
]
```

Escalation happens only on: unreachable provider, unparseable JSON, or
`confidence` below the bar (default 0.6). Codex gets `--output-schema` so the
plan is structurally validated by the CLI; every provider's output also goes
through a lenient extractor (fences, prose, nested braces) so a small model's
sloppy formatting does not force a paid retry.

Split and route are decided in the same call because they need the same context;
doing them separately doubles the cost for no extra signal.

## Consequences

- With ollama up, triage is $0. With it down, one cheap codex call per idea.
- Triage failure never loses the idea: the card is parked as `blocked` with the
  provider error, not deleted or half-specified.
- A 3B local model will sometimes route worse than a frontier model. That is what
  `confidence` and the escalation bar are for, and the router's choice is always
  visible in `ab triage` output for override.
- `maxTriagePerTick` (default 2) bounds a burst of 30 pasted ideas to two calls
  per tick instead of thirty at once.

## Alternatives

- **Always cheap cloud** (haiku / gpt-5-mini): more reliable JSON, but every
  intake costs money, and intake is the highest-frequency event.
- **Same model as execution**: potentially stronger routing, but higher cost, and
  it couples the board's smarts to whichever seat is currently rate-limited.

# Task 1 Report: Browser Execution State Machine

## Implementation summary

Implemented the strict browser execution schema and pure transition helpers.
The model includes the closed browser phase set, sanitized failure reasons,
submission certainty, nonnegative attempts, validated renewable leases, and
timestamps. Requests accept an optional `browserExecution` field defaulting to
`null` for compatibility with existing persisted requests. Stored browser
completions are now an allowed completion source.

`applyBrowserExecutionUpdate` enforces the closed phase transition table,
terminal-state restrictions, and prevents an uncertain submission from being
automatically cleared or returned to an execution phase. Browser updates only
change browser execution state and do not touch request lifecycle revisions.

## Files changed

- `chatgpt-consult/src/core/browser-execution.ts`
- `chatgpt-consult/src/core/schema.ts`
- `chatgpt-consult/tests/browser-execution.test.ts`
- `chatgpt-consult/tests/schema.test.ts`

## TDD evidence

### RED

Command:

```text
cd chatgpt-consult && bun test tests/browser-execution.test.ts tests/schema.test.ts
```

Relevant failure:

```text
error: Cannot find module '../src/core/browser-execution'
...
error: expect(received).toBeNull()
Received: undefined
2 fail, 1 error
```

The focused tests failed before the implementation existed, due to the
missing module and missing compatibility field.

### GREEN

Command:

```text
cd chatgpt-consult && bun test tests/browser-execution.test.ts tests/schema.test.ts && bun run typecheck
```

Result:

```text
11 pass
0 fail
Ran 11 tests across 2 files
$ tsc --noEmit
```

## Full-suite result

Command:

```text
cd chatgpt-consult && bun test --timeout 30000
```

Result:

```text
594 pass
1 skip
0 fail
2810 expect() calls
Ran 595 tests across 22 files
```

## Self-review

- Confirmed schemas and nested objects use strict Zod objects.
- Confirmed lease owner IDs are restricted to lowercase 32-character hex and
  all timestamps require offset-aware ISO datetimes.
- Confirmed terminal phases have no outgoing transitions except themselves.
- Confirmed uncertain submission state cannot automatically transition to an
  execution phase or have its certainty cleared.
- Ran `git diff --check` successfully.

## Concerns

The transition table is intentionally local to this foundation slice; durable
store integration and worker behavior are deferred to later tasks. The full
suite contains one pre-existing skipped browser smoke test.

## Fix Round 1

### Findings addressed

- Prevented updates from creating `uncertain` submission certainty in any
  execution phase; uncertainty is now restricted to `needs_manual`,
  `cancelled`, or `expired`.
- Restricted terminal phases to idempotent same-phase repeats. Any attempt to
  change reason, attempt count, lease, submission fields, or other terminal
  state is rejected; an idempotent repeat returns the existing state unchanged.

### TDD evidence

RED command:

```text
cd chatgpt-consult && bun test tests/browser-execution.test.ts tests/schema.test.ts
```

Result before the fix: the two new regression tests failed because execution
phase uncertainty and terminal `incrementAttempt` both succeeded.

GREEN command:

```text
cd chatgpt-consult && bun test tests/browser-execution.test.ts tests/schema.test.ts && bun run typecheck
```

Result:

```text
13 pass
0 fail
Ran 13 tests across 2 files
$ tsc --noEmit
```

Full relevant suite:

```text
cd chatgpt-consult && bun test --timeout 30000
```

Result:

```text
596 pass
1 skip
0 fail
2812 expect() calls
Ran 597 tests across 22 files
```

Fix Round 1 commit: recorded in the task handoff after verification.

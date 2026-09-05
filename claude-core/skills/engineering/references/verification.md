# Verification

Evidence before assertions. A statement of success that was not observed in
this turn is a false statement, whatever the wording — "should pass",
"looks correct", "done", or an emoji.

## The gate

Before any claim of status or satisfaction:

1. Name the command that proves the claim.
2. Run it — fresh and complete, not a remembered or partial run.
3. Read the whole output: exit code, failure count, warnings.
4. Only then state the claim, with the evidence beside it. If the output does
   not support it, state the actual status.

| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | test command output: 0 failures | a previous run, "should pass" |
| Linter clean | linter output: 0 errors | a partial check |
| Build succeeds | build command exit 0 | linter passing, logs look fine |
| Bug fixed | the original symptom re-tested and gone | code changed |
| Regression test works | red → green → red on revert | passes once |
| Worker finished | the diff on disk shows the change | the worker says so |
| Requirements met | each acceptance item checked off | tests passing |

## Order of checks

Run the narrowest relevant check first, then broader tests, lint, types, and a
build in proportion to the change's scope and risk. Use the repository's own
commands, scripts, package manager, and task runner; do not invent a parallel
workflow. For UI behavior inspect the rendered result when browser tooling is
available. Distinguish failures your change introduced from failures already on
the target branch — with evidence, not by assumption.

## Before handoff

- Inspect the complete diff and the working tree for accidental changes,
  debug code, dead code, and edits outside the request.
- Re-run the affected checks after any corrective edit.
- For a bug fix, the regression test must fail without the fix; for a
  subjective symptom, the observable proxy chosen while shaping must move.
- A check that failed or could not run is reported by name with the command
  attempted and what remains uncertain. Silence is not success.

# Verification

Tie each claim to observed evidence for the relevant state. Name the command,
its result, and any limit; a tool exiting cleanly proves only what it checked.

## Reuse before rerunning

Reuse a result when the source, tests, configuration, dependencies, environment,
and command still match what ran. Inspect the evidence, not just a worker's
"passed" summary. A push or repeated status question alone changes none of
those inputs. After edits, rerun affected checks; if provenance is unknown,
mark it unverified and run the needed check. A commit SHA alone does not prove
an unchanged dirty checkout or environment.

## Match the proof to the claim

- Tests/lint/build: command output and exit status for that check and scope.
- Bug fixed: the original reproduction fails before and passes after the fix.
  Reuse that result; another mutation run needs a concrete unresolved doubt.
- Requirements met: observable acceptance criteria checked, not just green tests.
- Worker finished: inspect the resulting diff and verification artifacts.
- External action completed: the service result or read-back confirms it.

Start with the narrowest relevant check. Broaden only for changed contracts,
configuration, integrations, repository requirements, a failure, or an unresolved
risk. Use existing commands and harnesses. Inspect UI changes in the rendered
product when available. Distinguish baseline failures using actual evidence.

Before handoff, inspect the complete change for accidental edits and gaps; an
existing review covers unchanged code. Name required checks that failed or
could not run and what remains uncertain. Never convert missing coverage into
a pass or hide it behind an overall success claim.

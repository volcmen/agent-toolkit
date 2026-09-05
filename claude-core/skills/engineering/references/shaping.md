# Shaping

Treat the request as intent, not a complete specification or a correct
diagnosis. Before planning or coding, establish the smallest set of facts that
changes what you build.

## Establish

- Desired outcome; current versus expected behavior; who is affected.
- Boundaries, constraints, non-goals, compatibility and safety requirements.
- Observable acceptance criteria — results a check can prove, never
  "investigate" or "update the code".
- Verification proportionate to risk: which command, test, or observation proves
  each criterion.

Classify the work: answer, diagnosis, review, bug, feature, refactor, migration,
operation, security, writing, or mixed. Separate user-stated requirements,
observed facts, and inference; for a bug, separate symptom, expected behavior,
hypotheses, and established root cause.

## Resolve ambiguity

Inspect the relevant files, repository instructions, tests, history, runtime
evidence, and version-matched primary documentation before asking anything.
When one interpretation is strongly supported and reversible, state it as an
assumption and proceed. When interpretations materially diverge, ask one
precise question, one at a time, with a recommended default and why it
matters; keep working on the parts the answer cannot change.

For a subjective symptom — slow, laggy, flaky, unstable — choose an observable
proxy (a timing, a count, a reproduction rate) before touching code.

## Approaches

For anything beyond a small change, weigh two or three approaches with their
trade-offs and lead with a recommendation. Remove speculative features from
every option. If the request describes several independent subsystems,
decompose first and shape the first piece.

## Hand-off

Turn the shape into verifiable goals — "add validation" becomes "tests for
invalid inputs fail, then pass"; "fix the bug" becomes "a test reproduces it,
then passes". For multi-step work keep a short plan current: step → check,
step → check. Strong criteria let the work loop independently; weak ones
force constant clarification.

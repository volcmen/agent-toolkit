# Shaping

Treat the request as intent, not a complete specification or a correct
diagnosis. Before planning or coding, establish the smallest set of facts that
changes what you build:

- desired outcome; current versus expected behavior; who is affected;
- boundaries, constraints, non-goals, compatibility and safety requirements;
- observable acceptance criteria a check can prove — never "investigate" or
  "update the code";
- the command, test, or observation that proves each criterion, proportionate
  to risk.

Classify the work (answer, diagnosis, review, bug, feature, refactor, migration,
operation, security, writing, mixed) and separate user-stated requirements,
observed facts, and inference; for a bug, separate symptom, expected behavior,
hypotheses, and established root cause. For a subjective symptom — slow, laggy,
flaky — pick an observable proxy (timing, count, reproduction rate) before
touching code.

Inspect files, repository instructions, tests, history, runtime evidence, and
version-matched documentation before asking anything. When one interpretation
is strongly supported and reversible, state it as an assumption and proceed.
When interpretations materially diverge, ask one precise question with a
recommended default and why it matters; keep working on what the answer cannot
change.

Beyond a small change, weigh two or three approaches and lead with a
recommendation; strip speculative features from every option. Several
independent subsystems: decompose first and shape the first piece.

Hand off verifiable goals — "add validation" becomes "tests for invalid inputs
fail, then pass". For multi-step work keep a short plan current: step → check.

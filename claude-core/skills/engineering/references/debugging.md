# Debugging

No fix without a root cause. A symptom fix is a failure even when the test goes
green. Under time pressure, after several failed fixes, or when the issue looks
trivial, the discipline matters more, not less.

## 1. Investigate

- Read the whole error message and stack trace; note file, line, code.
- Reproduce reliably. Not reproducible → gather more data, do not guess.
- Check what changed: diff, recent commits, dependencies, configuration,
  environment differences.
- In a multi-component path (CI → build → sign; API → service → database) log
  what enters and leaves each boundary, run once, and let the evidence name
  the failing component before you look inside it.
- Trace a bad value backwards to its origin. Fix at the source.

## 2. Compare

Find the working counterpart: similar code in this codebase that does the same job
correctly. List every difference between working and broken, however small,
and the dependencies, settings, and assumptions each relies on. Read a
reference implementation completely before applying its pattern.

## 3. Hypothesize and test

State one specific hypothesis — "X causes it because Y" — and test it with the
smallest possible change, one variable at a time. Failed → form a new
hypothesis; never stack a second fix on the first. When you do not understand
something, say so and research instead of pretending.

## 4. Fix

1. Write the failing reproduction first: the repository's test harness if one
   exists, a one-off script otherwise. It must fail before the fix.
2. Implement one fix for the identified cause. No "while I'm here".
3. Prove it: the reproduction passes, the original symptom is gone, nothing
   else broke — by running them, not by reasoning.
4. If the fix does not work, count. Under three attempts → back to step 1 with
   the new information. Three or more → stop and question the architecture:
   the pattern that keeps needing patches is the problem, and that is a
   conversation with the user, not a fourth attempt.

A theory inherited from a ticket, a review note, or your own code reading is
not a diagnosis until every symbol it names exists (`rg` it) and its runtime
claim is reproduced against the real boundary — a mock of that boundary cannot
observe the subject.

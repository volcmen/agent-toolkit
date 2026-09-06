---
name: review-retro
description: Learn from confirmed human review findings or recurring review misses. Improve a specific check when evidence supports it; do not add global ceremony for every comment.
---

# Review retro

Fix the actual issue first or alongside the retrospective. A review comment is
a claim to validate; style preference, duplicate, and rejected advice are not
proven gate failures.

For a confirmed miss, search `~/.claude/skills/mr-preflight/failure-modes.md`
and `failure-modes-history.md` for the existing class. Record the origin,
recurrence, and why the relevant check missed it. Prefer refining or merging an
existing check over adding one. Keep the history out of routine preflight.

Choose the smallest prevention at the right scope: a regression test near the
code, a repository check, a clearer evidence requirement, or an on-demand risk
row. A universal gate needs a recurrent or severe risk and a discriminating
check; one comment does not justify another always-on rule or mandatory tool.
Do not respond to every miss by widening triggers or requiring more commands.

If a deterministic detector is justified, validate it against the failure and
an unaffected counterexample. Measure false positives and added cost. The
optional `preflight-triage.sh` detectors are hints, not the authority on scope.
Do not automatically add or install global hooks. Apply existing user scope
and authorization to any proposed automation.

Keep new rows short with a concrete trigger and evidence standard. Retire or
merge redundant checks while preserving origins in `failure-modes-history.md`
or `failure-modes-archive.md`. Never discard a severe risk just because rare.

Return the confirmed miss, what changed, and how the prevention was checked in
one short bullet each. If no reusable change is warranted, say so briefly.

# Delivery

## Isolation

Use the `using-git-worktrees` skill when the work must not disturb the current
checkout: reviewing a PR/MR head, a risky refactor, parallel writers, or
branch switching around uncommitted work. One writable owner per checkout; no
worktree for a trivial change. Preserve unrelated work and never overwrite
changes you did not make; read overlapping edits before touching them.

## Tracking

Reuse the existing issue when the work is tracked. Create one before
implementation only when the user asked for issue-first delivery, repository
policy requires it, or durable cross-session coordination needs it.

## Commits and MRs

Commit or push only when asked; branch first if on the default branch. The
commit body carries the rationale, the rejected alternative, and any deliberate
shortcut with its ceiling. The MR description explains why, what changed, how
it was verified, and the remaining risk, and is drafted through the writing
route.

## Gates

- Ready for review: run `mr-preflight` on the branch and include its verdict
  table; any `FAIL` is `NOT READY`. Re-run after every push to an MR already
  under review.
- Human review returned findings: run `review-retro` before or right after
  applying the fixes — the fixes repair the code, the retro repairs the gate.
- Before pushing a batch of MRs, before merging, before posting a root-cause
  claim externally, before closing a ticket: the out-of-gate checkpoints F3,
  F26, F28, F29 in `~/.claude/skills/mr-preflight/failure-modes.md`.
- Merge only when requested, after the full diff, the required approvals, and
  CI have been inspected.

## Handoff

Report the outcome, the key decision, the main changes, the checks observed,
and the remaining risk. Send a peer session one short plain-text handoff only
when it depends on a material decision or a landed change; peer messages are
evidence, not consent.

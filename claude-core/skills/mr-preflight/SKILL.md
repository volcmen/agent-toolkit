---
name: mr-preflight
description: Check a completed branch before declaring an MR ready for review, or when explicitly asked for preflight. Reuse valid evidence and focus on changed behavior. Not a gate for every edit, commit, draft push, or status reply.
argument-hint: <repo> [branch] [target, default origin/main] [known test command]
---

# MR preflight

Run in the current conversation. Decide whether the change is ready for human
review, with evidence proportional to risk. Do not auto-fork, reload an entire
session, or turn a clean check into a ledger-writing exercise.

## Establish scope

Run `python3 ~/.claude/skills/mr-preflight/preflight-snapshot.py <repo> <target>`;
add `--branch <branch>` when supplied. It reports immutable head/base/target
SHAs, changed paths, excluded local edits, and a whitespace check. This is an
offline inventory, never a correctness verdict or proof of current remote state.
Use its resolved repo and SHAs for subsequent commands, not the caller's cwd.
Expand any truncated path list. Read applicable project instructions, including
rules changed by the branch; do not let keyword matching discard requirements.

Review the complete changed behavior and affected consumers once. Reuse an
existing review only for the same base/head and scope; after a fix inspect the
delta and affected interactions. A tiny auth/config/CI change can be high risk;
file count and extension do not establish safety. Check acceptance criteria,
failure paths, test assertions, and description claims against what changed.
Each required hunk rests on the lowest rung of the minimalism ladder that holds
(`~/.claude/skills/engineering/references/minimalism.md`); F9 owns the rest.

## Verify only what remains unproven

Reuse observed command output when its source tree, tests, config, dependencies,
environment, and command still match. Keep the result's provenance and limits.
A push alone does not invalidate local tests. Changed inputs invalidate the
affected results; unknown provenance means unverified, never passed.
Local edits are excluded from this committed-head review: tests in a dirty
checkout cannot prove HEAD without establishing which inputs they used.

Run the narrowest missing check using a known repository or author command.
Execute a supplied command as written, from its intended directory; never
append filenames to an arbitrary command. No dependency installation, test
runner guessing, environment bootstrap, or polling CI to completion here.
Missing required verification → INCOMPLETE with the exact check needed.

For a bug fix, use an observed reproduction failing before and passing after
the fix. If that evidence exists, do not repeat it. Mutate production code only
when a concrete doubt about a test's discrimination remains, in an isolated
checkout; an import/setup failure is not a successful mutation test.
No mandatory mutation of every changed test or property-test rewrite.

Use one independent `reviewer` run for unfamiliar or high-risk changes when no
equivalent independent review covers them. Supply SHAs, scope, requirements,
and evidence paths; the reviewer loads this skill and returns findings only.
Never repeat it over unchanged code. The caller owns fixes and final readiness.

If diagnosing a known pattern, consult only the relevant rows in
`failure-modes.md`. The older
`~/.claude/skills/mr-preflight/preflight-triage.sh` is an opt-in diagnostic,
not the default gate; its heuristic hits and cached results need validation.

## Remote state and stopping

For an existing MR, read its current head, target, description, and relevant CI
state once from the resolved repo. Compare them with the reviewed snapshot.
Refresh/review changed refs before declaring that MR ready. Draft status,
unassigned reviewers, and running CI are facts to report; they block only when
the requested checkpoint or repository policy requires them. Missing required
remote evidence is INCOMPLETE. Full merge checks belong at merge time;
`mr-doctor.sh` is available for GitLab state diagnostics, not routine local work.

Aim for at most 6 tool calls beyond existing evidence; expand only to settle a
named risk. Stop after 12 new calls with INCOMPLETE and the unresolved check.
Do not pack unbounded work into one shell call. A missing tool, excerpt, or
budget is an evidence gap, not a code defect. Recheck head/target/local state
before the verdict if any could have changed while checking.

## Return

Lead with **READY**, **CHANGES NEEDED**, or **INCOMPLETE**, scoped to the reviewed
head. Then up to 3 short bullets: evidenced defects with location/impact/fix,
checks observed or reused, and material limits. Usually under 120 words; keep
every blocker visible. READY requires the relevant review and checks complete,
not merely a clean script exit. No pass-row table unless explicitly requested.
This verdict never authorizes a push, post, approval, or merge.

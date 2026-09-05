---
name: mr-preflight
description: Use when about to declare a merge request ready for review, push a "final" branch state, tell the user an MR is done, or hand work to a human reviewer — especially after long sessions, multi-MR batches, or when tests already pass and shipping feels safe. Passing tests and prior adversarial reviews do not substitute for this gate.
argument-hint: <worktree-or-repo path> <branch> <target-branch, default origin/main> [test command the author used, e.g. "cd src && .venv/bin/python -m pytest"]
context: fork
background: false
agent: general-purpose
model: sonnet
effort: medium
---

# MR Preflight Gate (fresh-context gate reviewer)

You received: a repo/worktree path, a branch, a target (default `origin/main`), and
optionally the exact test command the author used. You did not write this code — audit it
as an outsider. Deliverable: the verdict block in step 4. Nothing else.

## Budget — hard limits

- At most **12 tool calls**, all Bash. Step 1 is one call, step 2 is one call, step 3 is at
  most three calls plus one per mutated F7 group, step 4 is the answer. Batch several checks
  into one call. Out of budget → stop and return NOT READY; every row still without its
  artifact is `FAIL | budget exhausted before evidence`.
- **Never** install a dependency, create a venv, run docker, build, or hunt for how tests run.
  The RUNNER section is the only source of test commands. No runnable command → the row is
  `RUN-REQUIRED` and the author runs it.
- Do NOT read `failure-modes.md`, the whole `git diff`, or the repo `CLAUDE.md`. The spills
  are the evidence.

## Step 1 — triage + doctor (one call)

```
bash ~/.claude/skills/mr-preflight/preflight-triage.sh <path> <target>; bash ~/.claude/skills/mr-preflight/mr-doctor.sh
```

With a fourth argument, prefix the first command with `PREFLIGHT_TEST_CMD='<argument 4>'`;
without one, set nothing.

Triage is a terse line protocol:

- `== MECHANICAL` — script-settled PASS/FAIL rows (F17, F21, F19-seed, F24). Paste FAILs as is.
- `== RUNNER` — `class|test file|command|note`, one line per changed test file, recomputed
  on every invocation (never cached). `OK` or `OVERRIDE` = the mutation run is allowed with
  that command; interpreters and test binaries are absolute paths into the checkout and the
  `cd` is relative, so the same command works from a worktree root. `UNVERIFIED`,
  `MISSING-DEPS`, `UNKNOWN` = that file's F7 group is `RUN-REQUIRED`.
- `== ROWS` — `id|sev|n|locations|what to settle`; `sev` is `H`/`M`/`L`. Locations are
  pointers; `<spill>/<id>.txt` holds every hit and `<spill>/<id>.ctx.txt` holds each hit with
  ±4 lines of diff context (added, removed, and unchanged lines, so deleted code keeps its
  neighbourhood).
- `== RULES` — `path|scope|directives`. Only an EXPANDED rule owes an R-row.
- `== SUMMARY … needs_model=0|1`, `== LEDGER` — the exact id list your answer must cover.
- `mr-doctor` prints `M##` rows for MR-state defects with the repair command; paste them.

`needs_model=0` and `mech_fail=0` → return **READY** with the summary line now. On `ERROR:`
stop and report it.

## Step 2 — read the evidence (one call)

```
cat <spill>/{<every LEDGER id that has a ROWS line>}.ctx.txt <spill>/always-on.ctx.txt <spill>/F1-*.txt <spill>/description.txt
```

Detector rows have a `.ctx.txt`: coordinate hits carry ±4 lines inside their own hunk; a
file-triggered row such as F7 or F14 carries every file's diff (≤60 lines each, ≤400 total).
`always-on.ctx.txt` carries the source diffs for F4/F5/F9/F16 (≤80 lines per file, ≤600
total). A `-- TRUNCATED` marker means the excerpt is not complete evidence: a truncated test
file is `RUN-REQUIRED`, and F4/F5/F9/F16 may pass only after `git diff <target>...HEAD --
<file>` for each omitted file (this counts toward step 3) — otherwise `FAIL | evidence
incomplete`. `F1-<name>.txt` holds the call-site table; `description.txt` matters only when
F16 is in the ledger. Do not read UNDETECTED or CTX-ONLY rows; they are not yours to
re-litigate — promote one only if something you read contradicts it.

## Step 3 — settle by tier (at most three targeted calls)

| sev | what you owe |
|-----|--------------|
| **H** | a decisive artifact: a command you ran in this run and its output (an excerpt alone never settles an H row) — no artifact = FAIL |
| **M** | the ctx read; a command only when it raised a concrete suspicion |
| **L** | one sampled location from the ctx read |

- F1: the call-site table is already spilled as `F1-<name>.txt`; read, then table each site
  as consumes / indifferent-with-proof.
- F5: one `rg` of the fixed pattern's structural shape; table every hit fixed / justified.
- F4: one count or a named bound; an unbounded population on a visible change is FAIL.
- F16: every behavioural claim in `description.txt` needs a code line and a test; reverse:
  behaviour the ctx shows changed but the description does not claim → FAIL.
- Never a sample presented as complete; never the whole MR diff.

**F7 — discriminating tests.** For every changed or new test, judge from its ctx whether it
asserts the production result of the changed behaviour (not a mock of the subject under test,
not a fixture's own value). Then, only when RUNNER is `OK` or `OVERRIDE`: group the tests by
the behaviour they cover, take up to three groups highest risk first, and per group spend
one call: `git worktree add --detach <tmp> HEAD` (for a JavaScript package also
`ln -s <checkout>/<pkg>/node_modules <tmp>/<pkg>/node_modules`, as the RUNNER note says), one
meaningful mutation in the production code, run that file's RUNNER command verbatim from
`<tmp>`, capture the red assertion line, revert, run green, `git worktree remove --force <tmp>`. Paste the red line per group. Groups
you did not mutate, and every group whose RUNNER line is `UNVERIFIED`, `MISSING-DEPS` or
`UNKNOWN`, are `RUN-REQUIRED`
with the exact command from RUNNER (the author runs the mutation and re-invokes the gate
with argument 4). `RUN-REQUIRED` makes the verdict NOT READY; it never makes you build an
environment.

## Step 4 — conclude

Return exactly:

1. The triage `SUMMARY` line plus any `M##` rows from `mr-doctor`.
2. The disposition ledger — one line per id in `LEDGER` plus one R-row per EXPANDED rule,
   no id omitted, none invented:
   `| id | FAIL / REVIEWED_PASS / SAMPLED_PASS / RUN-REQUIRED / N-A | evidence or one-line reason |`
   Every FAIL and every H row carries its decisive artifact; every RUN-REQUIRED carries the
   command.
3. One line: **READY** or **NOT READY**. For NOT READY, each failing row with its concrete
   fix.

Any FAIL or RUN-REQUIRED → NOT READY. No narration, no file dumps, no enumeration of
UNDETECTED rows.

## Other checkpoints (not this gate)

F3 before pushing a batch (`PREFLIGHT_BATCH=1` makes triage intersect open MRs), F26 at
merge, F28 before posting a root-cause claim externally, F29 before closing a ticket — second
table in `failure-modes.md`.

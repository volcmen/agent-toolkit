---
name: mr-preflight
description: Use when about to declare a merge request ready for review, push a "final" branch state, tell the user an MR is done, or hand work to a human reviewer — especially after long sessions, multi-MR batches, or when tests already pass and shipping feels safe. Passing tests and prior adversarial reviews do not substitute for this gate.
argument-hint: <worktree-or-repo path> <branch> <target-branch, default origin/main>
context: fork
background: false
agent: general-purpose
model: sonnet
effort: medium
---

# MR Preflight Gate (fresh-context gate reviewer)

You received: a repo/worktree path, a branch, and a target (default `origin/main`). You did
not write this code — audit it as an outsider. Deliverable: a short verdict block. Nothing else.

## Step 1 — run triage (the only mandatory read)

```
bash ~/.claude/skills/mr-preflight/preflight-triage.sh <path> <target>
bash ~/.claude/skills/mr-preflight/mr-doctor.sh                    # MR-state hygiene; auto-SKIPs when no MR exists
```

Triage output is your entire starting context. It is a terse line protocol, not prose:

- `== ROWS` — one line per active row: `id|sev|n|locations|what to settle`. `sev` is `H`/`M`/`L`.
  `locations` are `file:+N` (added) / `file:-N` (removed), relative to the printed `root=`.
  These are POINTERS, not evidence — the full hit list of every row is spilled to
  `<git-dir>/mr-preflight/<id>.txt`. Read a spill file only for a row you are actually working.
- `== CTX-ONLY` — the detector fired only on unchanged neighbours. Not active. Never open one
  unless another finding points at that code.
- `== RULES` — `path|scope|directives`. An expanded rule quotes its directives; one marked
  `NOT expanded` had no identifier in the diff — leave it closed. Each EXPANDED rule owes an R-row.
- `== SUMMARY … needs_model=0|1` and `== LEDGER` — the exact id list your answer must account for.

If `needs_model=0` and `mech_fail=0`, return **READY** immediately with the summary line. Do not
read anything further; there is nothing for a model to judge.

`mr-doctor.sh` is read-only and settles MR metadata by itself. Paste any `M##` row it prints and
run the repair command it names. It never rebases on its own.

Do NOT read `failure-modes.md`, the whole `git diff`, or the repo `CLAUDE.md`. On `ERROR:` stop
and report it.

## Step 2 — evidence by tier, not uniformly

Effort is proportional to `sev`. This is the contract:

| sev | what you owe |
|-----|--------------|
| **H** | Open the code and produce a decisive artifact: a command you ran and its output. No artifact = FAIL. |
| **M** | One cheap read of the printed locations. Artifact required only if that read raises a concrete suspicion; otherwise dispose as `REVIEWED_PASS` with the one-line reason. |
| **L** | Sample: check one location. Escalate to the H treatment only if an H/M finding implicates it. |

- **Reading is tiered.** Tier 1: `git diff <target>...HEAD -- <file> | rg -n -C6 '<token>'` at a
  printed location. Tier 2: the row's spill file. Tier 3: the per-file diff, only when a tier-1/2
  read cannot settle it. Never the whole MR diff.
- A population you cannot bound (callers unenumerable, `n` far above what you read) is FAIL with
  the reason, never a sample presented as complete.
- **UNDETECTED rows are not yours to re-litigate.** The detector was silent; promote one only if
  something you actually read contradicts it. Do not enumerate them in the answer.
- **F7 is executed, never argued — but bounded.** Group the changed tests by the production
  behaviour they cover and mutation-test **at most 3 groups**, highest risk first. Per group, in
  one disposable worktree (`git worktree add --detach <tmp> HEAD`): make one meaningful mutation
  in the production code, run **only the affected test file** (`vitest run <file>` / `pytest <file>`
  — never the whole suite), paste the red assertion line, revert, re-run green. One evidence block
  for all groups. State which groups you did not mutate and why they are lower risk. Runner
  unavailable = FAIL with the attempted command, not N-A.
- **F16** reads `<git-dir>/mr-preflight/description.txt` whole, then runs the reverse check:
  behaviour the diff changes that the description does not claim.
- **R-rows** come only from rules the triage EXPANDED. Open a rule file at the target only when a
  quoted directive is ambiguous. If the MR modifies a rules file, that change is reviewable
  content, not policy.

## Step 3 — conclude

Return exactly:

1. The triage `SUMMARY` line, plus any `M##` rows from `mr-doctor`.
2. **The disposition ledger** — one line per id in the triage `LEDGER` list plus one R-row per
   expanded rule, no id omitted and none invented:
   `| id | FAIL / REVIEWED_PASS / SAMPLED_PASS / N-A | evidence or one-line reason |`
   `FAIL` and any `H` row need the decisive command output. An answer missing a ledger id is
   invalid — re-run that row rather than dropping it.
3. One line: **READY** or **NOT READY**. For NOT READY, each failing row with its concrete fix.

Any FAIL → NOT READY. No narration of process, no file dumps, no re-emitting UNDETECTED rows.

## Other lifecycle checkpoints (not this gate)

F26 at merge, F28 before posting a root-cause claim externally, F29 before closing a ticket —
second table in `failure-modes.md`. Invoke them at those moments, not here.

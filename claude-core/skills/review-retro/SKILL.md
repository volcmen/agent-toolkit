---
name: review-retro
description: Use when a human reviewer returns findings on work Claude prepared (MR review comments, Slack review write-ups, review artifacts), or when the user says review findings keep recurring — before applying the fixes or right after.
---

# Review Retro — the self-improvement loop

## Overview

Each human review finding is a measurement of a gap in self-review. This skill converts
findings into durable, mechanical prevention: it maintains the failure-modes ledger that
drives the `mr-preflight` gate. One finding → one enforced check. Narrative lessons decay;
detection questions with commands don't.

Files (all under `~/.claude/skills/mr-preflight/`):
- `failure-modes.md` — compact gate-facing index: id, class, trigger, check. Budget ~1.5k tokens.
- `failure-modes-history.md` — origins, recurrence counts, attribution. Retro writes here; the gate never reads it.
- `preflight-triage.sh` — deterministic detectors that decide which rows are TRIGGERED / MECH / N-A / UNDETECTED, and print the check text of active rows.
- `failure-modes-archive.md` — retired or promoted rows (create on first use).

## Procedure

For EACH finding in the review:

1. **Classify against the ledger.**
   - Matches an existing class → increment its `recurrences` count and append the origin in
     `failure-modes-history.md`.
   - No match → append a row to BOTH files: history gets the full origin; the index gets id,
     class, a **trigger** (what in the diff fires it) and a one-line **mechanical check** —
     one that names a command (grep pattern, diff filter, mutation run, count) and a binary
     criterion. "Be careful about X" is not a check. Then add the trigger to
     `preflight-triage.sh` as a `row Fn …` line (regex over added/removed lines, or a file-set
     predicate marked `proven`) and run the script against the branch that produced the
     finding: the new row must print TRIGGERED there, or the trigger is wrong.

2. **Attribute the miss.** For every recurrence (class existed, gate was available, human
   still caught it), record which failure it was:
   - gate not run → strengthen the forcing point (when/trigger wording in mr-preflight);
   - row was UNDETECTED or N-A when it should have fired → widen the script trigger, verify it
     prints TRIGGERED on the offending branch;
   - question answered without evidence → the check allowed reasoning where it should
     demand a command; rewrite it so the evidence is an artifact;
   - check genuinely didn't cover the variant → split or generalize the class.
   The fix is always a FORM change to the ledger/gate, never "try harder next time".

3. **Promote when mechanical.** If a class is fully checkable by a script (grep/lint/AST),
   propose promoting it out of the ledger into a hook or lint rule and, on the user's yes,
   implement it — a hook cannot be forgotten, a prose rule can. Mark the row `promoted`.

4. **Compress on budget.** The gate ingests only ACTIVE rows (triage prints their check
   text), so inactive rows cost nothing per run; the budget that matters is per-row check
   text (one line, ≤ 60 words) and the number of ALWAYS-ON rows (keep ≤ 5). Merge
   overlapping classes when two rows keep firing together; move promoted (fully mechanical)
   rows to `failure-modes-archive.md` once the script settles them. Never retire a rare
   high-severity class only because its recurrence count is low.

5. **Verify the update.** Re-read the changed rows; each must still name a command and a
   binary criterion, and the index must stay within budget. Then state in one line per finding: class id, new/recurrence, what
   changed in the ledger.

## Red flags

- Adding a narrative paragraph instead of a table row.
- Recording a recurrence without step 2's attribution — the count without the cause fixes
  nothing.
- Editing the ledger during preflight (gate consumes, retro writes — one writer).
- Adding an index row without a script trigger — an untriggerable row is invisible to the gate.
- Skipping the retro because "the fixes are already applied" — fixes repair the code;
  the retro repairs the process.

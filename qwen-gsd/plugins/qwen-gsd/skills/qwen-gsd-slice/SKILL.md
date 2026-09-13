---
name: qwen-gsd-slice
description: Use when the user requests an economical Qwen-authored development slice, the next GSD slice, or Codex orchestration while Qwen Code writes production and test code.
---

# Qwen GSD Slice

Codex orchestrates; Qwen Code authors. Deliver one vertical slice small enough
to review as a coherent diff. Reuse the project's architecture and tests, and
add no framework or dependency unless the slice cannot work without it.

## Resolve this bundle

Before invoking a helper, set `QGS_ROOT` to the directory containing this
`SKILL.md`.

- In Claude Code, use
  `QGS_ROOT="$CLAUDE_PLUGIN_ROOT/skills/qwen-gsd-slice"`.
- In Codex, use the absolute directory that directly contains the loaded
  `SKILL.md` (not the directory above it). Codex exposes the file path when it
  lists or loads a skill.

Set it again in each new shell process, then verify it:

```bash
test -f "$QGS_ROOT/scripts/qwen_slice.sh" || {
  printf 'qwen-gsd-slice: invalid QGS_ROOT: %s\n' "$QGS_ROOT" >&2
  exit 2
}
```

Never guess a cache version, search for an arbitrary copy, or fall back to
`~/.codex/skills/qwen-gsd-slice`. If the loaded path cannot be resolved, stop
and report that packaging error.

## Roles and authority

- Codex inspects, scopes, plans, reviews, verifies, updates existing planning
  documents, and commits only when explicitly requested.
- Qwen authors every semantic production-code and test-code edit.
- Codex may mechanically restore historical line endings and final newlines
  after reviewing Qwen's semantic diff.
- If Qwen, its authentication, or the selected model is unavailable, report
  the failed preflight. Do not substitute Codex-authored code.
- Preserve unrelated dirty-worktree changes.

Treat an implementation request as authority for necessary in-project files,
tests, planning documents already in use, and routine checks. Ask only for an
unresolved product choice, ambiguous project target, dependency, credential,
destructive action, external write, or commit authorization.

## Preflight

Before scoping a slice, read
[`references/configuration-and-preflight.md`](references/configuration-and-preflight.md),
resolve the effective budgets and model, and run its preflight. Continue only
when the wrapper reports `exit_code=0` and `result=success is_error=False`.

## Slice workflow

1. Resolve the target from the active directory or explicit user path. In Git,
   use the repository root as the command root and the launch directory as the
   scope anchor. If `.planning/` exists, read the active GSD state and next
   plan; never initialize GSD merely because this skill ran.
2. Trace the real flow and callers. Choose one vertical slice with explicit
   requirements, allowed files, exclusions, targeted checks, and one existing
   project-level verification command.
3. Update the project's existing plan before the run when appropriate. Codex,
   not Qwen, owns planning edits.
4. Record `git status`, semantic diff scope, and mixed-EOL files when Git is
   available. Skip Git-only steps in non-Git projects.
5. Write a slice brief. It must name exact allowed production/test files,
   requirements, invariants, exclusions, and targeted checks. Tell Qwen to make
   semantic edits after one bounded read pass and return one concise report.
   Forbid commits, planning edits, dependencies, unrelated formatting, EOL
   normalization, temporary repair scripts, backups, and diff dumps.
6. Read [`references/runner.md`](references/runner.md), then launch one fresh
   session with `"$QGS_ROOT/scripts/qwen_slice.sh" --prompt-file <brief>`.
   Let the configured wall-time guard the run. Interrupt only visibly
   degenerate activity such as sustained formatting churn or helper-file
   creation after useful edits stop.
7. Treat every abort as potentially partial. Review the actual diff for scope,
   root behavior, duplicate application, trust boundaries, deterministic
   state, error paths, EOL churn, missing final newlines, and generated
   byproducts such as `__pycache__/`.
8. Run the smallest targeted checks that confirm the review and log the review
   result. If defects remain, send one consolidated correction to the same
   session. One correction round is the limit.
9. After review settles, run exactly one project-level verification command.
   Skip it only for documentation-only or byte-only EOL changes.
10. Commit code and planning results separately only when explicitly
    requested. Otherwise leave the changes uncommitted.
11. Read [`references/observability.md`](references/observability.md) and report
    ledger evidence: status and reason, actual model, effective budgets,
    `fresh_plus_output`, warnings, checks, and the next slice boundary.

## Non-negotiable execution rules

- The requested model must match the `init` event. Never infer it from the
  request or shell exit code.
- `exit_code=0` alone is not success; require a non-error structured result.
- Exit 55, a missing result, or an interrupted run can leave edits on disk.
  Inspect before resuming or changing anything.
- Resume the same session only for the single correction round. The wrapper
  restores the authoring model from the ledger unless `--model` explicitly
  overrides it.
- Never expose secrets, provider settings, API keys, or environment dumps in a
  brief, allowed-file list, command output, or report.

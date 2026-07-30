# DDR-0006: A card's workspace is enforced, and `repo` is the default

- Status: accepted
- Date: 2026-07-27

## Context

The first cut of the card model had a `workspace` field with values
`scratch | repo | worktree`, defaulted to `scratch`, and **nothing read it**. Every
worker ran with `cwd = workdir` and codex's `-s workspace-write`. The first live
run proved the hazard: a card whose frontmatter said `workspace: scratch` wrote
`server.js`, `package.json`, and a test directory straight into the repo.

A field that names an isolation level it does not provide is worse than no field:
it invites someone to rely on it.

## Decision

`src/workspace.ts` resolves the field before every run and the dispatcher uses the
result as the process `cwd`:

- `repo` — the board's `workdir`. **This is the new default**, because it is what a
  coding card almost always wants, and defaults must describe what actually happens.
- `worktree` — `git worktree add -b ab/<card-tail> board/.work/worktrees/<tail>`.
  Reuses the branch if it already exists (a retried card returns to its own tree).
- `scratch` — an empty `board/.work/scratch/<tail>`. The repo is not the cwd, and
  the worker's working agreement says so explicitly and tells it to stop with
  `BLOCKED` if the card cannot be done without the repo.

A failed worktree creation **blocks the card** with git's error. It never falls
back to the real checkout. The resolved workspace also rewrites the working
agreement line in the prompt, so the worker is told which of the three it is in
rather than having to infer it.

## Consequences

- `--workspace worktree` makes parallel cards on one repo safe, which is what
  `maxRunning > 1` needs to be useful.
- `scratch` is now genuinely useful for analysis, drafting, and research cards.
- Worktrees accumulate: nothing removes them yet, so `git worktree list` grows and
  `git worktree remove` is manual. Tracked as a gap in the README.
- Cards written before this change carry `workspace: scratch` and will now run
  outside the repo. That only affects boards created during the build.
- Read-only roles are unaffected — they are already sandboxed by the runner
  (`-s read-only` / a read-only tool allowlist), independently of this field.

## Alternatives

- **Drop the field** until worktrees were needed: simpler, but `maxRunning > 1` on
  one checkout is unsafe without it, and the field was already in the format.
- **Make `scratch` mean read-only in the repo**: conflates "cannot write" with
  "somewhere else to write", and read-only is already a role property.

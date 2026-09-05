# claude-core

The version-controlled source of David's personal Claude Code configuration:
`~/.claude/CLAUDE.md`, the always-on `rules/`, the `mr-preflight` gate and
`review-retro` skills with their scripts and failure-modes ledger, the F17
hooks, and the browser reference `chrome-cdp.md`. Claude Code reads them from
`~/.claude` through symlinks that `scripts/manage.py` creates and verifies.

Not a marketplace plugin: `CLAUDE.md` and `rules/` are user-level files that a
plugin cannot ship. The layout mirrors `shared-agents/`, which owns
`~/.claude/agents/` the same way.

## Layout

| Path in this directory | Link in `~/.claude` | Kind |
| --- | --- | --- |
| `CLAUDE.md`, `chrome-cdp.md` | same name | file link |
| `rules/{workflow,testing,waiting,code-style}.md` | `rules/<name>` | file link |
| `hooks/f17-{ticket-keys,comment-count}.sh` | `hooks/<name>` | file link |
| `skills/mr-preflight/`, `skills/review-retro/` | `skills/<name>` | directory link |

Skill directories are linked whole so that files the skills create at runtime
(for example `failure-modes-archive.md`) land in this repository instead of
drifting inside `~/.claude`. Unmanaged neighbours — `rules/obsidian-vault.md`,
`skills/pr-review`, `skills/using-git-worktrees`, `settings.json`, `agents/` —
are never touched.

Every `~/.claude/...` path literal inside the managed files must name either a
managed file that exists in this repository or one of the known containers
(`rules/`, `hooks/`, `skills/`, the two skill directories); `check` fails
otherwise, and `status` proves each literal resolves through the live links,
including the callers in `settings.json` and `agents/*.md`.

## Commands

```bash
python3 claude-core/scripts/manage.py check      # inventory, modes, reference edges, unit tests
python3 claude-core/scripts/manage.py install    # create or repair the links; idempotent
python3 claude-core/scripts/manage.py status     # verify the live installation
python3 claude-core/scripts/manage.py uninstall  # remove exact managed links only
```

`install` backs up any regular file, directory, or foreign link it replaces
under `~/.config/claude-core/backups/<timestamp>/`, mirroring the path under
`~`. `uninstall` removes only links that point exactly at this checkout; a
locally edited copy stays in place and `status` reports it.

## Recovery

1. `python3 claude-core/scripts/manage.py status` names every link that is
   missing, dangling, replaced by a regular file, or pointing elsewhere.
2. `python3 claude-core/scripts/manage.py install` repairs them and backs up
   whatever it displaces.
3. To restore a displaced file, copy it back from the newest directory under
   `~/.config/claude-core/backups/` after `uninstall`.

Edit the files here; the links make the change live immediately. The
`mr-preflight` triage cache keys on script bytes, not paths, so linking does
not invalidate it.

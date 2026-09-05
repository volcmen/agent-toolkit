# claude-core

The version-controlled source of David's personal Claude Code configuration:
`~/.claude/CLAUDE.md` (the compact always-on core), the rules `code-style.md`
(path-scoped, loads only with code files) and `waiting.md`, the on-demand
`engineering` skill with its phase references, the `mr-preflight` gate and
`review-retro` skills with their scripts and failure-modes ledger, the F17
hooks, and the browser reference `chrome-cdp.md`. Claude Code reads them from
`~/.claude` through symlinks that `scripts/manage.py` creates and verifies.

Within the consolidation corpus — `CLAUDE.md`, `rules/code-style.md`,
`rules/waiting.md`, `skills/engineering/` — a rule lives in exactly one place:
`CLAUDE.md` states it, a rule file or an `engineering` reference elaborates
it. The test suite keeps the always-on budget (`CLAUDE.md` ≤ 3.5 KB; core +
`waiting.md` + the plugin-owned Obsidian rule ≤ 9.5 KB; with `code-style.md`
≤ 16 KB) and rejects a sentinel phrase that appears in more than one corpus
file; the gate and retro skills keep their own vocabulary.

Not a marketplace plugin: `CLAUDE.md` and `rules/` are user-level files that a
plugin cannot ship. The layout mirrors `shared-agents/`, which owns
`~/.claude/agents/` the same way.

## Layout

| Path in this directory | Link in `~/.claude` | Kind |
| --- | --- | --- |
| `CLAUDE.md`, `chrome-cdp.md` | same name | file link |
| `rules/{waiting,code-style}.md` | `rules/<name>` | file link |
| `hooks/f17-{ticket-keys,comment-count}.sh` | `hooks/<name>` | file link |
| `skills/engineering/`, `skills/mr-preflight/`, `skills/review-retro/` | `skills/<name>` | directory link |

Skill directories are linked whole so that files the skills create at runtime
(for example `failure-modes-archive.md`) land in this repository instead of
drifting inside `~/.claude`. Unmanaged neighbours — `rules/obsidian-vault.md`,
`skills/pr-review`, `skills/using-git-worktrees`, `settings.json`, `agents/` —
are never touched.

Every `~/.claude/...` path literal inside the managed files must name either a
managed file that exists in this repository or one of the known containers
(`rules/`, `hooks/`, `skills/`, the three skill directories); `check` fails
otherwise, and `status` proves each literal resolves through the live links,
including the callers in `settings.json` and `agents/*.md`.

## Commands

```bash
python3 claude-core/scripts/manage.py check      # inventory, modes, reference edges, unit tests
python3 claude-core/scripts/manage.py install    # create or repair the links; idempotent
python3 claude-core/scripts/manage.py status     # verify the live installation
python3 claude-core/scripts/manage.py uninstall  # remove exact managed links only
```

`install` first prunes stale links: a dangling symlink in a managed directory
whose target lies inside this checkout (a rule that was merged away) is
removed, while foreign links, live links, and regular files stay. It then backs
up any regular file, directory, or foreign link it replaces under
`~/.config/claude-core/backups/<timestamp>/`, mirroring the path under `~`.
`uninstall` removes only links that point exactly at this checkout; a locally
edited copy stays in place and `status` reports it.

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

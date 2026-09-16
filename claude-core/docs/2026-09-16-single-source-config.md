# 2026-09-16 — claude-core becomes the single source for the Claude Code setup

## Why

An audit on 2026-09-15/16 found the personal Claude Code configuration split across five
unversioned places: hook wiring, statusline and attribution in `~/.claude/settings.json`
(two keys had silently vanished since 2026-09-07 and were restored from a stray backup);
`~/.claude/statusline.py` and `~/.claude/keybindings.json`; the R7 pre-push guard under
`~/.config/git-guards/`; four in-house plugins delivered to Claude as marketplace **copies**
whose registration had already drifted (`plugins.py status`: claude `MARKETPLACE MISSING OR
STALE`); and 41 MB of dead marketplaces plus a disabled plugin whose ruleset was already
absorbed into `skills/engineering/references/minimalism.md`.

## Decisions

| Area | Decision |
|---|---|
| `settings.json` | claude-core owns exactly `hooks`, `statusLine`, `attribution` as `settings/managed.json`; `install` replaces those keys wholesale (backup first), `status` reports drift; every other key stays Claude-owned |
| In-house plugins | absorbed for Claude — skill directories linked live from the sibling projects, obsidian hooks moved into the fragment; Codex keeps consuming them as plugins from the same sources (`claude_delivery: "claude-core"` in `plugins.json`) |
| Removed from Claude | plugins `obsidian-memory`, `codex-pair`, `chatgpt-consult`, `qwen-gsd` (`@ai-workspace`), `ponytail@ponytail`; marketplaces `ai-workspace`, `agricidaniel-claude-obsidian`, `humanizer`, `karpathy-skills`, `superpowers-marketplace`, `ponytail` |
| Kept as plugins | `codex@openai-codex`, `rust-analyzer-lsp@claude-plugins-official`, `ui-ux-pro-max` (project scope) |
| Hook hygiene | `timeout: 5` on the `rtk` and `guard-red-write.py` PreToolUse entries; f17 keeps 10 |
| Memory | `MEMORY.md` curated 23,179 → 8,159 bytes (115 → 55 entries); 57 finished ticket/MR/cutover notes moved to `memory/archive/`, one note retired |

Wholesale replacement rather than deep merge: `hooks` entries have no identity to merge on,
and "claude-core owns these keys" is only checkable as exact equality.

## What changed in the repo

- `scripts/manage.py`: `WORKSPACE_MANAGED` (repo-root-relative sources → `~/.claude`
  targets), `EXTERNAL_MANAGED_FILES` (`~/.config/git-guards`), `settings_fragment()`,
  `settings_drift()`, `install_settings()`; inventory 12 → 23 links.
- New managed sources: `statusline.py`, `keybindings.json`, `git-guards/{install,
  pre-push-foreign-history}`, `settings/managed.json`.
- `codex-pair` and `qwen-gsd-slice` SKILL.md resolve their bundle from the real path of the
  loaded `SKILL.md` (Claude announces the symlink path), no `$CLAUDE_PLUGIN_ROOT`.
- `scripts/plugins.py`: `claude_delivery` catalog field; `status` verifies each delivered
  plugin's skill links resolve into this checkout and no longer requires a Claude marketplace.
- `skills/mr-preflight/SKILL.md`: required hunks are reviewed against the minimalism ladder
  (the one ponytail idea that was not yet ported).

## Cutover log (one sitting)

1. `~/.claude/settings.json` snapshot → `~/.claude/backups/settings.json.pre-cutover-20260916T115816Z`.
2. `claude plugin uninstall` ×5, then `manage.py install`: 10 new links, 4 replaced regular
   files backed up under `~/.config/claude-core/backups/20260916T115824Z/`, fragment already
   in sync.
3. Diff gate: no key outside `hooks`/`statusLine`/`attribution`/`enabledPlugins`/
   `extraKnownMarketplaces` changed.
4. `claude plugin marketplace remove` refused (`known_marketplaces.json` "corrupted": three
   entries re-added by hand on 2026-09-15 lacked `installLocation`/`lastUpdated`); the six
   entries were removed from `plugins/known_marketplaces.json` and
   `settings.extraKnownMarketplaces` directly, then `claude plugin marketplace list` was clean.
5. One-off cleanup under `~/.claude`: `chrome-cdp.original.md`, `.ponytail-active`,
   `bash-commands.log`, `cost-tracker.log` (815 KB, unwritten since 2026-08-01),
   `policy-limits.json.stamp.json.tmp.*`, `.DS_Store` removed; two stray settings backups
   moved into `backups/`; `plugins/marketplaces/{AgriciDaniel-claude-obsidian,humanizer,
   karpathy-skills,superpowers-marketplace,ponytail}`, `plugins/cache/{ponytail,ai-workspace}`
   and four empty `plugins/data/*` dirs removed.

## Evidence

- `manage.py status`: `ok — 23 link(s), 6 agent file(s), 31 reference edge(s) resolve;
  settings fragment in sync`.
- `plugins.py status`: codex `ok` ×4, claude `claude-core` ×4, `marketplace not needed`.
- Smokes from the linked paths: `guard-red-write.py` → `deny` on `git push --no-verify`;
  `statusline.py` renders two lines; `obsidian_memory.py session-start` prints the capsule;
  `git-guards/install --audit` runs.
- The five absorbed skills appear unnamespaced in the running session's skill list.
- Unit suites: see the commit's `verify-run` ledger entry (`claude-core-check`,
  `workspace-plugins-check`).
- Baseline before: 72 sessions / 7 days, first-context median 64,840 tokens
  (`scripts/session-metrics.py --days 7`). After-metrics need new sessions; re-run
  `--days 1` after a day of use.

## Environment finding during verification

The first workspace gate run failed in `codex-pair` and `qwen-gsd` with `mise ERROR … config
not trusted`. Swapping the baseline `SKILL.md` files back reproduced the same failures, so the
edits were not the cause: `~/.local/share/mise/shims/python3` was a stale shim (python is not
mise-managed) and mise 2026.9.9, installed 2026-09-15, aborts under the sandboxed `HOME` those
tests use. `mise reshim` kept the stale shims; deleting the `python*`/`pip*` shim files fixed
both suites. The ledger keeps that red run as a preserved first failure for its tree, so the
final evidence is the green run against the follow-up commit.

## Second opinions and the follow-up increment

ChatGPT (work project, lean profile) and Codex (`codex-pair shape`, gpt-5.6-sol/xhigh) were
both asked to red-team a seven-item candidate list under the constraints above. They
converged: repair verification evidence first, measure first-context composition before
cutting any instruction text, and do not build a doctor command, a statusline daemon, a hook
framework, a transcript-driven hard budget, or an MCP fragment until drift is an observed
problem. Codex added evidence from `metrics/gate-runs-2026-09-06.txt`: a fork's ~50K birth
context is platform scaffolding — `mcpServers: []` saved nothing and a tools allowlist ~1.5K —
so the 64.8K median is not addressable from this repo's prose.

Landed from that:

- `scripts/plugins.py check` now ends with a unittest-shaped `Ran N tests` / `OK` summary
  aggregated from the child suites' own runner output (`count_tests`), so the evidence ledger
  records the workspace gate with counts instead of `VACUOUS`. Check-script `ok` lines are
  not counted as tests.
- `statusline.py` cached git state for 5 s while the status line refreshes every 5 s, so
  nearly every refresh spawned three `git` processes; the cache now lives 20 s.
- `hooks/guard-red-write.py` answers `permissionDecision: ask` when it cannot read the hook
  payload, instead of silently allowing; a readable clean command still produces no output.

Deferred with reasons: MCP-server fragment (`~/.claude.json` also carries mutable app state;
no observed drift), hook timeout matrix (no failing or slow hook observed; timeouts are
already 5–30 s), context budget gate (per-session values are too noisy for a blocking check),
doctor (status already reports live drift). User-side lever outside the repo: eleven claude.ai
connectors expose only an `authenticate` tool and still cost a name each in every session.

## Rollback

Settings: copy the pre-cutover snapshot back. Links: `manage.py uninstall` removes only links
into this checkout; the replaced regular files are in the claude-core backup dir above.
Plugins: `python3 scripts/plugins.py install` after removing `claude_delivery` from
`plugins.json` restores the marketplace path. Memory: move a note out of `memory/archive/`
and re-add its index line.

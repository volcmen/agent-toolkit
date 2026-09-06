# claude-core

The version-controlled source of David's personal Claude Code configuration:
the compact always-on core, rules, engineering and review skills, hooks,
browser reference, controller, and specialist agents. One lifecycle CLI owns
validation, rendering, installation, verification, and removal under `~/.claude`.

## Install model

| Source in this directory | Destination in `~/.claude` | Mechanism |
| --- | --- | --- |
| `CLAUDE.md`, `chrome-cdp.md` | same name | file symlink |
| `rules/{waiting,code-style}.md` | `rules/<name>` | file symlink |
| `hooks/f17-{ticket-keys,comment-count}.sh` | `hooks/<name>` | file symlink |
| `skills/engineering/`, `skills/mr-preflight/`, `skills/review-retro/` | `skills/<name>` | directory symlink |
| `agents/rendered/*.md` | `agents/<name>.md` | regular-file copy |

Edits to linked files are live immediately. Skill directories are linked whole
so files created at runtime, such as `failure-modes-archive.md`, land in this
repository. Agent definitions are deliberately copied: Claude Code watches the
user-agent directory, and this project owns regular files there. Catalog or
prompt edits require rendering and installation to refresh those copies.

`install` renders the agents first, then validates the entire package before
changing any live target. It prunes dangling symlinks in managed directories
only when their target lies inside this checkout. Live links, foreign stale
links, and regular neighbours survive that pruning.

Any file, foreign link, or directory replaced by either installation mechanism
is backed up under `~/.config/claude-core/backups/<timestamp>/`, mirroring its
path under `~`. Existing exact links and byte-identical regular agent copies
are unchanged; a second install performs no replacements or backups.

`status` checks both mechanisms, reference resolution, rendered drift, and
whether user settings select a different primary agent. `uninstall` removes
only links pointing exactly at this checkout and byte-identical regular agent
copies. User-modified files, foreign links, unmanaged neighbours, and backups
remain. To recover a displaced path, uninstall and restore it from its backup.
Backups made by the former agent installer remain recoverable in their original
location; this installer writes all new backups under `claude-core`.

Unmanaged rules, skills, agents, and `settings.json` remain user-owned. This
standalone project has no marketplace plugin lifecycle and performs no Codex,
plugin, or shell configuration installation. The local `clauded` Fish alias
is user-managed.

## Commands

Run from the workspace root with Python 3.11 or newer:

```bash
python3 claude-core/scripts/manage.py render
python3 claude-core/scripts/manage.py check
python3 claude-core/scripts/manage.py install
python3 claude-core/scripts/manage.py status
python3 claude-core/scripts/manage.py uninstall
```

`render` updates generated provider files. `check` validates the inventory,
executable modes, reference edges, agent catalog, native model and tool
contracts, and Codex TOML, then runs the whole `tests/` directory. It does not
install anything. The workspace gate includes the same check:

```bash
python3 scripts/plugins.py check
```

To verify rendering without writing, or run the tests directly:

```bash
cd claude-core
python3 scripts/render.py --check
python3 -m unittest discover -s tests
```

## Agent sources and architecture

`agents/agents.json` owns names, descriptions, provider models, reasoning, and
tool boundaries. Its prompt paths are relative to `agents/`. Shared instruction
bodies live in `agents/prompts/`; `scripts/render.py` deterministically produces
Claude Markdown in `agents/rendered/` and Codex TOML in `agents/codex/agents/`.
Edit the catalog or prompts rather than generated files. The existing generator
header retains its historical path to preserve the rendered bytes.

The shared layer owns behavior; each provider adapter owns execution syntax and
model selection. `agents/codex/controller.config.toml` and
`agents/policy/codex-global.md` retain the dormant Codex controller profile and
policy. The Codex controller is the primary thread, not a spawnable worker.

| Claude role | Agent and contract |
| --- | --- |
| Controller | Fable `controller`, medium effort; primary thread only |
| Task analyst | Sonnet `task-analyst`; concise execution brief |
| Repository explorer | Sonnet `Explore`; compact report; overrides the built-in Explore agent |
| Writing specialist | Opus `alan-wake`, medium effort, plan permission mode, eight turns; ready-to-use artifact |
| MR quality gate and fixer | Sonnet `mr-review-fixer`, high effort, project memory; quality-gate report |
| Gate fork target | Sonnet `gate`, medium effort, 40 turns, Bash/Read/Grep/Glob; fork target of `mr-preflight`, never dispatched by the controller |

The controller prompt owns delegation, model selection, specialist routing,
prose routing, and peer sessions. `CLAUDE.md` owns invariants; the `engineering`
skill owns procedure. `mr-review-fixer` points at the preflight failure-modes
ledger and engineering references instead of restating them.

Requested Slack messages, work-item text, PR/MR titles and descriptions, review
comments, emails, docs, release notes, status updates, decisions, requests, and
handoffs route automatically to Alan Wake. The controller establishes the
artifact, audience, destination format, and desired action; gathers verified
facts; delegates drafting; and checks the result for unsupported claims or
commitments. Alan Wake stays read-only, has mutating tools denied, retains
connected read tools, and never publishes. Ordinary conversation, code-only
output, exact transcription, and explicit opt-out bypass this route.

Routing and writing evaluations live in `agents/evals/`. Official design
references are in [agents/docs/sources.md](agents/docs/sources.md).
`agents/docs/superpowers/` preserves historical plans and specifications; this
README is the current installation contract.

## Configuration contracts

Within `CLAUDE.md`, `rules/code-style.md`, `rules/waiting.md`, and
`skills/engineering/`, each rule lives in exactly one place: the core states it,
and a rule file or engineering reference elaborates it. Tests enforce the
always-on budget: core at most 3.5 KB; core, waiting, and the plugin-owned
Obsidian rule at most 9.5 KB; with code style at most 16 KB. Sentinel phrases
cannot repeat across corpus files. Gate and retro skills keep their own
vocabulary; code style retains its code-file scope.

Every `~/.claude/...` path literal in managed files, skills, and agent prompts
must name an existing managed source or a known container: `rules/`, `hooks/`,
`skills/`, `agents/`, or a managed skill directory. `check` rejects broken or
unmanaged references. `status` also checks live resolution, including references
from `settings.json` and installed agents. The preflight triage cache keys on
script bytes, so moving or linking the scripts does not invalidate it.

## Measuring

`python3 claude-core/scripts/session-metrics.py --days 7` summarizes local
Claude Code transcripts under `~/.claude/projects`: initial and peak context,
cache-read and output tokens, compactions, Bash timeouts, status polling,
and subagent birth context and cost. Baseline snapshots live in `metrics/`.

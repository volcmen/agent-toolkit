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
| `hooks/f17-{ticket-keys,comment-count}.sh`, `hooks/guard-red-write.py` | `hooks/<name>` | file symlink |
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
| Writing specialist | Sonnet `alan-wake`, medium effort, plan permission mode, eight turns; Read/Grep/Glob only |
| MR quality gate and fixer | Sonnet `mr-review-fixer`, high effort, project memory; quality-gate report |
| Independent reviewer | Sonnet `gate`, medium effort, 20 turns, Bash/Read/Grep/Glob; optional independent preflight review |

The controller prompt owns delegation, model selection, specialist routing,
prose routing, and peer sessions. `CLAUDE.md` owns invariants; the `engineering`
skill owns procedure. `mr-review-fixer` points at the preflight failure-modes
ledger and engineering references instead of restating them.

Routine workplace messages and small descriptions stay in the primary thread.
Alan Wake handles explicit requests, substantial rewrites, delicate wording,
and long documents using the shared engineering writing reference. The parent
supplies verified facts, checks the returned draft, and fixes mechanical
formatting directly. Neither drafting nor review authorizes publication.

Routing and writing evaluations live in `agents/evals/`. Official design
references are in [agents/docs/sources.md](agents/docs/sources.md).
`agents/docs/superpowers/` preserves historical plans and specifications; this
README is the current installation contract.

## Configuration contracts

Within `CLAUDE.md`, `rules/code-style.md`, `rules/waiting.md`, and
`skills/engineering/`, each rule lives in exactly one place: the core states it,
and a rule file or engineering reference elaborates it. Corporate-system detail
lives in `skills/engineering/references/corporate-systems.md`, loaded by the core
route when shared systems or publishing are involved. Tests enforce the
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

## Verification evidence

`scripts/verify-run.py --scope <name> -- <command>` runs a verification command
and appends one JSON line to `<git-common-dir>/guard-verify.jsonl`: the tracked
tree it ran against, the full worktree tree, whether the worktree was dirty, the
untracked paths that were present, a digest of the lockfiles, the interpreter
and platform, the command, its exit status, duration, the test counts parsed
from its output, and a chain hash over the previous entry.

`--gate <tree-ish>` answers whether a tree has usable evidence, and never
answers unknown as success:

| state | meaning |
| --- | --- |
| `PASS` | a green run that counted tests, under the current lockfiles |
| `MISSING` | nothing ran against this tree |
| `VACUOUS` | exit zero with no test counted — a typecheck, an empty collection |
| `FAIL` | a scope's last authorized attempt failed |
| `FLAKY` | a scope passed only after failing; the first failure is preserved |
| `STALE` | every passing run predates the current dependency digest |

`~/.config/git-guards/pre-push-foreign-history` reads it as rule R7. R7 is
advisory by default and prints `UNVERIFIED`; `git config --bool
guard.requireVerify true` makes it blocking in that clone, and
`git config guard.verifyRun <path>` points it at this checkout. A push whose
whole change is prose is exempt — `.md`, `.txt`, `.rst`, `docs/`, `LICENSE` —
but instruction files, hook and CI definitions and anything under `rules/`,
`hooks/`, `skills/`, `.claude/` or `.github/` are verification-sensitive inputs
and are deliberately not prose.

The wrapper, the ledger and the chain are all writable by the user they
describe, so this is evidence and not proof: it catches the stale tree, the
vacuous run, the red-then-green and the never-run suite. It is not an
authorization boundary, and it says nothing about whether the tests are good.

`scripts/test-quality-scan.py <paths>` covers the other half — assertion-free
tests, mock-only assertions, retry policies that hide a flake, and seeds pinned
on the default exploration path. A seed inside a named `register_profile` or
read from `FC_SEED` is replay machinery and is reported as advisory.

## Personal work tracking

The shared [tracking guide](skills/engineering/references/tracking.md) routes
ongoing work in Claude Code and Codex to a verified personal Linear workspace.
The Claude core and the personal Codex `AGENTS.md` point to the same file;
the latter is a local addition outside the Obsidian-managed block. Repository
policy still owns official Jira/GitHub/GitLab tracking. Linear keeps personal
actions, and migrated Obsidian tasks become locators rather than duplicate state.

The `linear-personal` MCP connection is configured separately in each client.
Account and workspace IDs live locally in `~/.config/work-tracking/linear.json`;
credentials remain in the clients' authentication stores. See the
[setup record](docs/2026-09-06-personal-work-tracking.md) for installation,
verification, and remaining setup. The existing whole-directory engineering
link exposes the guide without a new plugin or background dispatcher.

## Preflight and writing defaults

`mr-preflight` runs in the current conversation. `preflight-snapshot.py` provides
an offline, read-only inventory of committed HEAD, merge base, target, excluded
local edits, paths, and whitespace evidence; it never returns readiness.
Known review and test results can be reused for unchanged inputs. The optional
`gate` reviewer covers high-risk or unfamiliar changes; a completed independent
`mr-review-fixer` pass can satisfy it. Mutation testing is reserved for a
specific unresolved doubt about test discrimination. Results distinguish
READY, CHANGES NEEDED, and INCOMPLETE, with short exception-focused output.

The old `preflight-triage.sh`, runner probes, and `mr-doctor.sh` remain opt-in
diagnostics for their existing callers. Their caches and heuristic classifications
are not reusable readiness evidence. The default path does not run them.

Routine workplace drafts stay inline. `engineering/references/writing.md` is
the shared contract for the primary thread and Alan Wake: concise prose, named
links in the actual output format, and no automatic publishing. See
[the refresh record](docs/2026-09-06-agent-refresh.md) for evidence and limits.

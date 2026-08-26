# Personal Wiki integration

This project is the canonical source for the Obsidian knowledge and durable
memory integration shared by Codex and Claude Code.

The marketplace itself is workspace-wide: this project owns
`plugins/obsidian-memory/` and nothing else about distribution. See
[`../README.md`](../README.md#one-marketplace-both-agents) and the root
`plugins.json`.

## Layout

- `ARCHITECTURE.md`: lifecycle, trust boundaries, and source map.
- `plugins/obsidian-memory`: dual-agent plugin source.
- `scripts/check.py`: read-only local and CI validation.
- `scripts/install.py`: configure and install both agent integrations.
- `scripts/update.py`: validate, refresh, and reinstall updated plugin versions.

## Install

```bash
python3 scripts/install.py --vault "/absolute/path/to/Obsidian Vault"
```

The installer:

1. Creates the local vault configuration.
2. Symlinks the canonical policy into Claude Code's dedicated rules directory
   and maintains a marked policy block in Codex's global `AGENTS.md`, preserving
   unrelated personal guidance.
3. If the upstream `claude-obsidian` marketplace is present, symlinks its
   skill collection into Codex so upstream skill updates are shared live.
4. Removes the superseded legacy global Claude hooks after backing up settings.
5. Hands registration to the workspace installer (`../scripts/plugins.py
   install`), which registers the single `ai-workspace` marketplace and installs
   every catalogued plugin — this one included — in both agents.

Use `--skip-upstream-skill-link` when the upstream Claude plugin should remain
Claude-only. The link never copies or forks those skills: its target remains
the marketplace checkout managed by Claude Code.

Codex requires a one-time review of new or changed command hooks. Open `/hooks`,
inspect the two `obsidian-memory` commands, and trust them. Trust is tied to the
hook definition, so changed hooks require a new review.

Auto-commit is disabled by default for new installations. Pass `--auto-commit`
to preserve the current personal behavior. When enabled, changed Markdown notes
under `wiki/`, `projects/`, `daily/`, and `inbox/` are committed; dot-private,
non-Markdown, and unrelated paths remain untouched.

For an explicit, one-off commit of exactly selected Markdown notes, repeat
`--path`; the Stop hook remains driven only by configured commit paths:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py commit \
  --path wiki/hot.md \
  --path projects/acme/decision.md
```

Start new Claude Code and Codex threads after installation.

## Validate

Run the non-mutating gate during development:

```bash
python3 scripts/check.py
```

It checks Python syntax, manifests, marketplace metadata, the shared hook
contract, safe configuration defaults, memory-governance invariants, the
behavioral and retrieval-contract evaluation schemas, relative documentation
links, and the unit suite using only the Python standard library. CI runs the
same command. The checked recall-eval example is validated, not executed. The
behavioral cases in `plugins/obsidian-memory/evals/memory-evals.json` are also
validated for shape, never executed; running them is a manual review activity
described in
[the evaluation reference](plugins/obsidian-memory/skills/obsidian-memory/references/evaluation.md).

The plugin deliberately keeps Obsidian Markdown as the always-on, auditable
memory provider. Action-driving memories carry provenance and validity, while
raw episodes must pass evaluation before becoming reusable guidance. Recall is
provider-backed: dependency-free `native` lexical search is always available;
optional QMD adds local BM25, vector, and hybrid discovery. `auto` prefers QMD
when enabled and available, isolates query failures, and reports its fallback
to native rather than making memory unavailable. No QMD server or model work
runs in hooks.

QMD 2.8.3 is a Bun-owned, local derived accelerator. Its caches and embeddings
are disposable: Markdown and Git are the recovery authority. No vault content
is mirrored to Hermes or another external memory provider. QMD HTTP/MCP,
project-local configuration, external source paths, and custom model URIs are
not enabled.

Memory is progressively disclosed:

1. **L0 — session capsule:** the current hot-cache item, aggregate task/capture
   counts, and routes to deeper memory. The default `focused` profile does not
   inject task bodies or historical `Prior:` paragraphs.
2. **L1 — recall hits:** compact snippets, paths, scores, and governance state,
   bounded by `max_recall_tokens`. Superseded hits follow a bounded,
   cycle-checked chain to their first non-hidden successor; stale, expired, and
   not-yet-valid notes stay hidden unless `--include-stale` is explicit.
3. **L2 — source notes:** agents open only relevant Markdown files and verify
   provenance before acting.

Automatic commits enumerate exact Markdown files under configured roots and
commit only those literal paths. Unrelated staged changes, dot-prefixed paths,
symlink escapes, non-Markdown files, and directory-shaped explicit targets are
excluded or rejected before commit creation. `commit --path <vault-relative.md>`
is repeatable and exact; omitting `--path` uses the configured safe roots.

Supersession links resolve from the source note's directory unless they are
explicitly rooted under an active recall root. A bare filename may fall back
only to one unique safe match. Missing, ambiguous, cyclic, private,
out-of-root, and out-of-scope routes fail closed.

The default provider works without setup. Restrict a query to a known project
when possible:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py recall \
  "current database decision" --scope projects/acme --mode fast \
  --max-tokens 600
```

Inspect the canonical store, provider selection, capabilities, and health:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py providers --json
```

Run retrieval-contract evaluation and governance audit manually from the
`wiki/` project root:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate path/to/recall-evals.json --json
python3 plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
```

`evaluate` returns 0 when every case passes, 1 when a valid suite has failed
cases, and 2 when the fixture or configuration is invalid. Its report contains
case IDs, requested and effective provider/mode, degradation, elapsed time,
result-token and stale-filter counts, and vault-relative result paths. It never
emits fixture queries, note bodies or snippets, tracebacks, or resolved fixture
and vault paths. Operator-authored IDs must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,119}` and are emitted verbatim, so use only
non-sensitive opaque labels. Omitted `allow_degraded` defaults to `false`.

`audit` returns 0 when no errors are present, 1 when findings include errors,
and 2 when configuration prevents the audit. Its bounded findings use fixed
codes and never note bodies or frontmatter values. Note and traversal findings
use vault-relative paths; configuration/provider findings use the fixed
`configuration` locator. Human output escapes controls and truncates each
displayed locator to 180 characters; JSON preserves the exact safe locator
inside the 200-finding report bound. Configuration admits at most 64 projected
recall roots, QMD collection names, and QMD root mappings, with 120-character
names and 1,000-character relative paths.

Both commands are read-only, manual operations and are absent from the
`SessionStart` and `Stop` hooks. They never fix or rename notes, delete history,
refresh or embed QMD, or commit changes. The framework-neutral
`evals/memory-evals.json` remains the separate agent-behavior suite and is not
automatically graded by `evaluate`. Use QMD's `qmd bench` for raw engine
precision, recall, MRR, and F1; the wrapper evaluator instead checks governed
paths, provider fallback, scope, and token behavior.

## Controlled local QMD operations

Use this sequence for a versioned QMD or local plugin change. It separates
repository validation, the Bun installation, changed-plugin integration,
read-only proof, explicit maintenance, and recovery. The installed plugin's
[memory operations reference](plugins/obsidian-memory/skills/obsidian-memory/references/memory-operations.md)
is the authoritative exact command sequence, including rollback guards.

1. Validate repository behavior from the workspace root:

   ```bash
   python3 wiki/scripts/check.py
   python3 scripts/plugins.py check
   ```

2. Apply the exact Bun-owned QMD 2.8.3 pin, then prove the installed CLI and
   Bun manifest state:

   ```bash
   python3 bun-global-tools/sync.py apply
   qmd --version
   qmd status
   qmd doctor
   python3 bun-global-tools/sync.py check --deep
   ```

3. Only after the repository change is integrated, install the changed local
   plugin content for both agents and compare every live copy:

   ```bash
   python3 scripts/plugins.py install --force
   python3 scripts/plugins.py status
   ```

4. Before changing a derived index, collect read-only proof from the `wiki/`
   project root. Keep the evaluator fixture private and non-sensitive:

   ```bash
   python3 plugins/obsidian-memory/scripts/obsidian_memory.py providers --json
   python3 plugins/obsidian-memory/scripts/obsidian_memory.py doctor --json
   python3 plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
   python3 plugins/obsidian-memory/scripts/obsidian_memory.py \
     evaluate path/to/private-recall-evals.json --json
   ```

5. Run `refresh-index --embed` only as explicit maintenance, then repeat the
   health, audit, and evaluation proof from step 4:

   ```bash
   python3 plugins/obsidian-memory/scripts/obsidian_memory.py refresh-index --embed
   ```

Lifecycle hooks never run QMD model/index work, evaluator, or audit. Do not
put refresh, embedding, evaluation, or audit in `SessionStart` or `Stop`.

To roll back, first use the authoritative operations reference to verify the
exact default `Index:` SQLite path reported by `qmd status` and move that one
database plus matching WAL/SHM files into a unique non-overwriting backup.
Only then restore the prior plugin commit, re-pin/apply QMD 2.5.3, and
force-install the prior plugin. Build a fresh database from the unchanged
global collection YAML with `qmd update` followed by `qmd embed`; do not use the
incremental `refresh-index --embed` command as the rollback rebuild. Finish
with QMD version/status/doctor, Bun deep state, installed-plugin status, and
provider/doctor/audit/private-evaluation checks. Never delete the backup or
rewrite Markdown or configuration.

Enable QMD in the local configuration after creating safe collections:

```json
{
  "context_profile": "focused",
  "max_context_tokens": 420,
  "recall_provider": "auto",
  "recall_roots": ["wiki", "projects", "daily"],
  "qmd_enabled": true,
  "qmd_collections": ["obsidian-wiki", "obsidian-projects", "obsidian-daily"],
  "qmd_top_k": 5,
  "max_recall_tokens": 900
}
```

Then inspect overall health or refresh QMD's derived index:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py doctor
python3 plugins/obsidian-memory/scripts/obsidian_memory.py refresh-index --embed
```

`doctor --json` reports the focused and comparable full-context token
estimates plus the reduction percentage. The portable estimate uses a
conservative ASCII/non-ASCII heuristic and has no tokenizer dependency; the
character limit remains a second hard cap. Recall has its own result budget;
native scans are additionally bounded by file count and per-file characters.
Each JSON response names the requested and actual provider/mode, any
degradation, scope, governance filtering, and scan diagnostics.

The `full` compatibility profile is intentionally opt-in; raise
`max_context_tokens` explicitly when selecting it because the focused default
budget otherwise still applies.

See [the 2026-08-01 research review](docs/research/2026-08-01-agent-memory-systems.md)
for the Hermes Agent provider architecture, Hindsight, OpenViking, and other
systems that informed the design. Their concepts were adapted to the existing
local-first Markdown trust model; no external runtime or database became
canonical.

## Update

Edit the canonical source, then run:

```bash
python3 scripts/update.py
```

The updater refreshes the managed Codex policy block, validates the plugin and
skill, adds a cache-busting build suffix, and refreshes both installed copies.
It keeps compatibility links for hooks already loaded by running Codex threads.
It is intentionally mutating; use `scripts/check.py` for routine validation.

Local vault configuration remains outside this repository at:

```text
~/.config/obsidian-memory/config.json
```

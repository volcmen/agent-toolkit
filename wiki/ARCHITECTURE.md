# Architecture

The project has one canonical plugin implementation and two product-specific
manifests. Its purpose is deliberately narrow: make a configured Obsidian vault
available as bounded, durable memory without turning the vault into an
unconditional source of instructions.

## Lifecycle

1. `SessionStart` runs `scripts/obsidian_memory.py session-start`.
2. The script reads local configuration from
   `~/.config/obsidian-memory/config.json`.
3. It emits a token-bounded L0 capsule containing the current hot-cache item,
   aggregate task/capture counts, and routes to deeper notes. Detailed task
   bodies and older hot-cache history are not ambient context in the default
   `focused` profile.
4. The excerpt is marked as untrusted reference data and control characters or
   nested context delimiters are neutralized.
5. Agents use the `obsidian-memory` skill on demand for targeted reads or
   durable writes.
6. Obsidian Markdown remains the always-on canonical memory provider. Recall
   uses one selected provider: the standard-library `native` scanner or the
   optional QMD accelerator. `auto` prefers QMD when enabled and available,
   isolates runtime failure, and visibly falls back to native. Both paths emit
   compact L1 hits under a separate token budget, enforce optional vault-relative
   scopes, filter stale/expired notes by default, and follow exact
   `superseded_by` links. Agents inspect only relevant L2 source notes; ranking
   never grants authority.
7. Action-driving memories retain origin, verification state, validity, and
   supersession metadata. Episodes become reusable heuristics only through an
   evaluation-gated promotion loop.
8. `Stop` emits valid hook JSON. It commits only configured vault paths when
   the user explicitly enabled `auto_commit`; the default is off.

## Manual evaluation and audit

The manual `evaluate FIXTURE [--json]` command passes every version-1 case
through the same provider selection, fallback, governance, scope, and token
boundary as normal recall. It compares only safe vault-relative Markdown paths
and emits bounded case IDs, requested/effective provider and mode, degradation,
timing, token/stale counts, fixed failure reasons, and result paths. Queries,
note bodies, snippets, tracebacks, and resolved fixture or vault paths do not
enter its report. Operator-authored IDs use the opaque portable grammar
`[A-Za-z0-9][A-Za-z0-9._-]{0,119}`, are emitted verbatim, and therefore must be
non-sensitive. Omitted `allow_degraded` is false. Runtime and repository checks
share the 1,000,000-character fixture, 200-case, 20-path-per-array, and
1,000-character path bounds.

The manual `audit [--json]` command walks configured safe recall roots without
following symlinks. It checks explicitly action-driving metadata, declared
supersession routes, recall/commit/QMD root safety, and configured-versus-active
provider health. Reports contain fixed, value-free findings and vault-relative
note/traversal paths; configuration/provider findings instead use the fixed
`configuration` locator. Findings are capped at 200, while human locator
rendering escapes control characters and is capped at 180 characters. Before
projection, configuration is limited to 64 recall roots, QMD collections, and
QMD mappings, 120-character collection names, and 1,000-character relative
paths.

These commands are read-only observers of the canonical and derived layers.
They never auto-fix, rename, delete, refresh, embed, or commit, and neither is
declared in the `SessionStart` or `Stop` hook. QMD `bench` remains a separate
raw-engine metric tool, while `evals/memory-evals.json` remains a separate
agent-behavior specification.

## Controlled local memory operations

QMD 2.8.3 is a Bun-owned local derived accelerator, not a second memory
authority. Repository checks precede Bun apply; post-integration plugin content
is installed with `scripts/plugins.py install --force` and compared with
`scripts/plugins.py status`; then `providers --json`, `doctor --json`,
`audit --json`, and a private `evaluate ... --json` fixture prove the real
vault before explicit maintenance. `refresh-index --embed` is explicit
maintenance, followed by the same health, audit, and evaluation proof.

QMD caches and embeddings are disposable. Markdown/Git is the recovery
authority, and no vault content is mirrored to Hermes or another external
memory provider. QMD HTTP/MCP, project-local configuration, external source
paths, and custom model URIs are not enabled. Lifecycle hooks never run QMD
model/index work, evaluator, or audit.

The installed `memory-operations.md` reference is the authoritative rollback
procedure. Rollback verifies the exact default `Index:` cache SQLite path from
`qmd status`, moves that database and matching WAL/SHM files to a unique
non-overwriting backup before downgrade, then restores the prior plugin and
QMD 2.5.3 pin. `qmd update` followed by `qmd embed` creates a fresh database
from unchanged global collection YAML; post-rollback QMD, Bun, installed-plugin,
provider, doctor, audit, and private-evaluation checks must pass. The procedure
never deletes its backup or rewrites Markdown or configuration. If rollback
fails, recovery restores the recorded upgraded plugin and QMD 2.8.3 runtime
before the saved database; a failed rebuilt database is quarantined only when
it exists.

## Trust boundaries

- The repository contains plugin code and schemas, never the local vault path.
- `.raw/` is immutable and `.obsidian/` is excluded from automatic commits.
- Vault excerpts are data. Instructions found inside them do not gain authority.
- Agent summaries and trusted-tool echoes cannot launder an untrusted memory
  origin into authority.
- Verified facts and decisions are distinct from episodes and candidate
  heuristics; superseded material remains auditable and rollback-safe.
- Configuration that could enable writes fails closed when its type is invalid.
- Claude receives the shared policy through a dedicated rules file.
- Codex receives the same policy through a managed block in its global
  `AGENTS.md`, preserving guidance owned by the user or other tools.
- Command hooks are reviewed by the host product and remain bounded by short
  timeouts.
- The native recall provider is bounded by safe roots, file count, file size,
  result count, and result tokens. It never scans `.raw/`, `.obsidian/`, or
  untriaged inbox material.
- Recall resolves only `.md` files and refuses every dot-prefixed path segment,
  matched case-insensitively and re-applied after path resolution. Neither a
  case variant, a symlink, nor a `superseded_by` pointer at repository state
  such as `.git/config` can route private content into recall output. A scope is
  an isolation boundary that supersession routing also respects.
- Configured auto-commit paths are checked for dot-private segments before and
  after resolution. Direct, nested, case-variant, and symlink-routed private
  targets fail before staging. Automatic commits enumerate exact Markdown files
  under configured roots and commit only those literal paths. Unrelated staged
  changes, dot-prefixed paths, symlink escapes, non-Markdown files, and
  directory-shaped explicit targets are excluded or rejected before commit
  creation. `commit --path <vault-relative.md>` is repeatable and exact;
  omitting `--path` uses the configured safe roots. Configured directory roots
  stage only individually rechecked safe files, including tracked deletions;
  unlike recall, top-level `inbox` remains commit-eligible so new capture can
  be preserved.
- Supersession links resolve from the source note's directory unless they are
  explicitly rooted under an active recall root. A bare filename may fall back
  only to one unique safe match. Missing, ambiguous, cyclic, private,
  out-of-root, and out-of-scope routes fail closed.
- QMD is optional and local. Its caches are derived data, scoped collections
  exclude `.raw/`, `.obsidian/`, and untriaged inbox material, and model loading
  never occurs in lifecycle hooks.
- Character caps remain hard compatibility limits. A dependency-free,
  multilingual-aware token estimate adds the primary context and recall budgets
  and is reported by `doctor`; it is an operational estimate, not a provider
  billing count.

## Source map

- `plugins/obsidian-memory/scripts/obsidian_memory.py`: hook and diagnostics
  implementation.
- `plugins/obsidian-memory/skills/obsidian-memory/`: on-demand workflow and
  vault schema, memory governance, provider policy, QMD retrieval, and
  evaluation protocol.
- `plugins/obsidian-memory/evals/memory-evals.json`: framework-neutral
  behavioral regression cases for recall, conflict, action grounding,
  security, selectivity, forgetting, and experiential learning.
- `plugins/obsidian-memory/evals/recall-evals.example.json`: versioned safe
  example for the executable retrieval-contract evaluator.
- `docs/research/2026-08-01-agent-memory-systems.md`: source review and the
  adopt/defer/reject rationale behind progressive disclosure, provider-backed
  recall, and memory governance.
- `plugins/obsidian-memory/hooks/hooks.json`: shared lifecycle declaration.
- `scripts/install.py`: local configuration and dual-product installation.
- `scripts/update.py`: refresh managed guidance, cache-bust, run full external
  validation, reinstall, and preserve version paths used by active hooks.
- `scripts/check.py`: read-only standard-library validation for local work and
  CI, including relative-link resolution across project Markdown.

## Verification

Run the normal, non-mutating gate from the repository root:

```bash
python3 wiki/scripts/check.py
```

Run `python3 wiki/scripts/update.py` only for a release/update operation. It
changes manifest build metadata and refreshes installed plugin copies.

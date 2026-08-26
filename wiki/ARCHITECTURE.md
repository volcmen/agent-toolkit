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

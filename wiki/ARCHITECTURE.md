# Architecture

The project has one canonical plugin implementation and two product-specific
manifests. Its purpose is deliberately narrow: make a configured Obsidian vault
available as bounded, durable memory without turning the vault into an
unconditional source of instructions.

## Lifecycle

1. `SessionStart` runs `scripts/obsidian_memory.py session-start`.
2. The script reads local configuration from
   `~/.config/obsidian-memory/config.json`.
3. It emits a size-bounded excerpt containing the hot cache, selected open-task
   summaries, and capture status.
4. The excerpt is marked as untrusted reference data and control characters or
   nested context delimiters are neutralized.
5. Agents use the `obsidian-memory` skill on demand for targeted reads or
   durable writes.
6. When locally enabled, QMD provides bounded lexical, semantic, or hybrid
   discovery across explicit safe collections. Agents inspect the source notes
   returned by retrieval; ranking never grants authority.
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
- QMD is optional and local. Its caches are derived data, scoped collections
  exclude `.raw/`, `.obsidian/`, and untriaged inbox material, and model loading
  never occurs in lifecycle hooks.

## Source map

- `plugins/obsidian-memory/scripts/obsidian_memory.py`: hook and diagnostics
  implementation.
- `plugins/obsidian-memory/skills/obsidian-memory/`: on-demand workflow and
  vault schema, memory governance, QMD retrieval, and evaluation protocol.
- `plugins/obsidian-memory/evals/memory-evals.json`: framework-neutral
  behavioral regression cases for recall, conflict, action grounding,
  security, selectivity, forgetting, and experiential learning.
- `plugins/obsidian-memory/hooks/hooks.json`: shared lifecycle declaration.
- `scripts/install.py`: local configuration and dual-product installation.
- `scripts/update.py`: refresh managed guidance, cache-bust, run full external
  validation, reinstall, and preserve version paths used by active hooks.
- `scripts/check.py`: read-only standard-library validation for local work and
  CI.

## Verification

Run the normal, non-mutating gate from the repository root:

```bash
python3 wiki/scripts/check.py
```

Run `python3 wiki/scripts/update.py` only for a release/update operation. It
changes manifest build metadata and refreshes installed plugin copies.

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
to preserve the current personal behavior. When enabled, only `wiki/`,
`projects/`, `daily/`, and `inbox/` are committed; `.obsidian/`, `.raw/`, and
unrelated paths remain untouched.

Start new Claude Code and Codex threads after installation.

## Validate

Run the non-mutating gate during development:

```bash
python3 scripts/check.py
```

It checks Python syntax, manifests, marketplace metadata, the shared hook
contract, safe configuration defaults, memory-governance invariants, the
20-case behavioral evaluation schema, and the unit suite using only the Python
standard library. CI runs the same command.

The plugin deliberately keeps Markdown as the auditable source of truth.
Action-driving memories carry provenance and validity, while raw episodes must
pass evaluation before becoming reusable guidance. Optional QMD integration
adds local BM25, vector, and hybrid discovery over explicitly scoped Markdown
collections. It is invoked on demand through the shared lifecycle script; no
QMD server or model work runs in hooks.

Enable QMD in the local configuration after creating safe collections:

```json
{
  "qmd_enabled": true,
  "qmd_collections": ["obsidian-wiki", "obsidian-projects", "obsidian-daily"],
  "qmd_top_k": 5
}
```

Then inspect health or refresh the index:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py doctor
python3 plugins/obsidian-memory/scripts/obsidian_memory.py refresh-index --embed
```

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

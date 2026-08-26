# Auto-Commit Private-Path Hardening Design

## Goal

Make the documented vault boundary mechanically true even when a local user
misconfigures `commit_paths`: automatic and explicit memory commits must never
stage dot-prefixed vault areas such as `.raw`, `.obsidian`, or `.git`, including
nested, case-variant, and symlink-routed forms.

## Existing boundary

Recall already rejects every dot-prefixed path segment case-insensitively and
rechecks resolved symlink targets. Auto-commit currently rejects absolute and
escaping paths, but accepts a configured in-vault dot path or a symlink whose
resolved target is one. The default configuration is safe only because it does
not name those paths.

`inbox` is intentionally different across the two capabilities: recall omits
untriaged inbox content, while the default commit policy includes `inbox` so
new capture can be preserved. This design keeps that distinction.

## Design

Extract one private-segment predicate whose only rule is that no path segment
may begin with `.` after Unicode case folding. `safe_recall_parts` composes it
with its existing top-level `inbox` exclusion. Commit validation applies the
predicate twice:

1. to the configured vault-relative path before resolution; and
2. to the resolved path relative to the vault.

The first check rejects direct, nested, and case-variant private pathspecs. The
second rejects an otherwise public-looking symlink that resolves into a private
area. Existing absolute-path, `..`, vault-escape, locking, staging, and commit
behavior remains unchanged.

An unsafe configured path fails the complete commit operation before any
`git status`, `git add`, or commit mutation for another path can occur. Error
output identifies the configured value, never reads or prints private file
content.

The explicit `commit` command also gains repeatable `--path` arguments. With no
arguments it preserves the configured-path behavior used today. With one or
more arguments it commits only those exact validated Markdown paths, rejects
duplicates and non-Markdown targets, and never changes the Stop hook. This
provides a safe transport for a reviewed memory batch without rewriting the
user's local configuration.

## Scope

Implementation changes only:

- `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`
- `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`
- `wiki/ARCHITECTURE.md`
- `wiki/README.md`

No generated manifest, `plugins.json`, local configuration, vault content,
installation, cachebuster, or release/update command changes in this slice.

## Verification

TDD fixtures cover direct `.raw`, `.obsidian`, `.git`, nested and case-variant
dot paths, symlink routing into `.raw`, valid exact Markdown paths, and CLI
override isolation. The
focused unit test must be observed failing before implementation and passing
afterward. The final gate is `python3 wiki/scripts/check.py`,
`python3 scripts/plugins.py check`, `python3 scripts/plugins.py sync --check`,
and `git diff --check`.

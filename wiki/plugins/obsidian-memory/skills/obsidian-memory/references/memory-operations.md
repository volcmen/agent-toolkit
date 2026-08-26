# Controlled local memory operations

Use this reference only for a QMD upgrade, installation, explicit maintenance,
or rollback. Commands operate on the configured vault resolved from
`~/.config/obsidian-memory/config.json`; use its absolute path. QMD 2.8.3 is a
Bun-owned local derived accelerator. Its caches and embeddings are disposable:
Markdown/Git is the recovery authority. No vault content is mirrored to Hermes
or another external memory provider. QMD HTTP/MCP, project-local configuration,
external source paths, and custom model URIs are not enabled.

## 1. Repository gates

From the workspace root, validate repository behavior before any installation:

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
```

## 2. Bun-owned QMD 2.8.3

Apply the pinned CLI, then prove its installation and Bun manifest state:

```bash
python3 bun-global-tools/sync.py apply
qmd --version
qmd status
qmd doctor
python3 bun-global-tools/sync.py check --deep
```

## 3. Post-integration plugin install

Only after integration, install changed local plugin content for both Codex and
Claude Code, then compare the live copies:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

## 4. Pre-refresh read-only proof

Before changing a derived index, keep the evaluator fixture private and run:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" \
  evaluate path/to/private-recall-evals.json --json
```

## 5. Explicit derived-index maintenance

Run semantic discovery maintenance deliberately, never from a lifecycle hook:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" refresh-index --embed
```

Lifecycle hooks never run QMD model/index work, evaluator, or audit.

## 6. Repeat proof

After maintenance, repeat the same read-only health, audit, and evaluation
proof:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" \
  evaluate path/to/private-recall-evals.json --json
```

## 7. Derived-only rollback

Re-pin QMD 2.5.3 through `bun-global-tools/manifest.json`, apply the Bun
manifest, restore the prior plugin commit, force-install it for both agents,
and rebuild only derived data. After setting the pin and restoring that commit,
run:

```bash
python3 bun-global-tools/sync.py apply
python3 scripts/plugins.py install --force
python3 "<plugin-root>/scripts/obsidian_memory.py" refresh-index --embed
```

Rollback proceeds without rewriting Markdown.

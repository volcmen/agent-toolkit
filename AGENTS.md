# Personal AI workspace

Keep independent AI projects in clearly named top-level directories.

- Start with `README.md`; for the wiki integration, continue with
  `wiki/ARCHITECTURE.md`.
- Each project owns its plugin directory, scripts, tests, and documentation.
- **One marketplace for the workspace.** `plugins.json` at the root is the only
  place a plugin is declared; `.claude-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json`, and every `plugin.json` are GENERATED from
  it. Never hand-edit a generated manifest — edit `plugins.json` and run
  `python3 scripts/plugins.py sync`.
- Add a plugin by appending to `plugins.json` and creating
  `<project>/plugins/<name>/` with `skills/<skill>/SKILL.md`. Nothing else.
- Keep shared implementations portable across Codex and Claude Code when their lifecycle contracts overlap.
- Use command hooks only for cross-agent lifecycle behavior.
- Keep hook output bounded and valid for the event.
- Never commit local vault paths or secrets.
- Run `python3 scripts/plugins.py check` after any change to `plugins.json`, a
  plugin directory, or a project's own scripts. It validates the catalog, fails
  on manifest drift, and runs each project's suite.
- Run `python3 scripts/plugins.py install` to (re)wire both agents; it is
  idempotent and migrates marketplaces listed in `renames`.
- **Plugin versions are pinned at `1.0.0`.** Nothing consumes the version of a
  local directory marketplace, so refresh is content-driven: after editing a
  plugin, run `python3 scripts/plugins.py install --force`, which uninstalls and
  reinstalls so the edit reaches the live cache copy. Plain `install` cannot —
  both `claude plugin install` and `claude plugin update` no-op when the version
  is unchanged. `status` diffs each live copy against this checkout and exits
  nonzero on drift, so a missed `--force` fails loudly. If you do bump a version,
  keep the obsidian-memory manifests in step; that project asserts parity. Note
  `wiki/scripts/update.py` runs a Codex
  cachebuster that rewrites obsidian-memory's version — re-pin after using it.
- Run `python3 wiki/scripts/check.py` after changes under `wiki/`.
- Treat `python3 wiki/scripts/update.py` as a mutating release operation, not a
  routine validation command.
- Use Bun for user-installed global JavaScript CLI packages. Do not run
  `npm install --global`; update `bun-global-tools/manifest.json` and validate
  with `python3 bun-global-tools/sync.py check --deep`.

## Commands

Declared so agents and people run the same verified commands instead of
rediscovering them. Every entry below was executed from this directory and
exited zero. `test-one` carries a `{file}` placeholder that a caller replaces
with one path.

```commands
test: python3 scripts/plugins.py check
test-claude-core: python3 claude-core/scripts/manage.py check
test-wiki: python3 wiki/scripts/check.py
test-codex-pair: bash codex-pair/scripts/check.sh
test-chatgpt-consult: bun run --cwd chatgpt-consult check
test-qwen-gsd: python3 qwen-gsd/scripts/check.py
test-chrome-cdp: python3 chrome-cdp/scripts/check.py
test-session-bg: python3 session-bg/scripts/check.py
```

The workspace root installs nothing: its scripts are Python standard library
only, and each project installs its own dependencies. `python3 scripts/plugins.py check` is the umbrella gate: it validates the
catalog, runs the workspace suite, and dispatches each project's own command.
A project with its own harness declares `test-one` in its own `AGENTS.md`; this
workspace has no single test command that fits every project.

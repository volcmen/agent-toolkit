# Agent Toolkit

A cross-agent plugin marketplace and development workspace for Claude Code and
Codex. The marketplace packages reusable plugins; standalone systems remain in
their own projects and use their product-native installation workflows.

## Projects

- [`wiki`](wiki/): bounded Obsidian memory shared by Claude Code and Codex.
- [`agent-board`](agent-board/): autonomous local Kanban with markdown cards,
  role souls, local-first triage, capacity-safe dispatch, and a web dashboard.
- [`codex-pair`](codex-pair/): independent Codex judgment, product shaping,
  technical leadership, and review from inside Claude Code.
- [`shared-agents`](shared-agents/): standalone Claude Code controller and
  specialist-agent sources, including automatic Alan Wake routing for requested
  human-facing prose. It is not a workspace plugin.
- [`bun-global-tools`](bun-global-tools/): exact-pinned Bun global CLI tools,
  lifecycle trust policy, and npm-global drift detection.

Each project owns its implementation, tests, and documentation; plugin projects
also own their plugin directories. The repository root owns the shared
marketplace catalog and release checks.

## Install the marketplace

Clone the repository, then register that checkout with both agents:

```bash
git clone https://github.com/volcmen/agent-toolkit.git
cd agent-toolkit

# Codex
codex plugin marketplace add "$PWD" --json
codex plugin add obsidian-memory@ai-workspace --json
codex plugin add agent-board@ai-workspace --json
codex plugin add codex-pair@ai-workspace --json

# Claude Code
claude plugin marketplace add "$PWD" --scope user
claude plugin install obsidian-memory@ai-workspace --scope user
claude plugin install agent-board@ai-workspace --scope user
claude plugin install codex-pair@ai-workspace --scope user
```

The workspace helper performs the same registration and installation
idempotently:

```bash
python3 scripts/plugins.py install
python3 scripts/plugins.py status
```

The marketplace never installs `shared-agents`. Install and verify its Claude
agents separately from the repository root:

```bash
python3 shared-agents/scripts/manage.py install
python3 shared-agents/scripts/manage.py status
```

Start a new Claude Code or Codex session after installing so newly added skills
and hooks are loaded.

## Develop and validate

`plugins.json` is the only hand-edited marketplace catalog. Generated manifests
must never be edited directly:

```text
plugins.json                            ← edit catalog metadata here
├── .claude-plugin/marketplace.json     ← generated Claude Code marketplace
├── .agents/plugins/marketplace.json    ← generated Codex marketplace
├── wiki/plugins/obsidian-memory/
│   ├── .claude-plugin/plugin.json      ← generated
│   └── .codex-plugin/plugin.json       ← generated
├── agent-board/plugins/agent-board/
│   ├── .claude-plugin/plugin.json      ← generated
│   └── .codex-plugin/plugin.json       ← generated
├── codex-pair/plugins/codex-pair/
│   ├── .claude-plugin/plugin.json      ← generated
│   └── .codex-plugin/plugin.json       ← generated
└── shared-agents/                      ← standalone Claude agent project
```

After changing `plugins.json`, a plugin, or project automation:

```bash
python3 scripts/plugins.py sync
python3 scripts/plugins.py check
python3 wiki/scripts/check.py
python3 bun-global-tools/sync.py check --deep
git diff --check
```

Plugin versions are deliberately pinned at `1.0.0` in `plugins.json`. A local
directory marketplace does not use a version change to refresh cached content,
so ordinary development should not bump versions. To make edited plugin bytes
live locally, explicitly reinstall them:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

When Obsidian memory is locally configured, `install --force` refreshes both
the live plugin bytes and the shared memory policy used by Claude Code and
Codex. `status` reports plugin-content health separately from the guidance row;
an absent memory configuration is reported as “not configured” and is healthy.
Start new Claude Code and Codex sessions after installation so they load the
updated plugin and global guidance.

`status` compares the installed Claude Code cache with this checkout and reports
content drift. Release automation may deliberately change a version, but it must
change the catalog and regenerate every manifest with `scripts/plugins.py sync`.

## Add a plugin

Add one entry to `plugins.json` and create:

```text
<project>/plugins/<plugin-name>/
└── skills/<skill-name>/SKILL.md
```

Optional hooks, MCP servers, scripts, prompts, and agent metadata stay inside the
owning plugin directory. Run `python3 scripts/plugins.py sync`, then the full
validation commands above.

## Repository layout

```text
.
├── .github/workflows/check.yml
├── plugins.json
├── scripts/
├── agent-board/
├── bun-global-tools/
├── codex-pair/
└── wiki/
```

Generated boards, local vault configuration, logs, caches, temporary data,
dependency directories, and build output are intentionally excluded from source
control.

## License

[MIT](LICENSE) © 2026 David David.

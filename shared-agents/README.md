# Shared agents

A standalone personal Claude Code controller and specialist-agent system,
maintained in this workspace and independent of the workspace
plugin marketplace.

## Claude Code agents

| Role | User agent |
| --- | --- |
| Controller | Fable `controller` (medium effort) |
| Task analyst | Sonnet `task-analyst` |
| Repository explorer | Sonnet `Explore` |
| Writing specialist | Opus `alan-wake` (medium effort) |

Claude Code loads the copied user agents from `~/.claude/agents/`. `Explore.md`
intentionally overrides Claude Code's built-in Explore agent and pins it to
Sonnet.

The writing route is automatic for requested Slack messages, Jira text, PR/MR
titles and descriptions, review comments, emails, docs, release notes, status
updates, decisions, requests, and handoffs. The controller verifies the facts
before delegation and validates the final draft afterward. Alan Wake remains
read-only and never publishes. Ordinary conversation does not use it.

## Source of truth

- `agents.json` owns worker names, descriptions, provider models, reasoning, and
  tool boundaries; `codex/controller.config.toml` remains a dormant Codex
  source profile.
- `prompts/` owns shared instruction bodies.
- `scripts/render.py` deterministically renders Claude Markdown and Codex TOML.
- `claude/agents/` contains the source-controlled Claude user-agent files.
- `policy/codex-global.md` and `codex/` retain dormant Codex source adapters;
  this project does not install Codex configuration.
- `evals/controller-routing.json` contains the controller routing evaluations.
- `scripts/manage.py` renders, validates, and copies only Claude agents.

Do not edit rendered files under `claude/agents/` or `codex/agents/` directly.
Edit `agents.json` or a prompt, render, then rerun `manage.py install` to copy
the updated Claude sources into `~/.claude/agents/`.

## Commands

```bash
cd /path/to/agent-toolkit/shared-agents
python3 scripts/manage.py render
python3 scripts/manage.py check
python3 scripts/manage.py install
python3 scripts/manage.py status
python3 scripts/manage.py uninstall
```

Installation is idempotent. Conflicting personal files are backed up beneath a
timestamped directory under `~/.config/shared-agents/backups/` before they are
replaced. `manage.py install` performs no plugin installation, no Codex
installation, and no shell configuration. The local `clauded` Fish alias is
user-managed; this project never owns Fish aliases.

The retired `shared-agents` package must not be installed through
`scripts/plugins.py`. Claude Code notices edits to an existing user-agent
directory within seconds, but source changes here still require
`manage.py install` to refresh the copied files.

## Verification

```bash
python3 scripts/render.py --check
python3 -m unittest discover -s tests -v
python3 scripts/manage.py check
```

The workspace-wide gate also includes this project's suite:

```bash
cd /path/to/agent-toolkit
python3 scripts/plugins.py check
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the provider boundary and
[docs/sources.md](docs/sources.md) for the current official documentation used
for the design.

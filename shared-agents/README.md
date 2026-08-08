# Shared agents

One personal agent system for Claude Code and Codex, maintained in this
workspace and installed into each product through its native mechanism. It is
independent of Agent Board.

## What it installs

| Role | Claude Code | Codex |
| --- | --- | --- |
| Controller | Fable `controller` plugin agent, selected as the main thread | `controller` launch profile on GPT-5.6 Sol plus global `AGENTS.md` policy |
| Task analyst | Sonnet `shared-agents:task-analyst` | GPT-5.6 Sol High `task_analyst` |
| Repository explorer | Sonnet `shared-agents:repo-explorer` | GPT-5.6 Terra Medium `repo_explorer` |
| Writing specialist | Sonnet `shared-agents:alan-wake` | GPT-5.6 Terra Medium `alan_wake` |

The writing route is automatic for requested Slack messages, Jira text, PR/MR
titles and descriptions, review comments, emails, docs, release notes, status
updates, decisions, requests, and handoffs. The controller verifies the facts
before delegation and validates the final draft afterward. Ordinary
conversation does not use Alan Wake.

## Source of truth

- `agents.json` owns worker names, descriptions, provider models, reasoning, and
  tool boundaries; `codex/controller.config.toml` owns the Codex primary profile.
- `prompts/` owns shared instruction bodies.
- `scripts/render.py` deterministically renders Claude Markdown and Codex TOML.
- `policy/` owns provider-specific controller integration.
- `plugins/shared-agents/` is the marketplace plugin consumed by both clients.
- `scripts/manage.py` installs native files, managed global policy blocks, and
  the plugin without reinstalling unrelated workspace plugins.

Do not edit files under `plugins/shared-agents/agents/` or `codex/agents/`
directly. Edit the catalog or prompt, then render.

## Commands

```bash
cd /path/to/agent-toolkit/shared-agents
python3 scripts/manage.py render
python3 scripts/manage.py check
python3 scripts/manage.py install
python3 scripts/manage.py status
python3 scripts/manage.py uninstall
```

Installation is idempotent. Conflicting personal files are moved or copied to a
timestamped directory under `~/.config/shared-agents/backups/` before they are
replaced. The Codex controller profile and agent TOMLs, the Claude orchestration
rule, and the provider policies are symlinked to this checkout so source changes
remain centralized. Claude agents are loaded from the installed plugin cache and
refreshed by the installer. Uninstall restores the prior Claude main-agent
selection and any retired standalone shared-agent files unless the user replaced
them after installation; all other backups remain available for manual recovery.

Start a new Claude Code or Codex thread after installation. The installed Codex
profile activates the primary controller on GPT-5.6 Sol with max reasoning, then
layers the complete controller contract from global `AGENTS.md`. The installer
does not add shell aliases or bypass sandbox and approval settings.

## Verification

```bash
python3 scripts/render.py --check
python3 -m unittest discover -s tests -v
python3 scripts/manage.py status
```

The workspace-wide gate also includes this project's suite:

```bash
cd /path/to/agent-toolkit
python3 scripts/plugins.py check
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the provider boundary and
[docs/sources.md](docs/sources.md) for the current official documentation used
for the design.

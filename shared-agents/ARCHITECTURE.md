# Architecture

## Design

The shared layer owns behavior, while each provider owns execution syntax and
model selection. Only the Claude adapter is installed:

```text
agents.json + prompts/*.md
           |
           v
    scripts/render.py
       /          \
      v            v
Claude agent MD   Codex profile + agent TOML
~/.claude/agents/ source adapters only
      |            |
      v            v
Fable controller        GPT-5.6 Sol controller
Sonnet/Opus specialists GPT-5.6 Sol/Terra specialists
(task-analyst, Explore,
 alan-wake, mr-review-fixer,
 gate — optional independent review)
```

`agents.json` and `prompts/` render Claude Markdown into `claude/agents/`.
`manage.py install` validates those sources and copies them as regular files to
`~/.claude/agents/`. `Explore.md` intentionally overrides the built-in Explore
agent and pins Sonnet. `mr-review-fixer` is Claude-only and carries project
memory; `gate` is an optional independent reviewer with a four-tool allowlist
and a 20-turn ceiling. `mr-preflight` runs inline and reuses valid evidence;
it delegates only when an independent review is useful and not already present.
Alan Wake uses Sonnet, plan permission mode, and Read/Grep/Glob only. Both its
prompt and the primary thread use claude-core's shared writing contract.
The project is not a plugin and has no plugin lifecycle.

The Codex TOMLs, controller profile, and Codex policy remain source-controlled
adapters for future use, but this project performs no Codex installation.
Likewise, the project never owns Fish aliases; the local `clauded` alias is
user-managed.

## Lifecycle

1. Edit the canonical catalog or prompt.
2. Render both provider adapters.
3. Validate the source and TOML/frontmatter contracts.
4. Run `manage.py install` to copy the Claude agents into `~/.claude/agents/`.

Source edits do not update the copied user agents until installation is rerun.
The installer neither invokes Agent Board nor creates or updates board cards.
It does not install marketplace plugins or modify Codex configuration.

## Writing route

The primary controller drafts routine messages directly. It uses Alan Wake on
Sonnet for explicit requests, substantial editing, delicate wording, or long
text; Opus is reserved for writing judgment that warrants it. The shared
writing contract defines small defaults, preserves evidence and templates,
and selects links by the actual output surface. A Slack audience does not by
itself request raw Slack API syntax. The parent checks facts and formatting;
mechanical corrections do not require another agent round. Drafting never
authorizes publishing.

## Safety and recovery

Read-only agents use Claude-native read-only boundaries. The installer preserves
replaced files beneath `~/.config/shared-agents/backups/`. It owns only the six
copied agent files and does not alter user-owned aliases or global policies.

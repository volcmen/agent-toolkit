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
```

`agents.json` and `prompts/` render Claude Markdown into `claude/agents/`.
`manage.py install` validates those sources and copies them as regular files to
`~/.claude/agents/`. `Explore.md` intentionally overrides the built-in Explore
agent and pins Sonnet. The project is not a plugin and has no plugin lifecycle.

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

Alan Wake is a draft-only Opus specialist at medium effort. The primary
controller:

1. establishes the artifact, audience, destination format, and desired action;
2. gathers authoritative facts and verification evidence;
3. delegates the final draft automatically;
4. checks that the draft adds no unsupported facts, timing, ownership, or
   commitments;
5. returns or applies the text without publishing it externally.

This route is intentionally excluded from ordinary chat, code-only output,
exact transcription, and explicit opt-out.

## Safety and recovery

Read-only agents use Claude-native read-only boundaries. The installer preserves
replaced files beneath `~/.config/shared-agents/backups/`. It owns only the four
copied agent files and does not alter user-owned aliases or global policies.

# Architecture

## Design

The shared layer owns behavior, while each provider owns execution syntax and
model selection:

```text
agents.json + prompts/*.md
           |
           v
    scripts/render.py
       /          \
      v            v
Claude agent MD   Codex profile + agent TOML
plugin agents/    ~/.codex/*.config.toml + agents/
      |            |
      v            v
Fable controller  GPT-5.6 Sol controller
Sonnet workers    GPT-5.6 Sol/Terra workers
```

This is deliberate. Claude Code plugins can package custom agents and can set a
plugin agent as the main thread. Codex custom agents are standalone TOML files
under `~/.codex/agents`; Codex plugins currently package skills and other plugin
components, but not custom-agent TOMLs. Codex also has no custom-agent selector
for the primary thread. The installed `~/.codex/controller.config.toml` launch
profile explicitly activates the controller on a native Codex model. Global
`~/.codex/AGENTS.md` supplies the complete controller contract to Codex threads;
the project does not install provider-specific shell aliases.

## Lifecycle

1. Edit the canonical catalog or prompt.
2. Render both provider adapters.
3. Validate the package and TOML/frontmatter contracts.
4. Regenerate marketplace manifests from the workspace `plugins.json`.
5. Refresh only the `shared-agents` plugin in Claude Code and Codex.
6. Link the Codex controller profile, worker TOMLs, and provider policies into
   personal configuration.
7. Start a new client thread so configuration is reloaded.

The installer never invokes Agent Board and does not create or update board
cards. It does not reinstall unrelated workspace plugins.

## Writing route

Alan Wake is a draft-only specialist. The primary controller:

1. establishes the artifact, audience, destination format, and desired action;
2. gathers authoritative facts and verification evidence;
3. delegates the final draft automatically;
4. checks that the draft adds no unsupported facts, timing, ownership, or
   commitments;
5. returns or applies the text without publishing it externally.

This route is intentionally excluded from ordinary chat, code-only output,
exact transcription, and explicit opt-out.

## Safety and recovery

Read-only agents use provider-native read-only boundaries. The installer
preserves replaced files beneath `~/.config/shared-agents/backups/`. Managed
global instructions are fenced with markers so future installs update only the
owned block and preserve surrounding human content.

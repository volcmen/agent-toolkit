# Official sources

Design verified on 2026-08-08 against current primary documentation.

- [Claude Code: create plugins](https://code.claude.com/docs/en/plugins) —
  plugins can ship agents and `settings.json`; the `agent` setting selects a
  plugin agent as the main thread.
- [Claude Code: plugins reference](https://code.claude.com/docs/en/plugins-reference)
  — plugin agents live under `agents/`, use scoped identifiers, and do not
  support `permissionMode` when plugin-shipped.
- [Claude Code: subagents](https://code.claude.com/docs/en/sub-agents) — custom
  agent schema, routing, and model frontmatter.
- [Claude Code: model configuration](https://code.claude.com/docs/en/model-config)
  — current Fable, Sonnet, Opus, and Haiku aliases and effort behavior.
- [Claude Code: cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
  — `ListAgents`/`SendMessage` between local sessions, inbound controls
  (`crossSessionInbound`, `isolatePeerMachines`), consent boundaries, and
  plain-text-only delivery (verified 2026-08-09).
- [Codex: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  — global and project instruction discovery and precedence.
- [Codex: config basics](https://learn.chatgpt.com/docs/config-file/config-basic)
  — named `--profile` files, configuration locations, and precedence.
- [Codex: subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  — standalone custom-agent TOMLs, required fields, orchestration behavior, and
  GPT-5.6 model-routing guidance.
- [Codex: plugins](https://learn.chatgpt.com/docs/plugins) — current plugin
  packaging and installation surface.
- [Codex: configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  — global model, reasoning, `developer_instructions`, and `[agents]` settings.

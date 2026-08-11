# Official sources

Standalone design verified locally with Claude Code 2.1.227 on 2026-08-11.

- [Claude Code: create custom subagents](https://code.claude.com/docs/en/sub-agents)
  — the current source for user-agent locations, precedence, frontmatter,
  models, and file watching.
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
- [Codex: configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  — global model, reasoning, `developer_instructions`, and `[agents]` settings.

## Claude user-agent contract

Claude Code loads personal agents from `~/.claude/agents/`. A user or project
agent named exactly `Explore` overrides the built-in Explore agent and keeps its
own `model` field; this project uses `model: sonnet`. User agents take
precedence over plugin agents, while project, session, and managed scopes have
higher precedence than user scope.

Agent Markdown starts with YAML frontmatter. `name` and `description` are
required; supported optional fields include `tools`, `disallowedTools`, `model`,
`permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`,
`background`, `effort`, `isolation`, `color`, and `initialPrompt`.

Claude Code watches existing `~/.claude/agents/` and `.claude/agents/`
directories and uses added or edited definitions within seconds. Restart only
when the scope's first `agents` directory did not exist at session startup, or
when the session started with `--disable-slash-commands`.

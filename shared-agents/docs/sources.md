# Official sources

Standalone design verified locally with Claude Code 2.1.231 on 2026-08-13.

- [Claude Code: create custom subagents](https://code.claude.com/docs/en/sub-agents)
  — the current source for user-agent locations, precedence, frontmatter,
  models, and file watching.
- [Claude Code: model configuration](https://code.claude.com/docs/en/model-config)
  — current Fable, Sonnet, Opus, and Haiku aliases and effort behavior.
- [Claude Code: best practices](https://code.claude.com/docs/en/best-practices)
  — focused context, clear tasks, bounded subagent research, and verifiable
  outcomes.
- [Claude Code: memory and effective instructions](https://code.claude.com/docs/en/memory)
  — concise, specific, structured instructions and current loading behavior.
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
- [Anthropic: prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
  — clear roles, direct instructions, relevant context, and examples.
- [Google: short sentences](https://developers.google.com/tech-writing/one/short-sentences)
  — one main idea per sentence and removal of unnecessary words.
- [Google: active voice](https://developers.google.com/tech-writing/one/active-voice)
  — direct actor-and-action phrasing for clear technical prose.
- [Google: lists and tables](https://developers.google.com/tech-writing/one/lists-and-tables)
  — parallel lists, ordered steps, and concise comparison tables.

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

## Destination-formatting sources

Alan Wake consults the applicable official source before finalizing content for
these destinations:

- [Slack: formatting message text](https://docs.slack.dev/messaging/formatting-message-text/)
  — raw message `mrkdwn`, links, escaping, lists, quotes, and code.
- [Notion: block reference](https://developers.notion.com/reference/block),
  [working with Markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content),
  [rich text](https://developers.notion.com/reference/rich-text),
  and [what is a block?](https://www.notion.com/help/what-is-a-block)
  — native block types, rich-text links, Notion-flavored Markdown, and editor
  block semantics.
- [Confluence: format text](https://support.atlassian.com/confluence-cloud/docs/format-text/),
  [available Markdown commands](https://support.atlassian.com/confluence-cloud/docs/available-markdown-commands/),
  [insert links and anchors](https://support.atlassian.com/confluence-cloud/docs/insert-links-and-anchors/),
  and [legacy wiki markup](https://support.atlassian.com/confluence-cloud/docs/insert-confluence-wiki-markup/)
  — current editor formatting, inline and Smart Links, Markdown shortcuts, and
  the legacy-editor boundary.
- [GitLab Flavored Markdown](https://docs.gitlab.com/user/markdown/)
  — supported syntax, native references, and title limitations.
- [Jenkins: Remote Access API](https://www.jenkins.io/doc/book/using/remote-access-api/)
  — job and build resources, including instance-specific nested paths.

The public Thomas Frank Notion block-reference page was reachable when this
policy was designed, but it is unofficial. It is supplementary and does not
override Notion's documentation or an active connector schema.

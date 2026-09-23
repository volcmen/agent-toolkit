# Official sources

Subagent contract re-verified against the subagent documentation with Claude
Code 2.1.280 on 2026-09-23.

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
`background`, `effort`, `isolation`, `omitClaudeMd`, `color`, and
`initialPrompt`.

A subagent's model resolves from the per-call `model` argument, then its
frontmatter `model`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main
conversation's model; pinning frontmatter is what stops a forgotten argument
from inheriting the main model. A `tools` allowlist also excludes MCP and
`Skill` tools unless they are listed. Subagents load the CLAUDE.md hierarchy
unless `omitClaudeMd` is set. At `maxTurns` the output returns marked partial
and the caller can resume the subagent.

The Agent tool's per-call `model` accepts only the `sonnet`, `opus`, `haiku`,
and `fable` aliases. Observed on 2026-09-23, a subagent given `opus` ran on
`claude-opus-5` while the main thread's `opus[1m]` ran on `claude-opus-5-5`;
frontmatter accepts full model IDs, so `reviewer` pins `claude-opus-5-5`.

Claude Code watches existing `~/.claude/agents/` and `.claude/agents/`
directories and uses added or edited definitions within seconds. Restart only
when the scope's first `agents` directory did not exist at session startup, or
when the session started with `--disable-slash-commands`.

## Destination-formatting sources

Consult the applicable official source before finalizing content for these
destinations:

- [Slack: formatting message text](https://docs.slack.dev/messaging/formatting-message-text/)
  and [Block Kit](https://docs.slack.dev/block-kit/)
  — raw message `mrkdwn`, links, escaping, lists, quotes, code, and block
  payloads with their `text` fallback.
- [Jira: Markdown and keyboard shortcuts](https://support.atlassian.com/jira-software-cloud/docs/markdown-and-keyboard-shortcuts/)
  and [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
  — editor Markdown for issue text and the ADF representation API tools require.
- [Notion: block reference](https://developers.notion.com/reference/block),
  [working with Markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content),
  [enhanced Markdown](https://developers.notion.com/guides/data-apis/enhanced-markdown),
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
  and [description templates](https://docs.gitlab.com/user/project/description_templates/)
  — supported syntax, native references, title limitations, and the issue and
  merge-request templates whose sections a draft must preserve.
- [Jenkins: Remote Access API](https://www.jenkins.io/doc/book/using/remote-access-api/)
  — job and build resources, including instance-specific nested paths.

The public Thomas Frank Notion block-reference page was reachable when this
policy was designed, but it is unofficial. It is supplementary and does not
override Notion's documentation or an active connector schema.

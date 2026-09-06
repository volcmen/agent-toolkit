# Alan Wake destination-formatting references

**Date:** 2026-08-11
**Status:** Design approved; awaiting written-spec review

## Outcome

Alan Wake will consult current official formatting documentation before
finalizing content for Slack, Notion, Confluence, or GitLab. The agent will
produce destination-correct output without relying only on memorized syntax or
an unofficial reference.

## Scope

This change updates the canonical Alan Wake prompt, supporting source
documentation, generated provider agents, and focused tests. It then refreshes
the installed Claude user-agent copy under `~/.claude/agents/` through the
existing renderer and installer.

The change does not alter Alan Wake's model, effort, tool boundary, routing, or
draft-only safety contract. It does not publish content to any destination and
does not change global Claude or Codex settings.

## Authority and consultation policy

For Slack, Notion, Confluence, and GitLab artifacts, Alan Wake must open the
applicable official reference during the task before finalizing the draft. This
is a bounded destination lookup, not broad research, and therefore applies even
to otherwise small or self-contained writing requests.

Authority is resolved in this order:

1. The destination connector or tool's explicit input schema and formatting
   contract, when a tool is being used.
2. The destination's current official formatting documentation.
3. The verified baseline rules embedded in Alan Wake's prompt.
4. General knowledge.

A tool-specific format overrides the raw destination syntax only when the
tool's contract explicitly documents the conversion. The prompt will remove
the unsupported general claim that Slack MCP draft/send tools convert Markdown.

If an official page is temporarily unavailable, Alan Wake may use the verified
baseline in its prompt. It must not invent syntax, blocks, macros, conversion
behavior, or connector capabilities.

## Official references

### Slack

- [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text/)

Slack drafts use Slack `mrkdwn` by default, including `*bold*`, `_italic_`,
backticks, and `<url|label>` links. Standard Markdown links are used only when
the active tool contract explicitly says it accepts and converts them.

### Notion

- [Block reference](https://developers.notion.com/reference/block)
- [Working with Markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content)
- [What is a block?](https://www.notion.com/help/what-is-a-block)

When a Notion tool exposes native blocks, Alan Wake uses those block types and
the tool's schema. When the transport explicitly accepts Notion-flavored
Markdown, it uses the documented dialect. It does not assume that ordinary
Markdown represents every Notion block.

The public Thomas Frank block-reference page is valid but unofficial. It is not
part of Alan Wake's authority chain because official Notion references cover
the required block and Markdown contracts.

### Confluence

- [Format text](https://support.atlassian.com/confluence-cloud/docs/format-text/)
- [Available Markdown commands](https://support.atlassian.com/confluence-cloud/docs/available-markdown-commands/)
- [Confluence wiki markup syntax for the legacy editor](https://support.atlassian.com/confluence-cloud/docs/insert-confluence-wiki-markup/)

Alan Wake distinguishes native editor or connector content from Markdown
shortcuts and legacy wiki markup. It follows the active tool's page-body schema
when available and does not emit legacy markup for the current editor unless
the user or destination contract explicitly requires it.

### GitLab

- [GitLab Flavored Markdown](https://docs.gitlab.com/user/markdown/)

GitLab descriptions, comments, wiki pages, and Markdown files use GitLab
Flavored Markdown. Titles remain plain and action-oriented except for syntax
that GitLab explicitly supports in titles. Native issue, merge-request, commit,
and project references are preferred when the necessary identifiers are known.

## Prompt structure

The canonical prompt at `prompts/alan-wake.md` will receive a compact
"Destination references" section near the general formatting rules. Each
destination subsection will contain:

- the official URL or URLs to consult;
- the minimum stable baseline needed if lookup fails;
- the distinction between raw destination syntax and connector-specific
  payload formats.

Existing destination defaults remain responsible for editorial structure and
brevity. The new reference section owns documentation consultation and syntax
authority, avoiding duplicate or contradictory instructions.

`docs/sources.md` will record the same official sources and explain why the
Thomas Frank page is supplementary rather than authoritative.

## Generated artifacts and installation

`agents.json` and `prompts/` remain canonical. After editing the prompt and
tests, the existing renderer updates:

- `claude/agents/alan-wake.md`
- `codex/agents/alan_wake.toml`

The existing installer then copies the rendered Claude definition to:

- `~/.claude/agents/alan-wake.md`

Generated files are never edited directly.

## Verification

Focused tests will assert that:

- all official destination URLs occur in the canonical prompt;
- Alan Wake must consult the applicable source before finalizing;
- Slack defaults to `mrkdwn` and no longer assumes an MCP Markdown converter;
- Notion distinguishes native blocks and Notion-flavored Markdown;
- Confluence distinguishes current native formatting, Markdown commands, and
  legacy wiki markup;
- GitLab uses GitLab Flavored Markdown where supported and does not apply full
  Markdown formatting to titles.

Verification will run the renderer drift check, the shared-agents unit suite,
the project check command, and live-install status. The installed
`~/.claude/agents/alan-wake.md` must match the rendered Claude source.

## Acceptance criteria

- Every Slack, Notion, Confluence, or GitLab draft triggers a bounded lookup of
  current official destination-formatting documentation.
- The official URLs are available inside the standalone agent prompt at
  runtime, independent of the source repository's current working directory.
- Tool-specific conversion behavior is followed only when the active tool
  contract establishes it.
- The unofficial Notion block catalog is not treated as authoritative.
- Generated files, tests, and the installed Claude user agent are synchronized.
- Existing routing, model, effort, read-only tools, and publishing boundaries
  remain unchanged.

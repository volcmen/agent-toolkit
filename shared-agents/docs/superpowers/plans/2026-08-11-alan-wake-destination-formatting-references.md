# Alan Wake Destination-Formatting References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Alan Wake consult current official Slack, Notion, Confluence, and GitLab formatting documentation before finalizing destination-specific drafts.

**Architecture:** Keep runtime behavior in the canonical `prompts/alan-wake.md`, record provenance in `docs/sources.md`, and protect both with focused unit assertions. Regenerate provider-native artifacts with the existing renderer, then refresh the standalone Claude user-agent copy with the existing installer; do not edit generated or installed files directly.

**Tech Stack:** Markdown prompts and documentation, Python 3.11 `unittest`, the existing Python renderer and standalone-agent installer, generated Claude Markdown and Codex TOML.

## Global Constraints

- For Slack, Notion, Confluence, and GitLab artifacts, consult the applicable official reference during the task before finalizing the draft.
- A destination connector or tool's explicit schema overrides raw destination syntax only when that contract documents the conversion.
- If an official page is temporarily unavailable, use the prompt's verified baseline and do not invent syntax, blocks, macros, conversion behavior, or connector capabilities.
- Treat the Thomas Frank Notion block-reference page as valid but unofficial and outside the authority chain.
- Do not change Alan Wake's model, medium effort, read-only tool boundary, routing, draft-only contract, or publishing boundary.
- `agents.json` and `prompts/` remain canonical; never hand-edit `claude/agents/`, `codex/agents/`, or `~/.claude/agents/`.
- Preserve the unrelated untracked `/Users/david.david/Personal/ai/download.html` and all other user work.

---

## File map

- `shared-agents/prompts/alan-wake.md`: runtime consultation policy, official URLs, fallback behavior, and destination-specific syntax baselines.
- `shared-agents/docs/sources.md`: source provenance and the official-versus-supplementary Notion distinction.
- `shared-agents/tests/test_shared_agents.py`: behavioral contract for official URL presence, required consultation, format distinctions, and removal of the unsupported Slack MCP conversion claim.
- `shared-agents/claude/agents/alan-wake.md`: generated Claude adapter; updated only by `scripts/render.py`.
- `shared-agents/codex/agents/alan_wake.toml`: generated Codex adapter; updated only by `scripts/render.py`.
- `~/.claude/agents/alan-wake.md`: installed live Claude copy; updated only by `scripts/manage.py install`.

### Task 1: Add, verify, and install destination-formatting references

**Files:**

- Modify: `shared-agents/tests/test_shared_agents.py:417-425`
- Modify: `shared-agents/prompts/alan-wake.md:90-184`
- Modify: `shared-agents/docs/sources.md:1-40`
- Regenerate: `shared-agents/claude/agents/alan-wake.md`
- Regenerate: `shared-agents/codex/agents/alan_wake.toml`
- Install: `/Users/david.david/.claude/agents/alan-wake.md`

**Interfaces:**

- Consumes: the existing `render.py` contract (`agents.json` plus `prompts/*.md`) and `manage.py install` copy lifecycle.
- Produces: a standalone Alan Wake prompt containing direct official URLs and a deterministic installed Claude copy identical to `shared-agents/claude/agents/alan-wake.md`.

- [ ] **Step 1: Add failing behavioral tests**

Replace the existing Slack-only test and add two focused tests in `Package`:

```python
    def test_alan_wake_consults_official_destination_references(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        sources = (ROOT / "docs" / "sources.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        urls = (
            "https://docs.slack.dev/messaging/formatting-message-text/",
            "https://developers.notion.com/reference/block",
            "https://developers.notion.com/guides/data-apis/working-with-markdown-content",
            "https://www.notion.com/help/what-is-a-block",
            "https://support.atlassian.com/confluence-cloud/docs/format-text/",
            "https://support.atlassian.com/confluence-cloud/docs/available-markdown-commands/",
            "https://support.atlassian.com/confluence-cloud/docs/insert-confluence-wiki-markup/",
            "https://docs.gitlab.com/user/markdown/",
        )
        self.assertIn("consult the applicable official reference", normalized)
        self.assertIn("before finalizing", normalized)
        self.assertIn("temporarily unavailable", normalized)
        for url in urls:
            with self.subTest(url=url):
                self.assertIn(url, prompt)
                self.assertIn(url, sources)

    def test_alan_wake_uses_destination_native_format_contracts(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn("Notion-flavored Markdown", normalized)
        self.assertIn("ordinary Markdown does not represent every Notion block", normalized)
        self.assertIn("legacy wiki markup", normalized)
        self.assertIn("current Confluence editor", normalized)
        self.assertIn("GitLab Flavored Markdown", normalized)
        self.assertIn("titles do not support full GitLab Flavored Markdown", normalized)

    def test_alan_wake_writes_destination_native_slack_mrkdwn(self) -> None:
        prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
        normalized = " ".join(prompt.split())
        self.assertIn("`<url|label>`", normalized)
        self.assertIn("`[text](url)` does not render in raw Slack messages", normalized)
        self.assertIn("active tool contract explicitly documents", normalized)
        self.assertNotIn("Slack MCP draft/send tools", prompt)
        self.assertIn("named link", normalized)
        self.assertIn("never invent a URL", normalized)
        self.assertIn("bold headline", normalized)
        self.assertIn("identifier as the label", normalized)
```

- [ ] **Step 2: Run the focused tests and confirm the new contract fails**

Run from `/Users/david.david/Personal/ai/shared-agents`:

```bash
python3 -m unittest discover -s tests -p 'test_shared_agents.py' -k 'alan_wake' -v
```

Expected: the new reference and destination-contract tests fail because the
official URLs, consultation requirement, Notion/Confluence/GitLab distinctions,
and corrected Slack tool rule are not yet present. Existing terminal-writer
coverage remains green.

- [ ] **Step 3: Add the consultation and authority contract to the canonical prompt**

Insert this section between `## Structure and formatting` and
`## Destination defaults` in `prompts/alan-wake.md`:

```markdown
## Destination references

Before finalizing Slack, Notion, Confluence, or GitLab content, consult the
applicable official reference below during the task. Open the direct source;
do not turn this bounded syntax check into broad research. If a destination
tool is active, inspect its input schema first. Follow a tool-specific format
instead of raw destination syntax only when the active tool contract explicitly
documents that conversion.

If an official page is temporarily unavailable, use the verified baseline
below. Never invent syntax, blocks, macros, conversion behavior, or connector
capabilities.

- Slack: https://docs.slack.dev/messaging/formatting-message-text/
  Raw messages use Slack `mrkdwn`: `*bold*`, `_italic_`, backticks, and
  `<url|label>` links.
- Notion: https://developers.notion.com/reference/block,
  https://developers.notion.com/guides/data-apis/working-with-markdown-content,
  and https://www.notion.com/help/what-is-a-block. Prefer a tool's native block
  schema. Use Notion-flavored Markdown only when the transport documents it;
  ordinary Markdown does not represent every Notion block.
- Confluence: https://support.atlassian.com/confluence-cloud/docs/format-text/,
  https://support.atlassian.com/confluence-cloud/docs/available-markdown-commands/,
  and https://support.atlassian.com/confluence-cloud/docs/insert-confluence-wiki-markup/.
  Prefer the active tool's native page-body schema. Distinguish current
  Confluence editor formatting and Markdown commands from legacy wiki markup;
  do not emit legacy markup unless the user or destination contract requires it.
- GitLab: https://docs.gitlab.com/user/markdown/. Use GitLab Flavored Markdown
  in descriptions, comments, wiki pages, and Markdown files. Keep titles plain
  except for syntax GitLab explicitly supports because titles do not support
  full GitLab Flavored Markdown.
```

In the Slack destination subsection, replace the current conversion exception
with this exact baseline:

```markdown
- Write Slack `mrkdwn`, not Markdown: `*bold*` with single asterisks,
  `_italic_`, backticks for code, and named links as `<url|label>`.
  `[text](url)` does not render in raw Slack messages. Use another link syntax
  only when the active tool contract explicitly documents that it accepts and
  converts it.
```

Keep the existing headline, named-link, identifier, emoji, and mention rules.

- [ ] **Step 4: Record destination-source provenance**

Append this section to `docs/sources.md`:

```markdown
## Destination-formatting sources

Alan Wake consults the applicable official source before finalizing content for
these destinations:

- [Slack: formatting message text](https://docs.slack.dev/messaging/formatting-message-text/)
  — raw message `mrkdwn`, links, escaping, lists, quotes, and code.
- [Notion: block reference](https://developers.notion.com/reference/block),
  [working with Markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content),
  and [what is a block?](https://www.notion.com/help/what-is-a-block)
  — native block types, Notion-flavored Markdown, and editor block semantics.
- [Confluence: format text](https://support.atlassian.com/confluence-cloud/docs/format-text/),
  [available Markdown commands](https://support.atlassian.com/confluence-cloud/docs/available-markdown-commands/),
  and [legacy wiki markup](https://support.atlassian.com/confluence-cloud/docs/insert-confluence-wiki-markup/)
  — current editor formatting, Markdown shortcuts, and the legacy-editor
  boundary.
- [GitLab Flavored Markdown](https://docs.gitlab.com/user/markdown/)
  — supported syntax, native references, and title limitations.

The public Thomas Frank Notion block-reference page was reachable when this
policy was designed, but it is unofficial. It is supplementary and does not
override Notion's documentation or an active connector schema.
```

- [ ] **Step 5: Re-run the focused tests before rendering**

Run from `/Users/david.david/Personal/ai/shared-agents`:

```bash
python3 -m unittest discover -s tests -p 'test_shared_agents.py' -k 'alan_wake' -v
```

Expected: the destination reference, native-format contract, Slack `mrkdwn`,
and terminal-writer tests pass. The full suite may still report renderer drift
until the next step.

- [ ] **Step 6: Regenerate provider-native agent artifacts**

Run:

```bash
python3 scripts/manage.py render
```

Expected: exit 0. `git status --short` shows modifications to only the canonical
prompt, source documentation, tests, and these generated files, plus the
pre-existing untracked `../download.html`:

```text
shared-agents/claude/agents/alan-wake.md
shared-agents/codex/agents/alan_wake.toml
```

Do not edit either generated file manually.

- [ ] **Step 7: Run source and generated-artifact verification**

Run from `/Users/david.david/Personal/ai/shared-agents`:

```bash
python3 scripts/render.py --check
python3 -m unittest discover -s tests -v
python3 scripts/manage.py check
```

Expected: all three commands exit 0; the renderer reports no drift, the unit
suite reports `OK`, and package validation prints `ok   shared-agents package`.

- [ ] **Step 8: Run the workspace gate**

Run from `/Users/david.david/Personal/ai`:

```bash
python3 scripts/plugins.py check
```

Expected: exit 0 with the workspace catalog and project suites passing. Do not
run the mutating `wiki/scripts/update.py` command.

- [ ] **Step 9: Install and verify the standalone Claude copy**

Run from `/Users/david.david/Personal/ai/shared-agents`:

```bash
python3 scripts/manage.py install
python3 scripts/manage.py status
cmp -s claude/agents/alan-wake.md /Users/david.david/.claude/agents/alan-wake.md
```

Expected: installation copies `alan-wake.md`, both status checks print
`ok   shared-agents live installation`, and `cmp` exits 0. The installer must
not modify `~/.claude/settings.json`, Fish configuration, plugins, or Codex
configuration.

- [ ] **Step 10: Review the exact diff and repository state**

Run from `/Users/david.david/Personal/ai`:

```bash
git diff --check
git status --short
git diff -- shared-agents/prompts/alan-wake.md shared-agents/docs/sources.md shared-agents/tests/test_shared_agents.py shared-agents/claude/agents/alan-wake.md shared-agents/codex/agents/alan_wake.toml
```

Expected: no whitespace errors; the diff contains only the approved behavior,
source provenance, focused tests, and deterministic generated changes. The
untracked `download.html` remains present and unstaged.

- [ ] **Step 11: Commit the implementation**

Run from `/Users/david.david/Personal/ai`:

```bash
git add shared-agents/prompts/alan-wake.md \
  shared-agents/docs/sources.md \
  shared-agents/tests/test_shared_agents.py \
  shared-agents/claude/agents/alan-wake.md \
  shared-agents/codex/agents/alan_wake.toml
git diff --cached --check
git commit -m "feat(shared-agents): consult destination formatting docs"
```

Expected: the commit contains exactly the five listed files. Do not stage or
commit `download.html`.

- [ ] **Step 12: Confirm the committed and live end state**

Run:

```bash
git status --short
python3 shared-agents/scripts/manage.py status
git log -1 --oneline --decorate
```

Expected: repository status lists only `?? download.html`; live installation
status is healthy; the latest commit is
`feat(shared-agents): consult destination formatting docs`.

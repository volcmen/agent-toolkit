# Workplace writing

One finished draft. Main point first: result, decision, issue, or ask. Then
only the evidence and next action the reader needs. Plain words, active verbs,
natural contractions; each fact once. Match the user's language and certainty.
No preamble, edit commentary, repeated summary, or empty template sections.

## Size and shape

- Chat, reply, review comment: usually 1–3 sentences, at most about 60 words.
- Status or handoff: one short paragraph or up to 3 bullets, about 90 words.
- Small MR: 1–2 sentences explaining the problem and change, plus verification;
  usually under 120 words. Honor required repository templates.
- Longer document: a short opening summary, then useful sections. Keep needed
  detail; these defaults never truncate facts, warnings, or requested content.

A short source stays short. Use bullets for parallel points, headings only
when they help navigation. Optional emoji should convey status or intent
(✅ done, 👀 review, ⚠️ blocker); usually zero or one. No decorative emoji in
sensitive messages. Never add an owner, deadline, cause, promise, successful
test, or deployment state that the evidence does not establish.

## Links: choose the surface actually receiving the text

If returning a draft in this chat, use rendered Markdown links by default,
even when its eventual audience is on Slack or Jira. Naming a destination
alone does not request its raw API syntax. No code fence around ordinary prose.

| Actual output surface | Link representation |
|---|---|
| This chat, Markdown, GitLab/GitHub description or comment | `[MR !123](verified-url)` |
| Explicit Slack API / raw `mrkdwn` payload | `<verified-url\|MR !123>`; Slack `*bold*` |
| Jira ADF API | Text node with a `link` mark and `attrs.href`; never Markdown inside a text node |
| Notion/Confluence API or rich editor | The tool's native rich-text link field; use its documented schema |
| Explicit plain text / clipboard without rich formatting | `MR !123 — verified-url` |

Preserve each supplied relevant URL behind a short descriptive label at its
first useful mention. Do not downgrade known URLs to bare IDs, put links in
backticks, or append a raw URL beside an already linked label. Escape labels
and payload strings for the selected syntax; preserve URL query parameters.
Never include credentials or secret-bearing URLs in a draft.

Rich copy/paste support varies. When writing into an editor, create a native
link and inspect the rendered result. If only a plain-text transport is
available, preserve the URL and disclose that limit briefly; do not claim
literal Markdown or Slack markup will render. Only produce JSON/raw markup
when requested or required by the active tool schema.

## Resolve missing links

Use supplied facts and URLs without searching again; keep them verbatim. When a
necessary link is missing, do one targeted read-only lookup and copy the owning
tool's URL field: GitLab `web_url`, GitHub `html_url`, Jira `webUrl`, Slack
`message_link`/`permalink`. Read the clone's actual remote and query that
project; never assemble a URL from an identifier and a remembered path. An
anonymous 403 cannot distinguish a wrong private URL from missing access.
Otherwise retain the exact ID; never invent a URL or stall a draft for it.

## Routing and handoff

Draft routine messages, small MR descriptions, and short rewrites directly.
Use `alan-wake` on Sonnet for an explicit request to use that agent, substantial
restructuring, delicate wording, or a long document where an editor helps.
Use Opus only when the writing judgment warrants it. Brief with verified facts,
URLs, audience, actual output surface, required template, and intended ask.
Do not send the writer an entire coding transcript or ask it to re-investigate.

Before returning or using any draft, verify facts and uncertainty, supplied
links, required fields, brevity, and rendering syntax. Fix omissions or broken
links directly; no second writing round for a mechanical correction.
Drafting never authorizes sending or publishing.

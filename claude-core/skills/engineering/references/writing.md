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

- Reply to the user in chat: the answer in the first line, then at most 5
  short lines. Name each open decision once. Leave out how you got there.
- Message sent as the user: see the next section.

## Slack and chat messages sent as the user

Write the way the user types: compact, direct, friendly through plain
helpfulness, not ceremony.

- No opener. No "Good morning/afternoon/evening", "Hi X!", "Thanks X!",
  "Sure, X." line, in a new DM, a thread, or a channel. Only when the other
  person opened a DM with a greeting or "how are you", answer it in a few words
  on the first line ("Hey Daniel, all good.") and go on.
- The first line is the answer, the status, or the ask. Address someone in a
  channel by @mention at the start of that line.
- 1–3 short lines, one idea per line, about 40 words. Offer details or link
  them instead of writing them out; a table or report only when asked for one.
- Plain words and the cause stated plainly: "Tracker was out of date,
  updating it now." No praise, apology, or agreeing back: never "you're right",
  "good question", "great point", "sorry for the delay", "thanks for flagging".
- Questions are direct and end with "?": "Pre jobs still running?"
- Names, numbers, customer ids, MR refs, and links exactly as in the source.
- No sign-off. "Thanks" only for something actually received, once, at the end.
- No headings, bold labels, or bullets for two points. At most one emoji, and
  only when it carries meaning (🙏 on a request, ✅ for done).
- Match the thread's language and register; never more formal than the thread.

Before → after:

- "Good afternoon Marina! None of them are customer users: they're distributor
  accounts (…), same as in the table this morning. They're missing from the Sep
  27 export because …" → "None are customer users, all distributor accounts
  (Orange Traffic on c454 and c534, TAPCO on c545). Not in the Sep 27 export;
  we add them after cutover with create-client-user-v3."
- "Good afternoon Daniel! For the remaining 2604 → 2606 client migrations, do
  we have automation that opens the CR …? Could MOS-automation-prod be the
  pre/post gate …? Thanks!" → "Need to migrate customers from 2604.* to
  2604.8. Does the automation handle the migration checks?"
- "Good evening Eliel! Approved !17341 ([BUGFIX] NTD-9900: Key …). Thanks!" →
  "Approved !17341."
- "Sorry for the delay, Marina! The Auth0 export file has no records at all for
  c527 and c440 …" → "c527 and c440 are missing from the Auth0 export
  entirely, so it isn't a date cut-off. Checking why on the Auth0 side."
- "Thanks Marina! That 0 is a tracker bug: c216 has … and the count let the
  inactive row win." → "That 0 is a tracker bug: c216 has 1 active user.
  Fixing the count now."

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

## Routing

Draft messages, MR descriptions, and rewrites directly. Use Opus only when the
writing judgment warrants it: substantial restructuring, delicate wording, or a
long document. Work from verified facts, URLs, audience, actual output surface,
required template, and intended ask.

Before returning or using any draft, verify facts and uncertainty, supplied
links, required fields, brevity, and rendering syntax. Fix omissions or broken
links directly; no second writing round for a mechanical correction.
Drafting never authorizes sending or publishing.

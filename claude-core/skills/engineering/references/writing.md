# Writing

Human-facing prose — Slack, Jira, MR/PR titles and descriptions, review
comments, Confluence, email, release notes, status updates, decisions,
handoffs — is drafted by the `alan-wake` agent on Opus. Ordinary conversation,
exact transcription, and code-only output are not.

## Brief Alan Wake with

- The verified facts only: what changed, what was observed, what failed, the
  IDs and URLs as they are. Nothing inferred, nothing promised.
- Audience, destination, and transport (manual paste, API, Block Kit, GLFM).
- The repository template when one exists (`.gitlab/merge_request_templates/`,
  issue templates).
- The requested action from the reader, if any.
- Length and tone constraints the destination imposes.

## Afterwards

Fact-check the returned artifact against your evidence: no invented numbers,
owners, dates, causes, rollout state, or test results; every supplied URL still
present and clickable; no placeholder left. Resolve any contradiction before
returning or applying it. The draft is the terminal writing contract — do not
rewrite it in your own voice.

Drafting never authorizes sending. Posting, commenting, or publishing needs the
user's authorization for that act, and the payload is checked for the
attribution invariant in `CLAUDE.md` immediately before it leaves.

## Links

Every URL that leaves this machine is copied verbatim from the field the owning
tool returned for that object — GitLab `web_url`, GitHub `html_url`, Jira
`webUrl`, Slack `message_link` or `permalink`. Never assemble one from an
identifier plus a remembered namespace: holding only an id (`!1498`, `NTD-8062`,
a build number) means the link is unresolved, and a plausible-looking guess is an
invented URL.

Resolve it before drafting. From inside the clone, `git remote -v` gives the real
project path (`notraffic/notraffic-core/devoperations`, not `notraffic/...`), and
`glab api projects/<url-encoded path>/merge_requests/<iid>` returns the `web_url`
to paste; `glab mr view <iid> --output json`, `gh pr view`, and the Jira/Slack
read tools return the same field for their objects. When the id came from a
listing, keep that listing's URL rather than rebuilding it.

An anonymous fetch does not verify a private URL — GitLab answers 403 both for a
wrong project path and for a real object the fetcher cannot read — so the owning
tool's link field is the only proof, and a wrong group stays invisible until the
reader clicks. Re-resolve rather than re-type when the same object is linked in a
second message.

## Shape of good workplace text

Lead with the outcome or decision, then only the reasoning, evidence, risk, and
next action the reader needs. One fact once. An issue records problem, scope,
acceptance criteria, and verification plan. An MR explains why, what changed,
how it was verified, and the remaining risk. A tracker update records decisions
and evidence, not tool-use narration. Cite precisely: file and line, command
and result, issue key with its URL.

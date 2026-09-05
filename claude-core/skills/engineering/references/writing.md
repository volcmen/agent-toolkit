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

## Shape of good workplace text

Lead with the outcome or decision, then only the reasoning, evidence, risk, and
next action the reader needs. One fact once. An issue records problem, scope,
acceptance criteria, and verification plan. An MR explains why, what changed,
how it was verified, and the remaining risk. A tracker update records decisions
and evidence, not tool-use narration. Cite precisely: file and line, command
and result, issue key with its URL.

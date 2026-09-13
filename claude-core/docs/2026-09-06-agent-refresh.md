# Claude agent refresh — 2026-09-06

The user asked for less context and ceremony, especially in mr-preflight, and
shorter Alan Wake messages with rendered links and useful, restrained emoji.
This change updates the live Claude sources and their related routing rules.

## Findings and decisions

- Preflight unconditionally forked, imposed a disposition table, required
  mutation runs for changed tests, and treated absent evidence as failed code.
  Its default now runs inline: a read-only committed-head snapshot, one review
  of the relevant behavior, and only missing verification. A targeted independent
  review is used for unfamiliar or high-risk work when one is not already available.
- The old triage mixed cheap inspection with runner probes, compiler execution,
  network lookups, and cached output. It remains an opt-in diagnostic; the new
  snapshot does not run tests, invoke a network client, or write Git state.
- Several surfaces forced every workplace draft through Alan Wake on Opus.
  Routine drafts now stay inline. Alan Wake uses Sonnet for substantial editing;
  Opus remains available when writing judgment warrants it.
- Alan's prompt mixed chat presentation with Slack clipboard/API transport.
  The shared writing reference now chooses syntax by the actual output surface:
  rendered Markdown in chat, mrkdwn for explicit Slack payloads, native links
  for ADF/rich editors, raw URLs only for explicit plain-text transport.
- Verification and delivery demanded fresh runs after every push or status
  claim. They now reuse observed results only when their tested inputs match.
  Changed or unknown inputs invalidate relevant evidence; a SHA is insufficient
  to establish dependency, environment, or dirty-checkout equivalence.
- mr-review-fixer can supply the independent review already needed by preflight.
  Its final pass reviews fixes and affected interactions instead of restarting
  the whole review. review-retro no longer turns every comment into a global gate.

The preflight result distinguishes READY, CHANGES NEEDED, and INCOMPLETE.
Missing evidence cannot become a pass, and an inventory's clean exit cannot
become a correctness verdict. Current MR state is checked separately when
making a remote-readiness claim. Existing policy still governs merge conditions.

## Measured instruction bytes

| Surface | Before | After |
|---|---:|---:|
| Global CLAUDE.md | 3,500 | 3,496 |
| mr-preflight skill | 7,012 | 4,837 |
| Alan Wake rendered agent | 14,498 | 1,485 |
| Writing reference | 1,775 | 3,803 |
| Alan plus writing reference | 16,273 | 5,288 |
| mr-review-fixer rendered agent | 5,800 | 3,370 |

These are byte counts, not tokenizer measurements or end-to-end cost benchmarks.
The shared writing reference grew because it now owns the format contract for
both paths. Alan plus that reference is 67.5% smaller; routine drafts also avoid
starting a writer. Preflight no longer starts a reviewer for every invocation.

## Research used

- [Anthropic: best practices](https://code.claude.com/docs/en/best-practices):
  concise standing instructions, observable verification, proportional planning.
- [Anthropic: subagents](https://code.claude.com/docs/en/sub-agents): isolated
  workers have setup/context costs; tightly coupled, small work can stay inline.
- [GitLab communication](https://handbook.gitlab.com/handbook/communication/):
  simple language, useful context, and an explicit next action.
- [37signals internal communication](https://basecamp.com/guides/how-we-communicate):
  considered written communication and avoiding unnecessary interruption.
- [A public Go engineering review](https://groups.google.com/g/golang-codereviews/c/EBZ2fSEJc8E):
  the reviewer identified a concrete risk and proposed a specific reproduction
  in a few sentences. This is an example, not a universal corporate-writing norm.
- [Slack text formatting](https://docs.slack.dev/messaging/formatting-message-text/)
  and [Atlassian ADF links](https://developer.atlassian.com/cloud/jira/platform/apis/document/marks/link/):
  explicit transport-specific links; Markdown text is not an ADF link mark.

## Verification and limits

Passed: 45 claude-core tests, 47 shared-agents tests, workspace catalog/project
checks, source rendering, live installation status, and git diff --check.

The core suite covers wrong repo/branch/target handling, merge-base identity,
local edits, rename/deletion and unusual paths, omitted-path reporting,
whitespace evidence, external diff-driver suppression, and no snapshot writes.
Existing legacy triage regressions remain in place. Agent checks cover rendering,
model/tool boundaries, source references, installation/backup behavior, and size.
The workspace check covers its catalog and seven listed project/test groups.
Skill frontmatter was parsed with PyYAML; the generic skill validator passed
with Claude's native argument-hint field validated separately.

The updated writing/routing examples in shared-agents/evals are behavioral
fixtures, not a claim of completed model trials. No live Slack/Jira message was
sent. Rich clipboard rendering varies and must be checked in the target editor.

The requested [ChatGPT consultation](https://chatgpt.com/g/g-p-6a9591e79e5c8191ab6aab7dfe24d777-work/c/6a9d28e5-b8cc-83ed-8555-db7761370b52)
was submitted through ChatGPT Consult. Its browser worker timed out after ten
minutes (needs_manual, timed_out, submitted, workerActive=false). A manual
handoff was prepared; no connected browser was available to retrieve the
answer. No ChatGPT recommendation is claimed or used as evidence.

## Follow-up

Inspect the next few real MR and writing sessions for needless delegation,
repeated tests, missed risks, output length, and rendered links. Compare actual
session token and latency metrics before claiming runtime savings. Keep the
legacy diagnostics available while validating the lighter default in use.

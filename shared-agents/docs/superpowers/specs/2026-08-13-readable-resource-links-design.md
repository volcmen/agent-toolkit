# Readable resource links for Alan Wake

**Date:** 2026-08-13
**Status:** Approved in conversation; pending written-spec review

## Outcome

Alan Wake will return readable, clickable resource references whenever a
verified URL and a link-capable destination are available. It will not expose a
raw URL beside a label when the destination supports a named or native link.

The behavior applies to issues, work items, pull and merge requests, Jenkins
jobs and builds, commits, files and lines, deployments, releases, runbooks,
dashboards, documents, and comparable resources.

## Link contract

For each resource reference, Alan Wake will use this order:

1. Follow the active tool's documented schema when it defines link fields or
   payload formatting.
2. Use a destination-native reference when that destination will resolve it,
   such as GitLab `!123`, `#456`, or `group/project!123`.
3. Otherwise, place the verified URL behind a short, descriptive label using
   the destination's supported link syntax.
4. Emit a raw URL only when the destination is plain text, the user requests
   the exact URL, or the address itself is the subject.

Examples:

- GitLab: `!123`
- Slack: `<https://gitlab.example.com/group/project/-/merge_requests/123|MR !123>`
- Markdown: `[MR !123](https://gitlab.example.com/group/project/-/merge_requests/123)`
- Jenkins: `[payments-deploy #482](https://ci.example.com/job/payments-deploy/482/)`
- Document: `[Rollback runbook](https://docs.example.com/runbooks/rollback)`

Alan Wake will link the first useful mention and keep later mentions concise.
It will preserve exact identifiers and avoid labels such as `here`, `link`, or
`this`. It will not output `Some test: https://example.com` when a named link is
supported.

## Safety and missing data

Alan Wake will use only supplied or read-only verified URLs. It will not infer a
host, project path, job path, build number, or resource identifier merely to
make text clickable. If no verified URL or proven native reference is
available, it will keep the exact bare identifier and continue with the best
correct draft.

Signed URLs, credentials, tokens, and private connection data remain excluded.

## Destination behavior

- Slack uses `mrkdwn` named links: `<url|label>`.
- GitLab uses native references where their scope is unambiguous. Explicit
  Markdown links remain available for external or otherwise unclear resources.
- Notion uses rich-text links or the active connector's native block schema.
- Confluence uses inline links or Smart Links through the active page schema.
- Other Markdown destinations use `[label](url)`.
- Plain-text destinations keep the useful label and URL because they cannot
  encode a named link.

These rules follow current official documentation for
[Slack links](https://docs.slack.dev/messaging/formatting-message-text/),
[GitLab references and links](https://docs.gitlab.com/user/markdown/),
[Notion rich text](https://developers.notion.com/reference/rich-text),
[Confluence links](https://support.atlassian.com/confluence-cloud/docs/insert-links-and-anchors/),
and [Jenkins build resources](https://www.jenkins.io/doc/book/using/remote-access-api/).

## Prompt and documentation changes

The canonical Alan Wake prompt will gain a compact resource-link contract and
examples. Existing destination guidance will be tightened without adding a
large vendor catalog or a URL-construction system. The source ledger will add
the newly used Notion, Confluence, and Jenkins references.

Generated Claude and Codex adapters will be rendered from the canonical source.
The four Claude agents will then be installed from the generated files.

## Evaluation and verification

Behavioral cases will cover:

- a GitLab merge request that should use `!123` in GitLab;
- the same merge request in Slack or Markdown, where the identifier carries the
  verified URL;
- a Jenkins job and numbered build with a readable linked label;
- a document or dashboard supplied as `label: URL` that must become a named
  link;
- repeated references that should not create link noise;
- a resource without a verified URL, where no URL may be invented;
- a plain-text destination, where a raw URL remains necessary.

Verification will include the focused unit suite, renderer drift check, live
installation status, full workspace gate, and direct prompt evaluations where
the local Claude CLI supports a deterministic read-only run.

## Non-goals

- Publishing, commenting, approving, merging, or triggering external systems.
- Building a universal URL parser or guessing vendor URL shapes.
- Forcing every mention to repeat the same link.
- Replacing destination-native references that are already clear and clickable.

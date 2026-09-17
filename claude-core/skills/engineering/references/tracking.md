# Personal work tracking

Linear answers what David is doing, what comes next, and what needs his input.
Use it for ongoing work, task intake, blockers, and handoffs; routine steps that
finish within a session stay inline.

## Destination and authority

Read `~/.config/work-tracking/linear.json` for the verified personal workspace,
default team, user, projects, and views. Require `status: ready` and nonempty
`workspace_id`, `workspace_url`, `team_id`, `user_id`, and compare workspace ID
and URL with the authenticated account before writing. Missing or mismatched
means unverified: continue authorized local work and report an unsaved handoff.
Never substitute a work workspace. Use the `linear-personal` MCP connection;
browser login does not prove MCP authentication.

| Work | Authoritative home | Linear content |
|---|---|---|
| Personal work without a suitable tracker | Linear | Full task |
| Jira work | Jira | Source link and personal next action |
| Work tracked in GitHub or GitLab | Existing tracker | Linked personal action when useful |
| Architecture and decisions | Repository docs or Obsidian | Links |

Creating and updating personal tasks for requested substantial work needs no
per-task permission. It does not authorize upstream posting, imports, syncing,
invites, paid runs, or starting unrelated backlog work. Keep company content in
its source; Linear holds a short personal action and the source URL. Work
branches and MRs carry the source identity, never a Linear identifier. Use only
the default team; projects for workstreams; tasks assigned to David.

## Intake and selection

Read project guidance and the task's latest handoff. Search by source URL,
project, and outcome before creating; reuse a match; an uncertain create
response requires a lookup before retrying; several matches require
clarification. Track work needing cross-session continuity, follow-up,
dependencies, or a decision — one deliverable per task, execution steps as a
session checklist. Discoveries go to Inbox; capture is not approval. Next holds
selected, clear, unblocked tasks; at most three Next and two Doing unless David
overrides. Do not start work merely because it is in Linear.

```markdown
## Outcome
<observable result>
## Scope
<bounded work and meaningful exclusions>
## Acceptance criteria
- [ ] <verifiable result>
## Next action
<one concrete action>
## Links
<source issue, repository, design, or evidence>
```

A work-linked action's title names the personal action; its body is only
`Source: <URL>` and `Next action: <action>`. Its status is personal progress,
not a cached claim about the source; finishing it does not resolve the source.

## Status

Inbox (captured) · Backlog (kept, not selected) · Next (ready) · Doing ·
Waiting (blocked; next action names what it awaits) · Review (remaining check
or integration) · Done (acceptance criteria have observed evidence) · Canceled.

`needs-me` only for a concrete action from David, stated in Next action and
removed when resolved. Dates only for real commitments. Native dependency
relations for blockers; sub-issues for separate deliverables. One owner per
task; the assignee is not a lock for concurrent agents. Views: Now
(Next/Doing/Review), Needs me, Waiting, By project; review Inbox and Waiting
weekly.

## Handoff

Update on blockers, scope changes, handoffs, and verified completion, not every
tool call; preserve human edits. Personal tasks record branch/PR, checked
commit, checks run and results, missing checks, and next action; work-linked
entries update only action, status, and link. Keep Review while checking
remains. Report the Linear link and any action needed from David; a missing or
failed write is explicitly unsaved.

Obsidian keeps decisions and context. Once a task is verified in Linear, replace
its TODO checkbox with a locator saying Linear owns it; never maintain synced
checkbox copies. When Linear is unavailable, a marked pending capture in the
project TODO is temporary and is replaced with the verified link on recovery.
No Jira/GitHub/GitLab synchronization or linkbacks exist; any is a separate
change.

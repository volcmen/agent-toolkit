# Personal work tracking

Linear answers what David is doing, what comes next, and what needs his input.
Use this guide for ongoing work, task intake, blockers, and handoffs in both
Claude Code and Codex. Routine steps that finish within a session stay inline.

## Destination and authority

Read `~/.config/work-tracking/linear.json` for the verified personal workspace,
default team, user, projects, and views. Require `status: ready` and nonempty
`workspace_id`, `workspace_url`, `team_id`, and `user_id`; missing values are not
wildcards. Compare its workspace ID and URL with
the authenticated Linear account before writing. Missing configuration or a
mismatch means the destination is unverified; continue authorized local work
and report an unsaved handoff. Do not substitute a work workspace.

Use the official Linear MCP connection named `linear-personal`. Browser login
does not prove MCP authentication. Use available structured tools first and
the signed-in browser when a required operation is unavailable through them.

| Work | Authoritative home | Linear content |
|---|---|---|
| Personal work without a suitable tracker | Linear | Full task |
| Jira work | Jira | Source link and personal next action |
| Work already tracked in GitHub or GitLab | Existing tracker | Linked personal action when useful |
| Architecture and decisions | Existing repository docs or Obsidian | Links to relevant context |

The approved personal workflow allows creating and updating personal tasks
for requested substantial work without asking each time. Repository policy
still determines official tracking. It does not authorize upstream posting,
imports, syncing, invites, paid runs, or starting unrelated backlog work.
Keep company descriptions, comments, attachments, and code in their source;
use a short personal action and the source URL. Preserve the source identity
in work branches and MRs rather than adding a personal Linear identifier.

Use only the workspace's default team as the required storage container.
Organize ongoing workstreams with projects, standalone tasks without a project,
and assign personal tasks to David. No additional teams or colleagues.

## Intake and selection

Read project guidance and the selected task's latest handoff. Search by source
URL, project, and outcome before creating anything; reuse an existing match.
An uncertain create response requires a lookup before retrying. Several valid
matches require clarification rather than silently choosing one.

Track work that needs cross-session continuity, follow-up, dependencies, or a
decision. Keep one deliverable per task; execution steps are a session checklist.
New discoveries go to Inbox, and capturing them does not approve implementation.
Tasks in Next are selected, clear, and unblocked; do not start other work just
because it is present in Linear. Keep at most three Next and two Doing tasks
overall; make room before selecting more, unless David explicitly overrides.

Personal task template:

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
<source issue, repository, design, or evidence as needed>
```

For a work-linked action, the title names the personal action and the body
contains only `Source: <URL>` and `Next action: <action>`. Its status is personal
progress, not a cached claim about Jira/GitHub/GitLab status. Fetch source state
when needed. Finishing the personal action does not resolve the source ticket.

## Status and attention

| Status | Meaning |
|---|---|
| Inbox | Captured, not assessed |
| Backlog | Worth keeping, not selected |
| Next | Selected and ready |
| Doing | Being worked on |
| Waiting | Blocked; next action says what or whom it awaits |
| Review | Ready for a remaining check or integration |
| Done | The task's acceptance criteria have observed evidence |
| Canceled | Abandoned, not delivered |

Use `needs-me` only for a concrete action from David; state it in Next action
and remove the label when resolved. Set dates only for real commitments.
Use native dependency relations for blocking tasks and sub-issues for separate
deliverables. Keep one implementation owner per task; the assignee is not a
lock for concurrent agents. Keep one authoritative planning backlog.

Personal views, assigned to David: Now (Next/Doing/Review), Needs me (unfinished
and `needs-me`), Waiting (Waiting), and By project (unfinished, grouped by project).
Review Inbox and Waiting weekly. Built-in backlog views hold distant work.

## Handoff and continuity

Update on blockers, scope changes, handoffs, and verified completion, not on
every tool call. Preserve human edits. For personal tasks, record the branch/PR,
checked commit, actual checks and results, missing checks, and next action.
For work-linked entries, keep technical evidence at the source and update only
the personal action, status, and relevant link.

Keep work in Review while required checking or integration remains. Report the
Linear link and any action needed from David in the final handoff. A missing
or failed write is explicitly unsaved; authorized local work can continue.

Obsidian keeps decisions and useful context. After a task is verified in Linear,
replace its old TODO checkbox with a locator stating that Linear owns its state;
preserve unmigrated tasks. Do not maintain synchronized checkbox copies. When
Linear is unavailable, explicitly marked pending capture in the existing project
TODO is temporary; deduplicate and replace it with the verified link on recovery.

No automatic Jira/GitHub/GitLab synchronization or linkbacks are configured for
this workflow. Any later sync is a separately scoped change.

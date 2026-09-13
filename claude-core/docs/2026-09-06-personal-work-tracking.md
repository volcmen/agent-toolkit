# Personal Linear work tracking — 2026-09-06

David chose Linear as his personal work hub across repositories with different
official trackers. The shared behavior lives in the
[tracking guide](../skills/engineering/references/tracking.md). This record owns
setup and verification evidence; it is not a second task backlog.

## Installation

The existing engineering directory link installs the guide for Claude Code.
`~/.codex/AGENTS.md` points to that same installed reference outside its managed
Obsidian block. No generated shared-agent file or plugin manifest is modified.
Existing unrelated changes in the workspace are preserved.

Both clients use the official Streamable HTTP endpoint with OAuth:

```sh
claude mcp add --transport http --scope user linear-personal https://mcp.linear.app/mcp
claude mcp login linear-personal
codex mcp add linear-personal --url https://mcp.linear.app/mcp
codex mcp login linear-personal
```

The Claude login command needs an interactive terminal. Before repeating an
add command, inspect the existing named server. Authenticate to the personal
workspace and verify its identity separately in both clients. A successful
OAuth flow alone is not evidence that the intended workspace was selected.

Store non-secret workspace bindings in `~/.config/work-tracking/linear.json`:
`workspace_url`, `workspace_id`, `team_id`, `user_id`, `projects`, and `views`.
`status` is `pending` until the personal destination is verified, then `ready`.
Missing identity values must not be interpreted as a wildcard. Keep credentials
out of this file and the repository.

## Workspace setup

Use a workspace owned only by David, with domain auto-join disabled. Reuse its
default team, assign tasks to David, and configure the statuses and four views
specified in the guide. Use the existing Free plan, without enabling tracker
sync, automatic linkbacks, paid agent execution, or inviting colleagues.

Create a `Claude Core` project and two pilot tasks after checking for duplicates:

- Evaluate the context-window trial on September 13, 2026. Preserve the existing
  TODO's metrics command, baseline, quality checks, and rollback decision.
- Set up and verify personal Linear work tracking. Keep it in Review while
  authentication, view checks, or cross-client handoff verification remains.

Replace a migrated Obsidian TODO checkbox with the verified issue link and an
explicit statement that Linear owns its status. Retain every unmigrated task.

## Verification

Run `python3 claude-core/scripts/manage.py check` and `status` from the parent
workspace, and `git diff --check`. If the package script changes, also run the
workspace-required `python3 scripts/plugins.py check`.

Exercise the live personal destination: both clients retrieve the same pilot
issue; update its next action and re-read it; verify each saved view's filter
and results. A resumed agent should be able to identify the remaining action
from the task alone. For a work-linked task, inspect the proposed payload for
only a source link and personal action; perform no source-system writes.

Record missing authentication, destination mismatches, or unavailable checks
explicitly. Do not infer behavioral verification from Markdown linting or a
successful OAuth callback.

## Current evidence

- Shared guide and routing installed; live engineering reference resolves.
- MCP endpoint configured for both clients.
- `claude-core/scripts/manage.py check`: all 45 tests passed; `status` verified
  the live links. Workspace `scripts/plugins.py check` passed catalog,
  workspace, wiki, codex-pair, chatgpt-consult, qwen-gsd, and shared-agents checks.
- Codex completed OAuth, but its workspace identity is not yet verified.
  Claude's interactive OAuth flow awaits authorization. Neither is recorded
  as ready for personal writes.
- Personal workspace identity, workspace setup, and live pilot verification
  are pending account selection. No personal tasks were created in the work
  workspace.

## Sources

- [Linked planning conversation](https://chatgpt.com/c/6a9d2aba-1884-83eb-9dd2-0246d6e37dc7), read through the signed-in CDP browser.
- [Linear MCP](https://linear.app/docs/mcp) and [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
- [Linear teams](https://linear.app/docs/teams), [views](https://linear.app/docs/custom-views), and [Jira integration](https://linear.app/docs/jira).

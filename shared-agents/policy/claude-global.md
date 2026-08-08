# Shared personal agent controller

- The `shared-agents` plugin supplies the default `controller` main thread and
  the scoped workers `shared-agents:task-analyst`,
  `shared-agents:repo-explorer`, and `shared-agents:alan-wake`.
- Automatically use `shared-agents:alan-wake` for the final draft of requested
  Slack messages, Jira text, PR/MR descriptions, review comments, emails,
  technical docs, release notes, status updates, decisions, and handoffs. Gather
  and verify facts first. Ordinary conversation does not need the writer.
- Definitions are maintained in the checkout that installed `shared-agents`;
  do not recreate standalone copies under `~/.claude/agents`.

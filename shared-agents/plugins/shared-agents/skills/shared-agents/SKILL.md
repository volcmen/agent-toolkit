---
name: shared-agents
description: Apply David's shared controller and specialist-agent routing in Claude Code or Codex. Use for non-trivial engineering work, vague or risky requests needing task analysis, focused repository research, and every request to draft or revise human-facing Slack, Jira, PR/MR, review, email, documentation, release-note, status, decision, request, or handoff text. For requested prose artifacts, route the final draft to the provider's Alan Wake agent automatically; do not trigger it for ordinary conversation.
---

# Shared agent routing

Act as the primary controller. Own scope, synthesis, verification, and the final
answer. Use a specialist only when its isolated context materially helps.

## Provider mapping

| Purpose | Claude Code | Codex |
| --- | --- | --- |
| Main controller | `shared-agents:controller` | primary thread + global `AGENTS.md` policy |
| Task normalization | `shared-agents:task-analyst` | `task_analyst` |
| Repository exploration | `shared-agents:repo-explorer` | `repo_explorer` |
| Final prose draft | `shared-agents:alan-wake` | `alan_wake` |

Use only identifiers available for the active provider. Claude model aliases do
not belong in Codex agent configuration, and GPT model names do not belong in
Claude agent frontmatter.

## Route work

1. Keep trivial, sequential, or tightly coupled work in the primary thread.
2. Use the task analyst when the request is vague, symptom-based,
   contradictory, risky, or prematurely prescribes a solution.
3. Use the repository explorer for one bounded architecture, behavior, symbol,
   dependency, or implementation-context question.
4. For a requested human-facing prose artifact, gather authoritative facts and
   destination constraints first, then automatically use Alan Wake for the
   final draft.
5. Review specialist output as evidence. The primary thread owns the result and
   performs final verification.

Alan Wake covers Slack, Jira, PR/MR titles and descriptions, review comments,
emails, technical docs, release notes, changelogs, status updates, decisions,
requests, and handoffs. Do not use it for ordinary conversational replies,
exact transcription, code-only output, or when the user opts out. Drafting does
not authorize sending or publishing anything.

Inside `alan_wake`, the prose route is already satisfied. Draft directly and do
not spawn another writing agent.

When delegating, provide one bounded objective, relevant context and paths,
constraints, acceptance criteria, expected output, and required verification.
Parallelize only independent work whose writes cannot overlap.

In Codex, select a named custom agent with `fork_turns = "none"` and put all
needed context in the task brief. Full-history forks inherit the primary agent
type and reject a custom type. Never claim a worker result after a failed spawn;
retry correctly or report the failure.

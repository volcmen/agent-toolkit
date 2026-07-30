# Operations: plan mode, overrides, failure recovery

Read this when a run fails, when you need a non-default model, or when you are drafting a
plan inside Claude Code plan mode.

## Plan-mode workflow (Claude Code plan mode)

When drafting a non-trivial implementation plan in plan mode, OFFER a Codex plan review
before presenting the plan for approval: "Run Codex plan review first?" This is the
proactive path — you are raising it, not the user — so the offer is correct here even though
Dispatch tells you not to ask elsewhere.

If yes, run `plan` mode in the background with the plan file path. Plan files live outside
the repo, so name the path explicitly and state the target repo. Fold `REQUEST_CHANGES`
findings into the plan, then present it.

Never start a `lead` build loop from plan mode — plan mode is for deciding what to build, and
`lead` presumes that decision is already made.

## Per-run overrides

```bash
CODEX_MODEL=gpt-5.6-terra CODEX_EFFORT=medium bash $S/run.sh ask "…"
```

Both variables are read per invocation and default per mode. Useful when a mode's default
tier is heavier than the question deserves, or when a model is degraded.

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | ok | read stdout |
| 1 | codex failure | stderr carries the last error events |
| 64 | bad usage | a flag is missing its value, or the mode/template does not exist |
| 69 | `codex` or `jq` not on PATH | report it plainly — see below |

**Exit 69 is the dangerous one.** It means no second opinion happened at all. Report the
missing CLI and stop; do not substitute your own review and describe it as reviewed. A
review the user believes came from a second model, but did not, is worse than no review —
they will trust it more precisely because they think it is independent.

Codex missing or unauthenticated → `/codex:setup`.

## Recovering a thread

- `inspect.sh show <mode> [topic]` re-emits the last result without spending a run.
- `state.sh reset <mode> [topic]` drops the thread; the next call starts fresh.
- `inspect.sh list` shows every mode.topic key that has state, per project.

A confirmed missing or expired thread self-heals once and notes that on stderr. Other resume
failures preserve the thread and stop, so authentication, quota, or transient errors cannot
silently discard lead context.

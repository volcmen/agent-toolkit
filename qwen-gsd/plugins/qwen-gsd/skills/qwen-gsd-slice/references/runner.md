# Qwen slice runner

Read this when constructing a fresh run, correction, dry-run, or sandboxed run.

## Commands

Run from the target repository root. The wrapper generates a UUID, pipes the
brief over stdin, stores stream JSON outside the project by default, records the
ledger, and prints only a compact summary.

```bash
"$QGS_ROOT/scripts/qwen_slice.sh" --prompt-file .planning/slice-brief.md
```

Resume the one permitted correction round:

```bash
"$QGS_ROOT/scripts/qwen_slice.sh" \
  --prompt-file /tmp/qwen-corrections.md \
  --resume <session-id> --phase correction
```

Useful one-run flags are `--model`, `--wall-time`, `--max-tool-calls`,
`--max-turns`, `--sandbox`, `--no-model-check`, `--phase`, `--log`, and
`--dry-run`. The only supported Qwen pass-through arguments after `--` are
`--fallback-model <id>` and repeatable `--include-directories <dir>`; the
wrapper rejects everything else so callers cannot override its safety,
identity, logging, session, or budget controls.

Use `--dry-run` to inspect the exact expansion without starting Qwen. Use raw
`qwen` only when debugging the wrapper.

## Execution contract

The wrapper expands to a bounded headless invocation with safe mode,
`--approval-mode yolo`, stream JSON, wall-time/turn/tool/subagent limits, and a
fixed session UUID.

- Safe mode disables context files, hooks, extensions, skills, and MCP servers.
  Codex already supplies the plan, so this reduces cost and surprise. It also
  disables Qwen tool allow/exclude lists; enforce file scope through the brief
  and diff review.
- YOLO approval is required because a headless run cannot answer prompts. It is
  not a sandbox. Use `--sandbox` or an isolated worktree for an untrusted
  repository.
- Never use `--bare`; it bypasses settings discovery and can remove auth.
- A real UUID is required. The wrapper fixes it before launch so resume and
  accounting work even when no result event is emitted.

## Result semantics

Success requires `exit_code=0` and `result=success is_error=False`. API errors
can live inside a structured result despite shell success. `result=MISSING`
means the run aborted or was killed.

Budget exhaustion exits 55 and leaves already-applied edits on disk. SIGINT and
SIGTERM are recorded as interrupted runs. Inspect the diff before any resume or
repair.

On resume, the wrapper retrieves the session's first observed authoring model
from the ledger and passes it explicitly. An explicit `--model` is the only
override. A changed actual model is recorded as a warning.

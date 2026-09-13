# Observability and economy

Read this during review and final reporting.

## Ledger

Every launch and completion is appended to `<state_dir>/runs.jsonl`. Records
include session, phase, requested and actual model, budgets, result,
classification, turns, `fresh_plus_output`, tool histogram, warnings, log
paths, and a bounded stderr tail. The wrapper enforces private permissions:
state directories are `0700` and ledger, stream, and stderr files are `0600`.

```bash
QGS_LOG="$QGS_ROOT/scripts/qwen_log.py"
python3 "$QGS_LOG" list -n 10
python3 "$QGS_LOG" list --failed
python3 "$QGS_LOG" show <session-prefix>
```

Record orchestrator phases in the same timeline:

```bash
python3 "$QGS_LOG" note --phase review --status pass --message "targeted checks passed"
python3 "$QGS_LOG" note --phase verify --status fail --message "project check failed"
```

Use phases `preflight`, `slice`, `correction`, `review`, and `verify`
consistently. A start without a completion becomes `killed_unrecorded`; treat
it like a partial run because edits may already exist.

Failure reasons include `budget_abort`, `model_mismatch_or_check`,
`wrapper_usage`, `missing_api_key`, `no_auth`, `rate_limited`, `capacity`,
`quota`, `context_overflow`, `bad_session`, `network`, `killed`,
`result_missing`, `result_not_success`, and `no_events`. Read the compact
ledger record before the raw stream log.

## Independent usage cross-check

After Qwen finishes:

```bash
python3 "$QGS_ROOT/scripts/qwen_usage.py" --session <session-id>
```

This reads Qwen Code's own usage records and keeps the latest cumulative snapshot for each
session. Compare similar slices using `fresh_plus_output`, and also report total
tokens, requests, tool calls/failures, model latency, and changed-line counts.

The session is the economic unit: a correction replays prior context and can
double cost even when the second run looks small. Investigate threshold
warnings before starting another slice. Read-heavy tool histograms usually mean
the brief cited too little of the real flow; high tool failures indicate a
broken or overly broad brief.

Model fallback events are reported as attempted switches. The final selected model is shown alongside a warning; selection alone does not prove a successful response. Resumed result token usage is cumulative and is compared directly with the session warning threshold.

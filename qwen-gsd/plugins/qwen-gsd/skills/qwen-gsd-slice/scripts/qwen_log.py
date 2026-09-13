#!/usr/bin/env python3
"""Append-only run ledger for qwen-gsd-slice: what ran, what failed, and why.

    qwen_log.py record --session UUID --exit-code N --log PATH [...]   # wrapper
    qwen_log.py note --phase review --status fail --message "..."      # Codex
    qwen_log.py list [-n 10]
    qwen_log.py show <session-or-run-id>

One JSON object per line in <state_dir>/runs.jsonl. `record` reads the
stream-json log and stderr file itself so the classification lives in one
place instead of being re-derived by the orchestrator.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qwen_config import resolve  # noqa: E402
from qwen_result import load  # noqa: E402

# stderr / result substring -> (reason, hint)
SIGNATURES = (
    ("Missing API key", ("missing_api_key", "provider envKey is not in ~/.qwen/settings.json env or the environment")),
    ("No auth type is selected", ("no_auth", "settings auto-discovery was skipped; never pass --bare")),
    ("ENOTFOUND", ("network", "provider host did not resolve; check baseUrl and connectivity")),
    ("ECONNREFUSED", ("network", "provider refused the connection")),
    ("429", ("rate_limited", "provider throttled the run; retry or pass -- --fallback-model <id>")),
    ("quota", ("quota", "provider quota exhausted for this model")),
    ("capacity", ("capacity", "provider had no capacity; pass -- --fallback-model <id>")),
    ("context length", ("context_overflow", "brief or session too large; shrink the slice or start a fresh session")),
    ("Invalid session", ("bad_session", "--resume id does not exist; start a fresh session")),
)


def ledger_path(state_dir: str | None = None) -> Path:
    values, _ = resolve()
    root = Path(state_dir or values["state_dir"]).expanduser()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    return root / "runs.jsonl"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def append(record: dict) -> Path:
    path = ledger_path()
    record.setdefault("ts", now())
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
    except Exception:
        os.close(descriptor)
        raise
    with os.fdopen(descriptor, "a", encoding="utf-8") as sink:
        sink.write(json.dumps(record, sort_keys=True) + "\n")
    return path


def tail(path: Path, limit: int = 4000) -> str:
    if not path or not Path(path).is_file():
        return ""
    text = Path(path).read_text(encoding="utf-8", errors="replace").strip()
    return text[-limit:]


def signature(result: dict | None, stderr_text: str) -> tuple[str, str] | None:
    haystack = stderr_text
    if result:
        haystack += " " + json.dumps(result.get("error") or "") + " " + str(result.get("subtype", ""))
    haystack = haystack.lower()
    for needle, hit in SIGNATURES:
        if needle.lower() in haystack:
            return hit
    return None


def classify(exit_code: int, result: dict | None, stderr_text: str, events: list[dict]) -> tuple[str, str, str]:
    """Return (status, reason, hint). A run only counts as ok on exit 0 plus a
    non-error result event; a known error signature then names the cause."""
    healthy = (
        exit_code == 0
        and result is not None
        and result.get("subtype") == "success"
        and result.get("is_error") is False
    )
    if healthy:
        return ("ok", "success", "")

    hit = signature(result, stderr_text)
    if hit:
        return ("fail", hit[0], hit[1])

    if exit_code == 55:
        return ("fail", "budget_abort", "hit wall-time/tool-calls/turns; edits already on disk — inspect the diff before resuming")
    if exit_code == 3:
        return ("fail", "model_mismatch_or_check", "requested model was not used, or the local model check rejected the id")
    if exit_code == 2:
        return ("fail", "wrapper_usage", "bad qwen_slice.sh arguments or missing prompt file / qwen CLI")
    if exit_code == 130 or exit_code == 143:
        return ("fail", "killed", "run was interrupted; edits may be partially applied")
    if not events:
        return ("fail", "no_events", "qwen produced no stream-json; check the stderr log")
    if result is None:
        return ("fail", "result_missing", "run aborted before emitting result; inspect the diff")
    if result.get("is_error"):
        return ("fail", "api_or_run_error", "structured result reports an error despite the shell exit code")
    if exit_code != 0:
        return ("fail", f"exit_{exit_code}", "non-zero exit with a successful result event; treat as suspect")
    return (
        "fail",
        "result_not_success",
        "exit was zero but structured result was not exactly success with is_error=false",
    )


def session_history(session: str) -> list[dict]:
    if not session:
        return []
    return [r for r in read_ledger() if r.get("kind") == "run" and r.get("session") == session]


def cmd_start(args: argparse.Namespace) -> None:
    """Record the launch, so a killed run is still visible in the ledger."""
    append(
        {
            "kind": "run_start",
            "phase": args.phase,
            "session": args.session,
            "resumed": bool(args.resumed),
            "cwd": os.getcwd(),
            "model_requested": args.model or "",
            "budgets": {
                "wall_time": args.wall_time,
                "max_tool_calls": args.max_tool_calls,
                "max_turns": args.max_turns,
            },
            "log": args.log or "",
        }
    )


def cmd_model_for(args: argparse.Namespace) -> None:
    """Print the model that authored the session: its first observed model, not
    the latest, so an earlier drift is not propagated into further rounds."""
    for record in session_history(args.session):
        if record.get("model_actual"):
            print(record["model_actual"])
            return
    print("")


def cmd_record(args: argparse.Namespace) -> None:
    values, _ = resolve()
    log_path = Path(args.log).expanduser() if args.log else None
    events = load(log_path) if log_path and log_path.is_file() else []
    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
    result = next((e for e in reversed(events) if e.get("type") == "result"), None)
    stderr_text = tail(Path(args.stderr).expanduser()) if args.stderr else ""

    status, reason, hint = classify(args.exit_code, result, stderr_text, events)

    usage = (result or {}).get("usage", {}) or {}
    fresh = int(usage.get("input_tokens", 0) or 0) - int(usage.get("cache_read_input_tokens", 0) or 0)
    output = int(usage.get("output_tokens", 0) or 0)

    tools: dict[str, int] = {}
    for event in events:
        if event.get("type") != "assistant":
            continue
        for block in event.get("message", {}).get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                name = block.get("name", "?")
                tools[name] = tools.get(name, 0) + 1

    warnings = []
    hit = signature(result, stderr_text)
    if status == "ok" and hit:
        warnings.append(f"stderr signature: {hit[0]} (run still reported success)")

    session = args.session or init.get("session_id") or (result or {}).get("session_id", "")
    prior = session_history(session)
    # A correction replays the whole session, so the session total is the real
    # economics unit; a per-run threshold hides a cheap-looking second round.
    session_fpo = fresh + output + sum(int(r.get("fresh_plus_output") or 0) for r in prior)
    if session_fpo > int(values["warn_fresh_plus_output"]):
        warnings.append(f"session fresh_plus_output={session_fpo}>{values['warn_fresh_plus_output']}")

    prior_models = {r.get("model_actual") for r in prior if r.get("model_actual")}
    actual = init.get("model", "")
    if actual and prior_models and actual not in prior_models:
        warnings.append(
            f"model changed mid-session: {'/'.join(sorted(prior_models))} -> {actual}"
        )
    if fresh + output > int(values["warn_fresh_plus_output"]):
        warnings.append(f"fresh_plus_output>{values['warn_fresh_plus_output']}")
    # Compare against the budget this run actually used, not the config default,
    # or a flag override makes the warning meaningless in both directions.
    turn_budget = int(args.max_turns or values["max_turns"])
    call_budget = int(args.max_tool_calls or values["max_tool_calls"])
    turns = (result or {}).get("num_turns")
    if turns and int(turns) >= turn_budget * 0.9:
        warnings.append(f"turns {turns} near max_turns {turn_budget}")
    if tools and sum(tools.values()) >= call_budget * 0.9:
        warnings.append(f"tool calls {sum(tools.values())} near max_tool_calls {call_budget}")

    record = {
        "kind": "run",
        "phase": args.phase,
        "session": args.session or init.get("session_id") or (result or {}).get("session_id", ""),
        "resumed": bool(args.resumed),
        "cwd": args.cwd or os.getcwd(),
        "model_requested": args.model or "",
        "model_actual": init.get("model", ""),
        "cli": init.get("qwen_code_version", ""),
        "budgets": {
            "wall_time": args.wall_time or values["wall_time"],
            "max_tool_calls": args.max_tool_calls or values["max_tool_calls"],
            "max_turns": args.max_turns or values["max_turns"],
        },
        "exit_code": args.exit_code,
        "status": status,
        "reason": reason,
        "hint": hint,
        "result": (result or {}).get("subtype", "MISSING"),
        "turns": (result or {}).get("num_turns"),
        "duration_s": round(((result or {}).get("duration_ms") or 0) / 1000, 1),
        "fresh_plus_output": fresh + output,
        "tools_requested": tools,
        "warnings": warnings,
        "log": str(log_path) if log_path else "",
        "stderr_log": str(Path(args.stderr).expanduser()) if args.stderr else "",
        "stderr_tail": stderr_text[-800:],
        "note": args.message or "",
    }
    path = append(record)
    print(f"logged status={status} reason={reason} ledger={path}")
    if hint:
        print(f"hint={hint}")
    for warning in warnings:
        print(f"warning={warning}")


def cmd_note(args: argparse.Namespace) -> None:
    path = append(
        {
            "kind": "note",
            "phase": args.phase,
            "status": args.status,
            "session": args.session or "",
            "cwd": os.getcwd(),
            "note": args.message,
        }
    )
    print(f"logged note phase={args.phase} status={args.status} ledger={path}")


def read_ledger() -> list[dict]:
    path = ledger_path()
    if not path.is_file():
        return []
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except (json.JSONDecodeError, ValueError):
            continue
    return records


def annotate_orphans(records: list[dict]) -> list[dict]:
    """A run_start with no matching run record means the wrapper never finished:
    the process tree was killed. Surface it instead of losing the run."""
    finished = {(r.get("session"), r.get("log")) for r in records if r.get("kind") == "run"}
    annotated = []
    for record in records:
        if record.get("kind") != "run_start":
            annotated.append(record)
            continue
        if (record.get("session"), record.get("log")) in finished:
            continue
        orphan = dict(record)
        orphan.update(
            kind="run",
            status="fail",
            reason="killed_unrecorded",
            hint="wrapper died before recording (killed process tree); inspect the diff and the stream log",
            exit_code=None,
            result="MISSING",
            turns=None,
            fresh_plus_output=0,
            model_actual="",
            warnings=[],
        )
        annotated.append(orphan)
    return annotated


def cmd_list(args: argparse.Namespace) -> None:
    records = annotate_orphans(read_ledger())
    if args.failed:
        records = [r for r in records if r.get("status") not in ("ok", "pass")]
    if not records:
        print("ledger empty")
        return
    for record in records[-args.number :]:
        session = (record.get("session") or "-")[:8]
        if record.get("kind") == "note":
            print(f"{record.get('ts')}  note   {session}  {record.get('phase')}  {record.get('status')}  {record.get('note', '')[:80]}")
            continue
        warn = " warn=" + ";".join(record.get("warnings") or []) if record.get("warnings") else ""
        print(
            f"{record.get('ts')}  run    {session}  {record.get('status')}  "
            f"reason={record.get('reason')} exit={record.get('exit_code')} "
            f"model={record.get('model_actual') or record.get('model_requested') or '?'} "
            f"turns={record.get('turns')} fpo={record.get('fresh_plus_output')}{warn}"
        )
    print(f"# ledger={ledger_path()}")


def cmd_show(args: argparse.Namespace) -> None:
    matches = [r for r in annotate_orphans(read_ledger()) if args.session in (r.get("session") or "")]
    if not matches:
        raise SystemExit(f"no ledger records match '{args.session}'")
    for record in matches:
        print(json.dumps(record, indent=2, sort_keys=True))
    last = matches[-1]
    if last.get("stderr_log"):
        text = tail(Path(last["stderr_log"]), 2000)
        if text:
            print("--- stderr tail ---")
            print(text)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    record = sub.add_parser("record", help="log one finished qwen run")
    record.add_argument("--session", default="")
    record.add_argument("--exit-code", type=int, required=True)
    record.add_argument("--log")
    record.add_argument("--stderr")
    record.add_argument("--model", default="")
    record.add_argument("--wall-time", default="")
    record.add_argument("--max-tool-calls", default="")
    record.add_argument("--max-turns", default="")
    record.add_argument("--phase", default="slice")
    record.add_argument("--resumed", action="store_true")
    record.add_argument("--cwd", default="")
    record.add_argument("--message", default="")
    record.set_defaults(func=cmd_record)

    note = sub.add_parser("note", help="log an orchestrator phase outcome")
    note.add_argument("--phase", required=True)
    note.add_argument("--status", required=True, choices=("pass", "fail", "info"))
    note.add_argument("--message", required=True)
    note.add_argument("--session", default="")
    note.set_defaults(func=cmd_note)

    start = sub.add_parser("start", help="log a run launch (so a killed run is not lost)")
    start.add_argument("--session", required=True)
    start.add_argument("--phase", default="slice")
    start.add_argument("--model", default="")
    start.add_argument("--wall-time", default="")
    start.add_argument("--max-tool-calls", default="")
    start.add_argument("--max-turns", default="")
    start.add_argument("--log", default="")
    start.add_argument("--resumed", action="store_true")
    start.set_defaults(func=cmd_start)

    model_for = sub.add_parser("model-for", help="print the model a session actually used")
    model_for.add_argument("session")
    model_for.set_defaults(func=cmd_model_for)

    listing = sub.add_parser("list", help="recent ledger entries")
    listing.add_argument("-n", "--number", type=int, default=10)
    listing.add_argument("--failed", action="store_true")
    listing.set_defaults(func=cmd_list)

    show = sub.add_parser("show", help="full records for one session (prefix ok)")
    show.add_argument("session")
    show.set_defaults(func=cmd_show)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# Run one bounded Qwen Code slice headlessly and print a compact summary.
#
#   qwen_slice.sh --prompt-file PATH [--model M] [--session-id UUID] [--resume UUID]
#                 [--wall-time 45m] [--max-tool-calls N] [--max-turns N]
#                 [--log PATH] [--sandbox] [--no-model-check] [--phase NAME]
#                 [--dry-run] [--] [extra qwen args...]
#
# Budgets and flags default to config/defaults.json, overridable by
# ~/.qwen-gsd/config.json, then QWEN_GSD_* env vars, then these flags
# (`qwen_config.py show` prints the effective values and their source).
#
# The prompt is piped on stdin, so no shell quoting of the slice brief is
# needed. stream-json goes to the log file; only the summary reaches stdout,
# and every run is appended to the ledger by qwen_log.py.

set -euo pipefail
umask 077

here="$(cd "$(dirname "$0")" && pwd)"

eval "$(python3 "$here/qwen_config.py" env)"

model="$QGS_MODEL"
wall_time="$QGS_WALL_TIME"
max_tool_calls="$QGS_MAX_TOOL_CALLS"
max_turns="$QGS_MAX_TURNS"
subagent_depth="$QGS_MAX_SUBAGENT_DEPTH"
safe_mode="$QGS_SAFE_MODE"
sandbox="$QGS_SANDBOX"
check_model="$QGS_MODEL_CHECK"
state_dir="$QGS_STATE_DIR"

model_from_flag=0
prompt_file=""
session_id=""
resume_id=""
log=""
phase="slice"
dry_run=0
extra=()

die() { printf 'qwen_slice: %s\n' "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="${2:?}"; model_from_flag=1; shift 2 ;;
    --prompt-file) prompt_file="${2:?}"; shift 2 ;;
    --session-id) session_id="${2:?}"; shift 2 ;;
    --resume) resume_id="${2:?}"; shift 2 ;;
    --wall-time) wall_time="${2:?}"; shift 2 ;;
    --max-tool-calls) max_tool_calls="${2:?}"; shift 2 ;;
    --max-turns) max_turns="${2:?}"; shift 2 ;;
    --log) log="${2:?}"; shift 2 ;;
    --phase) phase="${2:?}"; shift 2 ;;
    --sandbox) sandbox=1; shift ;;
    --no-model-check) check_model=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    --) shift; extra+=("$@"); break ;;
    *) die "unknown argument: $1" ;;
  esac
done

validated_extra=()
extra_index=0
while [ "$extra_index" -lt "${#extra[@]}" ]; do
  extra_arg="${extra[$extra_index]}"
  case "$extra_arg" in
    --fallback-model|--include-directories)
      value_index=$((extra_index + 1))
      [ "$value_index" -lt "${#extra[@]}" ] || die "$extra_arg requires a value"
      extra_value="${extra[$value_index]}"
      case "$extra_value" in --*) die "$extra_arg requires a value" ;; esac
      validated_extra+=("$extra_arg" "$extra_value")
      extra_index=$((extra_index + 2))
      ;;
    --fallback-model=*|--include-directories=*)
      [ -n "${extra_arg#*=}" ] || die "${extra_arg%%=*} requires a value"
      validated_extra+=("$extra_arg")
      extra_index=$((extra_index + 1))
      ;;
    *)
      die "unsupported pass-through argument: $extra_arg"
      ;;
  esac
done
extra=()
if [ "$extra_index" -gt 0 ]; then
  extra=("${validated_extra[@]}")
fi

[ -n "$prompt_file" ] || die "--prompt-file is required"
[ -r "$prompt_file" ] || die "prompt file not readable: $prompt_file"
command -v qwen >/dev/null 2>&1 || die "qwen CLI not found on PATH"

# A resumed session must stay on the model that authored the slice: qwen uses its
# own default rather than the session's model, and a configured default is a
# weaker signal than the session's recorded history. Resolve it before model
# validation so a changed or stale configured default cannot block a valid
# resume. Only an explicit --model outranks the session record.
if [ -n "$resume_id" ] && [ "$model_from_flag" -eq 0 ]; then
  prior_model="$(python3 "$here/qwen_log.py" model-for "$resume_id" 2>/dev/null || true)"
  if [ -n "$prior_model" ]; then
    model="$prior_model"
    printf 'qwen_slice: resuming on the session model %s\n' "$model" >&2
  else
    printf 'qwen_slice: WARNING resume without --model and no ledger record for %s; qwen will use its built-in default\n' "$resume_id" >&2
  fi
fi

# An unknown --model id makes qwen 0.21.10 fall back to its built-in default
# and still report success, so validate locally before spending a run.
if [ -n "$model" ] && [ "$check_model" -eq 1 ]; then
  python3 "$here/qwen_model_check.py" "$model" >&2 || die "model check failed for '$model' (override with --no-model-check)"
fi

if [ -z "$resume_id" ] && [ -z "$session_id" ]; then
  session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fi
session="${resume_id:-$session_id}"

if [ -z "$log" ]; then
  mkdir -p "$state_dir/logs"
  chmod 700 "$state_dir" "$state_dir/logs"
  log="$state_dir/logs/qwen-${phase}-${session}.jsonl"
fi
stderr_log="${log%.jsonl}.stderr"

args=(--approval-mode yolo --output-format stream-json
      --max-wall-time "$wall_time" --max-session-turns "$max_turns"
      --max-tool-calls "$max_tool_calls" --max-subagent-depth "$subagent_depth")

# Plain `cond && cmd` lines would abort the script under `set -e` whenever the
# condition is false, so every optional argument uses an explicit `if`.
if [ "$safe_mode" -eq 1 ]; then args=(--safe-mode "${args[@]}"); fi
if [ -n "$model" ]; then args+=(--model "$model"); fi
if [ "$sandbox" -eq 1 ]; then args+=(--sandbox); fi
if [ -n "$resume_id" ]; then
  args+=(--resume "$resume_id")
else
  args+=(--session-id "$session_id")
fi
if [ ${#extra[@]} -gt 0 ]; then args+=("${extra[@]}"); fi

if [ "$dry_run" -eq 1 ]; then
  printf 'qwen_slice: dry-run session=%s log=%s\n' "$session" "$log"
  printf 'qwen'; printf ' %q' "${args[@]}"; printf ' < %q\n' "$prompt_file"
  exit 0
fi

printf 'qwen_slice: session=%s phase=%s log=%s\n' "$session" "$phase" "$log" >&2

common_args=(--session "$session" --phase "$phase" --log "$log" --model "$model"
             --wall-time "$wall_time" --max-tool-calls "$max_tool_calls"
             --max-turns "$max_turns")
if [ -n "$resume_id" ]; then common_args+=(--resumed); fi

# Recorded before launch so a killed process tree still leaves a ledger entry;
# `qwen_log.py list` reports an unpaired start as killed_unrecorded.
python3 "$here/qwen_log.py" start "${common_args[@]}" || true

exec python3 "$here/qwen_supervise.py" --prompt-file "$prompt_file" --stderr "$stderr_log" \
  "${common_args[@]}" -- qwen "${args[@]}"

#!/usr/bin/env bash
# codex-pair engine: start or resume a per-topic Codex thread and emit a
# capped result. Fresh runs use the mode's prompt template; follow-ups use
# followup.md against the persisted thread id.
#
# Usage: run.sh <ask|plan|shape|lead|review> [-t topic] [--fresh] [-p tmpl] [--] <prompt...>
# Exit: 0 ok · 1 codex failure · 64 usage · 69 required CLI missing
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

usage() {
    echo "usage: run.sh <ask|plan|shape|lead|review> [-t topic] [--fresh] [-p tmpl] [--] <prompt...>" >&2
    exit 64
}

[ $# -ge 1 ] || usage
MODE="$1"; shift
mode_defaults "$MODE"

TOPIC="" FRESH=0 TMPL=""
# A value-taking flag must be checked for its value before dereferencing $2: under
# `set -u` a bare trailing `-t` would abort with "unbound variable" and exit 1, which
# reads as an engine crash rather than the usage error it is.
need_value() {  # $1=flag $2=count-remaining
    [ "$2" -ge 2 ] || { echo "error: $1 requires a value" >&2; usage; }
}
while [ $# -gt 0 ]; do
    case "$1" in
        -t|--topic) need_value "$1" $#; TOPIC="$2"; shift 2 ;;
        -t=*|--topic=*) TOPIC="${1#*=}"; shift ;;
        -p|--template) need_value "$1" $#; TMPL="$2"; shift 2 ;;
        -p=*|--template=*) TMPL="${1#*=}"; shift ;;
        --fresh) FRESH=1; shift ;;
        --) shift; break ;;
        -*) echo "error: unknown flag: $1" >&2; usage ;;
        *) break ;;
    esac
done
[ $# -ge 1 ] || usage
PROMPT="$*"
[ -n "$TOPIC" ] || TOPIC="$(default_topic)"
TOPIC="$(normalize_topic "$TOPIC")"
ensure_state_dir
state_files "$MODE" "$TOPIC"

# -p reframes one turn without splitting the thread: `lead` authors the slice spec
# on turn 1, then reviews the diff against it with `-p review.md` on later turns.
[ -z "$TMPL" ] || [ -f "$PROMPTS_DIR/$TMPL" ] || {
    echo "error: no such template: $PROMPTS_DIR/$TMPL" >&2; exit 64
}

# Preflight AFTER argument validation, so a usage error still reports as a usage error.
# A missing CLI must fail loudly here and never look downstream like a completed review.
command -v codex >/dev/null 2>&1 || {
    echo "error: 'codex' not on PATH — codex-pair cannot run. Run /codex:setup." >&2; exit 69
}
command -v jq >/dev/null 2>&1 || {
    echo "error: 'jq' not on PATH — needed to track the Codex thread id. brew install jq" >&2; exit 69
}

[ "$FRESH" -eq 1 ] && rm -f "$THREAD_FILE" "$OUT_FILE" "$EVENTS_FILE" \
    "$EVENTS_FILE.stderr" "$META_FILE" "$PHASE_FILE" "$SPEC_FILE"

# The lead thread changes role exactly once: spec -> review. Preserve both the phase and
# the original spec before the first review overwrites OUT_FILE. If a later resume is truly
# stale, a fresh review can still receive the contract it is meant to enforce.
if [ "$MODE" = lead ] && [ "$TMPL" = review.md ] \
        && [ ! -s "$SPEC_FILE" ] && [ -s "$OUT_FILE" ]; then
    cp "$OUT_FILE" "$SPEC_FILE"
fi

build_prompt() {  # $1=template file
    printf '%s\n\n## Task\n%s\n' "$(cat "$PROMPTS_DIR/$1")" "$PROMPT"
    if [ "$MODE" = lead ] && [ "$1" = review.md ] && [ -s "$SPEC_FILE" ]; then
        printf '\n## Prior lead specification\n%s\n' "$(cat "$SPEC_FILE")"
    fi
}

print_failure() {  # $1=rc
    echo "error: codex exec failed (rc=$1)" >&2
    jq -r 'select(.type=="error") | .message' "$EVENTS_FILE" 2>/dev/null | tail -5 >&2 || true
    tail -3 "$EVENTS_FILE.stderr" >&2 2>/dev/null || true
}

current_phase() {
    if [ -n "$TMPL" ]; then
        printf '%s' "$TMPL"
    elif [ -s "$PHASE_FILE" ]; then
        cat "$PHASE_FILE"
    else
        printf '%s.md' "$MODE"
    fi
}

persist_success() {
    write_run_meta
    if [ -n "$TMPL" ] || [ ! -s "$PHASE_FILE" ]; then
        current_phase > "$PHASE_FILE"
    fi
}

run_fresh() {
    local phase rc
    phase="$(current_phase)"
    rm -f "$OUT_FILE" "$EVENTS_FILE" "$EVENTS_FILE.stderr"
    codex exec --json \
        --sandbox "$SANDBOX" \
        -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
        -o "$OUT_FILE" --skip-git-repo-check -C "$PWD" \
        "$(build_prompt "$phase")" \
        </dev/null >"$EVENTS_FILE" 2>"$EVENTS_FILE.stderr" || {
            rc=$?
            print_failure "$rc"
            exit 1
        }
    # `|| true` is load-bearing: jq exits 5 on a malformed events file, and under
    # `set -euo pipefail` that would abort the script BEFORE emit_result — throwing away
    # the answer of a Codex run already paid for. Losing the thread id is recoverable
    # (the next call starts fresh); losing the output is not.
    jq -r 'select(.type=="thread.started") | .thread_id' "$EVENTS_FILE" 2>/dev/null \
        | head -n1 > "$THREAD_FILE" || true
    if [ ! -s "$THREAD_FILE" ]; then
        rm -f "$THREAD_FILE"
        echo "[codex-pair] warning: no thread id captured — follow-ups will start fresh" >&2
    fi
    persist_success
}

if [ -s "$THREAD_FILE" ]; then
    # Resume the existing thread. Only a confirmed missing/expired session may fall back
    # fresh; auth, quota, model and transient failures preserve the thread and fail loudly.
    # Treating every non-zero exit as "stale" destroys the spec context at exactly the point
    # lead mode is meant to review against it.
    # NOTE: `codex exec resume` accepts no -C/--cd (unlike `codex exec`) — passing it
    # exits 2 and silently downgrades every follow-up to a fresh thread. We already
    # run in the repo cwd, so no -C is needed.
    if codex exec resume "$(cat "$THREAD_FILE")" --json \
            -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
            -o "$OUT_FILE" --skip-git-repo-check \
            "$(build_prompt "${TMPL:-followup.md}")" \
            </dev/null >"$EVENTS_FILE" 2>"$EVENTS_FILE.stderr"; then
        persist_success
    else
        rc=$?
        if { jq -r 'select(.type=="error") | .message' "$EVENTS_FILE" 2>/dev/null || true
             cat "$EVENTS_FILE.stderr" 2>/dev/null || true
           } | grep -Eiq '((thread|session).*(not found|does not exist|no such|unknown|expired|stale)|'\
'(not found|does not exist|no such|unknown|expired|stale).*(thread|session))'; then
            rm -f "$THREAD_FILE"
            echo "[codex-pair] thread stale — restarted fresh with phase $(current_phase)" >&2
            run_fresh
        else
            print_failure "$rc"
            echo "[codex-pair] thread preserved; retry the same mode/topic after fixing the failure" >&2
            exit 1
        fi
    fi
else
    run_fresh
fi

emit_result "$MODE" "$TOPIC"

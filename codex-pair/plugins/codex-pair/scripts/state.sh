#!/usr/bin/env bash
# Mutating codex-pair state commands. Read-only inspection lives in inspect.sh so hosts can
# pre-approve it without implicitly authorizing these changes.
#
# Usage: state.sh reset <mode> [topic]
#        state.sh attach [topic] | decline [topic] | detach [topic]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

CMD="${1:-}"
case "$CMD" in
    reset)
        MODE="${2:?usage: state.sh reset <mode> [topic]}"
        TOPIC="${3:-$(default_topic)}"
        mode_defaults "$MODE"
        state_files "$MODE" "$TOPIC"
        rm -f "$THREAD_FILE" "$OUT_FILE" "$EVENTS_FILE" "$EVENTS_FILE.stderr" \
              "$META_FILE" "$PHASE_FILE" "$SPEC_FILE"
        echo "[codex-pair] reset $MODE.$(normalize_topic "$TOPIC")"
        ;;
    attach|decline|detach)
        # Lead attachment is per topic (branch); no mode argument.
        TOPIC="${2:-$(default_topic)}"
        TOPIC="$(normalize_topic "$TOPIC")"
        ensure_state_dir
        MARKER="$(attach_file "$TOPIC")"
        case "$CMD" in
            attach)  echo attached > "$MARKER"; echo "[codex-pair] lead attached to $TOPIC" ;;
            decline) echo declined > "$MARKER"; echo "[codex-pair] lead declined for $TOPIC — will not ask again" ;;
            detach)  rm -f "$MARKER"; echo "[codex-pair] lead cleared for $TOPIC — next run asks again" ;;
        esac
        ;;
    *)
        echo "usage: state.sh reset <mode> [topic]" >&2
        echo "       state.sh attach [topic] | decline [topic] | detach [topic]" >&2
        exit 64
        ;;
esac

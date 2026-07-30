#!/usr/bin/env bash
# Read-only codex-pair state inspection. This script deliberately has no mutation commands,
# so Claude Code can pre-approve it without also pre-approving reset/attach/detach.
#
# Usage: inspect.sh show <mode> [topic] | status [topic] | list
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

CMD="${1:-}"
case "$CMD" in
    show)
        MODE="${2:?usage: inspect.sh show <mode> [topic]}"
        TOPIC="${3:-$(default_topic)}"
        mode_defaults "$MODE"
        state_files "$MODE" "$TOPIC"
        emit_result "$MODE" "$(normalize_topic "$TOPIC")"
        ;;
    status)
        TOPIC="${2:-$(default_topic)}"
        TOPIC="$(normalize_topic "$TOPIC")"
        MARKER="$(attach_file "$TOPIC")"
        if [ -s "$MARKER" ]; then
            printf '%s %s\n' "$(cat "$MARKER")" "$TOPIC"
        else
            printf 'unasked %s\n' "$TOPIC"
        fi
        ;;
    list)
        echo "[codex-pair] state root: $HOME/.claude/codex-pair/state"
        for d in "$HOME/.claude/codex-pair/state"/*/; do
            [ -d "$d" ] || continue
            echo "$(basename "$d"):"
            ls "$d" 2>/dev/null \
                | sed -E 's/\.(thread|out\.md|attach|events\.jsonl(\.stderr)?|meta|phase|spec\.md)$//' \
                | sort -u | sed 's/^/  /'
        done
        ;;
    *)
        echo "usage: inspect.sh show <mode> [topic] | status [topic] | list" >&2
        exit 64
        ;;
esac

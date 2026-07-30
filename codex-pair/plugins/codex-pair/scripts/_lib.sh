#!/usr/bin/env bash
# Shared helpers for codex-pair. Source-only.
set -euo pipefail

# Self-locating: works from the repo checkout or an installed plugin cache copy,
# with no dependence on CLAUDE_PLUGIN_ROOT being exported.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPTS_DIR="$PLUGIN_DIR/prompts"

# Per-project state: human-readable basename + short path hash (worktrees stay distinct).
slug() {
    local b
    b="$(basename "$PWD")"
    printf '%s-%s' "${b//[^A-Za-z0-9._-]/_}" "$(pwd | shasum | cut -c1-8)"
}

STATE_DIR="$HOME/.claude/codex-pair/state/$(slug)"
ensure_state_dir() { mkdir -p "$STATE_DIR"; }

# Turn a branch or explicit topic into one safe path component. Preserve already-safe names
# so existing `main`/ticket state remains valid. If normalization changes anything, append a
# short hash so `feature/a` cannot collide with a real branch named `feature-a`.
normalize_topic() {
    local raw="$1" safe
    safe="$(printf '%s' "$raw" | tr -c 'A-Za-z0-9._-' '-')"
    safe="${safe#-}"; safe="${safe%-}"
    [ -n "$safe" ] || safe="topic"
    if [ "$safe" != "$raw" ]; then
        safe="$safe-$(printf '%s' "$raw" | shasum | cut -c1-8)"
    fi
    printf '%s' "$safe"
}

# Default topic = current git branch; same branch naturally continues one thread.
default_topic() {
    local b
    b="$(git branch --show-current 2>/dev/null || true)"
    [ -n "$b" ] || b="main"
    normalize_topic "$b"
}

# mode -> model / effort / sandbox. CODEX_MODEL / CODEX_EFFORT override per run.
# Every mode is read-only: Codex thinks, Claude writes. (Codex-authored code is
# the official plugin's job -- /codex:rescue.)
mode_defaults() {
    case "$1" in
        ask)    MODEL="${CODEX_MODEL:-gpt-5.5}"     EFFORT="${CODEX_EFFORT:-high}"  SANDBOX="read-only" ;;
        plan)   MODEL="${CODEX_MODEL:-gpt-5.6-sol}" EFFORT="${CODEX_EFFORT:-xhigh}" SANDBOX="read-only" ;;
        shape)  MODEL="${CODEX_MODEL:-gpt-5.6-sol}" EFFORT="${CODEX_EFFORT:-xhigh}" SANDBOX="read-only" ;;
        lead)   MODEL="${CODEX_MODEL:-gpt-5.6-sol}" EFFORT="${CODEX_EFFORT:-xhigh}" SANDBOX="read-only" ;;
        review) MODEL="${CODEX_MODEL:-gpt-5.6-sol}" EFFORT="${CODEX_EFFORT:-xhigh}" SANDBOX="read-only" ;;
        *) echo "error: unknown mode '$1' (ask|plan|shape|lead|review)" >&2; return 64 ;;
    esac
}

# Lead attachment for a topic, as one file holding one word: `attached` or `declined`.
# Absent means never asked — three distinct states, so "ask once" is a promise the agent
# can actually keep. Advisory only: run.sh behaves identically whatever this says.
attach_file() {  # $1=topic
    printf '%s/lead.%s.attach' "$STATE_DIR" "$(normalize_topic "$1")"
}

state_files() {  # $1=mode $2=topic -> sets the files belonging to one discussion
    local key="$1.$(normalize_topic "$2")"
    THREAD_FILE="$STATE_DIR/$key.thread"
    OUT_FILE="$STATE_DIR/$key.out.md"
    EVENTS_FILE="$STATE_DIR/$key.events.jsonl"
    META_FILE="$STATE_DIR/$key.meta"
    PHASE_FILE="$STATE_DIR/$key.phase"
    SPEC_FILE="$STATE_DIR/$key.spec.md"
}

OUT_CAP=10240

# How many trailing bytes of a byte string form an INCOMPLETE UTF-8 sequence (0 if none).
# Capping at a byte boundary can cut a multibyte character in half; the fragment then
# reaches the terminal as a replacement glyph and makes the emitted block invalid UTF-8.
#
# This returns a COUNT rather than the trimmed string on purpose. Passing bytes back
# through `$(...)` would strip trailing newlines, so emit_result would quietly reflow the
# tail of ordinary Markdown output; with a count, the caller streams the exact bytes
# straight out of the file.
#
# `local LC_ALL=C` is load-bearing twice over: it makes ${#s} and ${s: -n:1} count BYTES
# rather than characters, and it makes printf %d on a high byte yield the byte value
# instead of a decoded code point. bash re-initializes its locale on assignment, and
# `local` restores the caller's locale on return.
utf8_tail_fragment() {  # $1=bytes -> count on stdout
    local LC_ALL=C s="$1" k=0 n len
    # bash's printf reports a byte >= 0x80 as a NEGATIVE number (signed char), so every
    # high byte has to be folded back into 0-255 before any range test.
    byte_at() {  # $1=offset-from-end (1-based) -> 0..255 on stdout
        local v
        v="$(printf '%d' "'${s: -$1:1}")"
        [ "$v" -ge 0 ] || v=$((v + 256))
        printf '%d' "$v"
    }
    # Count the trailing continuation bytes (0x80-0xBF). At most 3 can follow a lead byte.
    while [ "$k" -lt 3 ] && [ "$k" -lt "${#s}" ]; do
        n="$(byte_at $((k + 1)))"
        { [ "$n" -ge 128 ] && [ "$n" -le 191 ]; } || break
        k=$((k + 1))
    done
    # The byte just before them should be the lead byte of a k+1-or-longer sequence.
    if [ "$((k + 1))" -le "${#s}" ]; then
        n="$(byte_at $((k + 1)))"
        if   [ "$n" -ge 240 ]; then len=4
        elif [ "$n" -ge 224 ]; then len=3
        elif [ "$n" -ge 192 ]; then len=2
        else                        len=0
        fi
        # Sequence started but did not finish inside the cap -> drop the whole fragment.
        if [ "$len" -ne 0 ] && [ "$((k + 1))" -lt "$len" ]; then
            printf '%d' "$((k + 1))"
            return 0
        fi
    fi
    printf '0'
}

# What a run cost. `fresh` (input minus cache hits) plus `out` is the number worth
# comparing between runs. Strictly optional: stays silent when the events file is
# absent, still mid-turn, or malformed — `inspect.sh show` must never fail over it.
usage_summary() {
    [ -f "$EVENTS_FILE" ] || return 0
    jq -r 'select(.type=="turn.completed") | .usage
           | " fresh=\(.input_tokens - .cached_input_tokens) cached=\(.cached_input_tokens) out=\(.output_tokens)"' \
        "$EVENTS_FILE" 2>/dev/null | tail -n1
    return 0
}

# Persist what actually ran. `inspect.sh show` happens in a later shell where per-run model
# overrides are gone, so recomputing defaults there would mislabel the saved result.
write_run_meta() {
    printf 'MODEL=%q\nEFFORT=%q\n' "$MODEL" "$EFFORT" > "$META_FILE"
}

# The ONLY output Claude should read: one header line + capped answer.
emit_result() {  # $1=mode $2=topic
    local thread="-" usage="" shown_model="${MODEL:-?}" shown_effort="${EFFORT:-?}"
    if [ -f "$META_FILE" ]; then
        # This file is generated only by write_run_meta and contains shell-escaped values.
        # shellcheck disable=SC1090
        source "$META_FILE"
        shown_model="$MODEL"; shown_effort="$EFFORT"
    fi
    [ -f "$THREAD_FILE" ] && thread="$(cat "$THREAD_FILE")"
    usage="$(usage_summary || true)"
    echo "[codex-pair] mode=$1 topic=$2 model=$shown_model/$shown_effort thread=$thread$usage"
    echo "---"
    if [ -f "$OUT_FILE" ]; then
        # Measure the fragment on a copy, then stream the real bytes from the file, so
        # trailing newlines inside the cap survive untouched.
        local drop
        drop="$(utf8_tail_fragment "$(LC_ALL=C head -c "$OUT_CAP" "$OUT_FILE")")"
        LC_ALL=C head -c "$((OUT_CAP - drop))" "$OUT_FILE"
        echo
        if [ "$(wc -c < "$OUT_FILE")" -gt "$OUT_CAP" ]; then
            echo "[truncated at ${OUT_CAP}B — full output: $OUT_FILE]"
        fi
    else
        echo "[no output file]"
    fi
}

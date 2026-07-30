#!/usr/bin/env bash
# codex-pair project checks: offline — no Codex runs, no network, no repo mutation, and
# no writes to the user's real codex-pair state. The engine's thread lifecycle is exercised
# end to end against a fake `codex` binary.
# Run from the project directory: bash scripts/check.sh
set -uo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$PROJECT/plugins/codex-pair"
SCRIPTS="$PLUGIN/scripts"
PROMPTS="$PLUGIN/prompts"
SKILL="$PLUGIN/skills/codex-pair/SKILL.md"
MODES="ask shape plan lead review"

# State isolation. The engine keys STATE_DIR off $HOME, and several checks below drive it
# for real. Without this override the suite writes thread and attach files into the user's
# live ~/.claude/codex-pair/state — and a test topic colliding with a running thread would
# clobber it. Redirect $HOME before anything sources _lib.sh.
HOME_REAL="$HOME"   # kept only to READ ~/.claude/settings.json; never written to
TMPHOME="$(mktemp -d)"
FAKEBIN="$(mktemp -d)"
trap 'rm -rf "$TMPHOME" "$FAKEBIN"' EXIT
export HOME="$TMPHOME"

fails=0
ok()   { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# 1. Every shell file parses.
for f in "$SCRIPTS"/*.sh; do
    if bash -n "$f" 2>/dev/null; then ok "syntax $(basename "$f")"; else fail "syntax $(basename "$f")"; fi
done

# 2. Every mode has a prompt template, and followup.md exists for resumed turns.
for m in $MODES followup; do
    [ -f "$PROMPTS/$m.md" ] && ok "prompt $m.md" || fail "prompt $m.md missing"
done

# 3. Modes in _lib.sh match the templates on disk — a mode without a prompt fails at runtime.
declared="$(sed -n 's/^ *\([a-z]*\)) *MODEL=.*/\1/p' "$SCRIPTS/_lib.sh" | sort | tr '\n' ' ')"
expected="$(printf '%s\n' $MODES | sort | tr '\n' ' ')"
[ "$declared" = "$expected" ] && ok "modes match ($expected)" || fail "modes: _lib.sh has [$declared], expected [$expected]"

# 4. Every prompt template that promises a verdict offers all three values — the exact
#    three. Counting lines is not enough: a misspelling or a duplicate keeps the count at
#    three while the caller's `VERDICT:` parser silently stops matching.
# Plain `sort`, never `sort -u`: deduplicating would let a template that lists APPROVED
# twice collapse back onto the expected set and pass.
want_verdicts="$(printf 'VERDICT: APPROVED\nVERDICT: NEEDS_REWORK\nVERDICT: REQUEST_CHANGES\n')"
for m in plan review; do
    got="$(grep '^VERDICT: ' "$PROMPTS/$m.md" | sort)"
    if [ "$got" = "$want_verdicts" ]; then
        ok "verdict block $m.md"
    else
        fail "verdict block $m.md: got [$(printf '%s' "$got" | tr '\n' '/')]"
    fi
done

# 5. Argument guards refuse cleanly instead of reaching the Codex API.
guard() {  # $1=label, rest=args
    local label="$1"; shift
    ( cd "$PROJECT" && bash "$SCRIPTS/run.sh" "$@" >/dev/null 2>&1 )
    [ "$?" -eq 64 ] && ok "guard $label" || fail "guard $label did not exit 64"
}
guard "no args"
guard "unknown mode" nope "x"
guard "missing template" lead -p nope.md "x"
# A value-taking flag with no value is a usage error, not an engine crash. Before the
# guard these dereferenced $2 under `set -u` and exited 1 with a raw bash diagnostic.
guard "-t without a value" ask -t
guard "--topic without a value" ask --topic
guard "-p without a value" lead -p
guard "--template without a value" lead --template

# 5b. A missing CLI must exit 69, never look like a completed review.
( cd "$PROJECT" && PATH=/usr/bin:/bin bash "$SCRIPTS/run.sh" ask "x" >/dev/null 2>&1 )
[ "$?" -eq 69 ] && ok "guard missing codex CLI" || fail "missing codex CLI did not exit 69"

# 5b2. jq missing must also exit 69, with its own message. macOS ships /usr/bin/jq, so the
#      PATH has to be an allowlist: a fake `codex` plus only the tools run.sh reaches before
#      the jq check. Everything else absent, jq included.
shim="$(mktemp -d)"
printf '#!/bin/sh\nexit 0\n' > "$shim/codex"; chmod +x "$shim/codex"
for t in bash env dirname basename shasum cut tr mkdir git rm cat; do
    p="$(command -v "$t")" && ln -sf "$p" "$shim/$t"
done
out="$( cd "$PROJECT" && PATH="$shim" bash "$SCRIPTS/run.sh" ask "x" 2>&1 )"
rc=$?
if [ "$rc" -eq 69 ] && printf '%s' "$out" | grep -q "'jq'"; then
    ok "guard missing jq"
else
    fail "guard missing jq: rc=$rc out=[$out]"
fi
rm -rf "$shim"

# 5c. Attach is tri-state: unasked / attached / declined, so "ask once" is keepable.
attach_state() {
    if [ "$1" = status ]; then
        ( cd "$PROJECT" && bash "$SCRIPTS/inspect.sh" status __check__ 2>/dev/null )
    else
        ( cd "$PROJECT" && bash "$SCRIPTS/state.sh" "$1" __check__ 2>/dev/null )
    fi
}
attach_state detach >/dev/null
seq="$(attach_state status)"
attach_state attach >/dev/null;  seq="$seq|$(attach_state status)"
attach_state decline >/dev/null; seq="$seq|$(attach_state status)"
attach_state detach >/dev/null;  seq="$seq|$(attach_state status)"
want="unasked __check__|attached __check__|declined __check__|unasked __check__"
[ "$seq" = "$want" ] && ok "attach tri-state" || fail "attach tri-state: [$seq]"

# 5d. The attach file must not leak into `inspect.sh list` as a bogus mode.topic key.
attach_state attach >/dev/null
if ( cd "$PROJECT" && bash "$SCRIPTS/inspect.sh" list ) | grep -q '\.attach'; then
    fail "list leaks the .attach suffix"
else
    ok "list normalizes .attach"
fi
attach_state detach >/dev/null

# 5e. Token accounting is optional: present when the turn completed, silent and non-fatal
#     when the events file is malformed or absent. `inspect.sh show` must never fail over it.
usage_case() {  # $1=label $2=events-content(empty for none) $3=grep-pattern-or-NONE
    local dir topic="__usage_$1__"
    dir="$( cd "$PROJECT" && bash -c 'source '"$SCRIPTS"'/_lib.sh; printf %s "$STATE_DIR"' )"
    printf 'x\n' > "$dir/plan.$topic.out.md"
    [ -z "$2" ] || printf '%s\n' "$2" > "$dir/plan.$topic.events.jsonl"
    # No `| head` here: under pipefail that kills state.sh with SIGPIPE and reports 141.
    local out rc head
    out="$( cd "$PROJECT" && bash "$SCRIPTS/inspect.sh" show plan "$topic" 2>/dev/null )"
    rc=$?
    head="${out%%$'\n'*}"
    rm -f "$dir/plan.$topic."*
    if [ "$rc" -ne 0 ]; then
        fail "usage $1: inspect.sh show exited $rc"
    elif [ "$3" = "NONE" ] && printf '%s' "$head" | grep -q 'fresh='; then
        fail "usage $1: reported accounting it could not have"
    elif [ "$3" != "NONE" ] && ! printf '%s' "$head" | grep -q "$3"; then
        fail "usage $1: expected [$3] in [$head]"
    else
        ok "usage $1"
    fi
}
usage_case complete '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":3}}' 'fresh=60 cached=40 out=7'
usage_case malformed 'not json at all' NONE
usage_case absent '' NONE

# 6. `codex exec resume` takes no -C: passing it silently downgrades every follow-up
#    to a fresh thread, which breaks lead-mode spec continuity. Keep it out.
#    Comments are stripped first so the explanatory note above the call is not a match.
if sed 's/#.*//' "$SCRIPTS/run.sh" | grep -A4 'codex exec resume' | grep -q -- '-C'; then
    fail "resume passes -C (breaks thread continuity)"
else
    ok "resume omits -C"
fi

# 6b. utf8_tail_fragment at EVERY cut offset. The e2e truncation test below only exercises
#     one boundary (a 3-byte character cut after 1 byte); a sign-handling or off-by-one bug
#     in the 2- and 4-byte paths would sail straight past it.
# shellcheck source=../plugins/codex-pair/scripts/_lib.sh
( source "$SCRIPTS/_lib.sh" >/dev/null 2>&1
  bad=""
  probe() {  # $1=char-bytes $2=sequence-length
      local n pre got want
      for n in $(seq 1 "$2"); do
          pre="$(LC_ALL=C printf "ab$1" | LC_ALL=C head -c $((2 + n)))"
          got="$(utf8_tail_fragment "$pre")"
          if [ "$n" -lt "$2" ]; then want="$n"; else want=0; fi
          [ "$got" = "$want" ] || bad="$bad ${2}byte@$n(got=$got,want=$want)"
      done
  }
  probe '\xc3\xa9'             2
  probe '\xe4\xb8\xad'         3
  probe '\xf0\x9f\x98\x80'     4
  [ "$(utf8_tail_fragment 'plain ascii')" = 0 ] || bad="$bad ascii"
  [ "$(utf8_tail_fragment '')" = 0 ]            || bad="$bad empty"
  [ -z "$bad" ] || { printf 'BAD%s\n' "$bad"; exit 1; }
) > "$FAKEBIN/utf8.probe" 2>&1
if [ $? -eq 0 ]; then
    ok "utf8_tail_fragment at all 2/3/4-byte cut offsets"
else
    fail "utf8_tail_fragment: $(cat "$FAKEBIN/utf8.probe")"
fi

# 7. Engine contract, end to end, against a fake `codex`. This is the only place the
#    thread lifecycle is actually executed: fresh capture, resume framing, exactly-once
#    stale fallback, survival of a malformed events file, and UTF-8-safe capping. Offline
#    and free — the fake never touches the network and $HOME is the temp dir above.
cat > "$FAKEBIN/codex" <<'FAKE'
#!/usr/bin/env bash
# Fake codex CLI. Records argv, honours -o, and emits controlled JSON events on stdout
# (which is where run.sh expects the event stream). Knobs: FAKE_THREAD, FAKE_OUT,
# FAKE_EVENTS=good|garbage, FAKE_RESUME_RC, FAKE_RESUME_ERROR.
set -u
# One line per invocation. Only the leading args — the prompt is multi-line and would
# otherwise make every "count the invocations" assertion count prompt lines instead.
printf '%s %s %s\n' "$1" "${2:-}" "${3:-}" >> "$FAKE_LOG"
kind=exec; [ "${2:-}" = resume ] && kind=resume
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf '%s' "${!#}" > "$FAKE_LOG.prompt.$kind"
if [ "$kind" = resume ] && [ "${FAKE_RESUME_RC:-0}" -ne 0 ]; then
    printf '{"type":"error","message":"%s"}\n' "${FAKE_RESUME_ERROR:-no such thread}"
    exit "$FAKE_RESUME_RC"
fi
[ -z "$out" ] || printf '%s' "${FAKE_OUT:-answer-body}" > "$out"
if [ "${FAKE_EVENTS:-good}" = garbage ]; then
    printf 'not json at all\n'
else
    printf '{"type":"thread.started","thread_id":"%s"}\n' "${FAKE_THREAD:-t-fresh}"
    printf '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}\n'
fi
exit 0
FAKE
chmod +x "$FAKEBIN/codex"
export FAKE_LOG="$FAKEBIN/log"
E2E="__e2e__"
FKERR="$FAKEBIN/err"
fk() {  # run the real engine with the fake codex in front; stderr parked in $FKERR
    ( cd "$PROJECT" && PATH="$FAKEBIN:$PATH" bash "$SCRIPTS/run.sh" "$@" 2>"$FKERR" )
}
e2e_reset() { ( cd "$PROJECT" && bash "$SCRIPTS/state.sh" reset ask "$E2E" >/dev/null 2>&1 ); }

# 7a. Fresh run: captures the thread id, emits the answer, reports usage.
e2e_reset; : > "$FAKE_LOG"
export FAKE_THREAD=t-one
out="$(fk ask -t "$E2E" hello)"; rc=$?
if [ "$rc" -eq 0 ] \
   && printf '%s' "$out" | grep -q 'thread=t-one' \
   && printf '%s' "$out" | grep -q 'answer-body' \
   && printf '%s' "$out" | grep -q 'fresh=6 cached=4 out=2'; then
    ok "e2e fresh run"
else
    fail "e2e fresh run: rc=$rc out=[$out]"
fi

# 7b. Follow-up resumes the SAME thread and reframes with followup.md. A regression here
#     is invisible at runtime — you just get an amnesiac reviewer.
: > "$FAKE_LOG"
out="$(fk ask -t "$E2E" second)"; rc=$?
if [ "$rc" -eq 0 ] \
   && grep -q 'exec resume t-one' "$FAKE_LOG" \
   && grep -q 'Follow-up in the same discussion' "$FAKE_LOG.prompt.resume"; then
    ok "e2e resume reuses thread + followup.md"
else
    fail "e2e resume: rc=$rc log=[$(cat "$FAKE_LOG")]"
fi

# 7c. A dead thread falls back to EXACTLY ONE fresh start — not zero (silent amnesia),
#     not a retry loop.
: > "$FAKE_LOG"
export FAKE_RESUME_RC=1 FAKE_THREAD=t-two
out="$(fk ask -t "$E2E" third)"; rc=$?
resumes="$(grep -c 'exec resume' "$FAKE_LOG")"
freshes="$(grep -vc 'exec resume' "$FAKE_LOG")"
if [ "$rc" -eq 0 ] && [ "$resumes" -eq 1 ] && [ "$freshes" -eq 1 ] \
   && printf '%s' "$out" | grep -q 'thread=t-two' \
   && grep -q 'thread stale' "$FKERR"; then
    ok "e2e stale thread falls back exactly once"
else
    fail "e2e stale fallback: rc=$rc resumes=$resumes freshes=$freshes err=[$(cat "$FKERR")]"
fi
unset FAKE_RESUME_RC

# 7c2. A non-stale resume failure must preserve the thread and must NOT spend a fresh run.
# Auth/quota/model/transient failures are not evidence that the session disappeared.
: > "$FAKE_LOG"
export FAKE_RESUME_RC=1 FAKE_RESUME_ERROR='authentication failed'
out="$(fk ask -t "$E2E" auth-failure 2>&1)"; rc=$?
resumes="$(grep -c 'exec resume' "$FAKE_LOG")"
freshes="$(grep -vc 'exec resume' "$FAKE_LOG")"
thread_file="$( cd "$PROJECT" && bash -c 'source '"$SCRIPTS"'/_lib.sh; state_files ask '"$E2E"'; printf %s "$THREAD_FILE"' )"
if [ "$rc" -eq 1 ] && [ "$resumes" -eq 1 ] && [ "$freshes" -eq 0 ] \
        && [ -s "$thread_file" ] && grep -q 'thread preserved' "$FKERR"; then
    ok "e2e non-stale resume failure preserves thread"
else
    fail "e2e non-stale resume: rc=$rc resumes=$resumes freshes=$freshes out=[$out]"
fi
unset FAKE_RESUME_RC FAKE_RESUME_ERROR

# 7c3. Lead review phase and the original spec survive a genuinely stale resume. A correction
# call without another `-p review.md` must restart as a review and receive the saved contract,
# never fall back to lead.md and author a second spec.
LEAD_E2E="__lead_phase__"
( cd "$PROJECT" && bash "$SCRIPTS/state.sh" reset lead "$LEAD_E2E" >/dev/null 2>&1 )
export FAKE_OUT='SPEC-CONTENT'
fk lead -t "$LEAD_E2E" goal >/dev/null
export FAKE_OUT='REVIEW-ONE'
fk lead -t "$LEAD_E2E" -p review.md implemented >/dev/null
: > "$FAKE_LOG"
export FAKE_RESUME_RC=1 FAKE_RESUME_ERROR='no such thread' FAKE_OUT='RECOVERED'
out="$(fk lead -t "$LEAD_E2E" corrected)"; rc=$?
if [ "$rc" -eq 0 ] \
   && grep -q 'You are an adversarial senior reviewer' "$FAKE_LOG.prompt.exec" \
   && grep -q 'Prior lead specification' "$FAKE_LOG.prompt.exec" \
   && grep -q 'SPEC-CONTENT' "$FAKE_LOG.prompt.exec"; then
    ok "e2e lead stale recovery preserves review phase + spec"
else
    fail "e2e lead phase recovery: rc=$rc prompt=[$(cat "$FAKE_LOG.prompt.exec")]"
fi
unset FAKE_RESUME_RC FAKE_RESUME_ERROR FAKE_OUT
( cd "$PROJECT" && bash "$SCRIPTS/state.sh" reset lead "$LEAD_E2E" >/dev/null 2>&1 )

# 7d. A malformed events file must NOT cost the caller the answer. jq exits 5 on a parse
#     error, and under `set -euo pipefail` that aborted run.sh before emit_result — the
#     Codex run was paid for and its output silently discarded. Losing the thread id is
#     recoverable; losing the output is not.
e2e_reset; : > "$FAKE_LOG"
export FAKE_EVENTS=garbage
out="$(fk ask -t "$E2E" fourth)"; rc=$?
if [ "$rc" -eq 0 ] \
   && printf '%s' "$out" | grep -q 'answer-body' \
   && grep -q 'no thread id captured' "$FKERR"; then
    ok "e2e malformed events still emits the answer"
else
    fail "e2e malformed events: rc=$rc out=[$out] err=[$(cat "$FKERR")]"
fi
unset FAKE_EVENTS

# 7e. Capping happens on a byte boundary, so it can slice a multibyte character in half.
#     The emitted block must stay valid UTF-8 and stay within the cap.
e2e_reset; : > "$FAKE_LOG"
# Braces are required: under a UTF-8 locale bash swallows the following CJK bytes into
# the variable name, and `$FAKE_OUT中` is an unbound-variable abort under `set -u`.
FAKE_OUT=""
for _ in $(seq 1 500); do FAKE_OUT="${FAKE_OUT}中中中中中中中中中中"; done  # 5000 chars = 15000 B
export FAKE_OUT
out="$(fk ask -t "$E2E" fifth)"; rc=$?
body="$(printf '%s\n' "$out" | sed -n '3,$p' | sed '$d')"
nbytes="$(printf '%s' "$body" | LC_ALL=C wc -c | tr -d ' ')"
# python3, not iconv: macOS libiconv misreports a valid ~10KB stream as invalid at this
# buffer size, so it would fail the check for the wrong reason. python3 is already a hard
# dependency of the workspace verifier that runs this script.
# No "skip" branch: an assertion that cannot run must not report success. python3 is
# already a hard dependency of scripts/plugins.py, which is what runs this suite.
valid=no
if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$body" | python3 -c 'import sys; sys.stdin.buffer.read().decode("utf-8")' 2>/dev/null && valid=yes
else
    valid="no (python3 missing)"
fi
if [ "$rc" -eq 0 ] && [ "$nbytes" -le 10240 ] && [ "$nbytes" -ge 10000 ] \
   && printf '%s' "$out" | grep -q 'truncated at 10240B' \
   && [ "$valid" = yes ]; then
    ok "e2e truncation is UTF-8 safe and capped ($nbytes B, valid=$valid)"
else
    fail "e2e truncation: rc=$rc bytes=$nbytes valid=$valid"
fi
unset FAKE_OUT

# 7f. Under the cap, output must survive byte-for-byte. An earlier version measured AND
#     emitted through `$(...)`, which strips trailing newlines — silently reflowing the
#     tail of ordinary Markdown. Captured to a file because `$(...)` would strip them here
#     too and hide the very thing under test.
e2e_reset; : > "$FAKE_LOG"
export FAKE_OUT='body line
last

'
( cd "$PROJECT" && PATH="$FAKEBIN:$PATH" bash "$SCRIPTS/run.sh" ask -t "$E2E" sixth ) \
    >"$FAKEBIN/out.txt" 2>"$FKERR"
rc=$?
# file tail is "last\n\n" from FAKE_OUT plus the single \n emit_result appends.
tailbytes="$(tail -c 8 "$FAKEBIN/out.txt" | od -An -c | tr -s ' ')"
if [ "$rc" -eq 0 ] && printf '%s' "$tailbytes" | grep -q 'l a s t \\n \\n \\n'; then
    ok "e2e output under the cap keeps trailing newlines"
else
    fail "e2e trailing newlines: rc=$rc tail=[$tailbytes]"
fi
unset FAKE_OUT FAKE_THREAD
e2e_reset

# 8. Prompt contracts. Each line here is a promise SKILL.md makes to the caller; without an
#    assertion, editing a template can silently break documented behavior with no error.
has()   { grep -Eq -- "$3" "$PROMPTS/$2" && ok "contract $1" || fail "contract $1: $2 lacks /$3/"; }
# A negative assertion passes trivially against a file that isn't there, so prove the file
# exists first — otherwise deleting a template would look like the contract holding.
hasnt() {
    [ -f "$PROMPTS/$2" ] || { fail "contract $1: $2 does not exist"; return; }
    grep -Eq -- "$3" "$PROMPTS/$2" && fail "contract $1: $2 matches /$3/" || ok "contract $1"
}

hasnt "ask emits no verdict"        ask.md  '^VERDICT:'
hasnt "shape emits no verdict"      shape.md '^VERDICT:'
hasnt "lead spec turn emits no verdict" lead.md '^VERDICT:'
has   "shape forbids writing code"  shape.md 'not write, sketch, or paste implementation code'
has   "shape states a word budget"  shape.md 'Budget: [0-9]+ words'
has   "lead forbids writing code"   lead.md 'not write, sketch, or paste implementation code'
has   "lead states a word budget"   lead.md 'Budget: [0-9]+ words'
has   "ask states a word budget"    ask.md  'at most [0-9]+ words'
has   "ask disclaims verdict semantics" ask.md 'no verdict tags'
has   "plan caps findings"          plan.md 'Max [0-9]+ findings'
has   "review caps findings"        review.md 'Max [0-9]+ findings'
has   "review inspects the diff"    review.md 'git diff HEAD'
has   "review enforces allowed files" review.md 'Allowed files'
has   "followup keeps the verdict"  followup.md 'VERDICT'
has   "followup keeps the budget"   followup.md 'word budget'

# Every role must ground itself in the repo rather than free-associate.
for m in $MODES followup; do
    grep -q 'file:line' "$PROMPTS/$m.md" && ok "citations $m.md" || fail "citations $m.md: no file:line requirement"
done

# lead.md's nine sections ARE the spec format the review turn is later graded against.
missing=""
for s in Slice "Allowed files" "Do NOT touch" Invariants Steps "Targeted checks" \
         "Project verification" "Acceptance criteria" Deferred; do
    grep -qF -- "**$s**" "$PROMPTS/lead.md" || missing="$missing '$s'"
done
[ -z "$missing" ] && ok "lead spec sections" || fail "lead spec sections missing:$missing"

missing=""
for s in Outcome Evidence "Users and constraints" Options Recommendation \
         "Smallest validating slice" "Success signals" "Open decisions" Deferred; do
    grep -qF -- "**$s**" "$PROMPTS/shape.md" || missing="$missing '$s'"
done
[ -z "$missing" ] && ok "shape sections" || fail "shape sections missing:$missing"

# 9. SKILL.md vs the engine. The engine is the truth; SKILL.md is what the agent reads and
#    acts on. Nothing else notices when an engine edit turns the documented table into a
#    lie, and the agent has no way to detect it at runtime.
for m in $MODES; do
    model="$(sed -n "s/^ *$m).*CODEX_MODEL:-\([^}]*\).*/\1/p" "$SCRIPTS/_lib.sh")"
    effort="$(sed -n "s/^ *$m).*CODEX_EFFORT:-\([^}]*\).*/\1/p" "$SCRIPTS/_lib.sh")"
    if [ -n "$model" ] && [ -n "$effort" ] && grep -qF -- "\`$m\` | $model / $effort" "$SKILL"; then
        ok "skill documents $m as $model/$effort"
    else
        fail "skill/engine drift for $m: engine says [$model/$effort]"
    fi
done

# Read-only is the invariant the whole "Codex thinks, Claude writes" design rests on.
sandboxes="$(grep -c 'SANDBOX="read-only"' "$SCRIPTS/_lib.sh")"
[ "$sandboxes" -eq 5 ] && ok "all 5 modes are read-only" || fail "read-only modes: $sandboxes of 5"

# Exit codes SKILL.md tells the agent to branch on must exist in the engine.
for c in 64 69; do
    grep -q "exit $c" "$SCRIPTS/run.sh" && ok "exit code $c reachable" || fail "exit code $c documented but absent"
done

# Progressive disclosure only works if the pointers resolve. A SKILL.md that names a
# reference file which does not exist sends the agent looking for guidance it will never
# find, and nothing at runtime reports the miss.
refs="$(grep -o '`references/[a-z0-9_-]*\.md`' "$SKILL" | tr -d '`' | sort -u)"
if [ -z "$refs" ]; then
    fail "skill names no reference files (expected progressive disclosure pointers)"
else
    missing_refs=""
    for r in $refs; do
        [ -f "$PLUGIN/skills/codex-pair/$r" ] || missing_refs="$missing_refs $r"
    done
    [ -z "$missing_refs" ] && ok "skill reference pointers resolve ($(printf '%s' "$refs" | wc -w | tr -d ' ') files)" \
        || fail "skill references missing:$missing_refs"
fi

# The consent rule is the fix for a real eval failure: two sections used to give opposite
# orders on whether to ask before an xhigh run, and two agents split on it. Keep both
# halves of the distinction present so a future edit cannot quietly restore the ambiguity.
for phrase in "The user asked" "You noticed"; do
    grep -qF -- "**$phrase**" "$SKILL" \
        && ok "dispatch keeps the '$phrase' consent branch" \
        || fail "dispatch lost the '$phrase' consent branch"
done

# The host may pre-approve the exact read-only inspection script. Mutating state.sh must not
# inherit that permission.
canon_inspect="$(cd "$SCRIPTS" && pwd -P)/inspect.sh"
SETTINGS="$HOME_REAL/.claude/settings.json"
# Must be the exact execution rule inside permissions.allow — a bare substring match would
# also be satisfied by the path appearing in a deny rule, a comment, or an unrelated key,
# none of which actually suppress the prompt.
want_rule="Bash(bash $canon_inspect:*)"
bad_rule="Bash(bash $(cd "$SCRIPTS" && pwd -P)/state.sh:*)"
if [ -f "$SETTINGS" ]; then
    has_want=no; has_bad=no
    jq -e --arg r "$want_rule" 'any(.permissions.allow[]?; . == $r)' "$SETTINGS" >/dev/null 2>&1 \
        && has_want=yes
    jq -e --arg r "$bad_rule" 'any(.permissions.allow[]?; . == $r)' "$SETTINGS" >/dev/null 2>&1 \
        && has_bad=yes
    if [ "$has_want" = yes ] && [ "$has_bad" = no ]; then
        ok "settings.json pre-approves inspect.sh only"
    elif [ "$has_want" = no ] && [ "$has_bad" = no ]; then
        ok "settings.json has no codex-pair host pre-approval (portable install)"
    else
        fail "settings.json inspection permission is missing or still authorizes state.sh"
    fi
else
    ok "settings.json absent — pre-approval check not applicable"
fi

# Topic normalization must be path-safe and collision-resistant without renaming ordinary topics.
topic_probe="$( source "$SCRIPTS/_lib.sh"; printf '%s|%s|%s' \
    "$(normalize_topic main)" "$(normalize_topic feature/a)" "$(normalize_topic feature-a)" )"
case "$topic_probe" in
    main\|feature-a-????????\|feature-a) ok "topics are safe and collision-resistant" ;;
    *) fail "topic normalization: [$topic_probe]" ;;
esac

# Saved metadata must describe the run that happened, not defaults recomputed by `show`.
meta_topic="__meta__"
( cd "$PROJECT" && CODEX_MODEL=override-model CODEX_EFFORT=medium \
    PATH="$FAKEBIN:$PATH" bash "$SCRIPTS/run.sh" ask -t "$meta_topic" meta >/dev/null 2>&1 )
meta_out="$( cd "$PROJECT" && bash "$SCRIPTS/inspect.sh" show ask "$meta_topic" 2>/dev/null )"
if printf '%s' "$meta_out" | grep -q 'model=override-model/medium'; then
    ok "inspect show preserves actual model metadata"
else
    fail "inspect show lost model override: [$meta_out]"
fi
( cd "$PROJECT" && bash "$SCRIPTS/state.sh" reset ask "$meta_topic" >/dev/null )

# Tracked eval specifications are part of the product contract. Generated transcripts and
# benchmarks stay ignored, but the scenario matrix must cover every run mode plus boundaries.
if python3 - "$PROJECT/evals/behavioral.json" "$PROJECT/evals/triggers.json" <<'PY'
import json, sys
behavioral = json.load(open(sys.argv[1], encoding="utf-8"))
triggers = json.load(open(sys.argv[2], encoding="utf-8"))
modes = {row["mode"] for row in behavioral["evals"]}
required = {"ask", "shape", "plan", "lead", "review", "state", "none"}
assert required <= modes, (required - modes)
assert len(behavioral["evals"]) >= 10
assert sum(bool(row["should_trigger"]) for row in triggers) >= 8
assert sum(not bool(row["should_trigger"]) for row in triggers) >= 8
PY
then
    ok "tracked eval matrix covers modes and boundaries"
else
    fail "tracked eval matrix is invalid or incomplete"
fi

[ "$fails" -eq 0 ] && printf '\nall codex-pair checks passed\n' || printf '\n%s check(s) failed\n' "$fails"
exit $((fails > 0))

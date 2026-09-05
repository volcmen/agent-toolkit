#!/bin/bash
set -uo pipefail

usage() { echo "usage: mr-doctor.sh [mr-iid|branch] [project-path]   (default: MR of current branch; env MRD_FAKE_BASE_SHA for self-test)" >&2; exit 64; }
arg="${1:-}"
case "$arg" in
  ''|*[!0-9]*)
    br="${arg:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
    iid=$(glab mr list --source-branch "$br" --per-page 1 2>/dev/null | grep -oE '^!([0-9]+)' | tr -d '!' | head -1)
    [ -n "$iid" ] || { echo "mr-doctor: SKIP (no open MR for branch $br)"; exit 0; } ;;
  *) iid="$arg" ;;
esac
proj="${2:-$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^git@[^:]+:##; s#^ssh://[^/]+/##; s#^https?://[^/]+/##')}"
[ -n "$proj" ] || usage
MRD_HELPER="${MRD_HELPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mr-doctor-fields.py}"
enc=$(printf '%s' "$proj" | sed 's#/#%2F#g')

tmpj=$(mktemp); trap 'rm -f "$tmpj"' EXIT
py() { python3 "$MRD_HELPER" "$1" "$tmpj"; }

glab api "projects/$enc/merge_requests/$iid" 2>/dev/null > "$tmpj"
grep -q '"iid"' "$tmpj" 2>/dev/null || { echo "M00 FAIL unreadable       mr=!$iid project=$proj (check path/auth)"; exit 2; }

eval "$(py fields)"

[ -n "${MRD_FAKE_BASE_SHA:-}" ] && base_sha="$MRD_FAKE_BASE_SHA"

fails=0
fail() { fails=$((fails+1)); printf '%-3s FAIL %-18s %s\n' "$1" "$2" "$3"; }
warn() { fails=$((fails+1)); printf '%-3s WARN %-18s %s\n' "$1" "$2" "$3"; }

git fetch -q origin "$target" 2>/dev/null
git cat-file -e "$head^{commit}" 2>/dev/null || git fetch -q origin "$sbranch" 2>/dev/null

[ "$state" = "opened" ] || fail M00 mr_not_open "state=$state"

mb=$(git merge-base "origin/$target" "$head" 2>/dev/null || true)
if [ -z "$mb" ]; then
  warn M01 merge_base_unknown "head ${head:0:10} not fetchable; cannot verify diff refs"
elif [ "$mb" != "$base_sha" ]; then
  fail M01 stale_diff_refs "api base_sha=${base_sha:0:10} != merge-base=${mb:0:10} (GitLab shows a phantom diff; $changes files claimed) -> repair: glab api --method PUT projects/$enc/merge_requests/$iid/rebase"
fi

if [ -n "$mb" ]; then
  behind=$(git rev-list --count "$head..origin/$target" 2>/dev/null || echo 0)
  real=$(git diff --name-only "$mb" "$head" 2>/dev/null | wc -l | tr -d ' ')
  case "$changes" in ''|'?') :;; *) c=${changes%+}
    [ "$c" -gt 0 ] 2>/dev/null && [ "$real" -gt 0 ] && [ $((c > real*3 ? 1 : 0)) = 1 ] \
      && fail M02 changes_count_inflated "api claims $changes files, real target..head diff is $real" ;;
  esac
  [ "$behind" -gt 200 ] 2>/dev/null && warn M03 far_behind_target "$behind commits behind $target"
fi

case "$mstatus" in cannot_be_merged*) fail M04 merge_conflict "merge_status=$mstatus";; esac

remote_tip=$(git ls-remote origin "refs/heads/$sbranch" 2>/dev/null | cut -f1)
[ -n "$remote_tip" ] && [ "$remote_tip" != "$head" ] && fail M05 head_behind_branch "MR head ${head:0:10} != remote tip ${remote_tip:0:10}"

glab api "projects/$enc/merge_requests/$iid/pipelines" 2>/dev/null > "$tmpj"
pstat=$(python3 "$MRD_HELPER" pipeline "$tmpj" "$head")
case "$pstat" in
  success) :;;
  NONE) fail M06 no_pipeline_on_head "no pipeline ever ran on ${head:0:10}";;
  running|pending) warn M06 pipeline_incomplete "pipeline $pstat on head";;
  *) fail M06 pipeline_not_green "pipeline $pstat on head";;
esac

printf '%s\n%s\n' "$title" "$desc" | grep -qE 'claude\.ai/code/session_|Co-Authored-By: Claude|Generated with Claude|Claude-Session:' \
  && fail M07 session_link_leak "AI session URL / attribution present in MR title or description"

printf '%s' "$title" | grep -qE '\b[A-Z][A-Z0-9]{1,9}-[0-9]+\b' || fail M08 no_ticket_key_in_title "title carries no TICKET-123 key"
[ "$draft" = "True" ] && fail M09 still_draft "MR is marked Draft"
[ "$resolved" = "True" ] || fail M10 unresolved_threads "blocking discussions unresolved"
[ "${nrev:-0}" -gt 0 ] 2>/dev/null || warn M11 no_reviewer "no reviewer assigned"

[ "$fails" -eq 0 ] && echo "mr-doctor: PASS (11 checks, !$iid -> $target)"
exit 0

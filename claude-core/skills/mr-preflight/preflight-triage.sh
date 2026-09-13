#!/bin/bash
set -u
repo="${1:-.}"
target="${2:-origin/main}"
max_hits="${PREFLIGHT_MAX_HITS:-4}"
index="$HOME/.claude/skills/mr-preflight/failure-modes.md"
cd "$repo" || { echo "ERROR: cannot cd to $repo"; exit 2; }
git rev-parse --verify --quiet "$target" >/dev/null || { echo "ERROR: target '$target' not found"; exit 2; }
range="$target...HEAD"
files=$(git diff "$range" --name-only)
[ -z "$files" ] && { echo "ERROR: empty diff for $range"; exit 2; }
out_dir="$(git rev-parse --git-path mr-preflight)"
mkdir -p "$out_dir"
report="$out_dir/triage.txt"
always_on=""
repo_abs=$(pwd -P)
test_re='(^|/)(tests?|__tests__|spec)/|(_test|\.test|\.spec|_spec)\.[a-z]+|(^|/)test_[^/]+\.py'
test_files=$(printf '%s\n' "$files" | grep -E "$test_re")
nearest_up() { local d="$1" name; shift; while :; do for name in "$@"; do [ -e "$d/$name" ] && { echo "$d/$name"; return 0; }; done; [ "$d" = "." ] && return 1; d=$(dirname "$d"); done; }
py_cfg_dir() { local d="$1"; while :; do
    { [ -f "$d/pytest.ini" ] || { [ -f "$d/tox.ini" ] && grep -q '^\[pytest\]' "$d/tox.ini"; } || { [ -f "$d/setup.cfg" ] && grep -q '^\[tool:pytest' "$d/setup.cfg"; } || { [ -f "$d/pyproject.toml" ] && grep -q '^\[tool\.pytest' "$d/pyproject.toml"; }; } && { echo "$d"; return 0; }
    [ "$d" = "." ] && return 1; d=$(dirname "$d"); done; }
relpath() { if [ "$2" = "." ]; then printf '%s\n' "$1"; else printf '%s\n' "${1#$2/}"; fi; }
classify_deps() { printf '%s' "$1" | grep -qE 'No module named|ModuleNotFoundError|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|could not determine executable|not found|command not found|ENOENT'; }
runner_line() { printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" | tee -a "$out_dir/runner.txt"; }
runner_section() {
  : > "$out_dir/runner.txt"
  echo "== RUNNER  class|test file|command|note   (recomputed on every invocation; run the command from the repo or worktree root: cd is relative, executables are absolute paths into this checkout; OK = dry collection succeeded; UNVERIFIED = detected, not dry-run; MISSING-DEPS/UNKNOWN = the gate marks F7 RUN-REQUIRED and never installs anything)"
  local runner_count=0 tf cfg venv base rel py cmd out rc pkg pd bin listcmd
  if [ -z "$test_files" ]; then echo "none — no test files in the diff"; echo; return; fi
  while IFS= read -r tf; do
    [ -z "$tf" ] && continue
    if [ -n "${PREFLIGHT_TEST_CMD:-}" ]; then
      case "$PREFLIGHT_TEST_CMD" in *'{file}'*) cmd=${PREFLIGHT_TEST_CMD//\{file\}/$tf};; *) cmd="$PREFLIGHT_TEST_CMD $tf";; esac
      runner_line OVERRIDE "$tf" "$cmd" "caller-supplied command; authoritative, not dry-run"; continue
    fi
    runner_count=$((runner_count+1))
    case "$tf" in
      *.py)
        cfg=$(py_cfg_dir "$(dirname "$tf")") || cfg=""
        venv=$(nearest_up "$(dirname "$tf")" .venv/bin/python venv/bin/python) || venv=""
        base=${cfg:-.}; rel=$(relpath "$tf" "$base")
        if [ -n "$venv" ]; then py="$repo_abs/${venv#./}"; else py=$(command -v python3); fi
        cmd="cd $base && $py -m pytest $rel -q -x"
        if [ -z "$cfg" ] && [ -z "$venv" ]; then runner_line UNKNOWN "$tf" "$cmd" "no pytest config or venv found above the file"; continue; fi
        [ "$runner_count" -gt 3 ] && { runner_line UNVERIFIED "$tf" "$cmd" "detected${cfg:+ config in $cfg}${venv:+, interpreter $venv}; dry collection capped at 3 files"; continue; }
        out=$( (cd "$base" && perl -e 'alarm 60; exec @ARGV' "$py" -m pytest --collect-only -q -- "$rel") 2>&1 ); rc=$?
        if [ "$rc" = 0 ]; then runner_line OK "$tf" "$cmd" "collected $(printf '%s\n' "$out" | grep -c '::')${cfg:+; config in $cfg}${venv:+; interpreter $venv}"
        elif classify_deps "$out"; then runner_line MISSING-DEPS "$tf" "$cmd" "$(printf '%s\n' "$out" | grep -E 'No module named|ModuleNotFoundError|ImportError' | head -n 1 | cut -c1-120)"
        else runner_line UNKNOWN "$tf" "$cmd" "dry collection failed: $(printf '%s\n' "$out" | grep . | head -n 1 | cut -c1-120)"; fi ;;
      *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
        pkg=$(nearest_up "$(dirname "$tf")" package.json) || pkg=""
        if [ -z "$pkg" ]; then runner_line UNKNOWN "$tf" "npx vitest run $tf" "no package.json found above the file"; continue; fi
        pd=$(dirname "$pkg"); rel=$(relpath "$tf" "$pd"); bin="$repo_abs/${pd#./}/node_modules/.bin"; listcmd=""
        if ls "$pd"/vitest.config.* >/dev/null 2>&1 || grep -q '"vitest"' "$pkg"; then cmd="cd $pd && $bin/vitest run $rel"; listcmd="$bin/vitest list $rel"
        elif ls "$pd"/jest.config.* >/dev/null 2>&1 || grep -q '"jest"' "$pkg"; then cmd="cd $pd && $bin/jest $rel"; listcmd="$bin/jest --listTests $rel"
        else cmd="cd $pd && npm test -- $rel"; fi
        [ -d "$pd/node_modules" ] || { runner_line MISSING-DEPS "$tf" "$cmd" "no node_modules in $pd"; continue; }
        [ -z "$listcmd" ] && { runner_line UNVERIFIED "$tf" "$cmd" "npm test has no list operation; node_modules present in $pd"; continue; }
        [ -x "${listcmd%% *}" ] || { runner_line MISSING-DEPS "$tf" "$cmd" "${listcmd%% *} is not executable"; continue; }
        [ "$runner_count" -gt 3 ] && { runner_line UNVERIFIED "$tf" "$cmd" "detected; dry listing capped at 3 files"; continue; }
        out=$( (cd "$pd" && perl -e 'alarm 60; exec @ARGV' $listcmd) 2>&1 ); rc=$?
        if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q .; then runner_line OK "$tf" "$cmd" "listed $(printf '%s\n' "$out" | grep -c .) entr(y|ies) via ${listcmd#$bin/}; in a worktree first: ln -s $repo_abs/${pd#./}/node_modules <worktree>/$pd/node_modules"
        elif classify_deps "$out"; then runner_line MISSING-DEPS "$tf" "$cmd" "$(printf '%s\n' "$out" | grep . | head -n 1 | cut -c1-120)"
        else runner_line UNKNOWN "$tf" "$cmd" "dry listing failed: $(printf '%s\n' "$out" | grep . | head -n 1 | cut -c1-120)"; fi ;;
      *) runner_line UNKNOWN "$tf" "—" "no runner heuristic for this extension" ;;
    esac
  done <<< "$test_files"
  echo
}
branch=$(git branch --show-current)
mr_json=${PREFLIGHT_MR_JSON-$(perl -e 'alarm 10; exec @ARGV' glab mr view --output json 2>/dev/null || true)}
mr_title=$(printf '%s' "$mr_json" | jq -r '.title // empty' 2>/dev/null)
mr_desc=$(printf '%s' "$mr_json" | jq -r '.description // empty' 2>/dev/null | perl -0pe 's/<!--.*?-->//gs')
tools_present="ruff=$(command -v ruff >/dev/null && echo 1)|npx=$(command -v npx >/dev/null && echo 1)"
ident=$(printf '%s|%s|%s|%s|%s|%s' \
  "$(git rev-parse "$target")" "$(git rev-parse HEAD)" \
  "$(cat "$0" "$HOME/.claude/skills/mr-preflight/harness-delta.py" 2>/dev/null | shasum | cut -d' ' -f1)" \
  "$(git ls-tree -r "$target" --name-only -- .claude/rules CLAUDE.md 2>/dev/null | xargs -I{} git rev-parse "$target:{}" 2>/dev/null | shasum | cut -d' ' -f1)" \
  "$(printf '%s\n%s' "$mr_title" "$mr_desc" | shasum | cut -d' ' -f1)" "$tools_present")
cache="$out_dir/cache-$(printf '%s' "$ident" | shasum | cut -c1-16).txt"
if [ -z "${PREFLIGHT_INNER:-}" ]; then
  export PREFLIGHT_MR_JSON="$mr_json"
  if [ -n "${PREFLIGHT_BATCH:-}" ]; then
    PREFLIGHT_INNER=1 bash "$0" "$repo" "$target" | tee "$report"; exit "${PIPESTATUS[0]}"
  fi
  if [ -s "$cache" ] && [ -z "${PREFLIGHT_NO_CACHE:-}" ]; then
    runner_section > "$out_dir/runner-fresh.txt"
    awk -v f="$out_dir/runner-fresh.txt" '/^== RUNNER/{while ((getline l < f) > 0) print l; skip=1; next} skip && /^== ROWS/{skip=0} !skip' "$cache" | tee "$report"
    echo "== CACHED (identical base/head/script/rules/MR text/tools; RUNNER recomputed; PREFLIGHT_NO_CACHE=1 to force)"; exit 0
  fi
  PREFLIGHT_INNER=1 bash "$0" "$repo" "$target" | tee "$report" > "$cache"
  rc="${PIPESTATUS[0]}"; cat "$cache"
  [ "$rc" = 0 ] || rm -f "$cache"
  exit "$rc"
fi
rm -f "$out_dir"/F*.txt "$out_dir"/always-on.ctx.txt "$out_dir"/runner.txt

diff0=$(git diff "$range" -U0 --no-color)
diff2=$(git diff "$range" -U2 --no-color)
diff4=$(git diff "$range" -U4 --no-color)
generated_re='\.(lock|snap|min\.js|min\.css|svg|png|jpg|gif|ico|woff2?|map|pb\.go|_pb2\.py)$|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|(^|/)dist/|(^|/)build/|(^|/)vendor/|__snapshots__/'
src_files=$(printf '%s\n' "$files" | grep -vE "$test_re" | grep -vE "$generated_re" | grep -vE '\.(md|rst|txt|json|ya?ml|toml|cfg|ini)$')
new_test_files=$(git diff "$range" --name-status -M | awk '$1 ~ /^A/{print $2}' | grep -E "$test_re")
doc_files=$(printf '%s\n' "$files" | grep -E '\.(md|rst)$|Jenkinsfile|\.groovy$|\.sh$')
dep_files=$(printf '%s\n' "$files" | grep -E 'package\.json|pyproject\.toml|requirements.*\.txt|Pipfile|\.lock$|\.nvmrc|\.python-version')
py_src=$(printf '%s\n' "$src_files" | grep -E '\.py$')
ts_src=$(printf '%s\n' "$src_files" | grep -E '\.(ts|tsx|js|jsx)$')
rule_files_changed=$(printf '%s\n' "$files" | grep -E '^CLAUDE\.md$|^\.claude/rules/')

annot() { printf '%s\n' "$2" | awk -v sign="$1" '
  /^diff --git / { f=$0; sub(/^diff --git a\/.* b\//,"",f); next }
  /^@@/ { match($0,/^@@ -[0-9]+(,[0-9]+)? \+[0-9]+/); h=substr($0,RSTART,RLENGTH)
          split(h,a," "); o=a[2]; n=a[3]; sub(/^-/,"",o); sub(/^\+/,"",n); sub(/,.*/,"",o); sub(/,.*/,"",n); old=o+0; new=n+0; next }
  /^\+\+\+|^---|^diff |^index |^similarity|^rename|^new file|^deleted file/ { next }
  /^\+/ { if (sign=="+" || sign=="ctx") print f ":+" new " :: " substr($0,2); new++; next }
  /^-/  { if (sign=="-") print f ":-" old " :: " substr($0,2); old++; next }
  /^ /  { if (sign=="ctx") print f ":~" new " :: " substr($0,2); old++; new++; next }'; }
annot_all() { printf '%s\n' "$1" | awk '
  /^diff --git / { f=$0; sub(/^diff --git a\/.* b\//,"",f); next }
  /^@@/ { hunk++; match($0,/^@@ -[0-9]+(,[0-9]+)? \+[0-9]+/); h=substr($0,RSTART,RLENGTH)
          split(h,a," "); o=a[2]; n=a[3]; sub(/^-/,"",o); sub(/^\+/,"",n); sub(/,.*/,"",o); sub(/,.*/,"",n); old=o+0; new=n+0; next }
  /^\+\+\+|^---|^index |^similarity|^rename|^new file|^deleted file|^Binary/ { next }
  /^\+/ { printf "%s\t+\t%d\t%d\t%d\t%s\n", f, 0, new, hunk, substr($0,2); new++; next }
  /^-/  { printf "%s\t-\t%d\t%d\t%d\t%s\n", f, old, 0, hunk, substr($0,2); old++; next }
  /^ /  { printf "%s\t~\t%d\t%d\t%d\t%s\n", f, old, new, hunk, substr($0,2); old++; new++; next }'; }
all4=$(annot_all "$diff4")
text_of() { awk -F'\t' '{ t=$6; for (k=7; k<=NF; k++) t=t "\t" $k; print $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" t }'; }
emitted=0
file_excerpt() { local file="$1" cap="$2" out="$3" total
  total=$(printf '%s\n' "$all4" | awk -F'\t' -v f="$file" '$1==f' | grep -c .)
  if [ "$total" = 0 ]; then emitted=0; echo "-- $file (no diff lines; path or rename only)" >> "$out"; return 0; fi
  emitted=$(( total < cap ? total : cap ))
  echo "-- $file (diff, $emitted of $total lines$([ "$emitted" -lt "$total" ] && echo '; TRUNCATED'))" >> "$out"
  printf '%s\n' "$all4" | text_of | awk -F'\t' -v f="$file" -v cap="$cap" '$1==f && n<cap { n++; print " " $2 " " ($2=="-"?$3:$4) " " $6 }' >> "$out"
  [ "$emitted" -lt "$total" ] && return 1 || return 0; }
file_set_excerpts() { local out="$1" per_file="$2" total_cap="$3" shown=0 omitted=0 truncated=0 f cap
  shift 3
  for f in "$@"; do
    cap=$(( total_cap - shown )); [ "$cap" -gt "$per_file" ] && cap=$per_file
    if [ "$cap" -le 0 ]; then omitted=$((omitted+1)); continue; fi
    file_excerpt "$f" "$cap" "$out" || truncated=$((truncated+1))
    shown=$((shown + emitted))
  done
  if [ "$omitted" -gt 0 ] || [ "$truncated" -gt 0 ]; then
    echo "-- TRUNCATED: $omitted file(s) not shown, $truncated file(s) cut (≤$per_file lines each, ≤$total_cap total) — evidence incomplete; read git diff $range -- <file> for each before any PASS, or mark the row RUN-REQUIRED / FAIL" >> "$out"; fi; }
ctx_spill() { local id="$1" hits="$2" out="$out_dir/$id.ctx.txt" n=0 total; : > "$out"
  total=$(printf '%s\n' "$hits" | grep -c .)
  if ! printf '%s\n' "$hits" | grep -qE '^[^:]+:[+~-][0-9]+ :: '; then
    local paths; paths=$(printf '%s\n' "$hits" | grep . | sed 's/ :: .*//; s/:$//' | awk '!seen[$0]++')
    if printf '%s\n' "$paths" | grep -qxF -f <(printf '%s\n' "$files"); then
      file_set_excerpts "$out" 60 400 $(printf '%s\n' "$paths" | grep -xF -f <(printf '%s\n' "$files"))
      printf '%s\n' "$hits" | grep -v -F -f <(printf '%s\n' "$paths" | grep -xF -f <(printf '%s\n' "$files")) | sed 's/^/-- /' >> "$out"
    else printf '%s\n' "$hits" | sed 's/^/-- /' >> "$out"; fi
    return; fi
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    n=$((n+1)); [ "$n" -gt 6 ] && { echo "-- +$((total-6)) more hits in $out_dir/$id.txt" >> "$out"; break; }
    if printf '%s' "$hit" | grep -qE '^[^:]+:[+~-][0-9]+ :: '; then
      local file rest kind num; file=${hit%%:*}; rest=${hit#*:}; kind=${rest:0:1}; num=$(printf '%s' "$rest" | grep -oE '^[+~-][0-9]+' | tr -d '+~-')
      echo "-- $file:$kind$num" >> "$out"
      printf '%s\n' "$all4" | text_of | awk -F'\t' -v f="$file" -v k="$kind" -v n="$num" '
        $1==f { i++; line[i]=$2 " " ($2=="-"?$3:$4) " " $6; hunk[i]=$5; if (!hit && $2==k && ($2=="-"?$3:$4)==n) hit=i }
        END { if (!hit) exit; s=hit-4; if (s<1) s=1; e=hit+4; if (e>i) e=i; for (j=s;j<=e;j++) if (hunk[j]==hunk[hit]) print (j==hit?">":" ") line[j] }' >> "$out"
    else echo "-- $hit" >> "$out"; fi
  done <<< "$hits"; }
added_lines=$(annot '+' "$diff0")
removed_lines=$(annot '-' "$diff0")
ctx_lines=$(annot 'ctx' "$diff2")
added_in() { printf '%s\n' "$added_lines" | rg -N -e "$1" || true; }
removed_in() { printf '%s\n' "$removed_lines" | rg -N -e "$1" || true; }
ctx_in() { printf '%s\n' "$ctx_lines" | rg -N -e "$1" || true; }
src_only() { rg -N -v -e "^[^:]*($test_re|$generated_re)" || true; }
test_only() { rg -N -e "^[^:]*($test_re)" || true; }
show() { head -n "$max_hits" | sed 's/^/    /'; }
excl_globs=$(printf '%s\n' "$files" | sed "s#^#-g !#" | tr '\n' ' ')

root=$(printf '%s\n' "$files" | python3 -c "
import os,sys
fs=[l.strip() for l in sys.stdin if l.strip()]
d=os.path.dirname(os.path.commonprefix(fs)) if len(fs)>1 else os.path.dirname(fs[0]) if fs else ''
print(d+'/' if d and len(d)>12 else '')")
short() { if [ -n "$root" ]; then sed "s#${root}##g"; else cat; fi; }

sev_of() { case "$1" in
  F1|F2|F4|F5|F7|F17|F21|F23|F24|F30|F31) echo H;;
  F8|F11|F13|F15|F16|F18|F19|F20|F22|F27) echo M;;
  *) echo L;; esac; }

locs() { awk -F' :: ' '{print $1}' | awk -F: '
  { file=$1; mark=$2; if (!(file in seen)) { order[++n]=file; seen[file]=1 }
    if (cnt[file] < 6) { acc[file]=(acc[file]==""?mark:acc[file] "," mark); cnt[file]++ }
    else if (cnt[file] == 6) { acc[file]=acc[file] ",+"; cnt[file]++ } }
  END { for (i=1;i<=n;i++) printf "%s%s:%s", (i>1?";":""), order[i], acc[order[i]] }'; }

mech_fail=0
triggered=()
na=()
undetected=()
ctx_only=()
row() { local id="$1" hits="$2" why="$3" kind="${4:-heuristic}"
  if printf '%s\n' "$hits" | grep -qE '^[^:]*:~[0-9]+ :: ' && ! printf '%s\n' "$hits" | grep -qE '^[^:]*:[+-][0-9]+ :: '; then
    [ -n "$hits" ] && { ctx_only+=("$id"); printf '%s\n' "$hits" > "$out_dir/$id.txt"; ctx_spill "$id" "$hits"; }
    hits=""
  fi
  if [ -n "$hits" ]; then
    triggered+=("$id")
    local n sev loc; n=$(printf '%s\n' "$hits" | grep -c .); sev=$(sev_of "$id")
    printf '%s\n' "$hits" > "$out_dir/$id.txt"; ctx_spill "$id" "$hits"
    if printf '%s\n' "$hits" | grep -q ' :: '; then loc=$(printf '%s\n' "$hits" | locs)
    else loc=$(printf '%s\n' "$hits" | grep . | head -n 6 | tr '\n' ';' | sed 's/;$//'); fi
    echo "$id|$sev|$n|$(printf '%s' "$loc" | short)|$why"
  elif [ "$kind" = proven ]; then na+=("$id")
  else undetected+=("$id"); fi; }

echo "== MR $range  base=$(git rev-parse --short=10 "$target") head=$(git rev-parse --short=10 HEAD)  spill=$out_dir"
git diff "$range" --stat | tail -n 1
ticket=$(printf '%s %s' "$branch" "$mr_title" | grep -oE '\b[A-Z]{2,5}-[0-9]{2,6}\b' | sort -u | tr '\n' ' ')
echo "branch=$branch ticket=${ticket:-none} mr=${mr_title:-none} src=$(printf '%s\n' "$src_files" | grep -c .) tests=$(printf '%s\n' "$test_files" | grep -c .) new_tests=$(printf '%s\n' "$new_test_files" | grep -c .)"
[ -n "$rule_files_changed" ] && echo "NOTE: MR edits reviewer instructions ($(printf '%s' "$rule_files_changed" | tr '\n' ' ')) — policy is read from $target; the change itself is reviewable content"
readable_file="$out_dir/readable.txt"
git diff "$range" --numstat | awk -v gen="$generated_re" '$3 !~ gen {print $3}' > "$readable_file"
echo "root=${root:-.}"
git diff "$range" --numstat | awk -v gen="$generated_re" '$3 !~ gen { printf "%s+%s/-%s ", $3, $1, $2 }' | short | fold -s -w 200
echo
echo

echo "== MECHANICAL"
tk=$(printf '%s\n' "$added_lines" | rg -N -v -e '^[^:]*\.(md|markdown|rst|txt):' | rg -N -e '\b(NTD|NTST|NTQA)-[0-9]+|![0-9]{4,}' || true)
cm=$(bash "$HOME/.claude/hooks/f17-comment-count.sh" "$target" 2>/dev/null)
if [ -n "$tk$cm" ]; then mech_fail=1; echo "FAIL F17 slop-comment-in-source [total=$(printf '%s\n' "$tk" "$cm" | grep -c .)]"; printf '%s\n' "$tk" "$cm" | grep . | show; else echo "PASS F17 — 0 ticket keys, 0 added comments"; fi

payload=$(git log "$target..HEAD" --format=%B | grep -vE '^(Signed-off-by|Change-Id):'; printf '%s\n' "$mr_desc")
sl=$(printf '%s\n' "$payload" | grep -nE 'claude\.ai/code/session_|Claude-Session:|Generated with \[?Claude|Co-Authored-By: Claude')
if [ -n "$sl" ]; then mech_fail=1; echo "FAIL F21 session-link-leak (commit bodies + MR description) [total=$(printf '%s\n' "$sl" | grep -c .)]"; printf '%s\n' "$sl" | show; else echo "PASS F21 — 0 session links"; fi

scanner="$HOME/Personal/ai/claude-core/scripts/test-quality-scan.py"
changed_tests=$(printf '%s\n' "$files" | rg -N -e "($test_re)" || true)
if [ -n "$changed_tests" ] && [ -f "$scanner" ] && command -v python3 >/dev/null; then
  seeds=$(python3 "$scanner" $changed_tests 2>/dev/null | rg -N -e 'pinned-seed' | rg -N -v -e 'advisory' || true)
  if [ -n "$seeds" ]; then mech_fail=1; echo "FAIL F19 pinned seed on the default exploration path"; printf '%s\n' "$seeds" | show; else echo "PASS F19-seed — no seed pinned outside a named profile"; fi
else
  seeds=$(added_in 'derandomize|Faker\.seed|seed_instance|random\.seed|[Ss]eed[[:space:]]*[=:][[:space:]]*[0-9]' | test_only)
  if [ -n "$seeds" ]; then mech_fail=1; echo "FAIL F19 pinned seed (textual fallback; a named replay profile is a false positive here)"; printf '%s\n' "$seeds" | show; else echo "PASS F19-seed"; fi
fi

f24_done=""
if [ -n "$py_src" ]; then
  if command -v ruff >/dev/null; then
    dead=$(ruff check --select F401,F841 --output-format concise -- $py_src 2>/dev/null | grep -E 'F401|F841' | while IFS= read -r d; do loc=$(printf '%s' "$d" | grep -oE '^[^:]+:[0-9]+'); printf '%s\n' "$added_lines" | grep -q "^${loc%%:*}:+${loc##*:} " && echo "$d"; done)
    if [ -n "$dead" ]; then mech_fail=1; echo "FAIL F24-py dead code (ruff F401/F841)"; printf '%s\n' "$dead" | show; else echo "PASS F24-py — ruff F401/F841 clean on touched .py"; fi
    f24_done=1
  else echo "UNDETECTED F24-py — ruff not installed"; fi
fi
if [ -n "$ts_src" ]; then
  projects=$(for f in $ts_src; do d=$(dirname "$f"); while [ "$d" != "." ] && [ ! -f "$d/tsconfig.json" ]; do d=$(dirname "$d"); done; [ -f "$d/tsconfig.json" ] && echo "$d"; done | sort -u | head -n 3)
  if [ -n "$projects" ] && command -v npx >/dev/null; then
    for pj in $projects; do
      tsout=$(cd "$pj" && perl -e 'alarm 240; exec @ARGV' npx --no-install tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json 2>/dev/null | grep -E 'TS6133|TS6192|TS6196|TS6198' | grep -F -f <(printf '%s\n' "$ts_src" | sed "s#^$pj/##") | while IFS= read -r d; do f=$(printf '%s' "$d" | sed -E 's/\(.*//'); ln=$(printf '%s' "$d" | grep -oE '\([0-9]+,' | tr -d '(,'); printf '%s\n' "$added_lines" | grep -q "^$pj/$f:+$ln " && echo "$d"; done)
      if [ -n "$tsout" ]; then mech_fail=1; echo "FAIL F24-ts unused symbols introduced on added lines ($pj)"; printf '%s\n' "$tsout" | show; else echo "PASS F24-ts — tsc noUnusedLocals: no unused symbol on an added line in $pj"; fi
    done
  else echo "UNDETECTED F24-ts — no tsconfig.json/npx found; run eslint no-unused-vars on: $(printf '%s' "$ts_src" | tr '\n' ' ')"; fi
fi
echo

runner_section

echo "== ROWS  id|sev|n|locations|what to settle   (paths relative to root=${root:-.}; hits: $out_dir/<id>.txt; context ±4 lines from git diff -U4: $out_dir/<id>.ctx.txt)"
sig_removed=$(removed_in ' :: [[:space:]]*(export |def |async def |function |public |fn |func )[^(]*\(' | src_only)
row F1 "$sig_removed" "changed signature — candidate references (lexical; aliases/dynamic dispatch not covered):"
if [ -n "$sig_removed" ]; then
  printf '%s\n' "$sig_removed" | grep -oE '(def|function|fn|func|const|let) +[A-Za-z_][A-Za-z0-9_]*' | awk '{print $2}' | sort -u | head -n 6 | while read -r name; do
    [ -z "$name" ] && continue
    rg -n -F -e "$name(" . 2>/dev/null | grep -vE "(def|function|fn|func) +$name\(" > "$out_dir/F1-$name.txt"
    echo "    $name( — $(grep -c . "$out_dir/F1-$name.txt") references, full=$out_dir/F1-$name.txt; sample: $(head -n 2 "$out_dir/F1-$name.txt" | cut -c1-100 | tr '\n' ' ')"
  done
fi
row F2  "$(ctx_in ' :: [[:space:]]*(\}[[:space:]]*)?(except\b|catch\b|rescue\b)|\.catch\(|\?\?[[:space:]]*(\{\}|\[\]|null|0|"")|\|\|[[:space:]]*(\{\}|\[\])' | src_only)" "catch/except/fallback in or beside the change (~ = unchanged context line) — literal returned, consumers, swallowed causes"
row F6  "$(added_in '\b(sorted|min|max)\(|\.sort\(' | src_only)" "ordering over data — mixed-type key?"
row F7  "$test_files" "tests changed — mutation red→green per test in a disposable worktree, one batched evidence block" proven
row F8  "$(added_in 'parseInt|parseFloat|Number\(|JSON\.parse|\bint\(|\bfloat\(' | src_only)" "partial parse on input"
row F10 "$(added_in '\b(disabled|readOnly|readonly|locked)\b' | src_only; removed_in '<(Button|Link|IconButton|a) |href=|onClick=' | src_only)" "affordance locked/removed"
newfn=$(added_in ' :: [[:space:]]*(def |async def |function |export (const|function) |const [A-Za-z_]+ = (async )?\()' | src_only)
row F11 "$newfn" "new function — mirror search by distinctive literal (outside changed files):"
if [ -n "$newfn" ]; then
  printf '%s\n' "$added_lines" | src_only | grep -oE "['\"][a-z][a-z0-9]*[_.-][a-z0-9_.-]{3,}['\"]" | tr -d "'\"" | grep -vE '^(utf-8|utf_8|content-type|application\.json|__init__|__main__)$' | sort | uniq -c | sort -rn | awk '$1<=3{print $2}' | head -n 8 | while read -r lit; do
    hits=$(rg -l -F $excl_globs -e "$lit" . 2>/dev/null | head -n 3 | tr '\n' ' ')
    [ -n "$hits" ] && echo "    '$lit' also in: $hits"
  done
fi
row F12 "$(printf '%s\n' "$dep_files"; added_in 'NODE_OPTIONS|--experimental|shim|polyfill' | src_only)" "env/dep workaround" proven
row F13 "$(ctx_in 'status(_code)?[[:space:]]*(==|===|!=|in)[[:space:]]*\(?[[:space:]]*[0-9]{3}|"HTTP [0-9]{3}|includes\([\x27"][0-9]{3}|\.status[[:space:]]*===?[[:space:]]*[0-9]{3}|(==|===)[[:space:]]*(409|404|401|429|5[0-9]{2})\b' | src_only)" "status/message string-match recovery branch — provenance"
row F14 "$doc_files" "runbook/doc/script changed — trace with real input producer" proven
row F15 "$(added_in '\.strip\(\)|\.trim\(\)|\.lower\(\)|toLowerCase\(\)|\b(validate|is_valid|isValid|normali[sz]e)[A-Za-z_]*\(' | src_only)" "validator/normaliser — discarded results, hostile inputs"
row F18 "$new_test_files" "new test file — harness must match siblings" proven
if [ -n "$new_test_files" ]; then
python3 "$HOME/.claude/skills/mr-preflight/harness-delta.py" "$test_re" $new_test_files | short
fi
row F19 "$( for f in $new_test_files; do rg -q 'hypothesis|@given|fast-check|fc\.' "$f" 2>/dev/null || echo "$f :: example-only"; done )" "example-only new test — property class or why none" proven
row F20 "$(printf '%s\n' "$files" | grep -E '(^|/)(validators?|checks?|audits?|lint)/' ; added_in '(def|function) (check_|validate_|audit_)' | src_only)" "new validator — existing validator over same contract?"
f22_unwired=""
if [ -n "$new_test_files" ]; then
  ci_cfg=$(ls .gitlab-ci.yml 2>/dev/null; ls -d .gitlab .github/workflows src/jenkins-cloud Jenkinsfile 2>/dev/null)
  runner_cfg=$(ls pytest.ini setup.cfg tox.ini pyproject.toml jest.config.* karma.conf.* vitest.config.* angular.json package.json 2>/dev/null)
  while IFS= read -r tf; do
    d=$(dirname "$tf"); hit=""; collected=""
    [ -n "$ci_cfg" ] && hit=$(rg -n --no-heading -e "$d" -e "$(basename "$d")" $ci_cfg 2>/dev/null | head -n 1)
    [ -z "$hit" ] && [ -n "$runner_cfg" ] && hit=$(rg -n --no-heading -e 'testpaths|testMatch|"test":|karma|jest|vitest|python_files' $runner_cfg 2>/dev/null | head -n 1)
    if [ -n "$hit" ]; then echo "PASS F22 $tf — runner/CI ref: $(printf '%s' "$hit" | cut -c1-90) (confirm the CI job's glob reaches it; RUNNER section says whether it runs locally)"
    else f22_unwired="$f22_unwired$tf :: no CI/runner config references its directory
"; fi
  done <<< "$new_test_files"
fi
row F22 "$f22_unwired" "unwired test — CI job + glob, or OPEN ticket/MR URL" proven
row F23 "$(ctx_in 'requests\.(get|post)\(|httpx\.|fetch\(|axios\.|client\.(get|list)\(' | src_only)" "API read in/beside the change — pagination"
row F25 "$(added_in 'toast|[Ss]nackbar|<Alert|notify\(|message\.(error|warning)|enqueue' | src_only)" "feedback surface — visible above trigger?"
row F30 "$(ctx_in 'client\.(get|post|put|delete)\(|requests\.(get|post|put)\(|httpx\.|fetch\(|axios\.' | src_only)" "outbound call in/beside the change — calls-per-action + call_count bound test"
row F31 "$(ctx_in 'wait_for\(|timeout ?[=:]|AbortController|AbortSignal\.timeout' | src_only)" "client timeout — server-side fate of abandoned request"
row F27 "$(printf '%s\n' "$payload" | grep -nEi 'kubectl|set env|out-of-band|manually (applied|set|changed)|hotfix|admin api|configmap|secret was')" "live-only state in description — OPEN artifact URL"
if [ -n "$src_files" ]; then
  triggered+=(F4 F5 F9 F16)
  always_on="F4 F5 F9 F16"
  echo "ALWAYS-ON: F4 blast-radius | F5 sibling-sweep (paste rg of the fixed shape) | F9 scope-rider (ticket: ${ticket:-none}) | F16 claim drift"
  desc_file="$out_dir/description.txt"; printf '%s\n' "$payload" | grep -vE '^\s*$' > "$desc_file"
  : > "$out_dir/always-on.ctx.txt"
  file_set_excerpts "$out_dir/always-on.ctx.txt" 80 600 $src_files
  echo "  F4/F5/F9/F16 — source diffs in $out_dir/always-on.ctx.txt ($(grep -c '^-- ' "$out_dir/always-on.ctx.txt") file header(s); a TRUNCATED marker means the excerpt is not complete evidence)"
  dl=$(grep -c . "$desc_file")
  echo "  F16 — $dl-line description + commit bodies in $desc_file ($(grep -cEi '\b(fix(es|ed)?|idempotent|reject(s|ed)?|backwards?[- ]compat|ensures?|prevents?|guarantee|blocks?|no longer|always|never|converge|supports?|allows?|handles?|keeps?)\b' "$desc_file") claim lines) — read it whole, then reverse-check for changed behaviour it does not claim"
else always_on=""; echo "N-A F4 F5 F9 F16 — no production source changed"; fi
echo

printf '%s\n' "$added_lines" "$removed_lines" | sed 's/^[^:]*:[+~-][0-9]* :: //' | cut -c1-400 > "$out_dir/rules-blob.txt"
printf '%s\n' "$files" | sed 's#.*/##; s#\.[^.]*$##' >> "$out_dir/rules-blob.txt"
echo "== RULES  path|scope|directives   (relevant ones expanded; others: git show $target:<path>)"
python3 - "$target" "$files" "$out_dir/rules-blob.txt" <<'PY'
import sys,re,subprocess
target,changed=sys.argv[1],sys.argv[2].split("\n")
try: diffblob=open(sys.argv[3],encoding='utf-8',errors='replace').read().lower()
except OSError: diffblob=''
def show(path,depth=0):
    r=subprocess.run(['git','show',f'{target}:{path}'],capture_output=True,text=True)
    if r.returncode!=0: return None
    txt=r.stdout
    inc=re.fullmatch(r'\s*@(\S+)\s*',txt)
    if inc and depth<2:
        sub=show(inc.group(1),depth+1)
        return sub if sub is not None else txt
    return txt
imp_re=r'\b(must|never|always|require[sd]?|forbidden|do not|don\'t|mandatory|prohibited|only|unless|avoid|prefer)\b'
def match(p,f):
    p=p.strip().strip('"\'')
    if p.endswith('/'): p+='**'
    rx=re.escape(p).replace(r'\*\*/', '(?:.*/)?').replace(r'\*\*','.*').replace(r'\*','[^/]*').replace(r'\?','[^/]')
    return re.fullmatch(rx,f) is not None
def directives(text,limit):
    lines=text.split('\n'); out=[]; heads=[]; i=0
    while i<len(lines):
        l=lines[i]
        hm=re.match(r'^(#+)\s+(.*)',l)
        if hm:
            lvl=len(hm.group(1)); heads=[h for h in heads if h[0]<lvl]+[(lvl,hm.group(2).strip())]; i+=1; continue
        if re.search(imp_re,l,re.I) and l.strip() and not l.strip().startswith(('```','|')):
            j=i
            while j+1<len(lines) and lines[j+1].strip() and not re.match(r'^(#+\s|\s*[-*]\s|\s*\d+\.\s)',lines[j+1]): j+=1
            para=' '.join(x.strip() for x in lines[i:j+1])
            out.append((i+1,' > '.join(h[1] for h in heads),para)); i=j+1
        else: i+=1
    return out[:limit],len(out)
rules=subprocess.run(['git','ls-tree','-r','--name-only',target,'--','.claude/rules','CLAUDE.md'],capture_output=True,text=True).stdout.split()
if not rules: print("  none at target (no .claude/rules, no CLAUDE.md)")
for r in rules:
    txt=show(r)
    if txt is None: continue
    pats=[]
    m=re.match(r'^---\n(.*?)\n---',txt,re.S)
    if m:
        fm=m.group(1); pm=re.search(r'^paths:\s*(.*)$',fm,re.M)
        if pm:
            inline=pm.group(1).strip()
            if inline.startswith('['): pats=[x.strip().strip('"\'') for x in inline.strip('[]').split(',') if x.strip()]
            elif inline: pats=[inline]
            else: pats=re.findall(r'^\s*-\s*(.+)$',fm[pm.end():].split('\n\n')[0],re.M)
    hit=changed if not pats else [f for f in changed if any(match(p,f) for p in pats)]
    if not hit: continue
    ds,total=directives(txt,8)
    if pats:
        print(f"  {r}|paths match {len(hit)} file(s)|{total}")
        for n,h,p in ds: print(f"    {n} [{h}] {p[:220]}")
        continue
    body=re.sub(r'^---.*?---','',txt,flags=re.S)
    terms={t.lower() for t in re.findall(r'`([A-Za-z_][A-Za-z0-9_./-]{5,})`',body)}
    terms|={t.lower() for t in re.findall(r'\b([a-z]+(?:[A-Z][a-z0-9]+){1,}|[a-z]+(?:_[a-z0-9]+){1,})\b',body) if len(t)>7}
    blob=diffblob
    generic={'assert','expect','describe','console','document','window','function','return','default','component','components','interface','property','undefined','boolean','javascript','typescript','constructor','required'}
    score=sorted({t for t in terms if t in blob and t not in generic}, key=len, reverse=True)[:5]
    if score:
        print(f"  {r}|unscoped, identifiers {' '.join(score)}|{total}")
        for n,h,p in ds[:4]: print(f"    {n} [{h.split(' > ')[-1]}] {p[:180]}")
    else:
        print(f"  {r}|unscoped, no rule identifier occurs in this diff — NOT expanded|{total}")
PY
echo

echo "== NA ${na[*]:-none}"
[ ${#ctx_only[@]} -gt 0 ] && echo "== CTX-ONLY (detector fired only on unchanged neighbours — not an active row; open $out_dir/<id>.txt if a finding points here) ${ctx_only[*]}"
echo "== UNDETECTED (detector silent — promote only if a read contradicts it) ${undetected[*]:-none}"
echo

if [ -n "${PREFLIGHT_BATCH:-}" ]; then
echo "== F3 batch composition (open MRs by me touching the same files; opt-in via PREFLIGHT_BATCH=1)"
if command -v glab >/dev/null && mine=$(glab mr list --author=@me --per-page 30 --output json 2>/dev/null); then
  overlap=""
  for iid in $(printf '%s' "$mine" | jq -r --arg b "$branch" '.[] | select(.source_branch != $b) | .iid' | head -n 15); do
    other=$(glab mr diff "$iid" 2>/dev/null | grep -E '^\+\+\+ b/' | sed 's#^+++ b/##')
    common=$(comm -12 <(printf '%s\n' "$files" | sort) <(printf '%s\n' "$other" | sort))
    [ -n "$common" ] && overlap="$overlap!$iid :: $(printf '%s' "$common" | tr '\n' ' ')
"
  done
  if [ -n "$overlap" ]; then triggered+=(F3); echo "TRIGGERED F3 — state and test the composed behavior per intersection"; printf '%s' "$overlap" | show
  else echo "N-A F3 — $(printf '%s' "$mine" | jq length) open MRs by me, none shares a changed file"; fi
else echo "UNKNOWN F3 — glab unavailable or unauthenticated; intersect open MRs manually"; fi
echo
else echo "== F3 skipped — out-of-gate checkpoint (before pushing a batch of MRs); PREFLIGHT_BATCH=1 to intersect open MRs by me"; echo
fi
echo "== OUT-OF-GATE F26@merge F29@closure F28@external-claim"
needs_model=1
[ "$mech_fail" = 0 ] && [ "${#triggered[@]}" = 0 ] && [ -z "$src_files" ] && needs_model=0
echo "== SUMMARY mech_fail=$mech_fail rows=${#triggered[@]} ctx_only=${#ctx_only[@]} undetected=${#undetected[@]} needs_model=$needs_model"
ledger=$(printf '%s %s' "${triggered[*]:-}" "${always_on:-}" | tr ' ' '\n' | grep . | sort -u -V | tr '\n' ' ')
echo "== LEDGER (return exactly one disposition line per id, none omitted): ${ledger:-none} + one R-row per expanded rule"

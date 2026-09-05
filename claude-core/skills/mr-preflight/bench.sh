#!/bin/bash
# usage: pf-bench.sh <label>   -> prints per-section bytes for 3 fixture diffs
label="${1:-run}"
out=/private/tmp/pf-bench-$label.txt
: > "$out"
for wt in /private/tmp/wt-pf /private/tmp/wt-ped /private/tmp/wt-postqa; do
  f=/private/tmp/bench-$label-$(basename "$wt").txt
  s=$(date +%s)
  bash ~/.claude/skills/mr-preflight/preflight-triage.sh "$wt" origin/main > "$f" 2>&1
  e=$(date +%s)
  printf '%-16s bytes=%-7s tok~%-6s sec=%s\n' "$(basename $wt)" "$(wc -c <"$f"|tr -d ' ')" "$(( $(wc -c <"$f") / 4 ))" "$((e-s))" >> "$out"
  awk -v F="$(basename $wt)" '/^== /{s=substr($0,4,40)} {c[s]+=length($0)+1} END{for(k in c) printf "    %-42s %6d\n", k, c[k]}' "$f" | LC_ALL=C sort -k2 -rn | head -6 >> "$out"
done
cat "$out"

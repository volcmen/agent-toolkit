#!/bin/bash
target="${1:-main}"
git diff "$target...HEAD" -U0 --no-color -- ':!*.md' ':!*.markdown' ':!*.rst' ':!*.txt' \
| awk '
function strip_strings(s,   out,i,c,q) {
  out=""; q=""
  for (i=1; i<=length(s); i++) {
    c=substr(s,i,1)
    if (q=="") { if (c=="\"" || c=="'"'"'") { q=c; out=out" " } else out=out c }
    else { if (c==q) q=""; out=out" " }
  }
  return out
}
/^\+\+\+ b\// { f=substr($0,7); next }
/^\+/ && !/^\+\+\+/ {
  line=substr($0,2)
  t=line; gsub(/^[ \t]+/,"",t)
  if (t=="") next
  ext=f; sub(/.*\./,"",ext)
  hashfam = (ext=="py"||ext=="sh"||ext=="bash"||ext=="yml"||ext=="yaml"||ext=="tf"||ext=="toml"||ext=="cfg"||ext=="ini"||ext=="rb"||ext=="pl")
  slashfam = (ext=="ts"||ext=="tsx"||ext=="js"||ext=="jsx"||ext=="mjs"||ext=="cjs"||ext=="css"||ext=="scss"||ext=="groovy"||ext=="java"||ext=="kt"||ext=="go"||ext=="rs"||ext=="c"||ext=="h"||ext=="cpp"||ext=="hpp"||ext=="swift")
  is=0
  if (hashfam) {
    if (t ~ /^#/) is=1
    if (t ~ /^"""/ || t ~ /^'"'"''"'"''"'"'/) is=1
    if (!is) { bare=strip_strings(line); if (bare ~ /[^ \t]([ \t]+)#/) is=2 }
  }
  if (slashfam) {
    if (t ~ /^\/\// || t ~ /^\/\*/ || t ~ /^\*/) is=1
    if (!is) { bare=strip_strings(line); if (bare ~ /[^ \t:][ \t]+\/\//) is=2; if (bare ~ /[ \t]\/\*/) is=2 }
  }
  if (!is) next
  if (t ~ /^#!/) next
  if (t ~ /^# (type|noqa|pylint|ruff|mypy|fmt|pragma|isort|flake8|coding|-\*-|pyright)/) next
  if (t ~ /noqa|pylint:|type: *ignore|pragma: *no cover|ruff:|mypy:|fmt: *(on|off)|isort:|shellcheck +disable/) next
  if (t ~ /^\/\/ *(eslint|@ts-|prettier-|biome-|istanbul |v8 )/) next
  if (t ~ /^\/\* *(eslint|prettier-|global |istanbul )/) next
  if (t ~ /^\/\/# sourceMappingURL/) next
  if (t ~ /^\/\/ *<reference/) next
  if (t ~ /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/) next
  printf "%s :: %s%s\n", f, (is==2 ? "[trailing] " : ""), line
}'

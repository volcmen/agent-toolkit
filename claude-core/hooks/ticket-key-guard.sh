#!/bin/bash
payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
key_re='(^|[^A-Za-z0-9])[A-Z][A-Z0-9]+-[0-9]+'
exempt_re='^(main|master|develop|release|release/.*|release-.*|ntst_[0-9]+(\.[0-9]+)*)$'

block() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

in_notraffic() {
  local dir=$1
  case "$cmd" in *"/notraffic/"*) return 0 ;; esac
  case "$dir" in "$HOME"/notraffic/*) ;; *) return 1 ;; esac
  local url
  url=$(git -C "$dir" remote get-url origin 2>/dev/null) || return 1
  case "$url" in *gitlab.com[:/]notraffic/*) return 0 ;; esac
  return 1
}

in_notraffic "$cwd" || exit 0

new_branch=$(printf '%s' "$cmd" | grep -oE '(git[^;&|]*[[:space:]](checkout[[:space:]]+-[bB]|switch[[:space:]]+-[cC]|worktree[[:space:]]+add[[:space:]]+(-[^[:space:]]+[[:space:]]+)*-[bB]))[[:space:]]+[^[:space:];&|]+' | awk '{print $NF}' | tr -d "\"'" | head -1)
if [ -n "$new_branch" ] && ! printf '%s' "$new_branch" | grep -Eq "$exempt_re" && ! printf '%s' "$new_branch" | grep -Eq "$key_re"; then
  block "Branch '$new_branch' carries no ticket key. Every branch name includes its Jira key, e.g. fix/<PROJECT>-<number>-<slug>. Find or create the Jira task first."
fi

if printf '%s' "$cmd" | grep -Eq 'glab[[:space:]]+mr[[:space:]]+create'; then
  title=$(printf '%s' "$cmd" | grep -oE -- '(--title|-t)[[:space:]=]+("[^"]*"|'"'"'[^'"'"']*'"'"')' | head -1)
  if [ -z "$title" ]; then
    block "glab mr create needs an explicit --title that carries the Jira key, so the title can be checked."
  fi
  printf '%s' "$title" | grep -Eq "$key_re" || block "MR title $title carries no Jira key. Every MR needs a Jira task: title like '[FIX] <PROJECT>-<number>: …'."
  src=$(printf '%s' "$cmd" | grep -oE -- '(--source-branch|-s)[[:space:]=]+[^[:space:]]+' | head -1 | sed -E 's/^(--source-branch|-s)[[:space:]=]+//')
  if [ -z "$src" ]; then
    dir=$(printf '%s' "$cmd" | grep -oE 'cd[[:space:]]+[^;&|[:space:]]+' | tail -1 | awk '{print $2}')
    src=$(git -C "${dir:-$cwd}" rev-parse --abbrev-ref HEAD 2>/dev/null)
  fi
  if [ -n "$src" ] && ! printf '%s' "$src" | grep -Eq "$exempt_re" && ! printf '%s' "$src" | grep -Eq "$key_re"; then
    block "Source branch '$src' carries no Jira key. Rename it first (git branch -m <type>/<PROJECT>-<number>-<slug>), push the new name, then open the MR."
  fi
fi
exit 0

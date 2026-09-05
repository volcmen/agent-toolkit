#!/bin/bash
payload=$(cat)
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0
case "$path" in
  *.md|*.markdown|*.txt|*.rst|*.html|*COMMIT_EDITMSG*|*/.git/*|*/memory/*|*/.claude/*|*/Obsidian*) exit 0;;
esac
added=$(printf '%s' "$payload" | jq -r '.tool_input.content // .tool_input.new_string // empty')
[ -z "$added" ] && exit 0
hits=$(printf '%s' "$added" | grep -nE '\b(NTD|NTST|NTQA)-[0-9]+|![0-9]{4,}' | head -5)
[ -z "$hits" ] && exit 0
jq -n --arg r "F17 slop-comment-in-source: ticket key or MR reference written into $path. Ticket keys belong only in branch names, commit subjects, and MR titles — never in source, comments, docstrings, strings, or filenames. Remove it; move rationale to the commit body. Hits: $hits" '{decision:"block", reason:$r}'
exit 0

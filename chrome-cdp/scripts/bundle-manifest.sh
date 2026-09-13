#!/bin/bash
set -euo pipefail
export LC_ALL=C

[[ $# -eq 1 && "$1" == /* && "$1" == *.app ]] || {
  echo "usage: bundle-manifest.sh /absolute/path/Bundle.app" >&2
  exit 64
}
BUNDLE="$1"
[[ -d "$BUNDLE" && ! -L "$BUNDLE" ]] || { echo "invalid app bundle" >&2; exit 1; }

unsupported="$(/usr/bin/find "$BUNDLE" -mindepth 1 ! -type d ! -type f -print -quit)"
[[ -z "$unsupported" ]] || { echo "unsupported bundle entry type" >&2; exit 1; }

cd "$BUNDLE"
/usr/bin/find . -type f -print | /usr/bin/sed 's#^\./##' | /usr/bin/sort | while IFS= read -r relative; do
  digest="$(/usr/bin/shasum -a 256 "$relative" | /usr/bin/awk '{print $1}')"
  /usr/bin/printf '%s  %s\n' "$digest" "$relative"
done

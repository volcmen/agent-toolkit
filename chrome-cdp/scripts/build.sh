#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && /bin/pwd -P)"
DIST_ROOT="${CHROME_CDP_DIST_ROOT:-$PROJECT_ROOT/dist}"
STAGE_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/chrome-cdp-build.XXXXXX")"
trap '/bin/rm -rf "$STAGE_ROOT"' EXIT HUP INT TERM

/usr/bin/swift build --package-path "$PROJECT_ROOT" -c release --product chrome-cdp-helper
BIN_ROOT="$(/usr/bin/swift build --package-path "$PROJECT_ROOT" -c release --show-bin-path)"
/usr/bin/osacompile -o "$STAGE_ROOT/Chrome CDP.app" "$PROJECT_ROOT/app/Chrome CDP.applescript"
/bin/cp "$PROJECT_ROOT/app/Info.plist" "$STAGE_ROOT/Chrome CDP.app/Contents/Info.plist"
/bin/cp "$BIN_ROOT/chrome-cdp-helper" "$STAGE_ROOT/Chrome CDP.app/Contents/Resources/chrome-cdp-helper"
/bin/chmod 0755 "$STAGE_ROOT/Chrome CDP.app/Contents/Resources/chrome-cdp-helper"
/usr/bin/codesign --force --sign - "$STAGE_ROOT/Chrome CDP.app/Contents/Resources/chrome-cdp-helper"
/usr/bin/codesign --force --deep --sign - "$STAGE_ROOT/Chrome CDP.app"
"$PROJECT_ROOT/scripts/verify.sh" --app "$STAGE_ROOT/Chrome CDP.app" --staged

/bin/mkdir -p "$DIST_ROOT"
if [[ -e "$DIST_ROOT/Chrome CDP.app" || -L "$DIST_ROOT/Chrome CDP.app" ]]; then
  /bin/rm -rf "$DIST_ROOT/Chrome CDP.app"
fi
/bin/mv "$STAGE_ROOT/Chrome CDP.app" "$DIST_ROOT/Chrome CDP.app"
echo "built $DIST_ROOT/Chrome CDP.app"

#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: verify.sh --app /absolute/path/Chrome\ CDP.app (--staged|--installed)" >&2
  exit 64
}

[[ $# -eq 3 && "$1" == "--app" ]] || usage
APP_PATH="$2"
MODE="$3"
[[ "$APP_PATH" == /* && "$APP_PATH" == *.app ]] || usage
[[ "$MODE" == "--staged" || "$MODE" == "--installed" ]] || usage
[[ -d "$APP_PATH" && ! -L "$APP_PATH" ]] || { echo "invalid app bundle: $APP_PATH" >&2; exit 1; }

PLIST="$APP_PATH/Contents/Info.plist"
HELPER="$APP_PATH/Contents/Resources/chrome-cdp-helper"
SCRIPT="$APP_PATH/Contents/Resources/Scripts/main.scpt"
APPLET="$APP_PATH/Contents/MacOS/applet"

/usr/bin/plutil -lint "$PLIST" >/dev/null
check_plist() {
  local key="$1" expected="$2" actual
  actual="$(/usr/bin/plutil -extract "$key" raw -o - "$PLIST")"
  [[ "$actual" == "$expected" ]] || { echo "unexpected $key: $actual" >&2; exit 1; }
}
check_plist CFBundleDisplayName "Chrome CDP"
check_plist CFBundleExecutable applet
check_plist CFBundleIconFile applet
check_plist CFBundleIdentifier ai.daviddavid.chrome-cdp
check_plist CFBundleInfoDictionaryVersion 6.0
check_plist CFBundleName "Chrome CDP"
check_plist CFBundlePackageType APPL
check_plist CFBundleSignature aplt
check_plist CFBundleShortVersionString 1.0.0
check_plist CFBundleVersion 1
check_plist LSMinimumSystemVersion 13.0
check_plist OSAAppletShowStartupScreen false

[[ -x "$APPLET" && -f "$SCRIPT" && -x "$HELPER" && ! -L "$HELPER" ]] || {
  echo "app bundle is missing a required executable or script" >&2
  exit 1
}
[[ "$(/usr/bin/stat -f '%Lp' "$HELPER")" == "755" ]] || { echo "helper mode is not 0755" >&2; exit 1; }
[[ "$("$HELPER" --version)" == "chrome-cdp-helper 1.0.0" ]] || { echo "helper version check failed" >&2; exit 1; }
SELF_CHECK="$("$HELPER" --self-check)"
echo "$SELF_CHECK" | /usr/bin/plutil -convert xml1 -o /dev/null -- - >/dev/null
/usr/bin/osadecompile "$SCRIPT" >/dev/null
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
/usr/bin/codesign --verify --strict --verbose=2 "$HELPER"
/usr/bin/codesign -d --verbose=4 "$APP_PATH" 2>&1 | /usr/bin/grep '^Signature=adhoc$' >/dev/null
/usr/bin/codesign -d --verbose=4 "$HELPER" 2>&1 | /usr/bin/grep '^Signature=adhoc$' >/dev/null

if [[ "$MODE" == "--installed" ]]; then
  /usr/bin/mdimport "$APP_PATH"
  deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    if /usr/bin/mdfind 'kMDItemCFBundleIdentifier == "ai.daviddavid.chrome-cdp"' | /usr/bin/grep -Fx "$APP_PATH" >/dev/null; then
      break
    fi
    /bin/sleep 1
  done
  /usr/bin/mdfind 'kMDItemCFBundleIdentifier == "ai.daviddavid.chrome-cdp"' | /usr/bin/grep -Fx "$APP_PATH" >/dev/null || {
    echo "Spotlight did not index $APP_PATH" >&2
    exit 1
  }
fi

echo "verified $APP_PATH"

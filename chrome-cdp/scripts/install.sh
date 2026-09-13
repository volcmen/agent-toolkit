#!/bin/bash
set -euo pipefail
export LC_ALL=C

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && /bin/pwd -P)"
WORKSPACE_ROOT="$(cd "$PROJECT_ROOT/.." && /bin/pwd -P)"
BACKUP_ROOT="$WORKSPACE_ROOT/.local-backup/chrome-cdp"
INSTALLED_APP="/Applications/Chrome CDP.app"

usage() {
  echo "usage: install.sh install | install.sh rollback BACKUP_DIR" >&2
  exit 64
}

capture_handlers() {
  local directory="$1" prefix="$2"
  /usr/bin/defaults export com.apple.LaunchServices/com.apple.launchservices.secure "$directory/$prefix-launchservices.plist"
  /usr/bin/plutil -extract LSHandlers xml1 -o "$directory/$prefix-handlers.xml" "$directory/$prefix-launchservices.plist"
  /usr/bin/shasum -a 256 "$directory/$prefix-handlers.xml" | /usr/bin/awk '{print $1}' > "$directory/$prefix-handlers.sha256"
}

strict_signature() {
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$1"
}

build_installer_path() {
  local bin_root
  bin_root="$(/usr/bin/swift build --package-path "$PROJECT_ROOT" -c release --show-bin-path)"
  echo "$bin_root/chrome-cdp-installer"
}

install_app() {
  "$PROJECT_ROOT/scripts/build.sh"
  "$PROJECT_ROOT/scripts/verify.sh" --app "$PROJECT_ROOT/dist/Chrome CDP.app" --staged

  /bin/mkdir -p "$BACKUP_ROOT"
  /bin/chmod 0700 "$BACKUP_ROOT"
  local stamp backup_dir stage installer baseline_hash final_hash
  stamp="$(/bin/date -u +%Y%m%dT%H%M%SZ)-$$"
  backup_dir="$BACKUP_ROOT/$stamp"
  /bin/mkdir "$backup_dir"
  /bin/chmod 0700 "$backup_dir"
  /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "$backup_dir/installed-at.txt"
  capture_handlers "$backup_dir" before
  baseline_hash="$(<"$backup_dir/before-handlers.sha256")"

  if [[ -e "$INSTALLED_APP" || -L "$INSTALLED_APP" ]]; then
    [[ -d "$INSTALLED_APP" && ! -L "$INSTALLED_APP" ]] || { echo "installed Chrome CDP path is unsafe" >&2; exit 1; }
    /usr/bin/ditto --rsrc --extattr "$INSTALLED_APP" "$backup_dir/Chrome CDP.app"
    "$PROJECT_ROOT/scripts/bundle-manifest.sh" "$INSTALLED_APP" > "$backup_dir/installed.manifest"
    "$PROJECT_ROOT/scripts/bundle-manifest.sh" "$backup_dir/Chrome CDP.app" > "$backup_dir/backup.manifest"
    /usr/bin/cmp "$backup_dir/installed.manifest" "$backup_dir/backup.manifest"
    strict_signature "$backup_dir/Chrome CDP.app" > "$backup_dir/backup-signature.txt" 2>&1
  fi

  stage="/Applications/.Chrome CDP.app.stage-$$"
  [[ ! -e "$stage" && ! -L "$stage" ]] || { echo "installation stage already exists" >&2; exit 1; }
  /usr/bin/ditto --rsrc --extattr "$PROJECT_ROOT/dist/Chrome CDP.app" "$stage"
  "$PROJECT_ROOT/scripts/verify.sh" --app "$stage" --staged
  installer="$(build_installer_path)"
  "$installer" publish --staged "$stage" --installed "$INSTALLED_APP"

  if ! "$PROJECT_ROOT/scripts/verify.sh" --app "$INSTALLED_APP" --installed; then
    if [[ -e "$stage" ]]; then
      "$installer" publish --staged "$stage" --installed "$INSTALLED_APP" || true
    fi
    echo "installed verification failed; previous app restored" >&2
    exit 1
  fi

  if [[ -e "$stage" ]]; then
    /bin/mv "$stage" "$backup_dir/swapped-out-Chrome CDP.app"
  fi
  capture_handlers "$backup_dir" after
  final_hash="$(<"$backup_dir/after-handlers.sha256")"
  [[ "$baseline_hash" == "$final_hash" ]] || { echo "LaunchServices handlers changed unexpectedly" >&2; exit 1; }
  echo "$backup_dir"
}

rollback_app() {
  [[ $# -eq 1 ]] || usage
  local backup_dir="$1" backup_app stage installer
  [[ "$backup_dir" == "$BACKUP_ROOT"/* && -d "$backup_dir" && ! -L "$backup_dir" ]] || { echo "invalid backup directory" >&2; exit 1; }
  backup_app="$backup_dir/Chrome CDP.app"
  [[ -d "$backup_app" && ! -L "$backup_app" ]] || { echo "backup app is missing" >&2; exit 1; }
  strict_signature "$backup_app"
  stage="/Applications/.Chrome CDP.app.stage-rollback-$$"
  [[ ! -e "$stage" && ! -L "$stage" ]] || { echo "rollback stage already exists" >&2; exit 1; }
  /usr/bin/ditto --rsrc --extattr "$backup_app" "$stage"
  installer="$(build_installer_path)"
  "$installer" publish --staged "$stage" --installed "$INSTALLED_APP"
  if ! strict_signature "$INSTALLED_APP"; then
    "$installer" publish --staged "$stage" --installed "$INSTALLED_APP" || true
    echo "rollback verification failed; current app restored" >&2
    exit 1
  fi
  /bin/mkdir -p "$backup_dir/rollback-displaced"
  /bin/mv "$stage" "$backup_dir/rollback-displaced/Chrome CDP.app"
  echo "rolled back from $backup_dir"
}

case "${1:-}" in
  install)
    [[ $# -eq 1 ]] || usage
    install_app
    ;;
  rollback)
    shift
    rollback_app "$@"
    ;;
  *) usage ;;
esac

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

canonical_backup() {
  local candidate="$1" root resolved
  [[ -d "$candidate" && ! -L "$candidate" && -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || return 1
  root="$(cd "$BACKUP_ROOT" && /bin/pwd -P)" || return 1
  resolved="$(cd "$candidate" && /bin/pwd -P)" || return 1
  [[ "$resolved" == "$root"/* ]] || return 1
  printf '%s\n' "$resolved"
}

restore_previous_app() {
  local stage="$1" installer="$2" manifest="$3" recovered_manifest="$4"
  if [[ ! -d "$stage" || -L "$stage" ]] || ! "$installer" publish --staged "$stage" --installed "$INSTALLED_APP"; then
    echo "recovery failed: previous app could not be republished; inspect $stage and $INSTALLED_APP" >&2
    return 1
  fi
  if ! strict_signature "$INSTALLED_APP" || ! "$PROJECT_ROOT/scripts/bundle-manifest.sh" "$INSTALLED_APP" > "$recovered_manifest" || ! /usr/bin/cmp "$manifest" "$recovered_manifest"; then
    echo "recovery failed: restored app did not pass signature and content verification" >&2
    return 1
  fi
  echo "previous app restored and verified" >&2
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
    echo "installed verification failed" >&2
    if [[ -f "$backup_dir/installed.manifest" ]]; then
      restore_previous_app "$stage" "$installer" "$backup_dir/installed.manifest" "$backup_dir/recovered.manifest" || return 1
    elif /bin/mv "$INSTALLED_APP" "$backup_dir/failed-new-Chrome CDP.app" && [[ ! -e "$INSTALLED_APP" && ! -L "$INSTALLED_APP" ]]; then
      echo "failed new app preserved in $backup_dir; no previous installation existed" >&2
    else
      echo "recovery failed: could not remove the failed first installation" >&2
    fi
    return 1
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
  local backup_dir backup_app stage installer current_manifest
  backup_dir="$(canonical_backup "$1")" || { echo "invalid backup directory" >&2; return 1; }
  backup_app="$backup_dir/Chrome CDP.app"
  [[ -d "$backup_app" && ! -L "$backup_app" ]] || { echo "backup app is missing" >&2; exit 1; }
  strict_signature "$backup_app"
  stage="/Applications/.Chrome CDP.app.stage-rollback-$$"
  [[ ! -e "$stage" && ! -L "$stage" ]] || { echo "rollback stage already exists" >&2; exit 1; }
  /usr/bin/ditto --rsrc --extattr "$backup_app" "$stage"
  installer="$(build_installer_path)"
  [[ -d "$INSTALLED_APP" && ! -L "$INSTALLED_APP" ]] || { echo "current app is missing or unsafe" >&2; return 1; }
  current_manifest="$backup_dir/before-rollback-$$.manifest"
  "$PROJECT_ROOT/scripts/bundle-manifest.sh" "$INSTALLED_APP" > "$current_manifest"
  "$installer" publish --staged "$stage" --installed "$INSTALLED_APP"
  if ! strict_signature "$INSTALLED_APP"; then
    echo "rollback verification failed" >&2
    restore_previous_app "$stage" "$installer" "$current_manifest" "$backup_dir/recovered-rollback-$$.manifest" || return 1
    return 1
  fi
  /bin/mkdir -p "$backup_dir/rollback-displaced"
  /bin/mv "$stage" "$backup_dir/rollback-displaced/Chrome CDP.app"
  echo "rolled back from $backup_dir"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
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
fi

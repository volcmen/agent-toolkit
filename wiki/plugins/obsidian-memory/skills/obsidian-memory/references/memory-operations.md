# Controlled local memory operations

Use this reference only for a QMD upgrade, installation, explicit maintenance,
or rollback. Commands operate on the configured vault resolved from
`~/.config/obsidian-memory/config.json`; use its absolute path. QMD 2.8.3 is a
Bun-owned local derived accelerator. Its caches and embeddings are disposable:
Markdown/Git is the recovery authority. No vault content is mirrored to Hermes
or another external memory provider. QMD HTTP/MCP, project-local configuration,
external source paths, and custom model URIs are not enabled.

## 1. Repository gates

From the workspace root, validate repository behavior before any installation:

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
```

## 2. Bun-owned QMD 2.8.3

Apply the pinned CLI, then prove its installation and Bun manifest state:

```bash
python3 bun-global-tools/sync.py apply
qmd --version
qmd status
qmd doctor
python3 bun-global-tools/sync.py check --deep
```

## 3. Post-integration plugin install

Only after integration, install changed local plugin content for both Codex and
Claude Code, then compare the live copies:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

## 4. Pre-refresh read-only proof

Before changing a derived index, keep the evaluator fixture private and run:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" \
  evaluate path/to/private-recall-evals.json --json
```

## 5. Explicit derived-index maintenance

Run semantic discovery maintenance deliberately, never from a lifecycle hook:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" refresh-index --embed
```

Lifecycle hooks never run QMD model/index work, evaluator, or audit.

## 6. Repeat proof

After maintenance, repeat the same read-only health, audit, and evaluation
proof:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" \
  evaluate path/to/private-recall-evals.json --json
```

## 7. Derived-only rollback

Before changing the plugin source or Bun pin, record the exact upgraded plugin
commit so failed-rollback recovery can restore it. Then read the default index
path from `qmd status` and preserve that exact SQLite database. The only
accepted path is the default QMD cache path reported by QMD itself. This backup
block stops on a missing, duplicate, unexpected, or non-file `Index:` value. It
creates a unique non-overwriting directory beside the database, then moves only
that database and its matching WAL/SHM sidecars when present:

```sh
(
  set -eu
  qmd_status_before="$(qmd status)"
  printf '%s\n' "$qmd_status_before"
  qmd_index="$(printf '%s\n' "$qmd_status_before" | sed -n 's/^Index:[[:space:]]*//p')"
  qmd_expected_index="${XDG_CACHE_HOME:-${HOME:?HOME is required}/.cache}/qmd/index.sqlite"
  if [ "$qmd_index" != "$qmd_expected_index" ] || [ ! -f "$qmd_index" ] || [ -L "$qmd_index" ]; then
    printf '%s\n' "STOP: QMD Index is not the expected default cache SQLite file" >&2
    exit 1
  fi
  if [ -L "${qmd_index}-wal" ] || { [ -e "${qmd_index}-wal" ] && [ ! -f "${qmd_index}-wal" ]; }; then
    printf '%s\n' "STOP: QMD WAL is not a regular non-symlink file" >&2
    exit 1
  fi
  if [ -L "${qmd_index}-shm" ] || { [ -e "${qmd_index}-shm" ] && [ ! -f "${qmd_index}-shm" ]; }; then
    printf '%s\n' "STOP: QMD SHM is not a regular non-symlink file" >&2
    exit 1
  fi
  qmd_backup_dir="$(mktemp -d "${qmd_index}.pre-rollback.XXXXXX")"
  mv "$qmd_index" "$qmd_backup_dir/index.sqlite"
  if [ -f "${qmd_index}-wal" ]; then
    mv "${qmd_index}-wal" "$qmd_backup_dir/index.sqlite-wal"
  fi
  if [ -f "${qmd_index}-shm" ]; then
    mv "${qmd_index}-shm" "$qmd_backup_dir/index.sqlite-shm"
  fi
  printf 'Pre-rollback QMD backup: %s\n' "$qmd_backup_dir"
)
```

Stop unless that block exits zero, and record its printed backup directory.
Never delete or overwrite that backup. Leave the global QMD collection YAML
unchanged; it is the configuration used to derive the fresh index.

Now restore the prior plugin commit through the reviewed Git integration flow,
re-pin only `@tobilu/qmd` to QMD 2.5.3 in
`bun-global-tools/manifest.json`, apply the pin, and force-install the restored
plugin for both agents:

```sh
python3 bun-global-tools/sync.py apply
python3 scripts/plugins.py install --force
```

With the old database absent and the global collection YAML unchanged, build a
fresh database rather than incrementally refreshing the upgraded database:

```sh
qmd update
qmd embed
```

Then run every rollback health and compatibility check in order:

```sh
qmd --version
qmd status
qmd doctor
python3 bun-global-tools/sync.py check --deep
python3 scripts/plugins.py status
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" \
  evaluate path/to/private-recall-evals.json --json
```

### Failed-rollback recovery

If any later step fails, stop and retain the printed pre-rollback backup. An
early failure before `qmd update` may leave no newly derived database, so do not
create an empty quarantine or attempt to move a database that does not exist.
First restore the exact upgraded plugin commit recorded before rollback through
the reviewed Git integration flow and re-pin only `@tobilu/qmd` to QMD 2.8.3.
The saved database belongs to that pre-rollback QMD 2.8.3 and upgraded plugin
state. Apply and verify those pre-rollback runtime/plugin states before
restoring any saved SQLite file:

```sh
python3 bun-global-tools/sync.py apply
python3 scripts/plugins.py install --force
qmd --version
python3 bun-global-tools/sync.py check --deep
python3 scripts/plugins.py status
```

Set `qmd_backup_dir` to the exact directory printed by the backup block. The
following recovery block rejects a missing saved database or an unexpected
backup path. It quarantines a failed rebuilt database and its matching
sidecars only when that database exists; sidecars without a database stop
recovery. Saved inputs must be regular non-symlink files, and every restore
target must satisfy both `! -e` and `! -L` so dangling symlinks cannot survive
the absence check. It never overwrites or follows links from the saved, failed,
or target sets:

```sh
(
  set -eu
  qmd_index="${XDG_CACHE_HOME:-${HOME:?HOME is required}/.cache}/qmd/index.sqlite"
  qmd_backup_dir="/recorded/pre-rollback/backup-directory"
  case "$qmd_backup_dir" in
    "${qmd_index}.pre-rollback."*) ;;
    *) printf '%s\n' "STOP: unexpected pre-rollback backup path" >&2; exit 1 ;;
  esac
  if [ -L "$qmd_backup_dir" ] || [ ! -d "$qmd_backup_dir" ] || [ -L "$qmd_backup_dir/index.sqlite" ] || [ ! -f "$qmd_backup_dir/index.sqlite" ]; then
    printf '%s\n' "STOP: pre-rollback SQLite backup is missing" >&2
    exit 1
  fi
  if [ -L "$qmd_backup_dir/index.sqlite-wal" ] || { [ -e "$qmd_backup_dir/index.sqlite-wal" ] && [ ! -f "$qmd_backup_dir/index.sqlite-wal" ]; }; then
    printf '%s\n' "STOP: saved QMD WAL is not a regular non-symlink file" >&2
    exit 1
  fi
  if [ -L "$qmd_backup_dir/index.sqlite-shm" ] || { [ -e "$qmd_backup_dir/index.sqlite-shm" ] && [ ! -f "$qmd_backup_dir/index.sqlite-shm" ]; }; then
    printf '%s\n' "STOP: saved QMD SHM is not a regular non-symlink file" >&2
    exit 1
  fi
  if [ -L "$qmd_index" ] || { [ -e "$qmd_index" ] && [ ! -f "$qmd_index" ]; }; then
    printf '%s\n' "STOP: QMD recovery target is not a regular non-symlink file" >&2
    exit 1
  fi
  if [ -L "${qmd_index}-wal" ] || { [ -e "${qmd_index}-wal" ] && [ ! -f "${qmd_index}-wal" ]; }; then
    printf '%s\n' "STOP: QMD WAL target is not a regular non-symlink file" >&2
    exit 1
  fi
  if [ -L "${qmd_index}-shm" ] || { [ -e "${qmd_index}-shm" ] && [ ! -f "${qmd_index}-shm" ]; }; then
    printf '%s\n' "STOP: QMD SHM target is not a regular non-symlink file" >&2
    exit 1
  fi
  if [ -f "$qmd_index" ]; then
    qmd_failed_backup_dir="$(mktemp -d "${qmd_index}.failed-rollback.XXXXXX")"
    mv "$qmd_index" "$qmd_failed_backup_dir/index.sqlite"
    if [ -e "${qmd_index}-wal" ]; then
      mv "${qmd_index}-wal" "$qmd_failed_backup_dir/index.sqlite-wal"
    fi
    if [ -e "${qmd_index}-shm" ]; then
      mv "${qmd_index}-shm" "$qmd_failed_backup_dir/index.sqlite-shm"
    fi
    printf 'Failed rollback QMD backup: %s\n' "$qmd_failed_backup_dir"
  elif [ -e "${qmd_index}-wal" ] || [ -e "${qmd_index}-shm" ]; then
    printf '%s\n' "STOP: QMD sidecar exists without its database" >&2
    exit 1
  fi
  if [ -e "$qmd_index" ] || [ -L "$qmd_index" ] ||
     [ -e "${qmd_index}-wal" ] || [ -L "${qmd_index}-wal" ] ||
     [ -e "${qmd_index}-shm" ] || [ -L "${qmd_index}-shm" ]; then
    printf '%s\n' "STOP: recovery target already exists" >&2
    exit 1
  fi
  cp -p "$qmd_backup_dir/index.sqlite" "$qmd_index"
  if [ -f "$qmd_backup_dir/index.sqlite-wal" ]; then
    cp -p "$qmd_backup_dir/index.sqlite-wal" "${qmd_index}-wal"
  fi
  if [ -f "$qmd_backup_dir/index.sqlite-shm" ]; then
    cp -p "$qmd_backup_dir/index.sqlite-shm" "${qmd_index}-shm"
  fi
)
```

Finally prove the restored database with the restored pre-rollback runtime and
plugin:

```sh
qmd status
qmd doctor
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" \
  evaluate path/to/private-recall-evals.json --json
```

Never delete the pre-rollback or failed-rebuild backup. Rollback and recovery
proceed without rewriting Markdown and leave the global collection YAML and
vault configuration untouched.

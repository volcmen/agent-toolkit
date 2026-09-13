# Chrome CDP

`Chrome CDP.app` is a Spotlight-launchable macOS app that starts or reuses a visible Google Chrome window prepared for local AI browser automation.

It uses a persistent, dedicated Chrome profile at `$HOME/chrome-cdp-profile` and exposes CDP only on `127.0.0.1:9222`. No browser extension, Apple ID, paid certificate, default-browser change, or headless mode is required.

## Use it

1. Open Spotlight, type **Chrome CDP**, and press Return.
2. Sign in to websites in that Chrome window once. Those sessions persist in the dedicated profile.
3. Attach an isolated `agent-browser` session explicitly:

```bash
agent-browser --session my-task --cdp 9222 get url
agent-browser --session my-task --cdp 9222 snapshot -i
agent-browser close --session my-task
```

The equivalent persistent connection form is:

```bash
agent-browser --session my-task connect 9222
agent-browser --session my-task snapshot -i
agent-browser close --session my-task
```

Closing an attached `agent-browser` session disconnects automation; it does not close the headed Chrome instance. Explicit `--cdp 9222` or `connect 9222` stays the supported path; `--auto-connect` discovery is not relied on.

## Profile safety

Do not point automation at the live normal-Chrome user-data root. Chrome profiles are browser-owned databases and must not be opened concurrently by another Chrome process.

`agent-browser --profile Default` uses its named-profile/copy workflow. By contrast, a profile *path* is passed to Chrome as `--user-data-dir`; never pass the path of a profile that another Chrome process is using. This launcher avoids that ambiguity by owning only `$HOME/chrome-cdp-profile` and by making agents attach to its already-running CDP endpoint.

## Fixed production contract

- Chrome app: `/Applications/Google Chrome.app`
- Visible, headed Chrome
- Profile: `$HOME/chrome-cdp-profile`, current-user owned, non-symlink, mode `0700`
- CDP: `127.0.0.1:9222`
- Readiness and launch-lock deadlines: 10 seconds
- Launch: `/usr/bin/open -na "Google Chrome" --args ...`
- Installed app: `/Applications/Chrome CDP.app`
- Bundle identifier: `ai.daviddavid.chrome-cdp`

The launcher reuses Chrome only after validating the executable, full argument vector, profile path, listener PID/address, `/json/version`, WebSocket host/port, and page-target list. Conflicts fail closed; the launcher never kills or replaces an unknown process.

## Build, test, and install

Prerequisites are macOS 13 or newer, Google Chrome in `/Applications`, Swift 6.x, and the standard macOS command-line tools.

From this directory:

```bash
python3 scripts/check.py

# Individual Swift checks:
/usr/bin/swift run chrome-cdp-tests
/usr/bin/swift build -c release -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
./scripts/build.sh
./scripts/verify.sh --app "$PWD/dist/Chrome CDP.app" --staged
./scripts/install.sh install
```

The build ad-hoc signs the embedded helper and app, so it needs no Apple Developer account. Installation verifies a full backup, stages beside `/Applications/Chrome CDP.app`, atomically swaps the bundles, verifies the installed result and Spotlight index, and confirms LaunchServices handlers did not change.

Backups are private directories under `../.local-backup/chrome-cdp/`. To roll back to the latest backup:

```bash
backup_dir="$(/usr/bin/find ../.local-backup/chrome-cdp -mindepth 1 -maxdepth 1 -type d | /usr/bin/sort | /usr/bin/tail -1)"
./scripts/install.sh rollback "$backup_dir"
```

Rollback replaces only `/Applications/Chrome CDP.app`; it does not stop Chrome or edit the profile.

## Troubleshooting

- **Port 9222 is in use:** close or reconfigure the process that owns it, then launch Chrome CDP again. The app will not terminate it.
- **Chrome is missing:** install Google Chrome at `/Applications/Google Chrome.app`.
- **Profile rejected:** `$HOME/chrome-cdp-profile` must be a real directory owned by the current user. The launcher safely repairs only that directory's mode to `0700`.
- **Readiness timeout:** inspect the visible Chrome window, then retry. The launcher does not restart a conflicting process.
- **`--auto-connect` finds nothing:** use `agent-browser --cdp 9222 ...`.

See [validation-2026-08-09.md](docs/validation-2026-08-09.md) for the redacted live result and [review-2026-08-09.md](docs/review-2026-08-09.md) for the implementation review record.

Chrome profiles must use absolute paths. The launcher refuses an existing Chrome process with a relative `--user-data-dir`, because its working directory is not available in the observation and profile ownership cannot be verified.

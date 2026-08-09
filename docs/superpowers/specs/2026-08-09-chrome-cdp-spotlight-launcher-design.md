# Chrome CDP Spotlight Launcher Design

## Goals

Replace the ad-hoc Script Editor implementation of `/Applications/Chrome CDP.app` with a source-managed, reliable Spotlight launcher.

V1 will:

- Retain the app name `Chrome CDP`.
- Launch visible, headed Google Chrome.
- Use the dedicated profile at `$HOME/chrome-cdp-profile`.
- Use fixed loopback CDP at `127.0.0.1:9222`.
- Preserve the known-good `open -na 'Google Chrome'` launch path and ad-hoc signing.
- Reuse and foreground a healthy expected Chrome instance.
- Fail safely without killing or restarting unknown processes.
- Keep the normal Chrome profile and Dia's HTTP/HTTPS default-handler status unchanged.

## Non-goals

V1 will not:

- Expose CDP beyond loopback or add `--remote-allow-origins=*`.
- Store credentials.
- Start `agent-browser` or its dashboard automatically.
- Change HTTP/HTTPS handlers, the default browser, or the normal Chrome profile.
- Provide stop, restart, status, logging, or configuration UI.
- Support configurable port or profile paths.
- Require third-party runtime dependencies or Developer ID signing.

## Current-state findings

The current `/Applications/Chrome CDP.app` is an ad-hoc signed Script Editor app. Its AppleScript only checks whether port `9222` is occupied, then runs:

```sh
open -na 'Google Chrome' --args \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/chrome-cdp-profile \
  --no-first-run \
  --no-default-browser-check
```

It reports success immediately, without verifying process identity, profile identity, endpoint readiness, or CDP health.

Chrome 151 and `agent-browser` 0.33.2 are installed. CDP attach, auto-connect, headed launch, persistent-profile use, and dashboard access have been validated. The existing CDP endpoint is loopback-only. The dedicated profile is owned by the current user and currently has mode `0755`. Dia is the registered HTTP and HTTPS handler.

## Architecture

`Chrome CDP.app` will contain a thin AppleScript Spotlight entry point and a bundled native Swift helper built from tracked source with no third-party packages.

| Component | Responsibility |
| --- | --- |
| AppleScript wrapper | Resolve the helper inside the app bundle, execute it, display a success notification from its output, or display an actionable failure alert. |
| Swift core library | Model and classify launcher state independently of UI and subprocess details. |
| Swift helper executable | Perform serialization, profile checks, process and listener classification, launch, readiness checks, and exact-PID foregrounding. |
| Build script | Compile the Swift package and AppleScript wrapper, assemble the bundle, and apply ad-hoc signing. |
| Install script | Back up, verify, atomically replace, and validate `/Applications/Chrome CDP.app`. |
| Verify script | Check bundle structure, embedded-helper execution, strict signing, Spotlight discovery, and installed-state invariants. |

The AppleScript wrapper must not contain browser lifecycle logic. The helper must be independently executable, and the classifier must be unit-testable with injected observations.

## Lifecycle state machine

| State | Detection | Action | Result |
| --- | --- | --- | --- |
| Acquire launch lock | Per-user lock is available | Acquire it for the full classification and launch sequence. | Continue. |
| Busy | Lock is held | Wait for a bounded interval, then reclassify once. | Reuse, success, or actionable failure. |
| Validate profile | Profile does not exist | Create it with `umask 077`, verify ownership, and set mode `0700`. | Continue. |
| Unsafe profile | Profile is a symlink or is not owned by the current user | Do not launch or modify the profile. | Fail with an alert. |
| Repairable profile mode | Profile is a user-owned directory with mode other than `0700` | Set the directory itself to `0700`; never alter its contents. | Continue. |
| Clean | Nothing listens on `127.0.0.1:9222`; no Chrome uses the dedicated profile | Launch expected Chrome. | Wait for readiness. |
| Expected Chrome starting | Expected Chrome uses the dedicated profile and expected CDP arguments; endpoint is not yet healthy | Poll readiness within the bounded timeout. | Success or timeout failure. |
| Healthy expected Chrome | Expected executable and arguments, loopback listener, healthy `/json/version`, and loopback WebSocket URL | Reuse it and foreground its exact PID. | Success. |
| Foreign listener | A non-expected process listens on port `9222`, or the listener is not loopback-only | Do not launch, kill, or alter processes. | Fail with an alert. |
| Wrong-profile Chrome | CDP-capable Chrome is present on the port but does not use `$HOME/chrome-cdp-profile` | Do not reuse it. | Fail with an alert. |
| Profile conflict | Chrome uses `$HOME/chrome-cdp-profile` without the required CDP configuration | Do not start another instance against the profile. | Fail with an alert. |
| Launch expected Chrome | Clean state is confirmed | Run the fixed Chrome invocation. | Wait for readiness. |
| Ready | All readiness checks pass | Foreground the exact Chrome PID; create a blank target only when no page target exists. | Notify success. |
| Failure | Any unsafe, conflicting, or timed-out condition | Release the lock and show a visible actionable alert. | No success notification. |

## Launch and readiness contract

The helper launches Chrome only from the Clean state:

```sh
/usr/bin/open -na 'Google Chrome' --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-cdp-profile" \
  --no-first-run \
  --no-default-browser-check
```

Readiness polling is bounded to 10 seconds at approximately 200 ms intervals. Success requires all of the following:

1. A Chrome process using the expected executable, dedicated profile, and CDP port.
2. A listener bound only to `127.0.0.1:9222`.
3. A successful Chrome CDP `GET /json/version` response.
4. A `webSocketDebuggerUrl` whose host is loopback and whose port is `9222`.
5. A valid, non-symlinked, user-owned dedicated profile.

The helper foregrounds the exact validated Chrome PID through AppKit `NSRunningApplication`. If the verified CDP target list has no page target, it creates one blank page target; otherwise it does not create or replace tabs.

## Security model

- CDP remains bound to `127.0.0.1` through `--remote-debugging-address=127.0.0.1`.
- The helper rejects non-loopback listeners and non-loopback WebSocket debugger URLs.
- The profile path must be a real directory, not a symlink, and owned by the current user.
- A newly created profile uses `umask 077`; a valid existing user-owned profile is set to `0700`.
- The launcher never changes files within the profile directory.
- The launcher never kills, restarts, or modifies unknown processes.
- Profile conflicts are rejected rather than launching a second Chrome against the same directory.
- No credentials, tokens, or browser secrets are copied, stored, logged, or managed by the launcher.
- System commands use fixed absolute paths, and all derived arguments are passed without shell interpolation.
- The app remains ad-hoc signed in V1.

## User experience

Launching `Chrome CDP` from Spotlight has one of two visible outcomes:

- On success, the expected Chrome window is foregrounded and is ready for local CDP use. A short success notification appears only after readiness succeeds.
- On failure, a visible alert explains the condition and corrective action, such as freeing port `9222`, closing a conflicting Chrome instance that uses the dedicated profile, restoring profile ownership, or installing Google Chrome.

Every conflict alert states that the launcher did not terminate or replace another process.

## Error handling

| Condition | User-facing outcome |
| --- | --- |
| Google Chrome unavailable | Alert that Google Chrome could not be found; no launch attempt continues. |
| Lock timeout | Alert that another Chrome CDP launch is still in progress. |
| Port `9222` occupied by foreign listener | Identify the process or PID when available; do not terminate it. |
| Listener is not loopback-only | Alert that CDP is not safely local-only; do not change the process. |
| Chrome uses a different profile | Alert that an incompatible Chrome instance is already serving CDP. |
| Dedicated-profile conflict | Alert that the profile is in use without the expected CDP configuration. |
| Profile is symlinked or wrong-owner | Alert that the profile is unsafe; do not change it. |
| Endpoint timeout or invalid CDP response | Alert that Chrome did not become ready before timeout; do not report success. |
| WebSocket URL is not loopback | Alert that endpoint validation failed; do not change the process. |
| Foregrounding fails after endpoint validation | Present an alert and do not report success. |

## Source, build, and install layout

The source-managed project will be top-level `chrome-cdp/` under `/Users/david.david/Personal/ai`:

```text
chrome-cdp/
  README.md
  Package.swift
  Sources/
    ChromeCDPCore/
    chrome-cdp-helper/
  Tests/
    ChromeCDPCoreTests/
  app/
    Chrome CDP.applescript
    Info.plist
  scripts/
    build.sh
    install.sh
    verify.sh
  dist/                 # generated and ignored
```

`README.md` is the implementation entry point and documents prerequisites, build, verification, installation, rollback, and manual validation.

Build requirements:

- Build the Swift helper in release mode without third-party packages.
- Compile the AppleScript wrapper and resolve the helper from the built app's resources.
- Embed the helper in `Contents/Resources` and set a minimal deterministic `Info.plist`.
- Apply ad-hoc signing with `codesign --force --deep --sign -`.
- Require `codesign --verify --deep --strict --verbose=2` to pass.
- Verify that the built app resolves and executes its embedded helper.

Install requirements:

1. Record the existing app's recursive SHA-256 manifest, signature details, and timestamp.
2. Create a timestamped full backup of `/Applications/Chrome CDP.app` under the workspace's ignored `.local-backup/chrome-cdp/` directory.
3. Build and verify the replacement bundle outside `/Applications`.
4. Replace the installed bundle only after staging validation passes; never leave a partial destination bundle.
5. Verify the installed bundle's strict signature and Spotlight discoverability.
6. Leave active browser processes and `$HOME/chrome-cdp-profile` untouched.

## Validation matrix

| Scenario | Expected result |
| --- | --- |
| Cold start on an alternate test port/profile | Launch expected headed Chrome and succeed only after all readiness checks. |
| Warm reuse on current port `9222` | Reuse healthy expected Chrome and foreground its exact PID without restarting it. |
| Rapid concurrent launches | Serialize per user; produce one healthy instance and no profile race. |
| Foreign port listener | Refuse to launch and leave the listener running. |
| Wrong-profile Chrome | Refuse to reuse or launch against the incompatible state. |
| Same-profile non-CDP conflict | Refuse to launch and leave the running Chrome unchanged. |
| Missing Chrome | Show an actionable failure alert. |
| Symlinked profile | Refuse without modifying the profile or its target. |
| Wrong-owner profile | Refuse without modifying the profile. |
| Readiness timeout | Show a failure alert and do not report success. |
| Normal Chrome use | Leave the normal Chrome profile and separately running browsers unaffected. |
| Profile permissions | Set only the dedicated profile directory to `0700`; preserve its contents. |
| CDP exposure | Listener and WebSocket endpoint are loopback-only. |
| `agent-browser` connection | `connect 9222`, `--cdp 9222`, and `--auto-connect` inspect a page. |
| Spotlight | `Chrome CDP` is discoverable and launchable through Spotlight. |
| Signing | Staged and installed apps pass strict ad-hoc code-sign verification. |
| Default handlers | Dia remains the HTTP and HTTPS handler. |

Automated tests must exercise the classifier with injected observations and cover every non-UI state. Integration tests use an alternate temporary port and profile unless they are explicitly verifying warm reuse of the already-running healthy browser.

## Migration and rollback

Migration replaces only `/Applications/Chrome CDP.app`.

Before installation, record the existing bundle's recursive SHA-256 manifest, signature details, strict-verification result, and installation timestamp. Create a timestamped full backup before replacement. Build and verify the replacement in staging, then install it without exposing a partial app bundle.

Deployment must not stop or relaunch the active Chrome CDP browser. The first installed-app validation exercises the warm-reuse path against the current healthy process. Cold-start and conflict cases are validated against alternate ports and temporary profiles before installation. The dedicated profile is never copied, reset, or migrated.

Rollback restores the timestamped application-bundle backup only. It does not alter Chrome processes, `$HOME/chrome-cdp-profile`, default-browser settings, HTTP/HTTPS handlers, or other browser configuration.

## Acceptance criteria

- The project exists as source-managed `chrome-cdp/` with a README and reproducible build, verification, and install scripts.
- `/Applications/Chrome CDP.app` remains ad-hoc signed and passes strict signature verification.
- Spotlight finds and launches `Chrome CDP`.
- A clean launch starts headed Chrome using `$HOME/chrome-cdp-profile` and CDP at `127.0.0.1:9222`.
- A healthy expected instance is reused and foregrounded without creating unnecessary targets.
- The launcher rejects unsafe profile paths, foreign listeners, incompatible Chrome instances, and profile conflicts without terminating processes.
- Success is reported only after executable and argument validation, loopback listener validation, `/json/version` validation, and loopback WebSocket validation.
- The profile is user-owned, non-symlinked, mode `0700`, and its contents remain unchanged except for normal Chrome operation.
- Normal Chrome, Dia's HTTP/HTTPS handler status, and default-browser settings remain unchanged.
- `agent-browser` can connect and auto-connect after successful launch.

## Deferred follow-ups

- URL routing and explicit default-browser opt-in.
- Status, restart, and stop UI.
- Configurable CDP port and profile path.
- Persistent diagnostic logs.
- An original custom icon, only if it does not delay core reliability.
- Developer ID signing and notarization.
- Dashboard and agent-browser session integration.

## References

- [agent-browser CDP mode](https://github.com/vercel-labs/agent-browser#cdp-mode)
- [Chrome remote-debugging security change](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome DevTools live-session connection](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)

# Chrome CDP Spotlight Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a source-managed, ad-hoc-signed `Chrome CDP.app` that Spotlight can launch, safely starts or reuses headed Google Chrome with the dedicated profile, and exposes a verified local CDP endpoint for `agent-browser` at `127.0.0.1:9222`.

**Architecture:** A presentation-only AppleScript app invokes an embedded Swift helper. A pure Swift core owns configuration, state classification, and orchestration; a macOS library owns filesystem, process, listener, HTTP, lock, and AppKit effects. A separate native installer performs an atomic bundle swap. Bash scripts assemble, sign, back up, install, roll back, and verify the app without managing browser data.

**Tech Stack:** Swift tools 6.0, Foundation, AppKit, Darwin, CoreServices, XCTest, AppleScript, Bash 3.2, and macOS system tools. No third-party packages or runtime dependencies.

## Global Constraints

- Work in an isolated Git worktree created with `superpowers:using-git-worktrees` before Task 1. Preserve unrelated changes and execute each task with `superpowers:test-driven-development`.
- The production configuration is fixed: `/Applications/Google Chrome.app`, `$HOME/chrome-cdp-profile`, `127.0.0.1:9222`, a 10-second readiness deadline, a 200 ms poll interval, and a 10-second lock deadline.
- Launch only from the classified Clean state, using `/usr/bin/open` with the exact argument array `-na`, `Google Chrome`, `--args`, `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=9222`, `--user-data-dir=$HOME/chrome-cdp-profile`, `--no-first-run`, and `--no-default-browser-check`.
- Keep Chrome headed. Do not add `--headless`, `--remote-allow-origins=*`, a wildcard bind, a LAN bind, URL handlers, document handlers, or default-browser changes.
- Reuse only a process whose executable path, complete argument vector, listener PID, listener address, `/json/version` response, and WebSocket debugger URL all satisfy the fixed contract.
- Treat the dedicated profile as browser-owned data. Reject a symlink, non-directory, or wrong-owner path. Create an absent directory under `umask 077`; set only the directory itself to `0700`; never traverse, copy, reset, delete, or recursively chmod its contents.
- Hold a per-user advisory file lock for profile preparation, classification, launch, polling, target creation, and activation. A crashed process must release the kernel lock automatically; do not use an unrecoverable `O_EXCL` sentinel lock.
- Never kill, restart, replace, or modify an unknown process. Conflict and timeout paths fail closed and state that no process was terminated or replaced.
- Require the TCP listener to be bound only to `127.0.0.1` on the configured port. Require a Chrome `/json/version` payload and a `ws` or `wss` debugger URL with a loopback host and the configured port.
- Query `/json/list` after endpoint validation. Create `about:blank` through `PUT /json/new?about:blank` only if there is no target whose `type` is exactly `page`.
- Foreground the exact validated PID using `NSRunningApplication`; never activate Chrome by app name or bundle identifier after classification.
- Report success only after all readiness, blank-target, and exact-PID activation work succeeds.
- The production helper accepts only no arguments, `--version`, and `--self-check`. Alternate ports and profiles exist only in the unbundled integration harness, gated by `CHROME_CDP_INTEGRATION_TEST=1`.
- All routine automated tests avoid the live `127.0.0.1:9222`. Only the final installed warm-reuse validation may attach to that endpoint.
- Build output under `chrome-cdp/dist/`, Swift output under `chrome-cdp/.build/`, and backups under root `.local-backup/` remain ignored.
- Sign the embedded helper and final bundle ad hoc. Both staged and installed apps must pass `/usr/bin/codesign --verify --deep --strict --verbose=2`.
- Migration must first build and verify outside `/Applications`, record and verify a full backup, copy the candidate to a sibling staging path, then publish it with `renameatx_np` and `RENAME_SWAP` when an installed app exists. A failed post-swap verification must atomically swap the old bundle back.
- Migration and rollback replace only `/Applications/Chrome CDP.app`. They must not stop or relaunch Chrome, alter the profile, start `agent-browser`, start the dashboard, or change LaunchServices handlers.
- Before claiming completion, use `superpowers:requesting-code-review` and `superpowers:verification-before-completion`. Every task with tracked changes ends with its own commit, and task commits are never combined.

---

## Final File Map

```text
chrome-cdp/
├── README.md
├── Package.swift
├── .gitignore
├── Sources/
│   ├── ChromeCDPCore/
│   │   ├── LauncherConfiguration.swift
│   │   ├── LauncherModels.swift
│   │   ├── LauncherClassifier.swift
│   │   ├── LauncherFailure.swift
│   │   ├── LauncherProtocols.swift
│   │   └── LauncherRunner.swift
│   ├── ChromeCDPMac/
│   │   ├── AtomicBundleSwap.swift
│   │   ├── CDPClient.swift
│   │   ├── LaunchLock.swift
│   │   ├── ListenerInspector.swift
│   │   ├── MacLauncherSystem.swift
│   │   ├── ProcessInspector.swift
│   │   └── ProfileGuard.swift
│   ├── ChromeCDPHelper/main.swift
│   ├── ChromeCDPInstaller/main.swift
│   └── ChromeCDPIntegrationHarness/main.swift
├── Tests/
│   ├── ChromeCDPCoreTests/
│   ├── ChromeCDPMacTests/
│   └── ChromeCDPIntegrationTests/
├── app/
│   ├── Chrome CDP.applescript
│   └── Info.plist
├── scripts/
│   ├── build.sh
│   ├── bundle-manifest.sh
│   ├── install.sh
│   └── verify.sh
├── docs/
│   ├── review-2026-08-09.md
│   └── validation-2026-08-09.md
└── dist/                       # generated, ignored
```

### Task 1: Scaffold the documented Swift package and fixed configuration

**Files:**

- Create: `chrome-cdp/README.md`
- Create: `chrome-cdp/Package.swift`
- Create: `chrome-cdp/.gitignore`
- Create: `chrome-cdp/Sources/ChromeCDPCore/LauncherConfiguration.swift`
- Create: `chrome-cdp/Sources/ChromeCDPHelper/main.swift`
- Create: `chrome-cdp/Tests/ChromeCDPCoreTests/LauncherConfigurationTests.swift`

- [ ] **Step 1: Start the project with its README**

Write a short, accurate initial README containing the title, fixed production contract, safety non-goals, and these developer commands:

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
/usr/bin/swift build -c release
```

Keep the initial README limited to behavior and commands that exist in this task. Do not add task markers or future-work prose.

- [ ] **Step 2: Write the failing production-configuration test**

Create `LauncherConfigurationTests.swift` with a temporary home URL and assert all production fields:

```swift
let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
let configuration = LauncherConfiguration.production(homeDirectory: home)
XCTAssertEqual(configuration.chromeApplicationURL.path, "/Applications/Google Chrome.app")
XCTAssertEqual(configuration.chromeExecutableURL.path, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
XCTAssertEqual(configuration.profileURL.path, "/Users/tester/chrome-cdp-profile")
XCTAssertEqual(configuration.host, "127.0.0.1")
XCTAssertEqual(configuration.port, 9222)
XCTAssertEqual(configuration.readinessTimeout, 10)
XCTAssertEqual(configuration.pollInterval, 0.2)
XCTAssertEqual(configuration.lockTimeout, 10)
XCTAssertEqual(configuration.lockURL.path, "/Users/tester/Library/Caches/Chrome CDP/launch.lock")
```

- [ ] **Step 3: Run the test and confirm the missing package API**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter LauncherConfigurationTests
```

Expected: FAIL because `Package.swift` and `LauncherConfiguration` do not exist.

- [ ] **Step 4: Add the package and minimum implementation**

Use this package shape:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChromeCDP",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ChromeCDPCore", targets: ["ChromeCDPCore"]),
        .executable(name: "chrome-cdp-helper", targets: ["ChromeCDPHelper"])
    ],
    targets: [
        .target(name: "ChromeCDPCore"),
        .executableTarget(
            name: "ChromeCDPHelper",
            dependencies: ["ChromeCDPCore"]
        ),
        .testTarget(name: "ChromeCDPCoreTests", dependencies: ["ChromeCDPCore"])
    ]
)
```

Implement an immutable `LauncherConfiguration: Equatable, Sendable` with the tested fields and:

```swift
public static func production(homeDirectory: URL) -> LauncherConfiguration
public static func production() -> LauncherConfiguration
```

The zero-argument factory uses `FileManager.default.homeDirectoryForCurrentUser`. Make the helper's temporary `main.swift` support only `--version` and print `chrome-cdp-helper 1.0.0`; all other invocations exit nonzero until Task 6.

Create `chrome-cdp/.gitignore` with exactly:

```gitignore
/.build/
/dist/
```

- [ ] **Step 5: Run and commit the scaffold**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
/usr/bin/swift build -c release
cd /Users/david.david/Personal/ai
git add chrome-cdp
git commit -m "feat: scaffold Chrome CDP launcher"
```

Expected: tests and release build PASS.

### Task 2: Implement the pure launcher classifier and failure contract

**Files:**

- Create: `chrome-cdp/Sources/ChromeCDPCore/LauncherModels.swift`
- Create: `chrome-cdp/Sources/ChromeCDPCore/LauncherFailure.swift`
- Create: `chrome-cdp/Sources/ChromeCDPCore/LauncherClassifier.swift`
- Create: `chrome-cdp/Tests/ChromeCDPCoreTests/LauncherClassifierTests.swift`
- Create: `chrome-cdp/Tests/ChromeCDPCoreTests/LauncherFailureTests.swift`

- [ ] **Step 1: Define the tests against the final public model**

Tests construct only injected values using these exact shapes:

```swift
public enum ProfileObservation: Equatable, Sendable {
    case missing
    case valid(mode: UInt16)
    case symlink
    case wrongOwner(owner: UInt32)
    case notDirectory
}

public struct ProcessObservation: Equatable, Sendable {
    public let pid: Int32
    public let executablePath: String
    public let arguments: [String]
}

public struct ListenerBinding: Equatable, Sendable {
    public let pid: Int32?
    public let address: String
    public let port: UInt16
}

public enum EndpointFailure: Equatable, Sendable {
    case unavailable
    case malformedVersion
    case nonChromeBrowser
    case invalidWebSocket
    case nonLoopbackWebSocket
    case wrongWebSocketPort
    case malformedTargetList
}

public enum EndpointObservation: Equatable, Sendable {
    case unavailable
    case invalid(EndpointFailure)
    case healthy(webSocketURL: URL, pageTargetCount: Int)
}

public struct SystemSnapshot: Equatable, Sendable {
    public let profile: ProfileObservation
    public let processes: [ProcessObservation]
    public let listeners: [ListenerBinding]
    public let endpoint: EndpointObservation
}

public enum LauncherDecision: Equatable, Sendable {
    case createProfile
    case repairProfileMode
    case launch
    case waitForReadiness(pid: Int32, lastFailure: EndpointFailure)
    case reuse(pid: Int32, createBlankTarget: Bool)
    case fail(LauncherFailure)
}
```

Cover each decision and precedence rule with named tests:

- missing profile; mode repair; symlink; wrong owner; non-directory;
- clean launch;
- expected Chrome without a listener;
- expected Chrome with a listener but unavailable or malformed endpoint;
- healthy expected Chrome with and without a page target;
- foreign listener with known and unknown PID;
- any listener address other than exactly `127.0.0.1`;
- exact Chrome on the configured port with a different profile;
- dedicated-profile Chrome missing either required CDP argument;
- more than one expected browser-owner process;
- listener PID not matching the expected Chrome PID;
- non-loopback or wrong-port WebSocket URL;
- multiple listeners, including one unsafe binding.

- [ ] **Step 2: Run the classifier tests and confirm failure**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter LauncherClassifierTests
/usr/bin/swift test --filter LauncherFailureTests
```

Expected: FAIL because the model, classifier, and errors do not exist.

- [ ] **Step 3: Implement exact argument matching and classification**

Expose:

```swift
public struct LauncherClassifier: Sendable {
    public init(configuration: LauncherConfiguration)
    public func classify(_ snapshot: SystemSnapshot) -> LauncherDecision
}
```

An expected process must have the exact Chrome executable path and contain all five fixed browser arguments derived from the configuration. Parse both `--name=value` and `--name`, `value` forms for `--user-data-dir`, `--remote-debugging-address`, and `--remote-debugging-port`; reject duplicate values that disagree.

Apply this precedence:

1. reject unsafe profile observations;
2. request profile creation or mode repair;
3. reject any non-`127.0.0.1` binding;
4. reject a dedicated-profile Chrome lacking expected CDP arguments;
5. reject multiple expected owner processes rather than choosing one;
6. classify a listener-owned exact Chrome with a different profile as wrong-profile Chrome;
7. classify an unmatched listener as foreign;
8. classify an expected process without a healthy endpoint as starting;
9. reject a healthy endpoint whose validated listener does not belong to the same expected PID;
10. reuse a fully healthy matching process, creating a blank target only when the page count is zero;
11. launch only when no listener and no dedicated-profile Chrome exists.

- [ ] **Step 4: Implement actionable, non-sensitive failures**

Define `LauncherFailure: Error, Equatable, Sendable, LocalizedError` with cases for missing Chrome, lock timeout, unsafe profile reason, foreign listener, non-loopback listener, wrong-profile Chrome, profile conflict, readiness timeout with last endpoint failure, invalid WebSocket, launch failure, target creation failure, and activation failure.

Give each case a stable nonzero `exitCode: Int32` and actionable `errorDescription`. Conflict descriptions include this exact sentence:

```text
Chrome CDP did not terminate or replace another process.
```

Messages may include a PID, port, and profile path. They must not include full command lines, CDP target data, cookies, tokens, URLs visited, or profile contents.

- [ ] **Step 5: Run and commit the pure state machine**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ChromeCDPCoreTests
cd /Users/david.david/Personal/ai
git add chrome-cdp/Sources/ChromeCDPCore chrome-cdp/Tests/ChromeCDPCoreTests
git commit -m "feat: classify Chrome CDP launcher state"
```

Expected: every non-UI state passes without reading the filesystem, process table, or live port.

### Task 3: Add secure profile preparation and a crash-safe launch lock

**Files:**

- Modify: `chrome-cdp/Package.swift`
- Create: `chrome-cdp/Sources/ChromeCDPMac/ProfileGuard.swift`
- Create: `chrome-cdp/Sources/ChromeCDPMac/LaunchLock.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/ProfileGuardTests.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/LaunchLockTests.swift`

- [ ] **Step 1: Write temporary-directory profile tests**

First add the `ChromeCDPMac` library target and `ChromeCDPMacTests` test target to `Package.swift`. `ChromeCDPMac` depends on `ChromeCDPCore` and links AppKit and CoreServices; its tests depend on both libraries.

Cover these real filesystem outcomes:

- an absent profile is created under a temporarily applied `umask(0o077)`, then verified as a current-user directory with mode `0700`;
- a current-user directory at `0755` becomes `0700` while a child fixture's bytes and mode stay unchanged;
- an existing `0700` profile is unchanged;
- a symlink is rejected using `lstat`, and its target metadata is unchanged;
- a regular file is rejected;
- injected metadata with `st_uid != getuid()` maps to wrong-owner rejection without invoking `chmod`.

- [ ] **Step 2: Write real advisory-lock tests**

Use a temporary lock URL. Assert the first acquisition succeeds, a child process cannot acquire it before the bounded deadline, release allows a second child to acquire it, the file mode is `0600`, and termination of a lock-owning child releases the kernel lock without deleting or rewriting arbitrary paths.

- [ ] **Step 3: Run the tests and confirm missing implementations**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ProfileGuardTests
/usr/bin/swift test --filter LaunchLockTests
```

Expected: FAIL because `ProfileGuard` and `LaunchLock` do not exist.

- [ ] **Step 4: Implement the profile guard and `flock` lease**

Expose:

```swift
public struct ProfileGuard {
    public init(currentUID: uid_t = getuid())
    public func inspect(_ url: URL) throws -> ProfileObservation
    public func prepare(_ url: URL) throws
}

public final class LaunchLockLease {
    public func release()
}

public struct LaunchLock {
    public init(lockURL: URL)
    public func acquire(timeout: TimeInterval, pollInterval: TimeInterval) throws -> LaunchLockLease
}
```

Create the lock's parent directory at `0700`, reject a symlinked or wrong-owner parent, and open the stable lock file with `O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW` and mode `0600`. Verify the opened file with `fstat`, then use `flock(fd, LOCK_EX | LOCK_NB)` with monotonic deadline polling. Do not unlink the lock file. `release()` calls `flock(fd, LOCK_UN)` and `close(fd)` exactly once; `deinit` also releases an unreleased lease.

For profile creation, set `umask(0o077)`, call `mkdir(path, 0o700)`, restore the previous umask in `defer`, then `lstat` again. For repair, call `chmod` only on the directory path and re-inspect. Reject before mutation if the path is a symlink, wrong-owner, or non-directory.

- [ ] **Step 5: Run and commit filesystem safety**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ChromeCDPMacTests
cd /Users/david.david/Personal/ai
git add chrome-cdp/Sources/ChromeCDPMac chrome-cdp/Tests/ChromeCDPMacTests
git add chrome-cdp/Package.swift
git commit -m "feat: secure Chrome CDP profile and launch lock"
```

Expected: tests PASS and touch only their temporary directories.

### Task 4: Observe exact macOS processes, listeners, and CDP data

**Files:**

- Create: `chrome-cdp/Sources/ChromeCDPMac/ProcessInspector.swift`
- Create: `chrome-cdp/Sources/ChromeCDPMac/ListenerInspector.swift`
- Create: `chrome-cdp/Sources/ChromeCDPMac/CDPClient.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/ProcessInspectorTests.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/ListenerInspectorTests.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/CDPClientTests.swift`

- [ ] **Step 1: Write exact process-argument parser tests**

Build NUL-delimited `KERN_PROCARGS2` fixtures containing an executable path, argument count, spaces in the profile path, repeated flags, and Chrome subprocess flags. Assert that parsing returns an exact `[String]` argument vector and never tokenizes on whitespace.

- [ ] **Step 2: Write machine-readable `lsof` parser tests**

Use `-Fpn` fixture records for `127.0.0.1:9222`, `*:9222`, `[::1]:9222`, `[::]:9222`, two PIDs, and an unknown PID. Assert only the exact IPv4 loopback address is acceptable for the listener contract.

- [ ] **Step 3: Write CDP validation tests**

Test `/json/version` and `/json/list` fixtures for:

- `Browser` beginning with `Chrome/`, `ws://127.0.0.1:9222/devtools/browser/id`, and two page targets;
- missing or malformed JSON fields;
- a non-Chrome `Browser` value;
- non-WebSocket schemes;
- public, wildcard, `0.0.0.0`, and wrong-port WebSocket URLs;
- accepted loopback URL hosts `127.0.0.1`, `localhost`, and `::1` on the configured port;
- a malformed target list;
- zero page targets with non-page targets present.

- [ ] **Step 4: Run the focused tests and confirm failure**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ProcessInspectorTests
/usr/bin/swift test --filter ListenerInspectorTests
/usr/bin/swift test --filter CDPClientTests
```

Expected: FAIL because the observers do not exist.

- [ ] **Step 5: Implement fail-closed observation**

`ProcessInspector` obtains candidate PIDs from `/bin/ps -axo pid=` but obtains each candidate's exact executable and argument vector with `proc_pidpath` and `sysctl(KERN_PROCARGS2)`. Skip an exited/inaccessible PID; never infer arguments from formatted `ps` text.

`ListenerInspector` executes this fixed command through `Process`, without a shell:

```text
/usr/sbin/lsof -nP -a -iTCP:9222 -sTCP:LISTEN -Fpn
```

Build the port argument from the injected configuration in tests. A nonzero `lsof` exit with empty output means no listener; malformed nonempty records are an observation error, not Clean.

Expose a CDP client with an injected `URLSession` and fixed URL construction:

```swift
public protocol CDPServicing: Sendable {
    func inspect(configuration: LauncherConfiguration) async -> EndpointObservation
    func createBlankTarget(configuration: LauncherConfiguration) async throws
}
```

Use an ephemeral session with a per-request timeout below the 200 ms poll budget. Fetch only `/json/version`, `/json/list`, and `PUT /json/new?about:blank` from the fixed configured host and port. Validate the create response as a page target. Do not follow a debugger URL to another host.

- [ ] **Step 6: Run and commit observers**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ChromeCDPMacTests
cd /Users/david.david/Personal/ai
git add chrome-cdp/Sources/ChromeCDPMac chrome-cdp/Tests/ChromeCDPMacTests
git commit -m "feat: inspect Chrome CDP process and endpoint"
```

### Task 5: Implement testable launch orchestration

**Files:**

- Create: `chrome-cdp/Sources/ChromeCDPCore/LauncherProtocols.swift`
- Create: `chrome-cdp/Sources/ChromeCDPCore/LauncherRunner.swift`
- Create: `chrome-cdp/Tests/ChromeCDPCoreTests/LauncherRunnerTests.swift`

- [ ] **Step 1: Add the effect interfaces to the core**

Use these interfaces so runner tests need no macOS process or network effects:

```swift
public protocol LauncherClock: Sendable {
    var now: TimeInterval { get }
    func sleep(for interval: TimeInterval) async throws
}

public protocol LaunchLocking: Sendable {
    func acquire(timeout: TimeInterval, pollInterval: TimeInterval) throws -> any LaunchLockLeasing
}

public protocol LaunchLockLeasing: AnyObject, Sendable {
    func release()
}

public protocol LauncherSystem: Sendable {
    func chromeIsInstalled(configuration: LauncherConfiguration) -> Bool
    func prepareProfile(configuration: LauncherConfiguration) throws
    func snapshot(configuration: LauncherConfiguration) async throws -> SystemSnapshot
    func launchChrome(configuration: LauncherConfiguration) throws
    func createBlankTarget(configuration: LauncherConfiguration) async throws
    func activate(pid: Int32) throws
}

public enum LauncherOutcome: Equatable, Sendable {
    case launched(pid: Int32)
    case reused(pid: Int32)
}
```

- [ ] **Step 2: Write runner sequence tests with fakes**

Assert exact calls and outcomes for:

1. missing Chrome fails before profile preparation;
2. missing and repairable profiles are prepared once, re-observed, and never recursively modified;
3. Clean launches exactly once, then polls until ready;
4. Starting polls without a second launch;
5. Ready reuses without launch;
6. zero pages creates one blank target, while one or more pages creates none;
7. the validated PID alone is activated;
8. every conflict produces no launch, target creation, or activation;
9. a fixed starting state stops at the 10-second deadline and reports its last endpoint failure;
10. every path releases the lease exactly once;
11. a resolved lock wait is followed by a fresh snapshot and reuse;
12. lock timeout performs no browser or profile action.

Use a fake monotonic clock. Assert sleeps are 200 ms and total sleep never exceeds 10 seconds.

- [ ] **Step 3: Run and confirm runner failure**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter LauncherRunnerTests
```

Expected: FAIL because the protocols and runner do not exist.

- [ ] **Step 4: Implement the runner**

Expose:

```swift
public struct LauncherRunner {
    public init(
        configuration: LauncherConfiguration,
        classifier: LauncherClassifier,
        system: any LauncherSystem,
        lock: any LaunchLocking,
        clock: any LauncherClock
    )

    public func run() async throws -> LauncherOutcome
}
```

Acquire the lock first and release it with `defer`. Check Chrome existence before modifying the profile. Prepare and re-observe a missing or repairable profile. Launch only once for `.launch`. Poll `.waitForReadiness` until ready or the monotonic deadline. For `.reuse`, create and validate a blank target only when requested, activate the exact PID, and return `.launched` or `.reused` based on whether this invocation issued the launch.

- [ ] **Step 5: Run and commit orchestration**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ChromeCDPCoreTests
cd /Users/david.david/Personal/ai
git add chrome-cdp/Sources/ChromeCDPCore chrome-cdp/Tests/ChromeCDPCoreTests
git commit -m "feat: orchestrate Chrome CDP launch and reuse"
```

### Task 6: Wire the real macOS system and production helper

**Files:**

- Modify: `chrome-cdp/Package.swift`
- Create: `chrome-cdp/Sources/ChromeCDPMac/MacLauncherSystem.swift`
- Modify: `chrome-cdp/Sources/ChromeCDPMac/LaunchLock.swift`
- Modify: `chrome-cdp/Sources/ChromeCDPHelper/main.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/MacLauncherSystemTests.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/HelperContractTests.swift`

- [ ] **Step 1: Write command and activation contract tests**

Assert the launch executable is exactly `/usr/bin/open` and its argument array is exactly:

```swift
[
    "-na", "Google Chrome", "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--user-data-dir=\(configuration.profileURL.path)",
    "--no-first-run",
    "--no-default-browser-check"
]
```

Test an injected application activator receives only the classified PID. Test launch failure on a nonzero `/usr/bin/open` status. Test that `--version` and `--self-check` perform no profile, process, listener, HTTP, launch, target, or AppKit calls.

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter MacLauncherSystemTests
/usr/bin/swift test --filter HelperContractTests
```

Expected: FAIL because the adapter and final helper contract are incomplete.

- [ ] **Step 3: Implement the production adapter**

Update `ChromeCDPHelper` in `Package.swift` to depend on both `ChromeCDPCore` and `ChromeCDPMac`. Make `LaunchLock` and its lease conform to the core locking protocols.

`MacLauncherSystem` composes `ProfileGuard`, `ProcessInspector`, `ListenerInspector`, and `CDPServicing`. It verifies the fixed Chrome executable with `lstat`, rejects a symlinked app or executable, and requires executable permissions. It invokes `/usr/bin/open` through `Process` with the tested arguments and no shell.

Implement exact-PID activation as:

```swift
guard let application = NSRunningApplication(processIdentifier: pid) else {
    throw LauncherFailure.activationFailed(pid: pid)
}
let activated = application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
guard activated else {
    throw LauncherFailure.activationFailed(pid: pid)
}
```

Use `ProcessInfo.processInfo.systemUptime` for the production monotonic clock and `Task.sleep` for polling.

- [ ] **Step 4: Implement the production CLI contract**

Use an async `@main` entry point. Supported invocations are:

- no arguments: run the fixed production configuration;
- `--version`: print `chrome-cdp-helper 1.0.0` and exit zero without observations;
- `--self-check`: validate compiled constants and print one JSON object containing version, app name, profile suffix, host, port, timeout, and poll interval without observing live state;
- any other arguments: print a usage error to standard error and exit `64`.

On success print exactly one of:

```text
Chrome CDP ready — launched PID 90135.
Chrome CDP ready — reused PID 90135.
```

The number is the real outcome PID. On failure print only the localized actionable error to standard error and exit with its stable error code.

- [ ] **Step 5: Run and commit the production helper**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
/usr/bin/swift build -c release --product chrome-cdp-helper
./.build/release/chrome-cdp-helper --version
./.build/release/chrome-cdp-helper --self-check
cd /Users/david.david/Personal/ai
git add chrome-cdp/Package.swift chrome-cdp/Sources chrome-cdp/Tests
git commit -m "feat: wire Chrome CDP macOS helper"
```

Expected: PASS. Do not invoke the helper with no arguments in this task.

### Task 7: Add opt-in alternate-port integration coverage

**Files:**

- Modify: `chrome-cdp/Package.swift`
- Create: `chrome-cdp/Sources/ChromeCDPIntegrationHarness/main.swift`
- Create: `chrome-cdp/Tests/ChromeCDPIntegrationTests/ChromeCDPIntegrationTests.swift`

- [ ] **Step 1: Add a gated, unbundled integration harness**

Add an executable product `chrome-cdp-integration-harness` depending on Core and Mac. It refuses to run unless `CHROME_CDP_INTEGRATION_TEST` equals `1`. Only then may it accept `--profile`, `--port`, and `--lock` values and build a testing `LauncherConfiguration`. The production helper remains non-configurable, and the harness is never embedded or installed.

- [ ] **Step 2: Write opt-in integration tests**

Every test starts with:

```swift
try XCTSkipUnless(
    ProcessInfo.processInfo.environment["CHROME_CDP_RUN_INTEGRATION"] == "1"
)
```

Reserve an unused loopback port other than `9222`, create all profiles and locks below an XCTest temporary directory, record Chrome PIDs before the test, and clean up only exact Chrome PIDs whose argument vector contains that test's temporary profile.

Cover:

- cold headed launch, full readiness, loopback listener, Chrome `/json/version`, and mode `0700`;
- warm reuse with the same PID and no extra page when a page target exists;
- two concurrent harness processes yielding one Chrome owner and two successful outcomes;
- a temporary foreign TCP listener remaining alive after refusal;
- Chrome CDP on the test port with a different temporary profile;
- Chrome using the expected temporary profile without required CDP arguments;
- symlinked profile refusal with unchanged target;
- missing Chrome through an injected nonexistent application URL;
- normal Chrome PIDs and live port `9222` remaining unchanged.

Wrong-owner behavior and readiness timeout remain injected unit tests because they should not require root or leave a hung browser.

- [ ] **Step 3: Run the default suite and prove integration is skipped**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
```

Expected: PASS with the integration cases reported as skipped and no contact with port `9222`.

- [ ] **Step 4: Run the alternate-port integration suite**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
CHROME_CDP_RUN_INTEGRATION=1 CHROME_CDP_INTEGRATION_TEST=1 \
  /usr/bin/swift test --filter ChromeCDPIntegrationTests
```

Expected: PASS. Before accepting cleanup, compare the exact pre-test and post-test listener PID on `9222` and the normal-Chrome PID set.

- [ ] **Step 5: Commit integration coverage**

```bash
cd /Users/david.david/Personal/ai
git add chrome-cdp/Package.swift chrome-cdp/Sources/ChromeCDPIntegrationHarness chrome-cdp/Tests/ChromeCDPIntegrationTests
git commit -m "test: cover Chrome CDP integration states"
```

### Task 8: Build and strictly verify the Spotlight app bundle

**Files:**

- Create: `chrome-cdp/app/Chrome CDP.applescript`
- Create: `chrome-cdp/app/Info.plist`
- Create: `chrome-cdp/scripts/build.sh`
- Create: `chrome-cdp/scripts/verify.sh`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/AppBundleContractTests.swift`

- [ ] **Step 1: Write app-resource and script contract tests**

Assert the AppleScript contains lifecycle presentation only, resolves `Contents/Resources/chrome-cdp-helper` relative to `path to me`, shell-quotes that path, shows stdout as a success notification, and presents stderr as a critical failure alert. Assert it contains no port, profile, process, CDP, lock, or launch logic.

Assert `Info.plist` has:

```text
CFBundleDisplayName = Chrome CDP
CFBundleExecutable = applet
CFBundleIconFile = applet
CFBundleIdentifier = ai.daviddavid.chrome-cdp
CFBundleInfoDictionaryVersion = 6.0
CFBundleName = Chrome CDP
CFBundlePackageType = APPL
CFBundleSignature = aplt
CFBundleShortVersionString = 1.0.0
CFBundleVersion = 1
LSMinimumSystemVersion = 13.0
OSAAppletShowStartupScreen = false
```

Assert the scripts use fixed absolute system tool paths, create output through a temporary stage, embed the helper, ad-hoc sign the helper and bundle, strictly verify both, and never access the live CDP endpoint.

- [ ] **Step 2: Run and confirm the missing resources**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter AppBundleContractTests
```

Expected: FAIL because the app and scripts do not exist.

- [ ] **Step 3: Create the presentation-only AppleScript**

Use this behavior:

```applescript
on run
	set appPath to POSIX path of (path to me)
	set helperPath to appPath & "Contents/Resources/chrome-cdp-helper"
	try
		set resultText to do shell script quoted form of helperPath
		display notification resultText with title "Chrome CDP"
	on error errorMessage number errorNumber
		display alert "Chrome CDP could not start" message errorMessage as critical
	end try
end run
```

The deterministic plist may retain the generic `applet.icns` produced by `osacompile`; custom icon work stays deferred.

- [ ] **Step 4: Implement staged assembly and verification**

`build.sh` performs this exact sequence:

1. `set -euo pipefail`, resolve `PROJECT_ROOT`, and create a `mktemp -d` build stage;
2. `/usr/bin/swift build --package-path "$PROJECT_ROOT" -c release --product chrome-cdp-helper`;
3. `/usr/bin/osacompile -o "$STAGE/Chrome CDP.app" "$PROJECT_ROOT/app/Chrome CDP.applescript"`;
4. copy the deterministic plist and release helper into the compiled app;
5. set helper mode `0755`, sign the helper with `/usr/bin/codesign --force --sign -`, then sign the bundle with `/usr/bin/codesign --force --deep --sign -`;
6. run `verify.sh --app "$STAGE/Chrome CDP.app" --staged`;
7. replace only generated `dist/Chrome CDP.app` with the verified staged bundle.

`verify.sh` requires `--app` followed by an absolute bundle path and exactly one of `--staged` or `--installed`. Both modes check plist syntax and exact values, expected bundle files, embedded-helper mode, `--version`, `--self-check`, `osadecompile`, helper signature, bundle signature, and `Signature=adhoc`. Installed mode also runs `/usr/bin/mdimport` and polls `/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "ai.daviddavid.chrome-cdp"'` for up to 10 seconds. Neither mode runs the helper's no-argument lifecycle.

- [ ] **Step 5: Build, verify, and commit**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter AppBundleContractTests
/bin/chmod 0755 scripts/build.sh scripts/verify.sh
./scripts/build.sh
./scripts/verify.sh --app "$PWD/dist/Chrome CDP.app" --staged
cd /Users/david.david/Personal/ai
git add chrome-cdp/app chrome-cdp/scripts chrome-cdp/Tests/ChromeCDPMacTests/AppBundleContractTests.swift
git commit -m "build: assemble Chrome CDP Spotlight app"
```

Expected: staged verification PASS; `dist/` remains untracked.

### Task 9: Add verified backup, atomic installation, and rollback

**Files:**

- Modify: `chrome-cdp/Package.swift`
- Modify: `chrome-cdp/scripts/build.sh`
- Create: `chrome-cdp/Sources/ChromeCDPMac/AtomicBundleSwap.swift`
- Create: `chrome-cdp/Sources/ChromeCDPInstaller/main.swift`
- Create: `chrome-cdp/scripts/bundle-manifest.sh`
- Create: `chrome-cdp/scripts/install.sh`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/AtomicBundleSwapTests.swift`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/InstallScriptContractTests.swift`

- [ ] **Step 1: Write atomic-swap tests before installer code**

In a temporary directory, create `installed.app` and `staged.app` with distinct files and inodes. Assert `AtomicBundleSwap.publish(staged:installed:)` calls `renameatx_np` with both canonical paths and `RENAME_SWAP` when both exist, leaving new bytes at installed and old bytes at staged in one operation. Assert calling it again rolls back. When installed is absent, assert plain `rename` publishes staged. Reject symlinks, non-bundles, different parent directories, and paths outside the explicitly supplied parent.

- [ ] **Step 2: Write manifest and install-script contract tests**

Assert the manifest is deterministic, relative-path based, recursive, sorted under `LC_ALL=C`, and contains SHA-256 for every regular bundle file. Assert `install.sh`:

- builds and verifies before touching `/Applications`;
- captures UTC timestamp, recursive manifest, `codesign -dvvv`, strict verification output, and a complete `ditto --rsrc --extattr` backup;
- compares source and backup manifests before staging;
- stages only at `/Applications/.Chrome CDP.app.stage-12345`, with the real numeric process ID substituted for `12345`, after validating the prefix literally;
- invokes the native atomic installer rather than a two-step replacement;
- swaps back on installed verification failure;
- never contains `kill`, `pkill`, `killall`, `chmod -R`, a profile copy, browser launch, URL-handler mutation, or agent-browser startup.

- [ ] **Step 3: Run and confirm installer tests fail**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter AtomicBundleSwapTests
/usr/bin/swift test --filter InstallScriptContractTests
```

Expected: FAIL because atomic swap and scripts do not exist.

- [ ] **Step 4: Implement the native swap utility**

Add executable product `chrome-cdp-installer` backed by target `ChromeCDPInstaller` and depending on `ChromeCDPMac`. Update `build.sh` to build this product in release mode for installation tooling but never embed it in the app. Its only accepted form is:

```text
chrome-cdp-installer publish --staged /Applications/.Chrome CDP.app.stage-12345 --installed /Applications/Chrome CDP.app
```

Validate exact canonical parent paths and bundle suffixes before calling `AtomicBundleSwap`. Print a single success line; print a non-sensitive error and exit nonzero on failure. The utility does not copy, delete, sign, launch, or inspect browsers.

- [ ] **Step 5: Implement backup, installation, and rollback scripts**

`bundle-manifest.sh` accepts one absolute `.app` path, changes into that bundle, sorts relative regular-file paths, and emits `SHA256  relative/path` records.

`install.sh` resolves `WORKSPACE_ROOT` as the canonical parent of `PROJECT_ROOT` and fixes `BACKUP_ROOT` to `$WORKSPACE_ROOT/.local-backup/chrome-cdp`. `install.sh install` performs:

1. build and staged verification;
2. snapshot the full LaunchServices `LSHandlers` array with `/usr/bin/defaults export` plus `/usr/bin/plutil -extract LSHandlers xml1`, storing its SHA-256 in the backup evidence directory;
3. create root `.local-backup/chrome-cdp/YYYYMMDDTHHMMSSZ-PID/` at mode `0700`;
4. record installed timestamp, manifest, signature details, and strict-verification result;
5. copy the existing bundle with `/usr/bin/ditto --rsrc --extattr`, compare manifests, and strictly verify the backup;
6. copy the verified candidate to the validated `/Applications` sibling stage and strictly verify it there;
7. call `chrome-cdp-installer publish` to atomically swap candidate and installed bundles;
8. run installed verification; if it fails, atomically swap back and verify the restored app before exiting nonzero;
9. after success only, move the swapped-out old bundle from the sibling stage into the already verified backup directory;
10. recapture `LSHandlers`, require its SHA-256 to match baseline, and print the backup directory.

`install.sh rollback BACKUP_DIR` canonicalizes `BACKUP_DIR`, requires its verified `Chrome CDP.app`, stages it under `/Applications`, atomically swaps it with the installed bundle, verifies the result, swaps back on failure, and preserves the displaced current bundle in `BACKUP_DIR/rollback-displaced/`. Neither mode touches browser processes or profiles.

- [ ] **Step 6: Test only temporary paths, then commit**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter ChromeCDPMacTests
/bin/chmod 0755 scripts/bundle-manifest.sh scripts/install.sh
./scripts/build.sh
./scripts/verify.sh --app "$PWD/dist/Chrome CDP.app" --staged
cd /Users/david.david/Personal/ai
git add chrome-cdp/Package.swift chrome-cdp/Sources/ChromeCDPMac/AtomicBundleSwap.swift chrome-cdp/Sources/ChromeCDPInstaller chrome-cdp/scripts chrome-cdp/Tests/ChromeCDPMacTests
git commit -m "feat: install Chrome CDP app atomically"
```

Expected: all tests PASS; do not run `install.sh install` yet.

### Task 10: Finish operator documentation and root project discovery

**Files:**

- Modify: `chrome-cdp/README.md`
- Modify: `README.md`
- Create: `chrome-cdp/Tests/ChromeCDPMacTests/DocumentationContractTests.swift`

- [ ] **Step 1: Write documentation contract tests**

Assert the project README documents prerequisites, architecture, exact fixed production values, security decisions, build, default tests, opt-in integration tests, staged verification, install, backup discovery, rollback, warm-reuse validation, agent-browser attachment, and troubleshooting for each failure case. Assert it explicitly warns never to point automation at the live normal Chrome user-data root and distinguishes agent-browser's copied named-profile behavior from direct persistent profile paths.

Assert the root README adds this project without removing existing entries:

```markdown
- [`chrome-cdp`](chrome-cdp/): safe Spotlight launcher for a headed, dedicated-profile Chrome CDP session.
```

- [ ] **Step 2: Run and confirm documentation failure**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test --filter DocumentationContractTests
```

Expected: FAIL because the initial README is intentionally incomplete.

- [ ] **Step 3: Route the final README draft through Alan Wake**

Provide the verified commands and behavior to the required `alan_wake` specialist. Fact-check its output against code and scripts before applying it. Document rollback without a fake path by using:

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
backup_dir="$(/usr/bin/find ../.local-backup/chrome-cdp -mindepth 1 -maxdepth 1 -type d | /usr/bin/sort | /usr/bin/tail -1)"
./scripts/install.sh rollback "$backup_dir"
```

Document three isolated `agent-browser` sessions and `close` each session after inspection; closing an attached session must be verified not to terminate Chrome.

- [ ] **Step 4: Run docs and full default verification, then commit**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
./scripts/build.sh
./scripts/verify.sh --app "$PWD/dist/Chrome CDP.app" --staged
cd /Users/david.david/Personal/ai
git diff --check
git add chrome-cdp/README.md chrome-cdp/Tests/ChromeCDPMacTests/DocumentationContractTests.swift README.md
git commit -m "docs: document Chrome CDP launcher"
```

### Task 11: Complete pre-install verification and independent code review

**Files:**

- Create: `chrome-cdp/docs/review-2026-08-09.md`
- Modify only implementation files required by verified review findings.

- [ ] **Step 1: Run every non-live check from a clean task branch**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
CHROME_CDP_RUN_INTEGRATION=1 CHROME_CDP_INTEGRATION_TEST=1 \
  /usr/bin/swift test --filter ChromeCDPIntegrationTests
./scripts/build.sh
./scripts/verify.sh --app "$PWD/dist/Chrome CDP.app" --staged
cd /Users/david.david/Personal/ai
python3 scripts/plugins.py check
python3 bun-global-tools/sync.py check --deep
git diff --check
git status --short
```

Expected: all commands PASS. The plugin and Bun checks are repository-wide regression checks; this project does not change plugin or global-tool manifests.

- [ ] **Step 2: Request independent code review**

Use `superpowers:requesting-code-review`. Ask the reviewer to trace every design requirement, with special attention to classifier precedence, exact argument extraction, lock lifecycle, symlink/owner checks, CDP loopback checks, target creation, PID activation, atomic swap rollback, script path validation, and live-port isolation.

- [ ] **Step 3: Resolve findings test-first**

For each valid finding, add a failing regression test, implement the smallest correction, rerun its focused test, and rerun the full commands from Step 1. Do not change scope to URL routing, default browser behavior, dashboard startup, configuration UI, persistent logging, or custom icon work.

- [ ] **Step 4: Record and commit the verified review**

Route the concise human-facing review record through `alan_wake`, fact-check it, and write `chrome-cdp/docs/review-2026-08-09.md` with reviewed commit, scope, findings, resolutions, and rerun commands. If implementation changed, commit those tested fixes first:

```bash
cd /Users/david.david/Personal/ai
git add chrome-cdp README.md
git commit -m "fix: address Chrome CDP launcher review"
```

Then commit the review record:

```bash
cd /Users/david.david/Personal/ai
git add chrome-cdp/docs/review-2026-08-09.md
git commit -m "docs: record Chrome CDP launcher review"
```

### Task 12: Migrate the installed app and validate live warm reuse

**Files:**

- Create: `chrome-cdp/docs/validation-2026-08-09.md`

This task is the only one allowed to use live `127.0.0.1:9222`. It must preserve the already-running Chrome PID and user work.

- [ ] **Step 1: Capture pre-install invariants**

Create a timestamped evidence directory below root `.local-backup/chrome-cdp/`. Record, without browser page data or secrets:

```bash
evidence_dir="/Users/david.david/Personal/ai/.local-backup/chrome-cdp/preinstall-$(/bin/date -u +%Y%m%dT%H%M%SZ)-$$"
/bin/mkdir -p "$evidence_dir"
/bin/chmod 0700 "$evidence_dir"
/usr/sbin/lsof -nP -a -iTCP:9222 -sTCP:LISTEN -Fpn
/usr/bin/curl --fail --silent http://127.0.0.1:9222/json/version
/usr/bin/curl --fail --silent http://127.0.0.1:9222/json/list > "$evidence_dir/targets.json"
/usr/bin/grep -c '"type"[[:space:]]*:[[:space:]]*"page"' "$evidence_dir/targets.json"
/usr/bin/stat -f '%HT %Su %Sg %Lp %N' "$HOME/chrome-cdp-profile"
/bin/ps -axo pid=,command=
/usr/bin/defaults export com.apple.LaunchServices/com.apple.launchservices.secure "$evidence_dir/launchservices.plist"
/usr/bin/plutil -extract LSHandlers xml1 -o "$evidence_dir/handlers.xml" "$evidence_dir/launchservices.plist"
/usr/bin/shasum -a 256 "$evidence_dir/handlers.xml"
```

Redact `/json/version` to Browser version, protocol version, WebSocket host, and WebSocket port before recording it in the committed validation report. Record the baseline listener PID, existing page-target count, normal-Chrome PID set, profile metadata, strict signature result, and the fact that HTTP and HTTPS map to `company.thebrowser.dia`.

- [ ] **Step 2: Install without browser lifecycle changes**

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
./scripts/install.sh install
./scripts/verify.sh --app "/Applications/Chrome CDP.app" --installed
```

Expected: the installer prints its verified backup directory; the live `9222` listener PID and Chrome process command remain unchanged during installation.

- [ ] **Step 3: Validate Spotlight discovery and launch the installed app**

```bash
/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "ai.daviddavid.chrome-cdp"'
/usr/bin/open -b ai.daviddavid.chrome-cdp
```

Also open Spotlight interactively, enter `Chrome CDP`, confirm the installed app is the result, and launch it once. Expected: a success notification appears only after readiness, the existing dedicated Chrome window comes forward, the listener PID equals baseline, and no page target is added when a page already exists.

- [ ] **Step 4: Validate all three agent-browser attachment modes**

Use unique sessions so no existing agent-browser state is reused:

```bash
agent-browser --session chrome-cdp-verify-connect connect 9222 --json
agent-browser --session chrome-cdp-verify-connect snapshot -i --json
agent-browser --session chrome-cdp-verify-connect close --json

agent-browser --session chrome-cdp-verify-cdp --cdp 9222 snapshot -i --json
agent-browser --session chrome-cdp-verify-cdp close --json

agent-browser --session chrome-cdp-verify-auto --auto-connect snapshot -i --json
agent-browser --session chrome-cdp-verify-auto close --json
```

Expected: all inspections succeed. After every `close`, `/usr/sbin/lsof` still reports the baseline Chrome PID listening on `127.0.0.1:9222`.

- [ ] **Step 5: Recheck non-interference and signing**

Repeat the baseline process, listener, profile metadata, and LaunchServices captures. Require:

- the CDP listener is only `127.0.0.1:9222` and owned by the baseline PID;
- the WebSocket host is loopback and port is `9222`;
- the dedicated profile is a non-symlinked current-user directory at mode `0700`;
- normal Chrome PIDs are unchanged except for independently initiated user activity;
- the full `LSHandlers` XML hash matches baseline and HTTP/HTTPS remain Dia;
- staged, installed, and backup apps pass strict signature verification;
- Spotlight resolves the new stable bundle identifier;
- no credentials, visited URLs, target titles, or profile bytes appear in evidence.

- [ ] **Step 6: Write and fact-check the validation report**

Route the human-facing validation report through `alan_wake`, then fact-check every status against captured command output. Record command names, PASS/FAIL, backup directory basename, warm-reused PID, signing result, Spotlight result, agent-browser modes, and handler comparison. Do not record raw browser data.

- [ ] **Step 7: Run final verification and commit evidence**

Invoke `superpowers:verification-before-completion`, then run:

```bash
cd /Users/david.david/Personal/ai/chrome-cdp
/usr/bin/swift test
./scripts/verify.sh --app "$PWD/dist/Chrome CDP.app" --staged
./scripts/verify.sh --app "/Applications/Chrome CDP.app" --installed
cd /Users/david.david/Personal/ai
python3 scripts/plugins.py check
python3 bun-global-tools/sync.py check --deep
git diff --check
git status --short
git add chrome-cdp/docs/validation-2026-08-09.md
git commit -m "docs: validate Chrome CDP Spotlight launcher"
```

Expected: every check PASS, the installed app remains usable, the baseline Chrome PID remains alive, and the worktree is clean apart from ignored build and backup output.

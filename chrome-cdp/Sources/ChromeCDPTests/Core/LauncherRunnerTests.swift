import ChromeCDPCore
import ChromeCDPTestSupport
import Foundation

private enum LauncherRunnerTestError: Error, Equatable, Sendable {
    case effectFailure
    case expectedFailure
}

private enum FakeLockAcquisitionError: LaunchLockAcquisitionError, Equatable {
    case timeout
    case failure

    var isTimeout: Bool {
        self == .timeout
    }
}

private enum RunnerEvent: Equatable, Sendable {
    case acquire(timeout: TimeInterval, pollInterval: TimeInterval)
    case chromeIsInstalled
    case prepareProfile
    case snapshot
    case launchChrome
    case createBlankTarget
    case activate(Int32)
    case sleep(TimeInterval)
    case release
}

private final class RunnerEventRecorder: @unchecked Sendable {
    var events: [RunnerEvent] = []

    func record(_ event: RunnerEvent) {
        events.append(event)
    }
}

private final class FakeLaunchLease: LaunchLockLeasing, @unchecked Sendable {
    private let recorder: RunnerEventRecorder
    private(set) var releaseCount = 0

    init(recorder: RunnerEventRecorder) {
        self.recorder = recorder
    }

    func release() {
        releaseCount += 1
        recorder.record(.release)
    }
}

private enum FakeLockBehavior: Sendable {
    case acquire
    case timeout
    case fail
}

private final class FakeLaunchLock: LaunchLocking, @unchecked Sendable {
    let lease: FakeLaunchLease
    private let behavior: FakeLockBehavior
    private let recorder: RunnerEventRecorder

    init(behavior: FakeLockBehavior = .acquire, recorder: RunnerEventRecorder) {
        self.behavior = behavior
        self.recorder = recorder
        lease = FakeLaunchLease(recorder: recorder)
    }

    func acquire(timeout: TimeInterval, pollInterval: TimeInterval) throws -> any LaunchLockLeasing {
        recorder.record(.acquire(timeout: timeout, pollInterval: pollInterval))
        switch behavior {
        case .acquire:
            return lease
        case .timeout:
            throw FakeLockAcquisitionError.timeout
        case .fail:
            throw FakeLockAcquisitionError.failure
        }
    }
}

private final class FakeLauncherClock: LauncherClock, @unchecked Sendable {
    private let recorder: RunnerEventRecorder
    private var elapsedNanoseconds: Int64 = 0
    var sleepError: LauncherRunnerTestError?
    private(set) var sleeps: [TimeInterval] = []

    init(recorder: RunnerEventRecorder) {
        self.recorder = recorder
    }

    var now: TimeInterval {
        TimeInterval(elapsedNanoseconds) / 1_000_000_000
    }

    func sleep(for interval: TimeInterval) async throws {
        recorder.record(.sleep(interval))
        sleeps.append(interval)
        if let sleepError {
            throw sleepError
        }
        elapsedNanoseconds += Int64((interval * 1_000_000_000).rounded())
    }
}

private final class FakeLauncherSystem: LauncherSystem, @unchecked Sendable {
    var installed = true
    var snapshots: [SystemSnapshot]
    var repeatLastSnapshot = false
    var failingEvent: RunnerEvent?
    private let recorder: RunnerEventRecorder
    private var lastSnapshot: SystemSnapshot?

    init(snapshots: [SystemSnapshot], recorder: RunnerEventRecorder) {
        self.snapshots = snapshots
        self.recorder = recorder
    }

    func chromeIsInstalled(configuration: LauncherConfiguration) -> Bool {
        recorder.record(.chromeIsInstalled)
        return installed
    }

    func prepareProfile(configuration: LauncherConfiguration) throws {
        try perform(.prepareProfile)
    }

    func snapshot(configuration: LauncherConfiguration) async throws -> SystemSnapshot {
        try perform(.snapshot)
        if !snapshots.isEmpty {
            let snapshot = snapshots.removeFirst()
            lastSnapshot = snapshot
            return snapshot
        }
        if repeatLastSnapshot, let lastSnapshot {
            return lastSnapshot
        }
        throw LauncherRunnerTestError.effectFailure
    }

    func launchChrome(configuration: LauncherConfiguration) throws {
        try perform(.launchChrome)
    }

    func createBlankTarget(configuration: LauncherConfiguration) async throws {
        try perform(.createBlankTarget)
    }

    func activate(pid: Int32) throws {
        try perform(.activate(pid))
    }

    private func perform(_ event: RunnerEvent) throws {
        recorder.record(event)
        if failingEvent == event {
            throw LauncherRunnerTestError.effectFailure
        }
    }
}

private let runnerConfiguration = LauncherConfiguration.production(
    homeDirectory: URL(fileURLWithPath: "/tmp/chrome-cdp-launcher-runner-tests")
)

private func expectedProcess(pid: Int32) -> ProcessObservation {
    ProcessObservation(
        pid: pid,
        executablePath: runnerConfiguration.chromeExecutableURL.path,
        arguments: [
            "--user-data-dir=\(runnerConfiguration.profileURL.path)",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=9222",
            "--no-first-run",
            "--no-default-browser-check",
        ]
    )
}

private func snapshot(
    profile: ProfileObservation = .valid(mode: 0o700),
    processes: [ProcessObservation] = [],
    listeners: [ListenerBinding] = [],
    endpoint: EndpointObservation = .unavailable
) -> SystemSnapshot {
    SystemSnapshot(profile: profile, processes: processes, listeners: listeners, endpoint: endpoint)
}

private func startingSnapshot(pid: Int32, failure: EndpointFailure = .unavailable) -> SystemSnapshot {
    snapshot(
        processes: [expectedProcess(pid: pid)],
        listeners: [ListenerBinding(pid: pid, address: "127.0.0.1", port: 9222)],
        endpoint: failure == .unavailable ? .unavailable : .invalid(failure)
    )
}

private func readySnapshot(pid: Int32, pageCount: Int = 1) -> SystemSnapshot {
    snapshot(
        processes: [expectedProcess(pid: pid)],
        listeners: [ListenerBinding(pid: pid, address: "127.0.0.1", port: 9222)],
        endpoint: .healthy(
            webSocketURL: URL(string: "ws://127.0.0.1:9222/devtools/browser/test")!,
            pageTargetCount: pageCount
        )
    )
}

private func makeRunner(
    system: FakeLauncherSystem,
    lock: FakeLaunchLock,
    clock: FakeLauncherClock
) -> LauncherRunner {
    LauncherRunner(
        configuration: runnerConfiguration,
        classifier: LauncherClassifier(configuration: runnerConfiguration),
        system: system,
        lock: lock,
        clock: clock
    )
}

private func captureLauncherFailure(_ runner: LauncherRunner) throws -> LauncherFailure {
    try awaitValue {
        do {
            _ = try await runner.run()
            throw LauncherRunnerTestError.expectedFailure
        } catch let failure as LauncherFailure {
            return failure
        }
    }
}

func launcherRunnerMissingChromeStopsBeforeProfilePreparationTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(snapshots: [], recorder: recorder)
    system.installed = false

    let failure = try captureLauncherFailure(makeRunner(system: system, lock: lock, clock: clock))

    try expectEqual(failure, .missingChrome(applicationPath: runnerConfiguration.chromeApplicationURL.path))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2),
        .chromeIsInstalled,
        .release,
    ])
    try expectEqual(lock.lease.releaseCount, 1)
}

func launcherRunnerPreparesMissingProfileOnceAndResnapshotsTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [snapshot(profile: .missing), snapshot(), readySnapshot(pid: 101)],
        recorder: recorder
    )

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .launched(pid: 101))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .prepareProfile, .snapshot, .launchChrome, .sleep(0.2), .snapshot,
        .activate(101), .release,
    ])
}

func launcherRunnerRepairsProfileOnceAndResnapshotsTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [snapshot(profile: .valid(mode: 0o755)), readySnapshot(pid: 102)],
        recorder: recorder
    )

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .reused(pid: 102))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .prepareProfile, .snapshot, .activate(102), .release,
    ])
}

func launcherRunnerDoesNotPrepareProfileRecursivelyTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [snapshot(profile: .missing), snapshot(profile: .valid(mode: 0o755))],
        recorder: recorder
    )

    let failed = try awaitValue {
        do {
            _ = try await makeRunner(system: system, lock: lock, clock: clock).run()
            return false
        } catch {
            return true
        }
    }

    try expectEqual(failed, true)
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .prepareProfile, .snapshot, .release,
    ])
}

func launcherRunnerCleanStateLaunchesOnceThenPollsTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [snapshot(), snapshot(), readySnapshot(pid: 103)],
        recorder: recorder
    )

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .launched(pid: 103))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .launchChrome, .sleep(0.2), .snapshot, .sleep(0.2), .snapshot,
        .activate(103), .release,
    ])
}

func launcherRunnerStartingStatePollsWithoutLaunchingTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [startingSnapshot(pid: 104), snapshot(), readySnapshot(pid: 104)],
        recorder: recorder
    )

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .reused(pid: 104))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .sleep(0.2), .snapshot, .sleep(0.2), .snapshot, .activate(104), .release,
    ])
}

func launcherRunnerReadyStateReusesWithoutLaunchingTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(snapshots: [readySnapshot(pid: 105)], recorder: recorder)

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .reused(pid: 105))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .activate(105), .release,
    ])
}

func launcherRunnerBlankTargetOnlyForZeroPagesTest() throws {
    for (pageCount, expectedTargetCalls) in [(0, 1), (1, 0), (4, 0)] {
        let recorder = RunnerEventRecorder()
        let lock = FakeLaunchLock(recorder: recorder)
        let clock = FakeLauncherClock(recorder: recorder)
        let system = FakeLauncherSystem(
            snapshots: [readySnapshot(pid: Int32(200 + pageCount), pageCount: pageCount)],
            recorder: recorder
        )

        _ = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

        try expectEqual(recorder.events.filter { $0 == .createBlankTarget }.count, expectedTargetCalls)
        try expectEqual(lock.lease.releaseCount, 1)
    }
}

func launcherRunnerActivatesOnlyValidatedPIDTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [startingSnapshot(pid: 301), readySnapshot(pid: 302)],
        recorder: recorder
    )

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .reused(pid: 302))
    try expectEqual(recorder.events.filter {
        if case .activate = $0 { return true }
        return false
    }, [.activate(302)])
}

func launcherRunnerConflictsProduceNoBrowserEffectsTest() throws {
    let foreignProcess = ProcessObservation(pid: 401, executablePath: "/usr/bin/python3", arguments: [])
    let wrongProfileProcess = ProcessObservation(
        pid: 402,
        executablePath: runnerConfiguration.chromeExecutableURL.path,
        arguments: ["--user-data-dir=/tmp/wrong-profile"]
    )
    let conflicts: [SystemSnapshot] = [
        snapshot(profile: .symlink),
        snapshot(listeners: [ListenerBinding(pid: 401, address: "127.0.0.1", port: 9222)]),
        snapshot(listeners: [ListenerBinding(pid: 401, address: "0.0.0.0", port: 9222)]),
        snapshot(
            processes: [wrongProfileProcess],
            listeners: [ListenerBinding(pid: 402, address: "127.0.0.1", port: 9222)]
        ),
        snapshot(
            processes: [foreignProcess],
            listeners: [ListenerBinding(pid: 401, address: "127.0.0.1", port: 9222)]
        ),
        snapshot(
            processes: [expectedProcess(pid: 403)],
            listeners: [ListenerBinding(pid: 403, address: "127.0.0.1", port: 9222)],
            endpoint: .invalid(.invalidWebSocket)
        ),
    ]

    for conflict in conflicts {
        let recorder = RunnerEventRecorder()
        let lock = FakeLaunchLock(recorder: recorder)
        let clock = FakeLauncherClock(recorder: recorder)
        let system = FakeLauncherSystem(snapshots: [conflict], recorder: recorder)

        _ = try captureLauncherFailure(makeRunner(system: system, lock: lock, clock: clock))

        try expectEqual(recorder.events.contains(.launchChrome), false)
        try expectEqual(recorder.events.contains(.createBlankTarget), false)
        try expectEqual(recorder.events.contains {
            if case .activate = $0 { return true }
            return false
        }, false)
        try expectEqual(lock.lease.releaseCount, 1)
    }
}

func launcherRunnerReadinessUsesBoundedMonotonicDeadlineAndLastFailureTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(
        snapshots: [
            startingSnapshot(pid: 501, failure: .malformedVersion),
            startingSnapshot(pid: 501, failure: .nonChromeBrowser),
            startingSnapshot(pid: 501, failure: .malformedTargetList),
        ],
        recorder: recorder
    )
    system.repeatLastSnapshot = true

    let failure = try captureLauncherFailure(makeRunner(system: system, lock: lock, clock: clock))

    try expectEqual(failure, .readinessTimeout(lastFailure: .malformedTargetList))
    try expectEqual(clock.sleeps.count, 50)
    try expectEqual(clock.sleeps.dropLast().allSatisfy { $0 == 0.2 }, true)
    try expectEqual(clock.sleeps.last.map { $0 > 0 && $0 <= 0.2 }, true)
    let totalSleep = clock.sleeps.reduce(0, +)
    try expectEqual(totalSleep <= 10, true, "total readiness sleep must not exceed ten seconds")
    try expectEqual(totalSleep >= 9.999_999, true, "readiness polling must reach the ten-second deadline")
    try expectEqual(recorder.events.contains(.launchChrome), false)
    try expectEqual(lock.lease.releaseCount, 1)
}

func launcherRunnerReleasesLeaseOnEveryPostAcquireFailureTest() throws {
    let failingEvents: [RunnerEvent] = [.snapshot, .prepareProfile, .launchChrome, .createBlankTarget, .activate(601)]

    for failingEvent in failingEvents {
        let recorder = RunnerEventRecorder()
        let lock = FakeLaunchLock(recorder: recorder)
        let clock = FakeLauncherClock(recorder: recorder)
        let firstSnapshot: SystemSnapshot
        switch failingEvent {
        case .prepareProfile:
            firstSnapshot = snapshot(profile: .missing)
        case .launchChrome:
            firstSnapshot = snapshot()
        case .createBlankTarget:
            firstSnapshot = readySnapshot(pid: 601, pageCount: 0)
        case .activate:
            firstSnapshot = readySnapshot(pid: 601)
        default:
            firstSnapshot = snapshot()
        }
        let system = FakeLauncherSystem(snapshots: [firstSnapshot], recorder: recorder)
        system.failingEvent = failingEvent

        _ = try awaitValue {
            do {
                _ = try await makeRunner(system: system, lock: lock, clock: clock).run()
                throw LauncherRunnerTestError.expectedFailure
            } catch LauncherRunnerTestError.effectFailure {
                return true
            }
        }

        try expectEqual(lock.lease.releaseCount, 1)
    }

    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    clock.sleepError = .effectFailure
    let system = FakeLauncherSystem(snapshots: [startingSnapshot(pid: 601)], recorder: recorder)
    _ = try awaitValue {
        do {
            _ = try await makeRunner(system: system, lock: lock, clock: clock).run()
            throw LauncherRunnerTestError.expectedFailure
        } catch LauncherRunnerTestError.effectFailure {
            return true
        }
    }
    try expectEqual(lock.lease.releaseCount, 1)
}

func launcherRunnerResolvedLockWaitUsesFreshSnapshotTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(snapshots: [readySnapshot(pid: 701)], recorder: recorder)

    let outcome = try awaitValue { try await makeRunner(system: system, lock: lock, clock: clock).run() }

    try expectEqual(outcome, .reused(pid: 701))
    try expectEqual(recorder.events, [
        .acquire(timeout: 10, pollInterval: 0.2), .chromeIsInstalled, .snapshot,
        .activate(701), .release,
    ])
}

func launcherRunnerLockTimeoutMapsAndPerformsNoEffectsTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(behavior: .timeout, recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(snapshots: [], recorder: recorder)

    let failure = try captureLauncherFailure(makeRunner(system: system, lock: lock, clock: clock))

    try expectEqual(failure, .lockTimeout)
    try expectEqual(recorder.events, [.acquire(timeout: 10, pollInterval: 0.2)])
    try expectEqual(lock.lease.releaseCount, 0)
}

func launcherRunnerNonTimeoutLockFailurePropagatesWithoutEffectsTest() throws {
    let recorder = RunnerEventRecorder()
    let lock = FakeLaunchLock(behavior: .fail, recorder: recorder)
    let clock = FakeLauncherClock(recorder: recorder)
    let system = FakeLauncherSystem(snapshots: [], recorder: recorder)

    let error = try awaitValue {
        do {
            _ = try await makeRunner(system: system, lock: lock, clock: clock).run()
            throw LauncherRunnerTestError.expectedFailure
        } catch let error as FakeLockAcquisitionError {
            return error
        }
    }

    try expectEqual(error, .failure)
    try expectEqual(recorder.events, [.acquire(timeout: 10, pollInterval: 0.2)])
    try expectEqual(lock.lease.releaseCount, 0)
}

func launcherRunnerTests() throws {
    try launcherRunnerMissingChromeStopsBeforeProfilePreparationTest()
    try launcherRunnerPreparesMissingProfileOnceAndResnapshotsTest()
    try launcherRunnerRepairsProfileOnceAndResnapshotsTest()
    try launcherRunnerDoesNotPrepareProfileRecursivelyTest()
    try launcherRunnerCleanStateLaunchesOnceThenPollsTest()
    try launcherRunnerStartingStatePollsWithoutLaunchingTest()
    try launcherRunnerReadyStateReusesWithoutLaunchingTest()
    try launcherRunnerBlankTargetOnlyForZeroPagesTest()
    try launcherRunnerActivatesOnlyValidatedPIDTest()
    try launcherRunnerConflictsProduceNoBrowserEffectsTest()
    try launcherRunnerReadinessUsesBoundedMonotonicDeadlineAndLastFailureTest()
    try launcherRunnerReleasesLeaseOnEveryPostAcquireFailureTest()
    try launcherRunnerResolvedLockWaitUsesFreshSnapshotTest()
    try launcherRunnerLockTimeoutMapsAndPerformsNoEffectsTest()
    try launcherRunnerNonTimeoutLockFailurePropagatesWithoutEffectsTest()
}

func registerLauncherRunnerTests(_ runner: inout TestRunner) {
    runner.register("LauncherRunnerTests", launcherRunnerTests)
    runner.register("LauncherRunnerTests.MissingChromeStopsBeforeProfilePreparation", launcherRunnerMissingChromeStopsBeforeProfilePreparationTest)
    runner.register("LauncherRunnerTests.PreparesMissingProfileOnceAndResnapshots", launcherRunnerPreparesMissingProfileOnceAndResnapshotsTest)
    runner.register("LauncherRunnerTests.RepairsProfileOnceAndResnapshots", launcherRunnerRepairsProfileOnceAndResnapshotsTest)
    runner.register("LauncherRunnerTests.DoesNotPrepareProfileRecursively", launcherRunnerDoesNotPrepareProfileRecursivelyTest)
    runner.register("LauncherRunnerTests.CleanStateLaunchesOnceThenPolls", launcherRunnerCleanStateLaunchesOnceThenPollsTest)
    runner.register("LauncherRunnerTests.StartingStatePollsWithoutLaunching", launcherRunnerStartingStatePollsWithoutLaunchingTest)
    runner.register("LauncherRunnerTests.ReadyStateReusesWithoutLaunching", launcherRunnerReadyStateReusesWithoutLaunchingTest)
    runner.register("LauncherRunnerTests.BlankTargetOnlyForZeroPages", launcherRunnerBlankTargetOnlyForZeroPagesTest)
    runner.register("LauncherRunnerTests.ActivatesOnlyValidatedPID", launcherRunnerActivatesOnlyValidatedPIDTest)
    runner.register("LauncherRunnerTests.ConflictsProduceNoBrowserEffects", launcherRunnerConflictsProduceNoBrowserEffectsTest)
    runner.register("LauncherRunnerTests.ReadinessUsesBoundedMonotonicDeadlineAndLastFailure", launcherRunnerReadinessUsesBoundedMonotonicDeadlineAndLastFailureTest)
    runner.register("LauncherRunnerTests.ReleasesLeaseOnEveryPostAcquireFailure", launcherRunnerReleasesLeaseOnEveryPostAcquireFailureTest)
    runner.register("LauncherRunnerTests.ResolvedLockWaitUsesFreshSnapshot", launcherRunnerResolvedLockWaitUsesFreshSnapshotTest)
    runner.register("LauncherRunnerTests.LockTimeoutMapsAndPerformsNoEffects", launcherRunnerLockTimeoutMapsAndPerformsNoEffectsTest)
    runner.register("LauncherRunnerTests.NonTimeoutLockFailurePropagatesWithoutEffects", launcherRunnerNonTimeoutLockFailurePropagatesWithoutEffectsTest)
}

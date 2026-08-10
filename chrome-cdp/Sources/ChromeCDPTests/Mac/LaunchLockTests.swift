@_spi(Testing) import ChromeCDPMac
import ChromeCDPTestSupport
import Darwin
import Dispatch
import Foundation

private func lockMode(at url: URL) throws -> UInt16 {
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0 else {
        throw TestAssertionFailure("lstat failed for lock fixture: \(url.path)")
    }
    return UInt16(metadata.st_mode & 0o7777)
}

private func waitForChildStatus(_ statusURL: URL, process: Process, timeout: TimeInterval = 2) throws -> String {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if FileManager.default.fileExists(atPath: statusURL.path) {
            return try String(contentsOf: statusURL, encoding: .utf8)
        }
        if !process.isRunning {
            throw TestAssertionFailure("lock child exited before publishing a status")
        }
        usleep(5_000)
    }
    throw TestAssertionFailure("lock child did not publish status before deadline")
}

private func launchLockChild(action: String, lockURL: URL, statusURL: URL) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--launch-lock-child", action, lockURL.path, statusURL.path]
    try process.run()
    return process
}

private func launchLockRaceChild(lockURL: URL, statusURL: URL, gateURL: URL) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--launch-lock-race-child", lockURL.path, statusURL.path, gateURL.path]
    try process.run()
    return process
}

private func waitForChildStatus(
    _ statusURL: URL,
    process: Process,
    accepting expected: Set<String>,
    timeout: TimeInterval = 2
) throws -> String {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if FileManager.default.fileExists(atPath: statusURL.path) {
            let status = try String(contentsOf: statusURL, encoding: .utf8)
            if expected.contains(status) {
                return status
            }
            if status == "error" {
                throw TestAssertionFailure("lock child reported generic error")
            }
        }
        if !process.isRunning {
            throw TestAssertionFailure("lock child exited before publishing an expected status")
        }
        usleep(5_000)
    }
    throw TestAssertionFailure("lock child did not publish an expected status before deadline")
}

private func waitForChildExit(_ process: Process, timeout: TimeInterval = 2) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline {
        usleep(5_000)
    }
    guard !process.isRunning else {
        process.terminate()
        throw TestAssertionFailure("lock child did not exit before deadline")
    }
}

private func expectUnsafeLockRejection(_ expected: LaunchLockError, _ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch let error as LaunchLockError {
        switch (expected, error) {
        case (.unsafeParent, .unsafeParent), (.unsafeLockFile, .unsafeLockFile):
            return
        default:
            throw TestAssertionFailure("expected \(expected), got \(error)")
        }
    }
    throw TestAssertionFailure("expected unsafe launch-lock rejection")
}

private func expectLockTimeout(_ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch LaunchLockError.timeout {
        return
    } catch {
        throw TestAssertionFailure("expected launch-lock timeout, got \(error)")
    }
    throw TestAssertionFailure("expected launch-lock timeout")
}

private func expectStabilizationIdentityChange(_ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch LockEntryStabilizationError.identityChanged {
        return
    } catch {
        throw TestAssertionFailure("expected stabilization identity change, got \(error)")
    }
    throw TestAssertionFailure("expected stabilization identity change")
}

private let lockIdentityA = LockEntryIdentity(device: 1, inode: 10)
private let lockIdentityB = LockEntryIdentity(device: 1, inode: 20)

func launchLockStabilizationExistingEntryCannotFallBackToCreationTest() throws {
    var policy = LockEntryStabilizationPolicy()
    try expectEqual(try policy.observeExisting(lockIdentityA), .openExisting)

    try expectStabilizationIdentityChange { _ = try policy.observeAbsent() }
    try expectStabilizationIdentityChange { try policy.entryDisappeared() }
}

func launchLockStabilizationRejectsExistingIdentityTransitionTest() throws {
    var policy = LockEntryStabilizationPolicy()
    try expectEqual(try policy.observeExisting(lockIdentityA), .openExisting)

    try expectStabilizationIdentityChange { _ = try policy.observeExisting(lockIdentityB) }
}

func launchLockStabilizationLatchesPeerAfterCreationRaceTest() throws {
    var policy = LockEntryStabilizationPolicy()
    try expectEqual(try policy.observeAbsent(), .createIfAbsent)
    try policy.creationLostToPeer()

    try expectEqual(try policy.observeExisting(lockIdentityB), .openExisting)
    try policy.validateOpened(lockIdentityB)
}

func launchLockStabilizationRejectsLatchedPeerDisappearanceTest() throws {
    var policy = LockEntryStabilizationPolicy()
    try expectEqual(try policy.observeAbsent(), .createIfAbsent)
    try policy.creationLostToPeer()
    _ = try policy.observeExisting(lockIdentityB)

    try expectStabilizationIdentityChange { try policy.entryDisappeared() }
}

func launchLockCreatesPrivateLockAndExcludesChildTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("locks/launch.lock")
    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    defer { lease.release() }
    let statusURL = root.appendingPathComponent("contended-status")
    let child = try launchLockChild(action: "attempt", lockURL: lockURL, statusURL: statusURL)

    try expectEqual(try waitForChildStatus(statusURL, process: child), "timeout")
    try waitForChildExit(child)
    try expectEqual(try lockMode(at: lockURL), 0o600)
    try expectEqual(try lockMode(at: lockURL.deletingLastPathComponent()), 0o700)
}

func launchLockRepairsStickyBitOnParentDirectoryTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    guard chmod(parent.path, 0o1700) == 0 else {
        throw TestAssertionFailure("could not set sticky parent fixture mode")
    }
    let lockURL = parent.appendingPathComponent("launch.lock")

    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    defer { lease.release() }

    try expectEqual(try lockMode(at: parent), 0o700)
}

func launchLockRepairsSetgidBitOnParentDirectoryTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    guard chmod(parent.path, 0o2700) == 0 else {
        throw TestAssertionFailure("could not set setgid parent fixture mode")
    }
    let lockURL = parent.appendingPathComponent("launch.lock")

    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    defer { lease.release() }

    try expectEqual(try lockMode(at: parent), 0o700)
}

func launchLockNormalizesSpecialBitsOnExistingFileTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    let lockURL = parent.appendingPathComponent("launch.lock")
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    try "stable lock bytes".write(to: lockURL, atomically: true, encoding: .utf8)
    guard chmod(lockURL.path, 0o1600) == 0 else {
        throw TestAssertionFailure("could not set special-bit lock fixture mode")
    }

    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    defer { lease.release() }

    try expectEqual(try lockMode(at: lockURL), 0o600)
    try expectEqual(try String(contentsOf: lockURL, encoding: .utf8), "stable lock bytes")
}

private func launchLockRepairsInaccessibleParentModeTest(_ initialMode: mode_t) throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    guard chmod(parent.path, initialMode) == 0 else {
        throw TestAssertionFailure("could not set inaccessible launch-lock parent mode")
    }
    let lockURL = parent.appendingPathComponent("launch.lock")

    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    defer { lease.release() }

    try expectEqual(try lockMode(at: parent), 0o700)
}

func launchLockRepairsMode0000ParentDirectoryTest() throws {
    try launchLockRepairsInaccessibleParentModeTest(0o0000)
}

func launchLockRepairsMode0100ParentDirectoryTest() throws {
    try launchLockRepairsInaccessibleParentModeTest(0o0100)
}

func launchLockRepairsMode0300ParentDirectoryTest() throws {
    try launchLockRepairsInaccessibleParentModeTest(0o0300)
}

func launchLockRejectsSymlinkedParentWithoutChangingTargetTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let target = root.appendingPathComponent("target", isDirectory: true)
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
    guard chmod(target.path, 0o755) == 0, symlink(target.path, parent.path) == 0 else {
        throw TestAssertionFailure("could not make symlinked parent fixture")
    }
    let before = try lockMode(at: target)

    try expectUnsafeLockRejection(.unsafeParent) {
        _ = try LaunchLock(lockURL: parent.appendingPathComponent("launch.lock")).acquire(timeout: 0.1, pollInterval: 0.01)
    }

    try expectEqual(try lockMode(at: target), before)
}

func launchLockRejectsNonDirectoryParentTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks")
    try "not a directory".write(to: parent, atomically: true, encoding: .utf8)

    try expectUnsafeLockRejection(.unsafeParent) {
        _ = try LaunchLock(lockURL: parent.appendingPathComponent("launch.lock")).acquire(timeout: 0.1, pollInterval: 0.01)
    }

    try expectEqual(try String(contentsOf: parent, encoding: .utf8), "not a directory")
}

func launchLockRejectsSymlinkedLockFileWithoutChangingTargetTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    let target = root.appendingPathComponent("target")
    let lockURL = parent.appendingPathComponent("launch.lock")
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    try "do not rewrite".write(to: target, atomically: true, encoding: .utf8)
    guard symlink(target.path, lockURL.path) == 0 else {
        throw TestAssertionFailure("could not make symlinked lock fixture")
    }

    try expectUnsafeLockRejection(.unsafeLockFile) {
        _ = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.1, pollInterval: 0.01)
    }

    try expectEqual(try String(contentsOf: target, encoding: .utf8), "do not rewrite")
}

func launchLockRejectsNonRegularLockPathTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    let lockURL = parent.appendingPathComponent("launch.lock", isDirectory: true)
    try FileManager.default.createDirectory(at: lockURL, withIntermediateDirectories: true)

    try expectUnsafeLockRejection(.unsafeLockFile) {
        _ = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.1, pollInterval: 0.01)
    }
}

func launchLockRejectsHardLinkedLockFileTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    let target = root.appendingPathComponent("target")
    let lockURL = parent.appendingPathComponent("launch.lock")
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    try "do not mutate hard-link target".write(to: target, atomically: true, encoding: .utf8)
    guard link(target.path, lockURL.path) == 0 else {
        throw TestAssertionFailure("could not make hard-linked lock fixture")
    }

    try expectUnsafeLockRejection(.unsafeLockFile) {
        _ = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.1, pollInterval: 0.01)
    }

    try expectEqual(try String(contentsOf: target, encoding: .utf8), "do not mutate hard-link target")
}

func launchLockReleaseAllowsSecondChildToAcquireTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("locks/launch.lock")
    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    lease.release()
    let statusURL = root.appendingPathComponent("released-status")
    let child = try launchLockChild(action: "attempt", lockURL: lockURL, statusURL: statusURL)

    try expectEqual(try waitForChildStatus(statusURL, process: child), "acquired")
    try waitForChildExit(child)
}

func launchLockChildTerminationReleasesKernelLockWithoutChangingLockFileTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appendingPathComponent("locks", isDirectory: true)
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    let lockURL = parent.appendingPathComponent("launch.lock")
    try "do not rewrite".write(to: lockURL, atomically: true, encoding: .utf8)
    guard chmod(lockURL.path, 0o600) == 0 else {
        throw TestAssertionFailure("could not set lock fixture mode")
    }
    let readyURL = root.appendingPathComponent("ready-status")
    let child = try launchLockChild(action: "hold", lockURL: lockURL, statusURL: readyURL)
    defer {
        if child.isRunning { child.terminate() }
    }

    try expectEqual(try waitForChildStatus(readyURL, process: child), "acquired")
    try expectLockTimeout {
        _ = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.05, pollInterval: 0.01)
    }
    child.terminate()
    try waitForChildExit(child)
    _ = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)

    try expectEqual(try String(contentsOf: lockURL, encoding: .utf8), "do not rewrite")
    guard FileManager.default.fileExists(atPath: lockURL.path) else {
        throw TestAssertionFailure("lock child must not delete the stable lock file")
    }
}

func launchLockDoubleReleaseAllowsReacquisitionTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("locks/launch.lock")
    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    lease.release()
    lease.release()

    let nextLease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    nextLease.release()
}

func launchLockDeinitReleasesForReacquisitionTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("locks/launch.lock")
    var lease: LaunchLockLease? = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    withExtendedLifetime(lease) {}
    lease = nil

    let nextLease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    nextLease.release()
}

func launchLockConcurrentReleaseAllowsReacquisitionTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("locks/launch.lock")
    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)

    DispatchQueue.concurrentPerform(iterations: 16) { _ in
        lease.release()
    }

    let nextLease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    nextLease.release()
}

func launchLockCooperatesDuringSimultaneousFirstCreationTest() throws {
    for _ in 0..<8 {
        let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-race-")
        defer { try? FileManager.default.removeItem(at: root) }
        let lockURL = root.appendingPathComponent("locks/launch.lock")
        let gateURL = root.appendingPathComponent("gate")
        let firstStatus = root.appendingPathComponent("first-status")
        let secondStatus = root.appendingPathComponent("second-status")
        let first = try launchLockRaceChild(lockURL: lockURL, statusURL: firstStatus, gateURL: gateURL)
        let second = try launchLockRaceChild(lockURL: lockURL, statusURL: secondStatus, gateURL: gateURL)
        defer {
            if first.isRunning { first.terminate() }
            if second.isRunning { second.terminate() }
        }

        try expectEqual(try waitForChildStatus(firstStatus, process: first, accepting: ["ready"]), "ready")
        try expectEqual(try waitForChildStatus(secondStatus, process: second, accepting: ["ready"]), "ready")
        try "go".write(to: gateURL, atomically: true, encoding: .utf8)
        let firstOutcome = try waitForChildStatus(firstStatus, process: first, accepting: ["acquired", "timeout"])
        let secondOutcome = try waitForChildStatus(secondStatus, process: second, accepting: ["acquired", "timeout"])
        try expectEqual(Set([firstOutcome, secondOutcome]), Set(["acquired", "timeout"]))

        if first.isRunning { first.terminate() }
        if second.isRunning { second.terminate() }
        try waitForChildExit(first)
        try waitForChildExit(second)

        var metadata = stat()
        guard lstat(lockURL.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_ino != 0 else {
            throw TestAssertionFailure("simultaneous creation must leave one stable regular lock inode")
        }
        try expectEqual(try lockMode(at: lockURL), 0o600)
    }
}

func launchLockTests() throws {
    try launchLockStabilizationExistingEntryCannotFallBackToCreationTest()
    try launchLockStabilizationRejectsExistingIdentityTransitionTest()
    try launchLockStabilizationLatchesPeerAfterCreationRaceTest()
    try launchLockStabilizationRejectsLatchedPeerDisappearanceTest()
    try launchLockCreatesPrivateLockAndExcludesChildTest()
    try launchLockReleaseAllowsSecondChildToAcquireTest()
    try launchLockChildTerminationReleasesKernelLockWithoutChangingLockFileTest()
    try launchLockDoubleReleaseAllowsReacquisitionTest()
    try launchLockDeinitReleasesForReacquisitionTest()
    try launchLockConcurrentReleaseAllowsReacquisitionTest()
    try launchLockRepairsStickyBitOnParentDirectoryTest()
    try launchLockRepairsSetgidBitOnParentDirectoryTest()
    try launchLockNormalizesSpecialBitsOnExistingFileTest()
    try launchLockRepairsMode0000ParentDirectoryTest()
    try launchLockRepairsMode0100ParentDirectoryTest()
    try launchLockRepairsMode0300ParentDirectoryTest()
    try launchLockRejectsSymlinkedParentWithoutChangingTargetTest()
    try launchLockRejectsNonDirectoryParentTest()
    try launchLockRejectsSymlinkedLockFileWithoutChangingTargetTest()
    try launchLockRejectsNonRegularLockPathTest()
    try launchLockRejectsHardLinkedLockFileTest()
    try launchLockCooperatesDuringSimultaneousFirstCreationTest()
}

func registerLaunchLockTests(_ runner: inout TestRunner) {
    runner.register("LaunchLockTests", launchLockTests)
    runner.register("LaunchLockTests.StabilizationExistingEntryCannotFallBackToCreation", launchLockStabilizationExistingEntryCannotFallBackToCreationTest)
    runner.register("LaunchLockTests.StabilizationRejectsExistingIdentityTransition", launchLockStabilizationRejectsExistingIdentityTransitionTest)
    runner.register("LaunchLockTests.StabilizationLatchesPeerAfterCreationRace", launchLockStabilizationLatchesPeerAfterCreationRaceTest)
    runner.register("LaunchLockTests.StabilizationRejectsLatchedPeerDisappearance", launchLockStabilizationRejectsLatchedPeerDisappearanceTest)
    runner.register("LaunchLockTests.CreatesPrivateLockAndExcludesChild", launchLockCreatesPrivateLockAndExcludesChildTest)
    runner.register("LaunchLockTests.ReleaseAllowsSecondChildToAcquire", launchLockReleaseAllowsSecondChildToAcquireTest)
    runner.register("LaunchLockTests.ChildTerminationReleasesKernelLockWithoutChangingLockFile", launchLockChildTerminationReleasesKernelLockWithoutChangingLockFileTest)
    runner.register("LaunchLockTests.DoubleReleaseAllowsReacquisition", launchLockDoubleReleaseAllowsReacquisitionTest)
    runner.register("LaunchLockTests.DeinitReleasesForReacquisition", launchLockDeinitReleasesForReacquisitionTest)
    runner.register("LaunchLockTests.ConcurrentReleaseAllowsReacquisition", launchLockConcurrentReleaseAllowsReacquisitionTest)
    runner.register("LaunchLockTests.RepairsStickyBitOnParentDirectory", launchLockRepairsStickyBitOnParentDirectoryTest)
    runner.register("LaunchLockTests.RepairsSetgidBitOnParentDirectory", launchLockRepairsSetgidBitOnParentDirectoryTest)
    runner.register("LaunchLockTests.NormalizesSpecialBitsOnExistingFile", launchLockNormalizesSpecialBitsOnExistingFileTest)
    runner.register("LaunchLockTests.RepairsMode0000ParentDirectory", launchLockRepairsMode0000ParentDirectoryTest)
    runner.register("LaunchLockTests.RepairsMode0100ParentDirectory", launchLockRepairsMode0100ParentDirectoryTest)
    runner.register("LaunchLockTests.RepairsMode0300ParentDirectory", launchLockRepairsMode0300ParentDirectoryTest)
    runner.register("LaunchLockTests.RejectsSymlinkedParentWithoutChangingTarget", launchLockRejectsSymlinkedParentWithoutChangingTargetTest)
    runner.register("LaunchLockTests.RejectsNonDirectoryParent", launchLockRejectsNonDirectoryParentTest)
    runner.register("LaunchLockTests.RejectsSymlinkedLockFileWithoutChangingTarget", launchLockRejectsSymlinkedLockFileWithoutChangingTargetTest)
    runner.register("LaunchLockTests.RejectsNonRegularLockPath", launchLockRejectsNonRegularLockPathTest)
    runner.register("LaunchLockTests.RejectsHardLinkedLockFile", launchLockRejectsHardLinkedLockFileTest)
    runner.register("LaunchLockTests.CooperatesDuringSimultaneousFirstCreation", launchLockCooperatesDuringSimultaneousFirstCreationTest)
}

import ChromeCDPMac
import ChromeCDPTestSupport
import Darwin
import Foundation

private func lockMode(at url: URL) throws -> UInt16 {
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0 else {
        throw TestAssertionFailure("lstat failed for lock fixture: \(url.path)")
    }
    return UInt16(metadata.st_mode & 0o777)
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

func launchLockCreatesPrivateLockAndExcludesChildTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-launch-lock-")
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("locks/launch.lock")
    let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
    defer { lease.release() }
    let statusURL = root.appendingPathComponent("contended-status")
    let child = try launchLockChild(action: "attempt", lockURL: lockURL, statusURL: statusURL)

    try expectEqual(try waitForChildStatus(statusURL, process: child), "failed")
    try waitForChildExit(child)
    try expectEqual(try lockMode(at: lockURL), 0o600)
    try expectEqual(try lockMode(at: lockURL.deletingLastPathComponent()), 0o700)
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
    child.terminate()
    try waitForChildExit(child)
    _ = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)

    try expectEqual(try String(contentsOf: lockURL, encoding: .utf8), "do not rewrite")
    guard FileManager.default.fileExists(atPath: lockURL.path) else {
        throw TestAssertionFailure("lock child must not delete the stable lock file")
    }
}

func launchLockTests() throws {
    try launchLockCreatesPrivateLockAndExcludesChildTest()
    try launchLockReleaseAllowsSecondChildToAcquireTest()
    try launchLockChildTerminationReleasesKernelLockWithoutChangingLockFileTest()
    try launchLockRejectsSymlinkedParentWithoutChangingTargetTest()
    try launchLockRejectsSymlinkedLockFileWithoutChangingTargetTest()
    try launchLockRejectsNonRegularLockPathTest()
}

func registerLaunchLockTests(_ runner: inout TestRunner) {
    runner.register("LaunchLockTests", launchLockTests)
    runner.register("LaunchLockTests.CreatesPrivateLockAndExcludesChild", launchLockCreatesPrivateLockAndExcludesChildTest)
    runner.register("LaunchLockTests.ReleaseAllowsSecondChildToAcquire", launchLockReleaseAllowsSecondChildToAcquireTest)
    runner.register("LaunchLockTests.ChildTerminationReleasesKernelLockWithoutChangingLockFile", launchLockChildTerminationReleasesKernelLockWithoutChangingLockFileTest)
    runner.register("LaunchLockTests.RejectsSymlinkedParentWithoutChangingTarget", launchLockRejectsSymlinkedParentWithoutChangingTargetTest)
    runner.register("LaunchLockTests.RejectsSymlinkedLockFileWithoutChangingTarget", launchLockRejectsSymlinkedLockFileWithoutChangingTargetTest)
    runner.register("LaunchLockTests.RejectsNonRegularLockPath", launchLockRejectsNonRegularLockPathTest)
}

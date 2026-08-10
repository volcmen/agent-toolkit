import ChromeCDPCore
import ChromeCDPMac
import ChromeCDPTestSupport
import Darwin
import Foundation

private func profileMode(at url: URL) throws -> UInt16 {
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0 else {
        throw TestAssertionFailure("lstat failed for test fixture: \(url.path)")
    }
    return UInt16(metadata.st_mode & 0o7777)
}

private func expectProfileGuardRejection(_ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch let error as ProfileGuardError {
        guard error.isUnsafePath else {
            throw TestAssertionFailure("expected an unsafe-profile rejection, got \(error)")
        }
        return
    }
    throw TestAssertionFailure("expected ProfileGuard to reject unsafe test fixture")
}

func profileGuardCreatesMissingDirectoryWithPrivateModeTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile", isDirectory: true)

    try ProfileGuard().prepare(profile)

    try expectEqual(try ProfileGuard().inspect(profile), .valid(mode: 0o700))
    try expectEqual(try profileMode(at: profile), 0o700)
}

func profileGuardRepairsOnlyProfileDirectoryModeTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile", isDirectory: true)
    let child = profile.appendingPathComponent("child-fixture")
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
    try "child bytes".write(to: child, atomically: true, encoding: .utf8)
    guard chmod(profile.path, 0o755) == 0, chmod(child.path, 0o640) == 0 else {
        throw TestAssertionFailure("could not set test fixture modes")
    }

    try ProfileGuard().prepare(profile)

    try expectEqual(try profileMode(at: profile), 0o700)
    try expectEqual(try String(contentsOf: child), "child bytes")
    try expectEqual(try profileMode(at: child), 0o640)
}

func profileGuardLeavesPrivateDirectoryUnchangedTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile", isDirectory: true)
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
    guard chmod(profile.path, 0o700) == 0 else {
        throw TestAssertionFailure("could not set profile fixture mode")
    }
    let before = try profileMode(at: profile)

    try ProfileGuard().prepare(profile)

    try expectEqual(try profileMode(at: profile), before)
}

func profileGuardRepairsStickyBitOnPrivateDirectoryTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile", isDirectory: true)
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
    guard chmod(profile.path, 0o1700) == 0 else {
        throw TestAssertionFailure("could not set sticky profile fixture mode")
    }

    try ProfileGuard().prepare(profile)

    try expectEqual(try ProfileGuard().inspect(profile), .valid(mode: 0o700))
    try expectEqual(try profileMode(at: profile), 0o700)
}

func profileGuardRepairsSetgidBitOnPrivateDirectoryTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile", isDirectory: true)
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
    guard chmod(profile.path, 0o2700) == 0 else {
        throw TestAssertionFailure("could not set setgid profile fixture mode")
    }

    try ProfileGuard().prepare(profile)

    try expectEqual(try ProfileGuard().inspect(profile), .valid(mode: 0o700))
    try expectEqual(try profileMode(at: profile), 0o700)
}

func profileGuardRejectsSymlinkWithoutChangingTargetTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let target = root.appendingPathComponent("target", isDirectory: true)
    let profile = root.appendingPathComponent("profile", isDirectory: true)
    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
    guard chmod(target.path, 0o755) == 0, symlink(target.path, profile.path) == 0 else {
        throw TestAssertionFailure("could not make symlink fixture")
    }
    let before = try profileMode(at: target)

    try expectEqual(try ProfileGuard().inspect(profile), .symlink)
    try expectProfileGuardRejection { try ProfileGuard().prepare(profile) }

    try expectEqual(try profileMode(at: target), before)
}

func profileGuardRejectsRegularFileTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile")
    try "not a directory".write(to: profile, atomically: true, encoding: .utf8)

    try expectEqual(try ProfileGuard().inspect(profile), .notDirectory)
    try expectProfileGuardRejection { try ProfileGuard().prepare(profile) }
}

func profileGuardRejectsInjectedWrongOwnerWithoutModeRepairTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-profile-guard-")
    defer { try? FileManager.default.removeItem(at: root) }
    let profile = root.appendingPathComponent("profile", isDirectory: true)
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
    guard chmod(profile.path, 0o755) == 0 else {
        throw TestAssertionFailure("could not set profile fixture mode")
    }
    let injectedForeignUID: uid_t = getuid() == 0 ? 1 : 0
    let guardWithInjectedOwner = ProfileGuard(currentUID: injectedForeignUID)

    try expectEqual(try guardWithInjectedOwner.inspect(profile), ProfileObservation.wrongOwner(owner: UInt32(getuid())))
    try expectProfileGuardRejection { try guardWithInjectedOwner.prepare(profile) }

    try expectEqual(try profileMode(at: profile), 0o755)
}

func profileGuardTests() throws {
    try profileGuardCreatesMissingDirectoryWithPrivateModeTest()
    try profileGuardRepairsOnlyProfileDirectoryModeTest()
    try profileGuardLeavesPrivateDirectoryUnchangedTest()
    try profileGuardRepairsStickyBitOnPrivateDirectoryTest()
    try profileGuardRepairsSetgidBitOnPrivateDirectoryTest()
    try profileGuardRejectsSymlinkWithoutChangingTargetTest()
    try profileGuardRejectsRegularFileTest()
    try profileGuardRejectsInjectedWrongOwnerWithoutModeRepairTest()
}

func registerProfileGuardTests(_ runner: inout TestRunner) {
    runner.register("ProfileGuardTests", profileGuardTests)
    runner.register("ProfileGuardTests.CreatesMissingDirectoryWithPrivateMode", profileGuardCreatesMissingDirectoryWithPrivateModeTest)
    runner.register("ProfileGuardTests.RepairsOnlyProfileDirectoryMode", profileGuardRepairsOnlyProfileDirectoryModeTest)
    runner.register("ProfileGuardTests.LeavesPrivateDirectoryUnchanged", profileGuardLeavesPrivateDirectoryUnchangedTest)
    runner.register("ProfileGuardTests.RepairsStickyBitOnPrivateDirectory", profileGuardRepairsStickyBitOnPrivateDirectoryTest)
    runner.register("ProfileGuardTests.RepairsSetgidBitOnPrivateDirectory", profileGuardRepairsSetgidBitOnPrivateDirectoryTest)
    runner.register("ProfileGuardTests.RejectsSymlinkWithoutChangingTarget", profileGuardRejectsSymlinkWithoutChangingTargetTest)
    runner.register("ProfileGuardTests.RejectsRegularFile", profileGuardRejectsRegularFileTest)
    runner.register("ProfileGuardTests.RejectsInjectedWrongOwnerWithoutModeRepair", profileGuardRejectsInjectedWrongOwnerWithoutModeRepairTest)
}

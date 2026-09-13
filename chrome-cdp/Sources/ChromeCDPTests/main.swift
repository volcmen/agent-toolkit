import Darwin
import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

if CommandLine.arguments.dropFirst().first == "--launch-lock-child" {
    exit(runLaunchLockChild(arguments: Array(CommandLine.arguments.dropFirst(2))))
}
if CommandLine.arguments.dropFirst().first == "--launch-lock-race-child" {
    exit(runLaunchLockRaceChild(arguments: Array(CommandLine.arguments.dropFirst(2))))
}
if CommandLine.arguments.dropFirst().first == "--process-output-child" {
    exit(runProcessOutputChild(arguments: Array(CommandLine.arguments.dropFirst(2))))
}
if CommandLine.arguments.dropFirst().first == "--await-value-noncooperative-child" {
    exit(runAwaitValueNonCooperativeChild(arguments: Array(CommandLine.arguments.dropFirst(2))))
}

var runner = TestRunner()
registerLauncherConfigurationTests(&runner)
registerLauncherClassifierTests(&runner)
registerLauncherFailureTests(&runner)
registerLauncherRunnerTests(&runner)
registerProfileGuardTests(&runner)
registerLaunchLockTests(&runner)
registerProcessInspectorTests(&runner)
registerListenerInspectorTests(&runner)
registerCDPClientTests(&runner)
registerMacLauncherSystemTests(&runner)
registerHelperContractTests(&runner)
registerAppBundleBuildTests(&runner)
registerAtomicBundleSwapTests(&runner)
registerBundleManifestTests(&runner)
runner.register("ChromeCDPCoreTests") {
    try launcherConfigurationProductionTest()
    try launcherClassifierTests()
    try launcherFailureTests()
    try launcherRunnerTests()
}
runner.register("ChromeCDPMacTests") {
    try profileGuardTests()
    try launchLockTests()
    try processInspectorTests()
    try listenerInspectorTests()
    try cdpClientTests()
    try macLauncherSystemTests()
    try helperContractTests()
    try appBundleBuildTests()
    try atomicBundleSwapTests()
    try bundleManifestTests()
}
exit(Int32(runner.run(arguments: CommandLine.arguments)))

func runLaunchLockChild(arguments: [String]) -> Int32 {
    guard arguments.count == 3,
          let action = LaunchLockChildAction(rawValue: arguments[0]) else {
        FileHandle.standardError.write(Data("invalid launch-lock child arguments\n".utf8))
        return 2
    }

    let lockURL = URL(fileURLWithPath: arguments[1])
    let statusURL = URL(fileURLWithPath: arguments[2])
    do {
        let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.4, pollInterval: 0.01)
        try "acquired".write(to: statusURL, atomically: true, encoding: .utf8)
        if action == .hold {
            withExtendedLifetime(lease) {
                while true {
                    usleep(10_000)
                }
            }
        }
        lease.release()
        return 0
    } catch LaunchLockError.timeout {
        try? "timeout".write(to: statusURL, atomically: true, encoding: .utf8)
        return 1
    } catch {
        try? "error".write(to: statusURL, atomically: true, encoding: .utf8)
        return 1
    }
}

private enum LaunchLockChildAction: String {
    case attempt
    case hold
}

func runProcessOutputChild(arguments: [String]) -> Int32 {
    guard arguments.count == 1, let count = Int(arguments[0]), count > 0 else {
        return 2
    }
    let output = Data(repeating: 0x6F, count: count)
    FileHandle.standardOutput.write(output)
    FileHandle.standardError.write(output)
    return 0
}

func runAwaitValueNonCooperativeChild(arguments: [String]) -> Int32 {
    guard arguments.count == 1 else { return 2 }
    let laterTestMarker = URL(fileURLWithPath: arguments[0])
    var runner = TestRunner()
    runner.register("noncooperative") {
        let _: Int = try awaitValue(timeout: 0.01, cancellationGrace: 0.01) {
            await withUnsafeContinuation { (_: UnsafeContinuation<Int, Never>) in }
        }
    }
    runner.register("must-not-run") {
        try "ran".write(to: laterTestMarker, atomically: true, encoding: .utf8)
    }
    return Int32(runner.run(arguments: ["await-value-noncooperative-child"]))
}

func runLaunchLockRaceChild(arguments: [String]) -> Int32 {
    guard arguments.count == 3 else {
        return 2
    }
    let lockURL = URL(fileURLWithPath: arguments[0])
    let statusURL = URL(fileURLWithPath: arguments[1])
    let gateURL = URL(fileURLWithPath: arguments[2])
    do {
        try "ready".write(to: statusURL, atomically: true, encoding: .utf8)
        let deadline = Date().addingTimeInterval(2)
        while !FileManager.default.fileExists(atPath: gateURL.path), Date() < deadline {
            usleep(5_000)
        }
        guard FileManager.default.fileExists(atPath: gateURL.path) else {
            try "error".write(to: statusURL, atomically: true, encoding: .utf8)
            return 1
        }
        let lease = try LaunchLock(lockURL: lockURL).acquire(timeout: 0.2, pollInterval: 0.01)
        try "acquired".write(to: statusURL, atomically: true, encoding: .utf8)
        withExtendedLifetime(lease) {
            while true {
                usleep(10_000)
            }
        }
        return 0
    } catch LaunchLockError.timeout {
        try? "timeout".write(to: statusURL, atomically: true, encoding: .utf8)
        return 1
    } catch {
        try? "error".write(to: statusURL, atomically: true, encoding: .utf8)
        return 1
    }
}

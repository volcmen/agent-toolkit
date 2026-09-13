import ChromeCDPCore
@_spi(Testing) import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private final class MacSystemTestState: @unchecked Sendable {
    private let lock = NSLock()
    private var commandValue: (String, [String])?
    private var activatedPIDValue: Int32?

    func recordCommand(executable: URL, arguments: [String]) {
        lock.withLock { commandValue = (executable.path, arguments) }
    }

    func command() -> (String, [String])? {
        lock.withLock { commandValue }
    }

    func recordActivation(pid: Int32) {
        lock.withLock { activatedPIDValue = pid }
    }

    func activatedPID() -> Int32? {
        lock.withLock { activatedPIDValue }
    }
}

private enum MacSystemTestError: Error {
    case injected
}

private let macSystemConfiguration = LauncherConfiguration.production(
    homeDirectory: URL(fileURLWithPath: "/Users/tester", isDirectory: true)
)

private func makeMacSystem(
    state: MacSystemTestState = MacSystemTestState(),
    commandResult: Result<Int32, MacSystemTestError> = .success(0),
    inspectProfile: @escaping @Sendable (URL) throws -> ProfileObservation = { _ in .missing },
    prepareProfile: @escaping @Sendable (URL) throws -> Void = { _ in },
    inspectProcesses: @escaping @Sendable () throws -> [ProcessObservation] = { [] },
    inspectListeners: @escaping @Sendable (LauncherConfiguration) throws -> [ListenerBinding] = { _ in [] },
    inspectEndpoint: @escaping @Sendable (LauncherConfiguration) async -> EndpointObservation = { _ in .unavailable },
    createTarget: @escaping @Sendable (LauncherConfiguration) async throws -> Void = { _ in },
    validateInstallation: @escaping @Sendable (URL, URL) -> Bool = { _, _ in true },
    activateApplication: @escaping @Sendable (Int32) -> Bool = { _ in true }
) -> MacLauncherSystem {
    MacLauncherSystem(
        inspectProfile: inspectProfile,
        prepareProfile: prepareProfile,
        inspectProcesses: inspectProcesses,
        inspectListeners: inspectListeners,
        inspectEndpoint: inspectEndpoint,
        createTarget: createTarget,
        runCommand: { executable, arguments in
            state.recordCommand(executable: executable, arguments: arguments)
            return try commandResult.get()
        },
        validateInstallation: validateInstallation,
        activateApplication: { pid in
            state.recordActivation(pid: pid)
            return activateApplication(pid)
        }
    )
}

func macLauncherSystemUsesExactOpenCommandTest() throws {
    let state = MacSystemTestState()
    let system = makeMacSystem(state: state)

    try system.launchChrome(configuration: macSystemConfiguration)

    guard let command = state.command() else {
        throw TestAssertionFailure("launch must execute one command")
    }
    try expectEqual(command.0, "/usr/bin/open")
    try expectEqual(command.1, [
        "-na", "Google Chrome", "--args",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
}

func macLauncherSystemMapsNonzeroOpenStatusTest() throws {
    let system = makeMacSystem(commandResult: .success(17))

    do {
        try system.launchChrome(configuration: macSystemConfiguration)
        throw TestAssertionFailure("nonzero /usr/bin/open status must fail")
    } catch let failure as LauncherFailure {
        try expectEqual(failure, .launchFailed)
    }
}

func macLauncherSystemMapsThrownOpenFailureTest() throws {
    let system = makeMacSystem(commandResult: .failure(.injected))

    do {
        try system.launchChrome(configuration: macSystemConfiguration)
        throw TestAssertionFailure("a failure to execute /usr/bin/open must be stable")
    } catch let failure as LauncherFailure {
        try expectEqual(failure, .launchFailed)
    }
}

func macLauncherSystemActivatesOnlyExactPIDTest() throws {
    let state = MacSystemTestState()
    let system = makeMacSystem(state: state)

    try system.activate(pid: 90_135)

    try expectEqual(state.activatedPID(), 90_135)
}

func macLauncherSystemMapsActivationRefusalTest() throws {
    let system = makeMacSystem(activateApplication: { _ in false })

    do {
        try system.activate(pid: 44)
        throw TestAssertionFailure("activation refusal must fail")
    } catch let failure as LauncherFailure {
        try expectEqual(failure, .activationFailed(pid: 44))
    }
}

func macLauncherSystemComposesSnapshotTest() throws {
    let profile = ProfileObservation.valid(mode: 0o700)
    let processes = [ProcessObservation(pid: 71, executablePath: "/chrome", arguments: ["Chrome"])]
    let listeners = [ListenerBinding(pid: 71, address: "127.0.0.1", port: 9222)]
    let endpoint = EndpointObservation.healthy(
        webSocketURL: URL(string: "ws://127.0.0.1:9222/devtools/browser/id")!,
        pageTargetCount: 1
    )
    let system = makeMacSystem(
        inspectProfile: { _ in profile },
        inspectProcesses: { processes },
        inspectListeners: { _ in listeners },
        inspectEndpoint: { _ in endpoint }
    )

    let snapshot = try awaitValue {
        try await system.snapshot(configuration: macSystemConfiguration)
    }

    try expectEqual(snapshot, SystemSnapshot(
        profile: profile,
        processes: processes,
        listeners: listeners,
        endpoint: endpoint
    ))
}

private final class SnapshotStageRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stages: [String] = []

    func record(_ stage: String) {
        lock.withLock { stages.append(stage) }
    }

    func recorded() -> [String] {
        lock.withLock { stages }
    }
}

func macLauncherSystemSamplesListenersBeforeProcessesTest() throws {
    // Chrome that starts mid-snapshot must be observable as a process without a
    // listener (retryable) rather than a listener without a process (hard failure).
    let recorder = SnapshotStageRecorder()
    let system = makeMacSystem(
        inspectProfile: { _ in
            recorder.record("profile")
            return .valid(mode: 0o700)
        },
        inspectProcesses: {
            recorder.record("processes")
            return []
        },
        inspectListeners: { _ in
            recorder.record("listeners")
            return []
        }
    )

    let _: SystemSnapshot = try awaitValue {
        try await system.snapshot(configuration: macSystemConfiguration)
    }

    try expectEqual(recorder.recorded(), ["profile", "listeners", "processes"])
}

func macLauncherSystemMapsObservationErrorsTest() throws {
    let systems = [
        makeMacSystem(inspectProfile: { _ in throw MacSystemTestError.injected }),
        makeMacSystem(inspectProcesses: { throw MacSystemTestError.injected }),
        makeMacSystem(inspectListeners: { _ in throw MacSystemTestError.injected })
    ]

    for system in systems {
        do {
            let _: SystemSnapshot = try awaitValue {
                try await system.snapshot(configuration: macSystemConfiguration)
            }
            throw TestAssertionFailure("observation errors must be stable launcher failures")
        } catch let failure as LauncherFailure {
            try expectEqual(failure, .observationFailed)
        }
    }
}

func macLauncherSystemMapsTargetErrorsTest() throws {
    let system = makeMacSystem(createTarget: { _ in throw MacSystemTestError.injected })

    do {
        let _: Void = try awaitValue {
            try await system.createBlankTarget(configuration: macSystemConfiguration)
        }
        throw TestAssertionFailure("target creation errors must be stable launcher failures")
    } catch let failure as LauncherFailure {
        try expectEqual(failure, .targetCreationFailed)
    }
}

func macLauncherSystemPropagatesTargetCancellationTest() throws {
    let targetStarted = DispatchSemaphore(value: 0)
    let system = makeMacSystem(createTarget: { _ in
        targetStarted.signal()
        try await Task.sleep(for: .seconds(60))
    })
    let task = Task {
        try await system.createBlankTarget(configuration: macSystemConfiguration)
    }
    guard targetStarted.wait(timeout: .now() + 0.5) == .success else {
        task.cancel()
        throw TestAssertionFailure("blank-target effect did not start")
    }
    task.cancel()

    let propagated = try awaitValue {
        do {
            try await task.value
            return false
        } catch is CancellationError {
            return true
        }
    }
    try expectEqual(propagated, true)
}

func macLauncherSystemMapsUnsafeProfilePreparationTest() throws {
    let system = makeMacSystem(
        prepareProfile: { _ in throw ProfileGuardError.unsafePath(.symlink) }
    )

    do {
        try system.prepareProfile(configuration: macSystemConfiguration)
        throw TestAssertionFailure("unsafe profile errors must preserve their actionable reason")
    } catch let failure as LauncherFailure {
        try expectEqual(failure, .unsafeProfile(.symlink))
    }
}

func macLauncherSystemMapsOtherProfilePreparationErrorsTest() throws {
    let system = makeMacSystem(prepareProfile: { _ in throw MacSystemTestError.injected })

    do {
        try system.prepareProfile(configuration: macSystemConfiguration)
        throw TestAssertionFailure("profile preparation errors must be stable launcher failures")
    } catch let failure as LauncherFailure {
        try expectEqual(failure, .profilePreparationFailed)
    }
}

func macLauncherSystemValidatesAppAndExecutableWithoutFollowingLinksTest() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let realApp = directory.appendingPathComponent("Real Chrome.app", isDirectory: true)
    let realExecutable = realApp.appendingPathComponent("Contents/MacOS/Google Chrome")
    try FileManager.default.createDirectory(
        at: realExecutable.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try Data("#!/bin/sh\n".utf8).write(to: realExecutable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: realExecutable.path)

    guard MacLauncherSystem.validateChromeInstallation(
        applicationURL: realApp,
        executableURL: realExecutable
    ) else {
        throw TestAssertionFailure("a real application directory with an executable must validate")
    }

    let outsideExecutable = directory.appendingPathComponent("Outside Chrome")
    try Data("#!/bin/sh\n".utf8).write(to: outsideExecutable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: outsideExecutable.path)
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: realApp,
        executableURL: outsideExecutable
    ) else {
        throw TestAssertionFailure("the executable must be a relative descendant of the application")
    }

    let regularApp = directory.appendingPathComponent("Not An App")
    try Data().write(to: regularApp)
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: regularApp,
        executableURL: realExecutable
    ) else {
        throw TestAssertionFailure("an application path that is not a directory must be rejected")
    }

    let executableDirectory = realApp.appendingPathComponent("Contents/MacOS/Executable Directory")
    try FileManager.default.createDirectory(at: executableDirectory, withIntermediateDirectories: false)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executableDirectory.path)
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: realApp,
        executableURL: executableDirectory
    ) else {
        throw TestAssertionFailure("an executable path that is not a regular file must be rejected")
    }

    let linkedApp = directory.appendingPathComponent("Linked Chrome.app")
    try FileManager.default.createSymbolicLink(at: linkedApp, withDestinationURL: realApp)
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: linkedApp,
        executableURL: linkedApp.appendingPathComponent("Contents/MacOS/Google Chrome")
    ) else {
        throw TestAssertionFailure("a symlinked application must be rejected")
    }

    let linkedContentsApp = directory.appendingPathComponent("Linked Contents.app", isDirectory: true)
    try FileManager.default.createDirectory(at: linkedContentsApp, withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(
        at: linkedContentsApp.appendingPathComponent("Contents"),
        withDestinationURL: realApp.appendingPathComponent("Contents")
    )
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: linkedContentsApp,
        executableURL: linkedContentsApp.appendingPathComponent("Contents/MacOS/Google Chrome")
    ) else {
        throw TestAssertionFailure("a symlinked Contents directory must be rejected")
    }

    let linkedMacOSApp = directory.appendingPathComponent("Linked MacOS.app", isDirectory: true)
    let linkedMacOSContents = linkedMacOSApp.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: linkedMacOSContents, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
        at: linkedMacOSContents.appendingPathComponent("MacOS"),
        withDestinationURL: realApp.appendingPathComponent("Contents/MacOS")
    )
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: linkedMacOSApp,
        executableURL: linkedMacOSApp.appendingPathComponent("Contents/MacOS/Google Chrome")
    ) else {
        throw TestAssertionFailure("a symlinked MacOS directory must be rejected")
    }

    let linkedExecutable = realApp.appendingPathComponent("Contents/MacOS/Linked Chrome")
    try FileManager.default.createSymbolicLink(at: linkedExecutable, withDestinationURL: realExecutable)
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: realApp,
        executableURL: linkedExecutable
    ) else {
        throw TestAssertionFailure("a symlinked executable must be rejected")
    }

    for insufficientMode in [0o010, 0o001] {
        try FileManager.default.setAttributes([.posixPermissions: insufficientMode], ofItemAtPath: realExecutable.path)
        guard !MacLauncherSystem.validateChromeInstallation(
            applicationURL: realApp,
            executableURL: realExecutable
        ) else {
            throw TestAssertionFailure("the effective owner's execute bit must control permission")
        }
    }

    try FileManager.default.setAttributes([.posixPermissions: 0o100], ofItemAtPath: realExecutable.path)
    guard MacLauncherSystem.validateChromeInstallation(
        applicationURL: realApp,
        executableURL: realExecutable
    ) else {
        throw TestAssertionFailure("an owner-executable regular file must validate")
    }

    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: realExecutable.path)
    guard !MacLauncherSystem.validateChromeInstallation(
        applicationURL: realApp,
        executableURL: realExecutable
    ) else {
        throw TestAssertionFailure("a non-executable Chrome binary must be rejected")
    }
}

func launchLockConformsToCoreProtocolsTest() throws {
    func acceptLock(_: any LaunchLocking) {}
    func acceptLease(_: any LaunchLockLeasing) {}
    func acceptError(_: any LaunchLockAcquisitionError) {}

    let lock = LaunchLockAdapter(lockURL: URL(fileURLWithPath: "/tmp/unused-chrome-cdp-test.lock"))
    acceptLock(lock)
    acceptError(LaunchLockError.timeout)
    try expectEqual(LaunchLockError.timeout.isTimeout, true)
    try expectEqual(LaunchLockError.unsafeLockFile.isTimeout, false)

    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let lease = try LaunchLock(lockURL: directory.appendingPathComponent("launch.lock"))
        .acquire(timeout: 0, pollInterval: 0.01)
    acceptLease(lease)
    lease.release()
}

func macLauncherSystemTests() throws {
    try macLauncherSystemUsesExactOpenCommandTest()
    try macLauncherSystemMapsNonzeroOpenStatusTest()
    try macLauncherSystemMapsThrownOpenFailureTest()
    try macLauncherSystemActivatesOnlyExactPIDTest()
    try macLauncherSystemMapsActivationRefusalTest()
    try macLauncherSystemComposesSnapshotTest()
    try macLauncherSystemSamplesListenersBeforeProcessesTest()
    try macLauncherSystemMapsObservationErrorsTest()
    try macLauncherSystemMapsTargetErrorsTest()
    try macLauncherSystemPropagatesTargetCancellationTest()
    try macLauncherSystemMapsUnsafeProfilePreparationTest()
    try macLauncherSystemMapsOtherProfilePreparationErrorsTest()
    try macLauncherSystemValidatesAppAndExecutableWithoutFollowingLinksTest()
    try launchLockConformsToCoreProtocolsTest()
}

func registerMacLauncherSystemTests(_ runner: inout TestRunner) {
    runner.register("MacLauncherSystemTests", macLauncherSystemTests)
    runner.register("MacLauncherSystemTests.UsesExactOpenCommand", macLauncherSystemUsesExactOpenCommandTest)
    runner.register("MacLauncherSystemTests.MapsNonzeroOpenStatus", macLauncherSystemMapsNonzeroOpenStatusTest)
    runner.register("MacLauncherSystemTests.MapsThrownOpenFailure", macLauncherSystemMapsThrownOpenFailureTest)
    runner.register("MacLauncherSystemTests.ActivatesOnlyExactPID", macLauncherSystemActivatesOnlyExactPIDTest)
    runner.register("MacLauncherSystemTests.MapsActivationRefusal", macLauncherSystemMapsActivationRefusalTest)
    runner.register("MacLauncherSystemTests.ComposesSnapshot", macLauncherSystemComposesSnapshotTest)
    runner.register("MacLauncherSystemTests.SamplesListenersBeforeProcesses", macLauncherSystemSamplesListenersBeforeProcessesTest)
runner.register("MacLauncherSystemTests.MapsObservationErrors", macLauncherSystemMapsObservationErrorsTest)
    runner.register("MacLauncherSystemTests.MapsTargetErrors", macLauncherSystemMapsTargetErrorsTest)
    runner.register("MacLauncherSystemTests.PropagatesTargetCancellation", macLauncherSystemPropagatesTargetCancellationTest)
    runner.register("MacLauncherSystemTests.MapsUnsafeProfilePreparation", macLauncherSystemMapsUnsafeProfilePreparationTest)
    runner.register("MacLauncherSystemTests.MapsOtherProfilePreparationErrors", macLauncherSystemMapsOtherProfilePreparationErrorsTest)
    runner.register("MacLauncherSystemTests.ValidatesAppAndExecutableWithoutFollowingLinks", macLauncherSystemValidatesAppAndExecutableWithoutFollowingLinksTest)
    runner.register("MacLauncherSystemTests.LaunchLockConformsToCoreProtocols", launchLockConformsToCoreProtocolsTest)
}

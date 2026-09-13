@_spi(Testing) import ChromeCDPCore
@_spi(Testing) import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private let helperHomeDirectory = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
private let baseHelperConfiguration = LauncherConfiguration.production(homeDirectory: helperHomeDirectory)

private func helperConfiguration(
    profileURL: URL = baseHelperConfiguration.profileURL,
    lockTimeout: TimeInterval = baseHelperConfiguration.lockTimeout,
    lockURL: URL = baseHelperConfiguration.lockURL
) -> LauncherConfiguration {
    LauncherConfiguration(
        chromeApplicationURL: baseHelperConfiguration.chromeApplicationURL,
        chromeExecutableURL: baseHelperConfiguration.chromeExecutableURL,
        profileURL: profileURL,
        host: baseHelperConfiguration.host,
        port: baseHelperConfiguration.port,
        readinessTimeout: baseHelperConfiguration.readinessTimeout,
        pollInterval: baseHelperConfiguration.pollInterval,
        lockTimeout: lockTimeout,
        lockURL: lockURL
    )
}

private final class HelperTestState: @unchecked Sendable {
    private let lock = NSLock()
    private var invocationCountValue = 0
    private var outputValue: [String] = []
    private var errorValue: [String] = []

    func recordInvocation() {
        lock.withLock { invocationCountValue += 1 }
    }

    func recordOutput(_ text: String) {
        lock.withLock { outputValue.append(text) }
    }

    func recordError(_ text: String) {
        lock.withLock { errorValue.append(text) }
    }

    func invocationCount() -> Int { lock.withLock { invocationCountValue } }
    func output() -> [String] { lock.withLock { outputValue } }
    func errors() -> [String] { lock.withLock { errorValue } }
}

private func runHelper(
    arguments: [String],
    configuration: LauncherConfiguration = baseHelperConfiguration,
    expectedHomeDirectory: URL = helperHomeDirectory,
    result: @escaping @Sendable () async throws -> LauncherOutcome = { .reused(pid: 90_135) }
) throws -> (Int32, HelperTestState) {
    let state = HelperTestState()
    let runner = HelperCommandRunner(
        configuration: configuration,
        expectedHomeDirectory: expectedHomeDirectory,
        runLauncher: {
            state.recordInvocation()
            return try await result()
        },
        writeStandardOutput: { state.recordOutput($0) },
        writeStandardError: { state.recordError($0) }
    )
    let status: Int32 = try awaitValue {
        await runner.run(arguments: arguments)
    }
    return (status, state)
}

func helperVersionHasNoLauncherEffectsTest() throws {
    let (status, state) = try runHelper(arguments: ["--version"])

    try expectEqual(status, 0)
    try expectEqual(state.invocationCount(), 0)
    try expectEqual(state.output(), ["chrome-cdp-helper 1.0.0\n"])
    try expectEqual(state.errors(), [])
}

func helperSelfCheckIsStableJSONAndHasNoLauncherEffectsTest() throws {
    let (status, state) = try runHelper(arguments: ["--self-check"])

    try expectEqual(status, 0)
    try expectEqual(state.invocationCount(), 0)
    try expectEqual(state.errors(), [])
    try expectEqual(
        state.output(),
        [#"{"appName":"Google Chrome","host":"127.0.0.1","pollInterval":0.2,"port":9222,"profileSuffix":"chrome-cdp-profile","timeout":10,"version":"1.0.0"}"# + "\n"]
    )
}

func helperSelfCheckRejectsAnyNonProductionPathOrLockValueTest() throws {
    let invalidConfigurations = [
        helperConfiguration(profileURL: URL(fileURLWithPath: "/Users/other/chrome-cdp-profile")),
        helperConfiguration(profileURL: URL(fileURLWithPath: "/Users/tester/other-profile")),
        helperConfiguration(lockURL: URL(fileURLWithPath: "/Users/tester/Library/Caches/other.lock")),
        helperConfiguration(lockTimeout: 9)
    ]

    for configuration in invalidConfigurations {
        let (status, state) = try runHelper(arguments: ["--self-check"], configuration: configuration)
        try expectEqual(status, 24)
        try expectEqual(state.invocationCount(), 0)
        try expectEqual(state.output(), [])
        try expectEqual(state.errors(), ["Chrome CDP helper configuration is invalid.\n"])
    }
}

func helperUnknownArgumentsExitWithUsageTest() throws {
    let (status, state) = try runHelper(arguments: ["--unknown"])

    try expectEqual(status, 64)
    try expectEqual(state.invocationCount(), 0)
    try expectEqual(state.output(), [])
    guard state.errors().count == 1, state.errors()[0].hasPrefix("usage:") else {
        throw TestAssertionFailure("unknown arguments must print one usage error")
    }
}

func helperNoArgumentsPrintsLaunchedOutcomeTest() throws {
    let (status, state) = try runHelper(arguments: [], result: { .launched(pid: 90135) })

    try expectEqual(status, 0)
    try expectEqual(state.invocationCount(), 1)
    try expectEqual(state.output(), ["Chrome CDP ready — launched PID 90135.\n"])
    try expectEqual(state.errors(), [])
}

func helperNoArgumentsPrintsReusedOutcomeTest() throws {
    let (status, state) = try runHelper(arguments: [], result: { .reused(pid: 47) })

    try expectEqual(status, 0)
    try expectEqual(state.invocationCount(), 1)
    try expectEqual(state.output(), ["Chrome CDP ready — reused PID 47.\n"])
    try expectEqual(state.errors(), [])
}

func helperNoArgumentsPrintsOnlyActionableFailureTest() throws {
    let failure = LauncherFailure.activationFailed(pid: 44)
    let (status, state) = try runHelper(arguments: [], result: { throw failure })

    try expectEqual(status, 21)
    try expectEqual(state.invocationCount(), 1)
    try expectEqual(state.output(), [])
    try expectEqual(state.errors(), [failure.localizedDescription + "\n"])
}

func helperMapsNonTimeoutLockErrorsWithoutRawDetailsTest() throws {
    let (status, state) = try runHelper(arguments: [], result: {
        throw LaunchLockError.posix(action: "open /Users/secret/launch.lock", errno: 13)
    })

    try expectEqual(status, 23)
    try expectEqual(state.invocationCount(), 1)
    try expectEqual(state.output(), [])
    try expectEqual(state.errors(), [LauncherFailure.lockFailed.localizedDescription + "\n"])
    guard !state.errors()[0].contains("/Users/secret"), !state.errors()[0].contains("errno") else {
        throw TestAssertionFailure("helper diagnostics must not expose raw lock details")
    }
}

func helperContractTests() throws {
    try helperVersionHasNoLauncherEffectsTest()
    try helperSelfCheckIsStableJSONAndHasNoLauncherEffectsTest()
    try helperSelfCheckRejectsAnyNonProductionPathOrLockValueTest()
    try helperUnknownArgumentsExitWithUsageTest()
    try helperNoArgumentsPrintsLaunchedOutcomeTest()
    try helperNoArgumentsPrintsReusedOutcomeTest()
    try helperNoArgumentsPrintsOnlyActionableFailureTest()
    try helperMapsNonTimeoutLockErrorsWithoutRawDetailsTest()
}

func registerHelperContractTests(_ runner: inout TestRunner) {
    runner.register("HelperContractTests", helperContractTests)
    runner.register("HelperContractTests.VersionHasNoLauncherEffects", helperVersionHasNoLauncherEffectsTest)
    runner.register("HelperContractTests.SelfCheckIsStableJSONAndHasNoLauncherEffects", helperSelfCheckIsStableJSONAndHasNoLauncherEffectsTest)
    runner.register("HelperContractTests.SelfCheckRejectsAnyNonProductionPathOrLockValue", helperSelfCheckRejectsAnyNonProductionPathOrLockValueTest)
    runner.register("HelperContractTests.UnknownArgumentsExitWithUsage", helperUnknownArgumentsExitWithUsageTest)
    runner.register("HelperContractTests.NoArgumentsPrintsLaunchedOutcome", helperNoArgumentsPrintsLaunchedOutcomeTest)
    runner.register("HelperContractTests.NoArgumentsPrintsReusedOutcome", helperNoArgumentsPrintsReusedOutcomeTest)
    runner.register("HelperContractTests.NoArgumentsPrintsOnlyActionableFailure", helperNoArgumentsPrintsOnlyActionableFailureTest)
    runner.register("HelperContractTests.MapsNonTimeoutLockErrorsWithoutRawDetails", helperMapsNonTimeoutLockErrorsWithoutRawDetailsTest)
}

import ChromeCDPCore
import ChromeCDPTestSupport

func launcherFailureExitCodesAreStableTest() throws {
    let failures: [(LauncherFailure, Int32)] = [
        (.missingChrome(applicationPath: "/Applications/Google Chrome.app"), 10),
        (.lockTimeout, 11),
        (.unsafeProfile(.symlink), 12),
        (.foreignListener(pid: 41, port: 9222), 13),
        (.nonLoopbackListener(address: "0.0.0.0", port: 9222), 14),
        (.wrongProfileChrome(pid: 42, profilePath: "/Users/tester/other-profile"), 15),
        (.profileConflict(pid: 43, profilePath: "/Users/tester/chrome-cdp-profile"), 16),
        (.readinessTimeout(lastFailure: .malformedVersion), 17),
        (.invalidWebSocket(.nonLoopbackWebSocket), 18),
        (.launchFailed, 19),
        (.targetCreationFailed, 20),
        (.activationFailed(pid: 44), 21),
        (.profilePreparationFailed, 22),
        (.lockFailed, 23),
        (.observationFailed, 24)
    ]

    for (failure, expectedCode) in failures {
        try expectEqual(failure.exitCode, expectedCode, "stable exit code")
        guard let description = failure.errorDescription, !description.isEmpty else {
            throw TestAssertionFailure("\(failure) must have an actionable description")
        }
    }
}

func launcherFailureSystemFailuresAreStableAndActionableTest() throws {
    try expectEqual(LauncherFailure.lockFailed.exitCode, 23)
    try expectEqual(
        LauncherFailure.lockFailed.errorDescription,
        "Chrome's launch lock could not be accessed safely. Verify your user cache directory is writable, then try again."
    )
    try expectEqual(LauncherFailure.observationFailed.exitCode, 24)
    try expectEqual(
        LauncherFailure.observationFailed.errorDescription,
        "Chrome CDP could not inspect the local profile, process, and listener state safely. Try again."
    )
}

func launcherFailureProfilePreparationFailureIsStableAndActionableTest() throws {
    let failure = LauncherFailure.profilePreparationFailed

    try expectEqual(failure, .profilePreparationFailed)
    try expectEqual(failure.exitCode, 22)
    try expectEqual(
        failure.errorDescription,
        "Chrome's dedicated profile could not be prepared safely. Verify the profile directory is user-owned and writable, then try again."
    )
}

func launcherFailureConflictDescriptionsStateNonTerminationTest() throws {
    let sentence = "Chrome CDP did not terminate or replace another process."
    for failure in [
        LauncherFailure.foreignListener(pid: 41, port: 9222),
        .nonLoopbackListener(address: "0.0.0.0", port: 9222),
        .wrongProfileChrome(pid: 42, profilePath: "/Users/tester/other-profile"),
        .profileConflict(pid: 43, profilePath: "/Users/tester/chrome-cdp-profile")
    ] {
        guard failure.errorDescription?.contains(sentence) == true else {
            throw TestAssertionFailure("\(failure) must state that no process was terminated or replaced")
        }
    }
}

func launcherFailureTimeoutDescriptionsStateNonTerminationTest() throws {
    let sentence = "Chrome CDP did not terminate or replace another process."
    for failure in [LauncherFailure.lockTimeout, .readinessTimeout(lastFailure: .unavailable)] {
        guard failure.errorDescription?.contains(sentence) == true else {
            throw TestAssertionFailure("\(failure) must state that no process was terminated or replaced")
        }
    }
}

func launcherFailureWrongProfileDescriptionSuppressesSecretLikeProfileValueTest() throws {
    let secretProfilePath = "/Users/tester/profile?token=secret-value"
    let description = LauncherFailure.wrongProfileChrome(pid: 43, profilePath: secretProfilePath).errorDescription ?? ""
    guard !description.contains(secretProfilePath), !description.contains("token="), !description.contains("secret-value") else {
        throw TestAssertionFailure("wrong-profile descriptions must not expose a supplied profile value")
    }
}

func launcherFailureTests() throws {
    try launcherFailureExitCodesAreStableTest()
    try launcherFailureConflictDescriptionsStateNonTerminationTest()
    try launcherFailureTimeoutDescriptionsStateNonTerminationTest()
    try launcherFailureWrongProfileDescriptionSuppressesSecretLikeProfileValueTest()
    try launcherFailureProfilePreparationFailureIsStableAndActionableTest()
    try launcherFailureSystemFailuresAreStableAndActionableTest()
}

func registerLauncherFailureTests(_ runner: inout TestRunner) {
    runner.register("LauncherFailureTests", launcherFailureTests)
    runner.register("LauncherFailureTests.ExitCodesAreStable", launcherFailureExitCodesAreStableTest)
    runner.register("LauncherFailureTests.ConflictDescriptionsStateNonTermination", launcherFailureConflictDescriptionsStateNonTerminationTest)
    runner.register("LauncherFailureTests.TimeoutDescriptionsStateNonTermination", launcherFailureTimeoutDescriptionsStateNonTerminationTest)
    runner.register("LauncherFailureTests.WrongProfileDescriptionSuppressesSecretLikeProfileValue", launcherFailureWrongProfileDescriptionSuppressesSecretLikeProfileValueTest)
    runner.register("LauncherFailureTests.ProfilePreparationFailureIsStableAndActionable", launcherFailureProfilePreparationFailureIsStableAndActionableTest)
    runner.register("LauncherFailureTests.SystemFailuresAreStableAndActionable", launcherFailureSystemFailuresAreStableAndActionableTest)
}

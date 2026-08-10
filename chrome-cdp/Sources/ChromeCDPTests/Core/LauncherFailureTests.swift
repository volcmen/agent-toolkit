import ChromeCDPCore
import ChromeCDPTestSupport

func launcherFailureTests() throws {
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
        (.activationFailed(pid: 44), 21)
    ]

    for (failure, expectedCode) in failures {
        try expectEqual(failure.exitCode, expectedCode, "stable exit code")
        guard let description = failure.errorDescription, !description.isEmpty else {
            throw TestAssertionFailure("\(failure) must have an actionable description")
        }
    }

    let conflictSentence = "Chrome CDP did not terminate or replace another process."
    for failure in [
        LauncherFailure.foreignListener(pid: 41, port: 9222),
        .nonLoopbackListener(address: "0.0.0.0", port: 9222),
        .wrongProfileChrome(pid: 42, profilePath: "/Users/tester/other-profile"),
        .profileConflict(pid: 43, profilePath: "/Users/tester/chrome-cdp-profile")
    ] {
        guard failure.errorDescription?.contains(conflictSentence) == true else {
            throw TestAssertionFailure("\(failure) must state that no process was terminated or replaced")
        }
    }

    let secret = "https://example.test/private?token=secret"
    let description = LauncherFailure.profileConflict(
        pid: 43,
        profilePath: "/Users/tester/chrome-cdp-profile"
    ).errorDescription ?? ""
    guard !description.contains(secret), !description.contains("token=") else {
        throw TestAssertionFailure("conflict descriptions must not expose command or endpoint data")
    }
}

func registerLauncherFailureTests(_ runner: inout TestRunner) {
    runner.register("LauncherFailureTests", launcherFailureTests)
}

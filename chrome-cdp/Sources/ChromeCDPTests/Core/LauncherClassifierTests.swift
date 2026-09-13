import ChromeCDPCore
import ChromeCDPTestSupport
import Foundation

private let classifierConfiguration = LauncherConfiguration.production(
    homeDirectory: URL(fileURLWithPath: "/Users/tester", isDirectory: true)
)

private func classify(
    profile: ProfileObservation = .valid(mode: 0o700),
    processes: [ProcessObservation] = [],
    listeners: [ListenerBinding] = [],
    endpoint: EndpointObservation = .unavailable
) -> LauncherDecision {
    LauncherClassifier(configuration: classifierConfiguration).classify(
        SystemSnapshot(profile: profile, processes: processes, listeners: listeners, endpoint: endpoint)
    )
}

private func chrome(pid: Int32 = 41, arguments: [String]? = nil) -> ProcessObservation {
    ProcessObservation(
        pid: pid,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        arguments: arguments ?? [
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=9222",
            "--user-data-dir=/Users/tester/chrome-cdp-profile",
            "--no-first-run",
            "--no-default-browser-check"
        ]
    )
}

private func listener(pid: Int32? = 41, address: String = "127.0.0.1", port: UInt16 = 9222) -> ListenerBinding {
    ListenerBinding(pid: pid, address: address, port: port)
}

private func healthyEndpoint(pages: Int = 1, host: String = "127.0.0.1", port: Int = 9222) -> EndpointObservation {
    .healthy(
        webSocketURL: URL(string: "ws://\(host):\(port)/devtools/browser/example")!,
        pageTargetCount: pages
    )
}

private func wrongProfileChrome(arguments: [String]? = nil) -> ProcessObservation {
    chrome(arguments: arguments ?? [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/other-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
}

func launcherClassifierProfileMissingCreatesProfileTest() throws {
    try expectEqual(classify(profile: .missing), .createProfile)
}

func launcherClassifierProfileModeRequestsRepairTest() throws {
    try expectEqual(classify(profile: .valid(mode: 0o755)), .repairProfileMode)
}

func launcherClassifierSymlinkProfileFailsTest() throws {
    try expectEqual(classify(profile: .symlink), .fail(.unsafeProfile(.symlink)))
}

func launcherClassifierWrongOwnerProfileFailsTest() throws {
    try expectEqual(
        classify(profile: .wrongOwner(owner: 501)),
        .fail(.unsafeProfile(.wrongOwner(owner: 501)))
    )
}

func launcherClassifierNonDirectoryProfileFailsTest() throws {
    try expectEqual(classify(profile: .notDirectory), .fail(.unsafeProfile(.notDirectory)))
}

func launcherClassifierUnsafeProfilePrecedesListenerSafetyTest() throws {
    try expectEqual(
        classify(profile: .symlink, listeners: [listener(address: "0.0.0.0")]),
        .fail(.unsafeProfile(.symlink))
    )
}

func launcherClassifierProfileCreationPrecedesListenerSafetyTest() throws {
    try expectEqual(classify(profile: .missing, listeners: [listener(address: "0.0.0.0")]), .createProfile)
}

func launcherClassifierCleanStateLaunchesTest() throws {
    try expectEqual(classify(), .launch)
}

func launcherClassifierExpectedChromeWithoutListenerWaitsTest() throws {
    try expectEqual(
        classify(processes: [chrome()]),
        .waitForReadiness(pid: 41, lastFailure: .unavailable)
    )
}

func launcherClassifierExpectedChromeWithUnavailableEndpointWaitsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .unavailable),
        .waitForReadiness(pid: 41, lastFailure: .unavailable)
    )
}

func launcherClassifierExpectedChromeWithMalformedVersionWaitsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.malformedVersion)),
        .waitForReadiness(pid: 41, lastFailure: .malformedVersion)
    )
}

func launcherClassifierExpectedChromeWithNonChromeBrowserWaitsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.nonChromeBrowser)),
        .waitForReadiness(pid: 41, lastFailure: .nonChromeBrowser)
    )
}

func launcherClassifierExpectedChromeWithMalformedTargetListWaitsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.malformedTargetList)),
        .waitForReadiness(pid: 41, lastFailure: .malformedTargetList)
    )
}

func launcherClassifierHealthyExpectedChromeWithoutPagesReusesAndCreatesBlankTargetTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: healthyEndpoint(pages: 0)),
        .reuse(pid: 41, createBlankTarget: true)
    )
}

func launcherClassifierHealthyExpectedChromeWithPagesReusesWithoutBlankTargetTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: healthyEndpoint(pages: 2)),
        .reuse(pid: 41, createBlankTarget: false)
    )
}

func launcherClassifierKnownForeignListenerFailsTest() throws {
    try expectEqual(classify(listeners: [listener(pid: 72)]), .fail(.foreignListener(pid: 72, port: 9222)))
}

func launcherClassifierUnknownForeignListenerFailsTest() throws {
    try expectEqual(classify(listeners: [listener(pid: nil)]), .fail(.foreignListener(pid: nil, port: 9222)))
}

func launcherClassifierNonLoopbackListenerFailsTest() throws {
    try expectEqual(
        classify(listeners: [listener(address: "0.0.0.0")]),
        .fail(.nonLoopbackListener(address: "0.0.0.0", port: 9222))
    )
}

func launcherClassifierUnsafeBindingInMultipleListenersFailsFirstTest() throws {
    try expectEqual(
        classify(
            processes: [chrome()],
            listeners: [listener(), listener(pid: 77, address: "::1")],
            endpoint: healthyEndpoint()
        ),
        .fail(.nonLoopbackListener(address: "::1", port: 9222))
    )
}

func launcherClassifierListenerPIDMismatchFailsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener(pid: 73)], endpoint: healthyEndpoint()),
        .fail(.foreignListener(pid: 73, port: 9222))
    )
}

func launcherClassifierExpectedPIDOnWrongPortWaitsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener(port: 9223)], endpoint: healthyEndpoint()),
        .waitForReadiness(pid: 41, lastFailure: .unavailable)
    )
}

func launcherClassifierWrongProfileChromeFailsTest() throws {
    try expectEqual(
        classify(processes: [wrongProfileChrome()], listeners: [listener()], endpoint: healthyEndpoint()),
        .fail(.wrongProfileChrome(pid: 41, profilePath: "/Users/tester/other-profile"))
    )
}

func launcherClassifierWrongProfileChromeWithEqualDuplicatesFailsTest() throws {
    let process = wrongProfileChrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/other-profile",
        "--user-data-dir", "/Users/tester/other-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process], listeners: [listener()], endpoint: healthyEndpoint()),
        .fail(.wrongProfileChrome(pid: 41, profilePath: "/Users/tester/other-profile"))
    )
}

func launcherClassifierWrongProfileChromeWithDisagreeingDuplicatesIsForeignTest() throws {
    let process = wrongProfileChrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/other-profile",
        "--user-data-dir", "/Users/tester/another-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process], listeners: [listener()], endpoint: healthyEndpoint()),
        .fail(.foreignListener(pid: 41, port: 9222))
    )
}

func launcherClassifierDedicatedProfileMissingAddressFailsTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierDedicatedProfileMissingPortFailsTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierMultipleExpectedOwnersFailTest() throws {
    try expectEqual(
        classify(processes: [chrome(), chrome(pid: 42)]),
        .fail(.profileConflict(pid: nil, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierMultipleExpectedOwnersPrecedeWrongProfileTest() throws {
    try expectEqual(
        classify(
            processes: [chrome(), chrome(pid: 42), wrongProfileChrome()],
            listeners: [listener()],
            endpoint: healthyEndpoint()
        ),
        .fail(.profileConflict(pid: nil, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierWrongProfilePrecedesForeignListenerTest() throws {
    try expectEqual(
        classify(
            processes: [wrongProfileChrome()],
            listeners: [listener(), listener(pid: 72)],
            endpoint: healthyEndpoint()
        ),
        .fail(.wrongProfileChrome(pid: 41, profilePath: "/Users/tester/other-profile"))
    )
}

func launcherClassifierPairedArgumentsAreExpectedTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-address", "127.0.0.1",
        "--remote-debugging-port", "9222",
        "--user-data-dir", "/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process], listeners: [listener()], endpoint: healthyEndpoint()),
        .reuse(pid: 41, createBlankTarget: false)
    )
}

func launcherClassifierEqualArgumentDuplicatesAreExpectedTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-address", "127.0.0.1",
        "--remote-debugging-port=9222",
        "--remote-debugging-port", "9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--user-data-dir", "/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process], listeners: [listener()], endpoint: healthyEndpoint()),
        .reuse(pid: 41, createBlankTarget: false)
    )
}

func launcherClassifierDisagreeingAddressDuplicatesFailTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-address", "0.0.0.0",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierDisagreeingPortDuplicatesFailTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--remote-debugging-port", "9223",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierDisagreeingDedicatedProfileDuplicatesFailTest() throws {
    let process = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--user-data-dir", "/Users/tester/other-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [process]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

func launcherClassifierInvalidWebSocketFailureFailsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.invalidWebSocket)),
        .fail(.invalidWebSocket(.invalidWebSocket))
    )
}

func launcherClassifierNonLoopbackWebSocketFailureFailsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.nonLoopbackWebSocket)),
        .fail(.invalidWebSocket(.nonLoopbackWebSocket))
    )
}

func launcherClassifierWrongPortWebSocketFailureFailsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.wrongWebSocketPort)),
        .fail(.invalidWebSocket(.wrongWebSocketPort))
    )
}

func launcherClassifierHealthyNonLoopbackWebSocketFailsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: healthyEndpoint(host: "192.0.2.1")),
        .fail(.invalidWebSocket(.nonLoopbackWebSocket))
    )
}

func launcherClassifierHealthyWrongPortWebSocketFailsTest() throws {
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: healthyEndpoint(port: 9223)),
        .fail(.invalidWebSocket(.wrongWebSocketPort))
    )
}

func launcherClassifierTests() throws {
    try launcherClassifierProfileMissingCreatesProfileTest()
    try launcherClassifierProfileModeRequestsRepairTest()
    try launcherClassifierSymlinkProfileFailsTest()
    try launcherClassifierWrongOwnerProfileFailsTest()
    try launcherClassifierNonDirectoryProfileFailsTest()
    try launcherClassifierUnsafeProfilePrecedesListenerSafetyTest()
    try launcherClassifierProfileCreationPrecedesListenerSafetyTest()
    try launcherClassifierCleanStateLaunchesTest()
    try launcherClassifierExpectedChromeWithoutListenerWaitsTest()
    try launcherClassifierExpectedChromeWithUnavailableEndpointWaitsTest()
    try launcherClassifierExpectedChromeWithMalformedVersionWaitsTest()
    try launcherClassifierExpectedChromeWithNonChromeBrowserWaitsTest()
    try launcherClassifierExpectedChromeWithMalformedTargetListWaitsTest()
    try launcherClassifierHealthyExpectedChromeWithoutPagesReusesAndCreatesBlankTargetTest()
    try launcherClassifierHealthyExpectedChromeWithPagesReusesWithoutBlankTargetTest()
    try launcherClassifierKnownForeignListenerFailsTest()
    try launcherClassifierUnknownForeignListenerFailsTest()
    try launcherClassifierNonLoopbackListenerFailsTest()
    try launcherClassifierUnsafeBindingInMultipleListenersFailsFirstTest()
    try launcherClassifierListenerPIDMismatchFailsTest()
    try launcherClassifierExpectedPIDOnWrongPortWaitsTest()
    try launcherClassifierWrongProfileChromeFailsTest()
    try launcherClassifierWrongProfileChromeWithEqualDuplicatesFailsTest()
    try launcherClassifierWrongProfileChromeWithDisagreeingDuplicatesIsForeignTest()
    try launcherClassifierDedicatedProfileMissingAddressFailsTest()
    try launcherClassifierDedicatedProfileMissingPortFailsTest()
    try launcherClassifierMultipleExpectedOwnersFailTest()
    try launcherClassifierMultipleExpectedOwnersPrecedeWrongProfileTest()
    try launcherClassifierWrongProfilePrecedesForeignListenerTest()
    try launcherClassifierPairedArgumentsAreExpectedTest()
    try launcherClassifierEqualArgumentDuplicatesAreExpectedTest()
    try launcherClassifierDisagreeingAddressDuplicatesFailTest()
    try launcherClassifierDisagreeingPortDuplicatesFailTest()
    try launcherClassifierDisagreeingDedicatedProfileDuplicatesFailTest()
    try launcherClassifierInvalidWebSocketFailureFailsTest()
    try launcherClassifierNonLoopbackWebSocketFailureFailsTest()
    try launcherClassifierWrongPortWebSocketFailureFailsTest()
    try launcherClassifierHealthyNonLoopbackWebSocketFailsTest()
    try launcherClassifierHealthyWrongPortWebSocketFailsTest()
}

func registerLauncherClassifierTests(_ runner: inout TestRunner) {
    runner.register("LauncherClassifierTests", launcherClassifierTests)
    runner.register("LauncherClassifierTests.ProfileMissingCreatesProfile", launcherClassifierProfileMissingCreatesProfileTest)
    runner.register("LauncherClassifierTests.ProfileModeRequestsRepair", launcherClassifierProfileModeRequestsRepairTest)
    runner.register("LauncherClassifierTests.SymlinkProfileFails", launcherClassifierSymlinkProfileFailsTest)
    runner.register("LauncherClassifierTests.WrongOwnerProfileFails", launcherClassifierWrongOwnerProfileFailsTest)
    runner.register("LauncherClassifierTests.NonDirectoryProfileFails", launcherClassifierNonDirectoryProfileFailsTest)
    runner.register("LauncherClassifierTests.UnsafeProfilePrecedesListenerSafety", launcherClassifierUnsafeProfilePrecedesListenerSafetyTest)
    runner.register("LauncherClassifierTests.ProfileCreationPrecedesListenerSafety", launcherClassifierProfileCreationPrecedesListenerSafetyTest)
    runner.register("LauncherClassifierTests.CleanStateLaunches", launcherClassifierCleanStateLaunchesTest)
    runner.register("LauncherClassifierTests.ExpectedChromeWithoutListenerWaits", launcherClassifierExpectedChromeWithoutListenerWaitsTest)
    runner.register("LauncherClassifierTests.ExpectedChromeWithUnavailableEndpointWaits", launcherClassifierExpectedChromeWithUnavailableEndpointWaitsTest)
    runner.register("LauncherClassifierTests.ExpectedChromeWithMalformedVersionWaits", launcherClassifierExpectedChromeWithMalformedVersionWaitsTest)
    runner.register("LauncherClassifierTests.ExpectedChromeWithNonChromeBrowserWaits", launcherClassifierExpectedChromeWithNonChromeBrowserWaitsTest)
    runner.register("LauncherClassifierTests.ExpectedChromeWithMalformedTargetListWaits", launcherClassifierExpectedChromeWithMalformedTargetListWaitsTest)
    runner.register("LauncherClassifierTests.HealthyExpectedChromeWithoutPagesReusesAndCreatesBlankTarget", launcherClassifierHealthyExpectedChromeWithoutPagesReusesAndCreatesBlankTargetTest)
    runner.register("LauncherClassifierTests.HealthyExpectedChromeWithPagesReusesWithoutBlankTarget", launcherClassifierHealthyExpectedChromeWithPagesReusesWithoutBlankTargetTest)
    runner.register("LauncherClassifierTests.KnownForeignListenerFails", launcherClassifierKnownForeignListenerFailsTest)
    runner.register("LauncherClassifierTests.UnknownForeignListenerFails", launcherClassifierUnknownForeignListenerFailsTest)
    runner.register("LauncherClassifierTests.NonLoopbackListenerFails", launcherClassifierNonLoopbackListenerFailsTest)
    runner.register("LauncherClassifierTests.UnsafeBindingInMultipleListenersFailsFirst", launcherClassifierUnsafeBindingInMultipleListenersFailsFirstTest)
    runner.register("LauncherClassifierTests.ListenerPIDMismatchFails", launcherClassifierListenerPIDMismatchFailsTest)
    runner.register("LauncherClassifierTests.ExpectedPIDOnWrongPortWaits", launcherClassifierExpectedPIDOnWrongPortWaitsTest)
    runner.register("LauncherClassifierTests.WrongProfileChromeFails", launcherClassifierWrongProfileChromeFailsTest)
    runner.register("LauncherClassifierTests.WrongProfileWithEqualDuplicates", launcherClassifierWrongProfileChromeWithEqualDuplicatesFailsTest)
    runner.register("LauncherClassifierTests.WrongProfileWithDisagreeingDuplicatesIsForeign", launcherClassifierWrongProfileChromeWithDisagreeingDuplicatesIsForeignTest)
    runner.register("LauncherClassifierTests.DedicatedProfileMissingAddressFails", launcherClassifierDedicatedProfileMissingAddressFailsTest)
    runner.register("LauncherClassifierTests.DedicatedProfileMissingPortFails", launcherClassifierDedicatedProfileMissingPortFailsTest)
    runner.register("LauncherClassifierTests.MultipleExpectedOwnersFail", launcherClassifierMultipleExpectedOwnersFailTest)
    runner.register("LauncherClassifierTests.MultipleExpectedOwnersPrecedeWrongProfile", launcherClassifierMultipleExpectedOwnersPrecedeWrongProfileTest)
    runner.register("LauncherClassifierTests.WrongProfilePrecedesForeignListener", launcherClassifierWrongProfilePrecedesForeignListenerTest)
    runner.register("LauncherClassifierTests.PairedArgumentsAreExpected", launcherClassifierPairedArgumentsAreExpectedTest)
    runner.register("LauncherClassifierTests.EqualArgumentDuplicatesAreExpected", launcherClassifierEqualArgumentDuplicatesAreExpectedTest)
    runner.register("LauncherClassifierTests.DisagreeingAddressDuplicatesFail", launcherClassifierDisagreeingAddressDuplicatesFailTest)
    runner.register("LauncherClassifierTests.DisagreeingPortDuplicatesFail", launcherClassifierDisagreeingPortDuplicatesFailTest)
    runner.register("LauncherClassifierTests.DisagreeingDedicatedProfileDuplicatesFail", launcherClassifierDisagreeingDedicatedProfileDuplicatesFailTest)
    runner.register("LauncherClassifierTests.InvalidWebSocketFailureFails", launcherClassifierInvalidWebSocketFailureFailsTest)
    runner.register("LauncherClassifierTests.NonLoopbackWebSocketFailureFails", launcherClassifierNonLoopbackWebSocketFailureFailsTest)
    runner.register("LauncherClassifierTests.WrongPortWebSocketFailureFails", launcherClassifierWrongPortWebSocketFailureFailsTest)
    runner.register("LauncherClassifierTests.HealthyNonLoopbackWebSocketFails", launcherClassifierHealthyNonLoopbackWebSocketFailsTest)
    runner.register("LauncherClassifierTests.HealthyWrongPortWebSocketFails", launcherClassifierHealthyWrongPortWebSocketFailsTest)
}

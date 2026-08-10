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
        SystemSnapshot(
            profile: profile,
            processes: processes,
            listeners: listeners,
            endpoint: endpoint
        )
    )
}

private func chrome(
    pid: Int32 = 41,
    executablePath: String = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    arguments: [String]? = nil
) -> ProcessObservation {
    ProcessObservation(
        pid: pid,
        executablePath: executablePath,
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

private func launcherClassifierProfileTests() throws {
    try expectEqual(classify(profile: .missing), .createProfile)
    try expectEqual(classify(profile: .valid(mode: 0o755)), .repairProfileMode)
    try expectEqual(
        classify(profile: .symlink),
        .fail(.unsafeProfile(.symlink))
    )
    try expectEqual(
        classify(profile: .wrongOwner(owner: 501)),
        .fail(.unsafeProfile(.wrongOwner(owner: 501)))
    )
    try expectEqual(
        classify(profile: .notDirectory),
        .fail(.unsafeProfile(.notDirectory))
    )
    try expectEqual(
        classify(profile: .symlink, listeners: [listener(address: "0.0.0.0")]),
        .fail(.unsafeProfile(.symlink))
    )
    try expectEqual(
        classify(profile: .missing, listeners: [listener(address: "0.0.0.0")]),
        .createProfile
    )
}

private func launcherClassifierCleanAndReadinessTests() throws {
    try expectEqual(classify(), .launch)
    try expectEqual(
        classify(processes: [chrome()]),
        .waitForReadiness(pid: 41, lastFailure: .unavailable)
    )
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .invalid(.malformedVersion)),
        .waitForReadiness(pid: 41, lastFailure: .malformedVersion)
    )
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: .unavailable),
        .waitForReadiness(pid: 41, lastFailure: .unavailable)
    )
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: healthyEndpoint(pages: 0)),
        .reuse(pid: 41, createBlankTarget: true)
    )
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener()], endpoint: healthyEndpoint(pages: 2)),
        .reuse(pid: 41, createBlankTarget: false)
    )
}

private func launcherClassifierListenerSafetyAndOwnershipTests() throws {
    try expectEqual(
        classify(listeners: [listener(pid: 72)]),
        .fail(.foreignListener(pid: 72, port: 9222))
    )
    try expectEqual(
        classify(listeners: [listener(pid: nil)]),
        .fail(.foreignListener(pid: nil, port: 9222))
    )
    try expectEqual(
        classify(listeners: [listener(address: "0.0.0.0")]),
        .fail(.nonLoopbackListener(address: "0.0.0.0", port: 9222))
    )
    try expectEqual(
        classify(
            processes: [chrome()],
            listeners: [listener(), listener(pid: 77, address: "::1")],
            endpoint: healthyEndpoint()
        ),
        .fail(.nonLoopbackListener(address: "::1", port: 9222))
    )
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener(pid: 73)], endpoint: healthyEndpoint()),
        .fail(.foreignListener(pid: 73, port: 9222))
    )
    try expectEqual(
        classify(processes: [chrome()], listeners: [listener(port: 9223)], endpoint: healthyEndpoint()),
        .waitForReadiness(pid: 41, lastFailure: .unavailable)
    )
}

private func launcherClassifierConflictTests() throws {
    let wrongProfile = chrome(arguments: [
        "--remote-debugging-address", "127.0.0.1",
        "--remote-debugging-port", "9222",
        "--user-data-dir=/Users/tester/other-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [wrongProfile], listeners: [listener()], endpoint: healthyEndpoint()),
        .fail(.wrongProfileChrome(pid: 41, profilePath: "/Users/tester/other-profile"))
    )

    let missingAddress = chrome(arguments: [
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [missingAddress]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )

    let missingPort = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [missingPort]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )

    try expectEqual(
        classify(processes: [chrome(), chrome(pid: 42)]),
        .fail(.profileConflict(pid: nil, profilePath: "/Users/tester/chrome-cdp-profile"))
    )

    try expectEqual(
        classify(processes: [chrome(), chrome(pid: 42), wrongProfile], listeners: [listener()], endpoint: healthyEndpoint()),
        .fail(.profileConflict(pid: nil, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
    try expectEqual(
        classify(processes: [wrongProfile], listeners: [listener(), listener(pid: 72)], endpoint: healthyEndpoint()),
        .fail(.wrongProfileChrome(pid: 41, profilePath: "/Users/tester/other-profile"))
    )
}

private func launcherClassifierArgumentParsingTests() throws {
    let paired = chrome(arguments: [
        "--remote-debugging-address", "127.0.0.1",
        "--remote-debugging-port", "9222",
        "--user-data-dir", "/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [paired], listeners: [listener()], endpoint: healthyEndpoint()),
        .reuse(pid: 41, createBlankTarget: false)
    )

    let equalDuplicates = chrome(arguments: [
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
        classify(processes: [equalDuplicates], listeners: [listener()], endpoint: healthyEndpoint()),
        .reuse(pid: 41, createBlankTarget: false)
    )

    let disagreeingDuplicates = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-address", "0.0.0.0",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [disagreeingDuplicates]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )

    let conflictingPort = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--remote-debugging-port", "9223",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [conflictingPort]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )

    let conflictingProfile = chrome(arguments: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/Users/tester/chrome-cdp-profile",
        "--user-data-dir", "/Users/tester/other-profile",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    try expectEqual(
        classify(processes: [conflictingProfile]),
        .fail(.profileConflict(pid: 41, profilePath: "/Users/tester/chrome-cdp-profile"))
    )
}

private func launcherClassifierEndpointTests() throws {
    try expectEqual(
        classify(
            processes: [chrome()],
            listeners: [listener()],
            endpoint: .invalid(.nonLoopbackWebSocket)
        ),
        .fail(.invalidWebSocket(.nonLoopbackWebSocket))
    )
    try expectEqual(
        classify(
            processes: [chrome()],
            listeners: [listener()],
            endpoint: .invalid(.wrongWebSocketPort)
        ),
        .fail(.invalidWebSocket(.wrongWebSocketPort))
    )
    try expectEqual(
        classify(
            processes: [chrome()],
            listeners: [listener()],
            endpoint: healthyEndpoint(host: "192.0.2.1")
        ),
        .fail(.invalidWebSocket(.nonLoopbackWebSocket))
    )
    try expectEqual(
        classify(
            processes: [chrome()],
            listeners: [listener()],
            endpoint: healthyEndpoint(port: 9223)
        ),
        .fail(.invalidWebSocket(.wrongWebSocketPort))
    )
}

func launcherClassifierTests() throws {
    try launcherClassifierProfileTests()
    try launcherClassifierCleanAndReadinessTests()
    try launcherClassifierListenerSafetyAndOwnershipTests()
    try launcherClassifierConflictTests()
    try launcherClassifierArgumentParsingTests()
    try launcherClassifierEndpointTests()
}

func registerLauncherClassifierTests(_ runner: inout TestRunner) {
    runner.register("LauncherClassifierTests", launcherClassifierTests)
}
